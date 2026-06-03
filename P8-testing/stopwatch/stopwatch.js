// stopwatch.js
// Cardio stopwatch with HRS3300 heart-rate (eucWatch / P8 / P22)
//
// This version includes:
// - H:MM:SS display
// - all-white text
// - side button is the supported exit path
// - swipe ignored
// - HR only while stopwatch is running
// - aggressive cleanup on exit
// - redraws synchronized to exact second boundaries
// - accel wake/raise-to-wake disabled while app is active
//   and restored on exit
// - proper face[1] redirect face for clean framework-compatible exits

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

// Sampling cadence
var HR_FS_MS = 40; // 25 Hz

// Plausible interval limits
var HR_MIN_IBI = 320;   // ~187 bpm max
var HR_MAX_IBI = 1500;  // 40 bpm min

// Updated EMA coefficients for a 25Hz (40ms) sample rate
var HR_BASELINE_ALPHA = 0.08;
var HR_SMOOTH_ALPHA   = 0.60;

// Beat acceptance
var HR_MIN_AMP = 20;

// RR handling
var HR_RR_BUF_N = 4;
var HR_RR_SPREAD_MAX = 1.35;

// Filter / detector state
var hrBaseline = 0;
var hrFilt = 0;
var hrAmpEma = 0;

var hrPrev2 = 0;
var hrPrev1 = 0;

var hrValley = 0;
var hrHaveValley = 0;

var hrLastBeat = 0;
var hrLastIBI = 850; // seed around 70 bpm
var hrLastReliableAt = 0;

// RR history
var hrRR = [];

// ----------------------
// Helpers
// ----------------------

function fmt(ms) {
  if (ms < 0) ms = 0;

  var total = (ms / 1000) | 0;

  var hh = ((total / 3600) | 0) % 10;
  var mm = ((total / 60) | 0) % 60;
  var ss = total % 60;

  return hh + ":" +
         (mm < 10 ? "0" : "") + mm + ":" +
         (ss < 10 ? "0" : "") + ss;
}

function updateAwake() {
  if (running)
    face[0].offms = 86400000; // 24h while running
  else
    face[0].offms = 600000;   // 10m while stopped
}

function nextSecondDelay() {
  if (!running)
    return 1000;

  var e = acc + (Date.now() - t0);
  var d = 1000 - (e % 1000);

  if (d < 20)
    d += 1000;

  return d + 5;
}

// ----------------------
// Accel wake control
// ----------------------

function suspendAccelWake() {
  if (typeof acc !== "undefined" && acc && acc.off)
    acc.off();
}

function resumeAccelWake() {
  if (typeof ew !== "undefined" &&
      ew.do &&
      ew.do.update &&
      ew.do.update.acc)
    ew.do.update.acc();
}

// ----------------------
// I2C / sensor access
// ----------------------

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

  var id = hrReadReg(bus, 0x00);
  if (id !== 0x21)
    return false;

  hrWriteReg(bus, 0x0C, 0x68); // PON + driver
  hrWriteReg(bus, 0x16, 0x66); // resolution
  hrWriteReg(bus, 0x17, 0x10); // gain
  hrWriteReg(bus, 0x01, 0xE8); // enable

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
  hrRaw = 0;

  hrBaseline = 0;
  hrFilt = 0;
  hrAmpEma = 0;

  hrPrev2 = 0;
  hrPrev1 = 0;

  hrValley = 0;
  hrHaveValley = 0;

  hrLastBeat = 0;
  hrLastIBI = 850;
  hrLastReliableAt = 0;

  hrRR = [];

  if (clearValue)
    hrBpm = null;
}

function hrPushRR(ibi) {
  hrRR.push(ibi);
  if (hrRR.length > HR_RR_BUF_N)
    hrRR.shift();
}

function median3(a, b, c) {
  if ((a <= b && b <= c) || (c <= b && b <= a)) return b;
  if ((b <= a && a <= c) || (c <= a && a <= b)) return a;
  return c;
}

