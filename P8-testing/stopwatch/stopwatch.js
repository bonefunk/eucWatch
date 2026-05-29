// stopwatch.js
// Cardio stopwatch with HRS3300 heart-rate (eucWatch / P8 / P22)
//
// Stability-focused version:
// - H:MM:SS display (single-digit hours)
// - all-white text
// - side button is the supported exit path
// - swipe ignored for now
// - HR only while stopwatch is running
// - aggressive cleanup on exit
// - redraws synchronized to exact second boundaries
// - no redraw loop while stopped

var G = w.gfx;

// ----------------------
// Stopwatch state
// ----------------------

var running = 0;
var t0 = 0;
var acc = 0;

var drawTid = 0;

var lastLine = "";

var ignoreTapUntil = 0;

// ----------------------
// HRM (HRS3300) state
// ----------------------

var HR_ADDR = 0x44;

var hrOn = 0;
var hrTickId = 0;

var hrBpm = null;
var hrRaw = 0;

// Cardio-tuned constants

var HR_FS_MS   = 40;   // 25 Hz
var HR_WIN     = 25;   // ~1 second window
var HR_REFRACT = 400;
var HR_THR_MUL = 1.15;
var HR_THR_MIN = 25;

// Moving window + peak detect

var hrBuf = new Array(HR_WIN);
var hrAbsBuf = new Array(HR_WIN);

var hrI = 0;
var hrFilled = 0;
var hrSum = 0;
var hrAbsSum = 0;

var hrPrevAc = 0;
var hrRising = false;
var hrPeakAc = 0;
var hrLastPeak = 0;
var hrLastBeat = 0;

// ----------------------
// Helpers
// ----------------------

// H:MM:SS with single-digit hours

function fmt(ms) {

  if (ms < 0)
    ms = 0;

  var total = (ms / 1000) | 0;

  var hh = ((total / 3600) | 0) % 10;
  var mm = ((total / 60) | 0) % 60;
  var ss = total % 60;

  return hh + ":" +
         (mm < 10 ? "0" : "") + mm + ":" +
         (ss < 10 ? "0" : "") + ss;
}

// Dynamically control face timeout

function updateAwake() {

  if (running)
    face[0].offms = 86400000; // 24h while running
  else
    face[0].offms = 600000;   // 10m while stopped
}

// Align redraws to exact second boundaries.
// This prevents "short" and "long" displayed seconds.

function nextSecondDelay() {

  if (!running)
    return 1000;

  var e = acc + (Date.now() - t0);

  var d = 1000 - (e % 1000);

  // avoid tiny near-zero redraw delays
  if (d < 20)
    d += 1000;

  return d + 5;
}

// Use only handler-provided i2c bus

function getBus() {

  if (typeof i2c !== "undefined" &&
      i2c &&
      i2c.writeTo &&
      i2c.readFrom)
    return i2c;

  return null;
}

function hrReadReg(bus, reg) {

  bus.writeTo(HR_ADDR, reg);

  return bus.readFrom(HR_ADDR, 1)[0];
}

function hrWriteReg(bus, reg, val) {

  bus.writeTo(HR_ADDR, reg, val);
}

function hrReadCH0(bus) {

  var m = hrReadReg(bus, 0x09);
  var h = hrReadReg(bus, 0x0A);
  var l = hrReadReg(bus, 0x0F);

  return (m << 8) |
         ((h & 0x0F) << 4) |
         (l & 0x0F);
}

// ----------------------
// HR control
// ----------------------

function hrEnable() {

  var bus = getBus();

  if (!bus)
    return false;

  // HRS3300 ID should be 0x21

  var id = hrReadReg(bus, 0x00);

  if (id !== 0x21)
    return false;

  hrWriteReg(bus, 0x0C, 0x68);
  hrWriteReg(bus, 0x16, 0x66);
  hrWriteReg(bus, 0x17, 0x10);
  hrWriteReg(bus, 0x01, 0xE8);

  hrOn = 1;

  return true;
}

