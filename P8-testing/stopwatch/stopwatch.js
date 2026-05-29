// stopwatch.js
// Cardio stopwatch with HRS3300 heart-rate (eucWatch / P8 / P22)

var G = w.gfx;

// ----------------------
// Stopwatch state
// ----------------------
var running = 0;   // 0/1
var t0 = 0;        // start timestamp (ms)
var acc = 0;       // accumulated elapsed (ms)
var drawTid = 0;   // draw loop timeout
var ignoreTapUntil = 0; // suppress stray tap after long press / exit

// ----------------------
// HRM (HRS3300) state
// ----------------------
var HR_ADDR = 0x44;
var hrOn = 0;
var hrTickId = 0;
var hrBpm = null;
var hrRaw = 0;

// Cardio-tuned constants:
// - More responsive than the old resting-biased profile
// - Still conservative enough to avoid a lot of false highs
var HR_FS_MS   = 40;   // 25 Hz
var HR_WIN     = 25;   // ~1 second window
var HR_REFRACT = 400;  // was 500; allows up to ~150 bpm
var HR_THR_MUL = 1.15; // slightly easier to trigger on real beats
var HR_THR_MIN = 25;

// Moving window + peak detect
var hrBuf = new Array(HR_WIN);
var hrAbsBuf = new Array(HR_WIN);
var hrI = 0, hrFilled = 0, hrSum = 0, hrAbsSum = 0;
var hrPrevAc = 0, hrRising = false, hrPeakAc = 0, hrLastPeak = 0, hrLastBeat = 0;

// ----------------------
// Helpers
// ----------------------
function fmt(ms) {
  // mm:ss.hh
  if (ms < 0) ms = 0;
  var cs = (ms / 10) | 0;
  var ss = (cs / 100) | 0;
  cs = cs % 100;
  var mm = (ss / 60) | 0;
  ss = ss % 60;
  return (mm < 10 ? "0" : "") + mm + ":" +
         (ss < 10 ? "0" : "") + ss + "." +
         (cs < 10 ? "0" : "") + cs;
}

// Use the handler-provided i2c if available; otherwise try I2C1
function getBus() {
  if (typeof i2c !== "undefined" && i2c && i2c.writeTo && i2c.readFrom) return i2c;
  if (typeof I2C1 !== "undefined" && I2C1 && I2C1.writeTo && I2C1.readFrom) return I2C1;
  return null;
}

function hrReadReg(bus, reg) {
  bus.writeTo(HR_ADDR, reg);
  return bus.readFrom(HR_ADDR, 1)[0];
}

function hrWriteReg(bus, reg, val) {
  bus.writeTo(HR_ADDR, reg, val);
}

// CH0 sample read
function hrReadCH0(bus) {
  var m = hrReadReg(bus, 0x09);
  var h = hrReadReg(bus, 0x0A);
  var l = hrReadReg(bus, 0x0F);
  return (m << 8) | ((h & 0x0F) << 4) | (l & 0x0F);
}

// Power/config on
function hrEnable() {
  var bus = getBus();
  if (!bus) return false;

  var id = hrReadReg(bus, 0x00);
  if (id !== 0x21) return false;

  hrWriteReg(bus, 0x0C, 0x68); // PON + driver
  hrWriteReg(bus, 0x16, 0x66); // resolution
  hrWriteReg(bus, 0x17, 0x10); // gain
  hrWriteReg(bus, 0x01, 0xE8); // enable forced

  hrOn = 1;
  return true;
}

// keepValue=true => power down sensor but keep last bpm visible
function hrDisable(keepValue) {
  var bus = getBus();
  if (bus) {
    hrWriteReg(bus, 0x01, 0x00);
    hrWriteReg(bus, 0x0C, 0x48);
  }
  hrOn = 0;
  if (!keepValue) hrBpm = null;
}