function hrUpdateDisplayFromRR(now) {
  if (hrRR.length < 2)
    return;

  if (hrRR.length == 2) {
    var avg2 = (hrRR[0] + hrRR[1]) / 2;
    var bpm2 = 60000 / avg2;

    if (bpm2 >= 40 && bpm2 <= 200) {
      hrBpm = hrBpm ? ((0.80 * hrBpm) + (0.20 * bpm2)) : bpm2;
      hrBpm = hrBpm | 0;
      hrLastReliableAt = now;
    }
    return;
  }

  var min = hrRR[0];
  var max = hrRR[0];
  var sum = 0;
  var i;

  for (i = 0; i < hrRR.length; i++) {
    if (hrRR[i] < min) min = hrRR[i];
    if (hrRR[i] > max) max = hrRR[i];
    sum += hrRR[i];
  }

  if ((max / min) > HR_RR_SPREAD_MAX)
    return;

  var bpm;

  if (hrRR.length >= 3) {
    var n = hrRR.length;
    var med = median3(hrRR[n-1], hrRR[n-2], hrRR[n-3]);
    bpm = 60000 / med;
  } else {
    bpm = 60000 / (sum / hrRR.length);
  }

  if (bpm >= 40 && bpm <= 200) {
    hrBpm = hrBpm ? ((0.80 * hrBpm) + (0.20 * bpm)) : bpm;
    hrBpm = hrBpm | 0;
    hrLastReliableAt = now;
  }
}

// ----------------------
// HR processing
// ----------------------

function hrTick() {
  var bus = getBus();
  if (!bus || !hrOn)
    return;

  var raw = hrReadCH0(bus);
  hrRaw = raw;

  if (!hrBaseline) {
    hrBaseline = raw;
    hrFilt = 0;
    hrPrev2 = 0;
    hrPrev1 = 0;
    hrValley = 0;
    hrHaveValley = 1;
    hrAmpEma = HR_MIN_AMP * 2;
    return;
  }

  // 1) DC Removal (High-pass)
  hrBaseline = hrBaseline + HR_BASELINE_ALPHA * (raw - hrBaseline);
  var ac = raw - hrBaseline;

  // 2) Noise Removal (Low-pass)
  hrFilt = hrFilt + HR_SMOOTH_ALPHA * (ac - hrFilt);

  // 3) Decay expected amplitude so threshold can recover downward
  hrAmpEma *= 0.995;
  if (hrAmpEma < HR_MIN_AMP) hrAmpEma = HR_MIN_AMP;

  var now = Date.now();

  // Track valley continuously
  if (!hrHaveValley || hrFilt < hrValley) {
    hrValley = hrFilt;
    hrHaveValley = 1;
  }

  // Local peak detection
  if (hrPrev1 > hrPrev2 && hrPrev1 >= hrFilt) {

    var peak = hrPrev1;
    var amp = peak - hrValley;

    var dynAmpThr = Math.max(HR_MIN_AMP, hrAmpEma * 0.50);

    if (amp > dynAmpThr) {

      if (!hrLastBeat) {
        // First plausible beat primes detector
        hrLastBeat = now;
      } else {
        var ibi = now - hrLastBeat;

        // Dynamic refractory:
        // Require at least 60% of previous interval to skip dicrotic notch
        var minDynamicIBI = Math.max(HR_MIN_IBI, hrLastIBI * 0.60);

        if (ibi >= minDynamicIBI) {

          // Critical fix: resync beat timer even if this interval is too long for BPM use
          hrLastBeat = now;

          // Reset valley to prep for the next wave cycle
          hrValley = hrFilt;

          // Only use this interval for BPM if it is contiguous enough
          if (ibi <= HR_MAX_IBI) {
            hrLastIBI = ibi;

            // Clamp amplitude impact so a giant artifact doesn't permanently deafen threshold
            var safeAmp = Math.min(amp, hrAmpEma * 3);
            hrAmpEma = (hrAmpEma * 0.80) + (safeAmp * 0.20);

            hrPushRR(ibi);
            hrUpdateDisplayFromRR(now);
          }
        }
      }
    }
  }

  // Hold last BPM longer before blanking
  if (hrLastReliableAt && (now - hrLastReliableAt) > 15000) {
    hrBpm = null;
    hrRR = [];
    hrLastReliableAt = 0;
  }

  hrPrev2 = hrPrev1;
  hrPrev1 = hrFilt;
}