function hrDisable(clearValue) {

  var bus = getBus();

  if (bus) {

    hrWriteReg(bus, 0x01, 0x00);
    hrWriteReg(bus, 0x0C, 0x48);
  }

  hrOn = 0;

  if (clearValue)
    hrBpm = null;
}

function hrResetState(clearValue) {

  hrI = 0;
  hrFilled = 0;
  hrSum = 0;
  hrAbsSum = 0;

  hrPrevAc = 0;
  hrRising = false;
  hrPeakAc = 0;
  hrLastPeak = 0;
  hrLastBeat = 0;

  hrRaw = 0;

  if (clearValue)
    hrBpm = null;
}

function hrTick() {

  var bus = getBus();

  if (!bus || !hrOn)
    return;

  var v = hrReadCH0(bus);

  hrRaw = v;

  if (hrFilled < HR_WIN) {

    hrBuf[hrI] = v;

    hrSum += v;

    hrFilled++;

    hrAbsBuf[hrI] = 0;

  } else {

    hrSum -= hrBuf[hrI];

    hrBuf[hrI] = v;

    hrSum += v;

    hrAbsSum -= hrAbsBuf[hrI];
  }

  var mean = hrSum / hrFilled;

  var ac = v - mean;

  var absAc = Math.abs(ac);

  hrAbsBuf[hrI] = absAc;

  hrAbsSum += absAc;

  hrI = (hrI + 1) % HR_WIN;

  var mad = hrAbsSum / hrFilled;

  var thr = Math.max(
    HR_THR_MIN,
    mad * HR_THR_MUL
  );

  var now = Date.now();

  // Peak detect

  if (ac > hrPrevAc) {

    hrRising = true;

    if (ac > hrPeakAc)
      hrPeakAc = ac;

  } else if (hrRising) {

    hrRising = false;

    if (
      hrPeakAc > thr &&
      (now - hrLastPeak) > HR_REFRACT
    ) {

      hrLastPeak = now;

      if (hrLastBeat) {

        var inst = 60000 / (now - hrLastBeat);

        if (inst >= 40 && inst <= 200) {

          hrBpm = hrBpm
            ? (0.7 * hrBpm + 0.3 * inst)
            : inst;

          hrBpm = hrBpm | 0;
        }
      }

      hrLastBeat = now;
    }

    hrPeakAc = 0;
  }

  hrPrevAc = ac;
}

function hrStartLoop() {

  if (hrTickId)
    return;

  hrResetState(true);

  if (!hrEnable())
    return;

  hrTickId = setInterval(
    hrTick,
    HR_FS_MS
  );
}

function hrStopLoop(clearValue) {

  if (hrTickId) {

    clearInterval(hrTickId);

    hrTickId = 0;
  }

  hrDisable(clearValue);
}

// ----------------------
// Drawing
// ----------------------

function draw(force) {

  var now = Date.now();

  var elapsed =
    acc +
    (running ? (now - t0) : 0);

  var line1 = fmt(elapsed);

  var line2 =
    hrBpm
      ? ("HR " + hrBpm)
      : "HR --";

  var line3 =
    running
      ? "RUNNING"
      : "STOPPED";

  var combined =
    line1 + "\n" +
    line2 + "\n" +
    line3;

  if (!force && combined === lastLine)
    return;

  lastLine = combined;

  var W = (
    G.getWidth
      ? G.getWidth()
      : 240
  );

  var H = (
    G.getHeight
      ? G.getHeight()
      : 240
  );

  // background

  G.setColor(0, 0);

  G.fillRect(
    0,
    0,
    W - 1,
    H - 1
  );

  // white text only

  G.setColor(1, 15);

  // main time

  G.setFont("Vector", 46);

  G.drawString(
    line1,
    ((W - G.stringWidth(line1)) / 2) + 6,
    72
  );

  // status

  G.setFont("Vector", 18);

  G.drawString(
    line3,
    (W - G.stringWidth(line3)) / 2,
    135
  );

  // HR

  G.setFont("Vector", 24);

  G.drawString(
    line2,
    (W - G.stringWidth(line2)) / 2,
    165
  );

  // hint

  G.setFont("Vector", 14);

  var hint =
    running
      ? "TAP: STOP  BTN: EXIT"
      : "TAP: START  LONG: RESET";

  G.drawString(
    hint,
    (W - G.stringWidth(hint)) / 2,
    205
  );

  G.flip();
}