// HR sample tick
function hrTick() {
  var bus = getBus();
  if (!bus || !hrOn) return;

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
  var thr = Math.max(HR_THR_MIN, mad * HR_THR_MUL);

  var now = Date.now();

  // Peak detect: rising then falling
  if (ac > hrPrevAc) {
    hrRising = true;
    if (ac > hrPeakAc) hrPeakAc = ac;
  } else if (hrRising) {
    hrRising = false;

    if (hrPeakAc > thr && (now - hrLastPeak) > HR_REFRACT) {
      hrLastPeak = now;

      if (hrLastBeat) {
        var inst = 60000 / (now - hrLastBeat);
        if (inst >= 40 && inst <= 200) {
          // Faster response than the old 0.85/0.15 smoothing
          hrBpm = hrBpm ? (0.7 * hrBpm + 0.3 * inst) : inst;
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
  if (hrTickId) return;
  if (!hrEnable()) return;

  // reset estimator state
  hrI = 0; hrFilled = 0; hrSum = 0; hrAbsSum = 0;
  hrPrevAc = 0; hrRising = false; hrPeakAc = 0; hrLastPeak = 0; hrLastBeat = 0;
  hrBpm = null;

  hrTickId = setInterval(hrTick, HR_FS_MS);
}

// keepValue=true keeps the last HR displayed after stop
function hrStopLoop(keepValue) {
  if (hrTickId) {
    clearInterval(hrTickId);
    hrTickId = 0;
  }
  hrDisable(keepValue);
}

// ----------------------
// Drawing
// ----------------------
var lastLine = "";

function draw(force) {
  var now = Date.now();
  var elapsed = acc + (running ? (now - t0) : 0);

  var line1 = fmt(elapsed);
  var line2 = hrBpm ? ("HR " + hrBpm) : "HR --";
  var line3 = running ? "RUNNING" : "STOPPED";

  var combined = line1 + "\n" + line2 + "\n" + line3;
  if (!force && combined === lastLine) return;
  lastLine = combined;

  var W = (G.getWidth ? G.getWidth() : 240);
  var H = (G.getHeight ? G.getHeight() : 240);

  // Explicit background fill
  G.setColor(0, 0);
  G.fillRect(0, 0, W - 1, H - 1);

  // Everything in white
  G.setColor(1, 15);

  // Time
  G.setFont("Vector", 60);
  G.drawString(line1, (W - G.stringWidth(line1)) / 2, 65);

  // Status
  G.setFont("Vector", 18);
  G.drawString(line3, (W - G.stringWidth(line3)) / 2, 135);

  // HR
  G.setFont("Vector", 24);
  G.drawString(line2, (W - G.stringWidth(line2)) / 2, 165);

  // Hint
  G.setFont("Vector", 14);
  var hint = running ? "TAP: STOP   SWIPE: EXIT" : "TAP: START   LONG: RESET";
  G.drawString(hint, (W - G.stringWidth(hint)) / 2, 205);

  G.flip();
}

function drawLoop() {
  draw(false);
  // slower redraw than before (was 100ms)
  drawTid = setTimeout(drawLoop, 250);
}

// ----------------------
// Cleanup
// ----------------------
function stopAll(keepHrValue) {
  if (drawTid) {
    clearTimeout(drawTid);
    drawTid = 0;
  }
  hrStopLoop(keepHrValue);
}

// ----------------------
// Stopwatch controls
// ----------------------
function startSW() {
  if (running) return;
  running = 1;
  t0 = Date.now();
  if (buzzer && buzzer.sys) buzzer.sys(80);

  // Start HR only while timing
  hrStartLoop();
  draw(true);
}

function stopSW() {
  if (!running) return;
  acc += (Date.now() - t0);
  running = 0;
  if (buzzer && buzzer.sys) buzzer.sys([80, 120, 80]);

  // Stop HR when stopped, but keep last value displayed
  hrStopLoop(true);
  draw(true);
}

function resetSW() {
  // Only allow reset when stopped
  if (running) {
    if (buzzer && buzzer.sys) buzzer.sys(40);
    return;
  }
  acc = 0;
  t0 = 0;
  hrBpm = null; // clear displayed HR on reset
  if (buzzer && buzzer.sys) buzzer.sys([100, 50, 80]);
  draw(true);
}

// ----------------------
// eucWatch face + touch
// ----------------------
face[0] = {
  offms: 600000, // 10 minutes

  init: function () {
    // Defensive cleanup in case the app was exited badly before
    stopAll(false);

    running = 0;
    acc = 0;
    t0 = 0;
    lastLine = "";
    ignoreTapUntil = 0;
    hrBpm = null;

    draw(true);
    drawLoop();
    return 1;
  },

  show: function () {
    if (running && touchHandler && touchHandler.timeout) touchHandler.timeout();
    return 1;
  },

  clear: function () {
    stopAll(false);
    return 1;
  },

  off: function () {
    G.off();
    stopAll(false);
  }
};

// Touch:
// e==5 tap
// e==12 long press
// e==1 swipe down/back
touchHandler[0] = function (e, x, y) {
  var now = Date.now();

  if (e == 1) {
    // Swipe down exits, like calculator-style navigation
    stopAll(false);
    ignoreTapUntil = now + 500; // ignore any follow-up tap noise
    face.go("main", 0);
    return;
  }

  if (e == 12) {
    // Long press reset only when stopped
    resetSW();
    // Suppress the "tap" that often follows a long press
    ignoreTapUntil = now + 800;
    this.timeout();
    return;
  }

  if (e == 5) {
    // Ignore synthetic / follow-up tap after long press or exit
    if (now < ignoreTapUntil) {
      this.timeout();
      return;
    }

    if (running) stopSW();
    else startSW();
  }

  this.timeout();
};