function hrStartLoop() {
  if (hrTickId)
    return;

  hrResetState(true);

  if (!hrEnable())
    return;

  hrTickId = setInterval(hrTick, HR_FS_MS);
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
  var elapsed = acc + (running ? (now - t0) : 0);

  var line1 = fmt(elapsed);
  var line2 = hrBpm ? ("HR " + hrBpm) : "HR --";
  var line3 = running ? "RUNNING" : "STOPPED";

  var combined = line1 + "\n" + line2 + "\n" + line3;

  if (!force && combined === lastLine)
    return;

  lastLine = combined;

  var W = (G.getWidth ? G.getWidth() : 240);
  var H = (G.getHeight ? G.getHeight() : 240);

  G.setColor(0, 0);
  G.fillRect(0, 0, W - 1, H - 1);

  G.setColor(1, 15);

  G.setFont("Vector", 46);
  G.drawString(line1, ((W - G.stringWidth(line1)) / 2) + 6, 72);

  G.setFont("Vector", 18);
  G.drawString(line3, (W - G.stringWidth(line3)) / 2, 135);

  G.setFont("Vector", 24);
  G.drawString(line2, (W - G.stringWidth(line2)) / 2, 165);

  G.setFont("Vector", 14);
  var hint = running ? "TAP: STOP  BTN: EXIT" : "TAP: START  LONG: RESET";
  G.drawString(hint, (W - G.stringWidth(hint)) / 2, 205);

  G.flip();
}

function drawLoop() {
  draw(false);

  if (drawTid)
    clearTimeout(drawTid);

  if (running) {
    drawTid = setTimeout(drawLoop, nextSecondDelay());
  } else {
    drawTid = 0;
  }
}

// ----------------------
// Cleanup
// ----------------------

function hardCleanup(clearHrValue) {
  if (drawTid) {
    clearTimeout(drawTid);
    drawTid = 0;
  }

  hrStopLoop(clearHrValue);

  running = 0;
  t0 = 0;
  acc = 0;

  hrResetState(clearHrValue);

  lastLine = "";
  ignoreTapUntil = Date.now() + 500;
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

  hrStartLoop();

  draw(true);
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

  hrStopLoop(false);

  draw(true);
}

function resetSW() {
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
// eucWatch faces
// ----------------------

// Main stopwatch face (page 0)
face[0] = {
  offms: 600000,

  init: function () {

    hardCleanup(true);

    // Disable accel wake while stopwatch is active
    suspendAccelWake();

    running = 0;
    acc = 0;
    t0 = 0;
    hrBpm = null;
    lastLine = "";
    ignoreTapUntil = 0;

    updateAwake();
    draw(true);

    return 1;
  },

  show: function () {
    if (running && touchHandler && touchHandler.timeout)
      touchHandler.timeout();

    return 1;
  },

  clear: function () {
    hardCleanup(true);

    // restore user's normal accel behavior
    resumeAccelWake();

    return 1;
  },

  off: function () {
    hardCleanup(true);

    // restore user's normal accel behavior
    resumeAccelWake();

    G.off();
  }
};

// Redirect face (page 1)
// handler_face.js routes page-0 non-clock off transitions into page 1,
// so page 1 must exist for clean lifecycle behavior.
face[1] = {
  offms: 1000,

  init: function () {
    return 1;
  },

  show: function () {

    // Ensure everything is truly stopped
    hardCleanup(true);
    resumeAccelWake();

    // Go to a known-good face
    face.go("clock", 0);

    return 1;
  },

  clear: function () {
    return 1;
  },

  off: function () {
    this.clear();
  }
};

// ----------------------
// Touch handling
// ----------------------

touchHandler[0] = function (e, x, y) {

  var now = Date.now();

  // swipe ignored for now
  if (e == 1) {
    this.timeout();
    return;
  }

  // long press reset
  if (e == 12) {
    resetSW();
    ignoreTapUntil = now + 1200;
    this.timeout();
    return;
  }

  // tap start/stop
  if (e == 5) {

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