// redraw loop synchronized to second boundaries

function drawLoop() {

  draw(false);

  // ensure only one draw loop exists

  if (drawTid)
    clearTimeout(drawTid);

  // no need to redraw while stopped

  if (running) {

    drawTid = setTimeout(
      drawLoop,
      nextSecondDelay()
    );

  } else {

    drawTid = 0;
  }
}

// ----------------------
// Cleanup
// ----------------------

function hardCleanup(clearHrValue) {

  // stop draw loop

  if (drawTid) {

    clearTimeout(drawTid);

    drawTid = 0;
  }

  // stop HR

  hrStopLoop(clearHrValue);

  // reset stopwatch state

  running = 0;

  t0 = 0;

  acc = 0;

  // reset HR estimator

  hrResetState(clearHrValue);

  // reset UI state

  lastLine = "";

  ignoreTapUntil =
    Date.now() + 500;
}

// ----------------------
// Stopwatch controls
// ----------------------

function startSW() {

  if (running)
    return;

  running = 1;

  updateAwake();

  t0 = Date.now();

  if (buzzer && buzzer.sys)
    buzzer.sys(80);

  // HR only while timing

  hrStartLoop();

  draw(true);

  // restart synchronized draw loop

  drawLoop();
}

function stopSW() {

  if (!running)
    return;

  acc += (Date.now() - t0);

  running = 0;

  updateAwake();

  if (buzzer && buzzer.sys)
    buzzer.sys([80,120,80]);

  // stop HR immediately

  hrStopLoop(false);

  draw(true);

  // drawLoop intentionally NOT restarted
}

function resetSW() {

  // reset only while stopped

  if (running) {

    if (buzzer && buzzer.sys)
      buzzer.sys(40);

    return;
  }

  acc = 0;

  t0 = 0;

  hrBpm = null;

  if (buzzer && buzzer.sys)
    buzzer.sys([100,50,80]);

  draw(true);
}

// ----------------------
// eucWatch face
// ----------------------

face[0] = {

  offms: 600000,

  init: function () {

    // defensive cleanup

    hardCleanup(true);

    running = 0;

    acc = 0;

    t0 = 0;

    hrBpm = null;

    lastLine = "";

    ignoreTapUntil = 0;

    updateAwake();

    draw(true);

    // no drawLoop until stopwatch starts

    return 1;
  },

  show: function () {

    // keep watch awake while running

    if (
      running &&
      touchHandler &&
      touchHandler.timeout
    ) {
      touchHandler.timeout();
    }

    return 1;
  },

  clear: function () {

    hardCleanup(true);

    return 1;
  },

  off: function () {

    // cleanup first

    hardCleanup(true);

    G.off();
  }
};

// ----------------------
// Touch handling
// ----------------------
//
// e==5  tap
// e==12 long press
// e==1  swipe down
//
// Swipe intentionally ignored for now.
// Side button is the supported exit path.

touchHandler[0] = function (e, x, y) {

  var now = Date.now();

  // ignore swipe

  if (e == 1) {

    this.timeout();

    return;
  }

  // long press reset

  if (e == 12) {

    resetSW();

    // suppress follow-up tap

    ignoreTapUntil =
      now + 1200;

    this.timeout();

    return;
  }

  // tap start/stop

  if (e == 5) {

    // ignore synthetic tap after long press

    if (now < ignoreTapUntil) {

      this.timeout();

      return;
    }

    if (running)
      stopSW();
    else
      startSW();
  }

  this.timeout();
};
