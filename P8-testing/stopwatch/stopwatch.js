// stopwatch.js
// Cardio stopwatch with HRS3300 heart-rate (eucWatch / P8 / P22)

var G = w.gfx;

// ----------------------
// Stopwatch state
// ----------------------
var running = 0;   // 0/1
var t0 = 0;        // start timestamp (ms)
var acc = 0;       // accumulated elapsed (ms)
var drawTid = -1;  // draw loop timeout

// ----------------------
// HRM (HRS3300) state
// ----------------------
var HR_ADDR = 0x44;
var hrOn = 0;
var hrTickId = 0;
var hrBpm = null;
var hrRaw = 0;

// Tuned constants from your “looks good” run:
// - threshold multiplier 1.2
// - REFRACT 500ms (conservative; good for avoiding false high bpm)
// These can be relaxed later for higher HR ranges.
var HR_FS_MS   = 40;   // 25 Hz sampling cadence (device streams PPG samples to host) [1](https://infinitime.io/)
var HR_WIN     = 25;   // ~1 second window
var HR_REFRACT = 500;  // ms (max 120 bpm). Lower later for exercise, e.g. 420.
var HR_THR_MUL = 1.2;  // dynamic threshold multiplier
var HR_THR_MIN = 25;   // floor threshold

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

// In app runtime, eucWatch handler usually exposes a working I2C wrapper as global `i2c`.
// We'll try to use it if available; otherwise fall back to I2C1 if present.
// If neither works, HR will show “--”.
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

// CH0 sample read (registers documented for HRS3300 CH0 at 0x09/0x0A/0x0F) [1](https://infinitime.io/)
function hrReadCH0(bus) {
  var m = hrReadReg(bus, 0x09);
  var h = hrReadReg(bus, 0x0A);
  var l = hrReadReg(bus, 0x0F);
  return (m << 8) | ((h & 0x0F) << 4) | (l & 0x0F);
}

// Power/config on (uses documented control registers and values you verified)
// - ID reg 0x00 = 0x21, addr 0x44 [1](https://infinitime.io/)[2](https://pine64.org/devices/pinetime/)
function hrEnable() {
  var bus = getBus();
  if (!bus) return false;

  // Confirm sensor ID (0x00 should be 0x21) [1](https://infinitime.io/)
  var id = hrReadReg(bus, 0x00);
  if (id !== 0x21) return false;

  // PON/driver (0x0C), resolution (0x16), gain (0x17), enable (0x01) [1](https://infinitime.io/)
  hrWriteReg(bus, 0x0C, 0x68);
  hrWriteReg(bus, 0x16, 0x66);
  hrWriteReg(bus, 0x17, 0x10);
  hrWriteReg(bus, 0x01, 0xE8); // force enable bit

  hrOn = 1;
  return true;
}

function hrDisable() {
  var bus = getBus();
  if (!bus) return;
  // disable + power down oscillator/driver (0x01 and 0x0C) [1](https://infinitime.io/)
  hrWriteReg(bus, 0x01, 0x00);
  hrWriteReg(bus, 0x0C, 0x48);
  hrOn = 0;
  hrBpm = null;
}

// HR sample tick (peak detector + dynamic threshold)
function hrTick() {
  var bus = getBus();
  if (!bus || !hrOn) return;

  var v = hrReadCH0(bus);
  hrRaw = v;

  // Moving average DC removal + MAD-like threshold
  if (hrFilled < HR_WIN) {
    hrBuf[hrI] = v; hrSum += v; hrFilled++;
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
          // smooth
          hrBpm = hrBpm ? (0.85 * hrBpm + 0.15 * inst) : inst;
          hrBpm = hrBpm | 0;
        }
      }
      hrLastBeat = now;
    }

    hrPeakAc = 0;
  }

  hrPrevAc = ac;
}

// Start/stop HR loop cleanly (no reboot required)
function hrStartLoop() {
  if (hrTickId) return;
  if (!hrEnable()) return;

  // reset estimator state
  hrI = 0; hrFilled = 0; hrSum = 0; hrAbsSum = 0;
  hrPrevAc = 0; hrRising = false; hrPeakAc = 0; hrLastPeak = 0; hrLastBeat = 0;
  hrBpm = null;

  hrTickId = setInterval(hrTick, HR_FS_MS);
}

