// stopwatch.js
// Cardio stopwatch with HRS3300 heart-rate (eucWatch / P8 / P22)

var G = w.gfx;

// ----------------------
// Stopwatch state
// ----------------------
var running = 0;
var t0 = 0;
var acc = 0;
var drawTid = 0;
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
var HR_WIN     = 25;   // ~1 second
var HR_REFRACT = 400;  // more responsive than 500
var HR_THR_MUL = 1.15;
var HR_THR_MIN = 25;

// Moving window + peak detect
var hrBuf = new Array(HR_WIN);
var hrAbsBuf = new Array(HR_WIN);
var hrI = 0, hrFilled = 0, hrSum = 0, hrAbsSum = 0;
var hrPrevAc = 0, hrRising = false, hrPeakAc = 0, hrLastPeak = 0, hrLastBeat = 0;

// ----------------------
// Helpers
// ----------------------

// Format as H:MM:SS (single hour digit, no subseconds)
function fmt(ms) {
  if (ms < 0) ms = 0;
  var total = (ms / 1000) | 0;

  var hh = ((total / 3600) | 0) % 10;   // single digit hours
  var mm = ((total / 60) | 0) % 60;
  var ss = total % 60;

  return hh + ":" +
         (mm < 10 ? "0" : "") + mm + ":" +
         (ss < 10 ? "0" : "") + ss;
}

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

function hrReadCH0(bus) {
  var m = hrReadReg(bus, 0x09);
  var h = hrReadReg(bus, 0x0A);
  var l = hrReadReg(bus, 0x0F);
  return (m << 8) | ((h & 0x0F) << 4) | (l & 0x0F);
}

function hrEnable() {
  var bus = getBus();
  if (!bus) return false;

  var id = hrReadReg(bus, 0x00);
  if (id !== 0x21) return false;

  hrWriteReg(bus, 0x0C, 0x68); // PON + driver
  hrWriteReg(bus, 0x16, 0x66); // resolution
  hrWriteReg(bus, 0x17, 0x10); // gain
  hrWriteReg(bus, 0x01, 0xE8); // enable

  hrOn = 1;
  return true;
}

function hrDisable(keepValue) {
  var bus = getBus();
  if (bus) {
    hrWriteReg(bus, 0x01, 0x00);
    hrWriteReg(bus, 0x0C, 0x48);
  }
  hrOn = 0;
  if (!keepValue) hrBpm = null;
}

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

  hrI = 0; hrFilled = 0; hrSum = 0; hrAbsSum = 0;
  hrPrevAc = 0; hrRising = false; hrPeakAc = 0; hrLastPeak = 0; hrLastBeat = 0;
  hrBpm = null;

  hrTickId = setInterval(hrTick, HR_FS_MS);
}

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

  G.setColor(0, 0);
  G.fillRect(0, 0, W - 1, H - 1);

  // White text only
  G.setColor(1, 15);

  // Main stopwatch line: slightly smaller and nudged right
  // so the left side doesn’t clip
  G.setFont("Vector", 50);
  G.drawString(line1, ((W - G.stringWidth(line1)) / 2) + 4, 70);

  G.setFont("Vector", 18);
  G.drawString(line3, (W - G.stringWidth(line3)) / 2, 135);

  G.setFont("Vector", 24);
  G.drawString(line2, (W - G.stringWidth(line2)) / 2, 165);

  G.setFont("Vector", 14);
  var hint = running ? "TAP: STOP   SWIPE: EXIT" : "TAP: START   LONG: RESET";
  G.drawString(hint, (W - G.stringWidth(hint)) / 2, 205);

  G.flip();
}

function drawLoop() {
  draw(false);
  // slower redraw; no need for 100ms without subseconds
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

  // stop HR but keep last displayed value
  hrStopLoop(true);
  draw(true);
}

function resetSW() {
  if (running) {
    if (buzzer && buzzer.sys) buzzer.sys(40);
    return;
  }
  acc = 0;
  t0 = 0;
  hrBpm = null;
  if (buzzer && buzzer.sys) buzzer.sys([100, 50, 80]);
  draw(true);
}

// ----------------------
// eucWatch face + touch
// ----------------------
face[0] = {
  offms: 600000,

  init: function () {
    stopAll(false); // defensive cleanup

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

// Touch model follows the same eucWatch pattern as calculator:
// tap=e==5, swipe down=e==1, long press=e==12. [1](https://amwater-my.sharepoint.com/personal/jesse_quadrel_amwater_com/Documents/Microsoft%20Copilot%20Chat%20Files/stopwatch.js)
touchHandler[0] = function (e, x, y) {
  var now = Date.now();

  if (e == 1) {
    // Swipe down to exit
    ignoreTapUntil = now + 500;
    this.timeout();
    face.go("main", 0);
    return;
  }

  if (e == 12) {
    // Long press resets only when stopped
    resetSW();
    // Ignore the synthetic tap that often follows a long press
    ignoreTapUntil = now + 800;
    this.timeout();
    return;
  }

  if (e == 5) {
    if (now < ignoreTapUntil) {
      this.timeout();
      return;
    }

    if (running) stopSW();
    else startSW();
  }

  this.timeout();
};