function hrStopLoop() {
  if (hrTickId) { clearInterval(hrTickId); hrTickId = 0; }
  hrDisable();
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

  var combined = line1 + "|" + line2 + "|" + (running ? "R" : "S");
  if (!force && combined === lastLine) return;
  lastLine = combined;

  var W = (G.getWidth ? G.getWidth() : 240);
  var H = (G.getHeight ? G.getHeight() : 240);

  // explicit background fill (avoid clear() ambiguity)
  G.setColor(0, 0);
  G.fillRect(0, 0, W - 1, H - 1);

  // Time
  G.setColor(1, 15);
  G.setFont("Vector", 60);
  G.drawString(line1, (W - G.stringWidth(line1)) / 2, 65);

  // Status
  G.setFont("Vector", 18);
  var st = running ? "RUNNING" : "STOPPED";
  G.drawString(st, (W - G.stringWidth(st)) / 2, 135);

  // HR
  G.setFont("Vector", 24);
  G.setColor(1, 14);
  G.drawString(line2, (W - G.stringWidth(line2)) / 2, 165);

  // Hint
  G.setFont("Vector", 14);
  G.setColor(1, 13);
  var hint = running ? "TAP: STOP   LONG: (no reset)" : "TAP: START   LONG: RESET";
  G.drawString(hint, (W - G.stringWidth(hint)) / 2, 205);

  G.flip();
}

function drawLoop() {
  draw(false);
  drawTid = setTimeout(drawLoop, 100); // 10 fps for centiseconds
}

// ----------------------
// Stopwatch controls
// ----------------------
function startSW() {
  if (running) return;
  running = 1;
  t0 = Date.now();
  if (buzzer && buzzer.sys) buzzer.sys(80);

  // Start HR loop when stopwatch starts (cardio session)
  hrStartLoop();

  draw(true);
}

function stopSW() {
  if (!running) return;
  acc += (Date.now() - t0);
  running = 0;
  if (buzzer && buzzer.sys) buzzer.sys([80, 120, 80]);
  draw(true);

  // Optional: keep HR running while you view results
  // If you want HR to stop immediately when stopped, uncomment:
  // hrStopLoop();
}

function resetSW() {
  // Only allow reset when stopped (prevents accidental reset mid-session)
  if (running) {
    if (buzzer && buzzer.sys) buzzer.sys(40);
    return;
  }
  acc = 0; t0 = 0;
  if (buzzer && buzzer.sys) buzzer.sys([100, 50, 80]);
  draw(true);
}

// ----------------------
// eucWatch face + touch
// ----------------------
face[0] = {
  offms: 600000, // 10 minutes

  init: function () {
    running = 0; acc = 0; t0 = 0;
    lastLine = "";

    // Start HR loop immediately so BPM is ready when you start (optional)
    // Comment out if you only want HR when stopwatch is running:
    hrStartLoop();

    draw(true);
    drawLoop();
    return 1;
  },

  show: function () {
    // keep awake while running
    if (running && touchHandler && touchHandler.timeout) touchHandler.timeout();
    return 1;
  },

  clear: function () {
    if (drawTid >= 0) clearTimeout(drawTid);
    drawTid = -1;

    // Stop HR + power down LED when leaving app
    hrStopLoop();

    return 1;
  },

  off: function () {
    G.off();
    this.clear();
  }
};

// Touch events: same model as calc (tap=e==5, long=e==12, swipe down=e==1) [3](https://files.pine64.org/doc/datasheet/pinetime/HRS3300%20Heart%20Rate%20Sensor.pdf)
touchHandler[0] = function (e, x, y) {
  if (e == 5) {
    if (running) stopSW();
    else startSW();
  } else if (e == 12) {
    resetSW(); // only resets when stopped
  } else if (e == 1) {
    face.go("main", 0);
    return;
  }

  this.timeout();
};
