// stopwatch.js
// Cardio stopwatch with HRS3300 heart-rate (eucWatch / P8 / P22)
//
// This version includes:
// - H:MM:SS display (single-digit hours)
// - all-white text
// - side button is the supported exit path
// - swipe ignored for now
// - HR only while stopwatch is running
// - aggressive cleanup on exit
// - redraws synchronized to exact second boundaries
// - no redraw loop while stopped
// - Option A HR processing:
//   * slow EMA baseline removal
//   * short EMA smoothing
//   * valley-to-peak beat detection
//   * less strict RR gating so BPM actually displays

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

var hrBpm = null;      // displayed BPM
var hrRaw = 0;

// HRS3300 runs well at 25 Hz sampling cadence
var HR_FS_MS = 40; // 25 Hz

// Plausible interval limits
var HR_MIN_IBI = 300;   // ~200 bpm max
var HR_MAX_IBI = 1500;  // 40 bpm min

// EMA coefficients
var HR_BASELINE_ALPHA = 0.015;  // slow baseline tracking (~2–4 sec feel)
var HR_SMOOTH_ALPHA   = 0.35;   // short smoothing
var HR_AMP_ALPHA      = 0.12;   // envelope adaptation

// Beat acceptance
var HR_MIN_AMP = 18;
var HR_AMP_MUL = 0.85;
var HR_RR_BUF_N = 4;
var HR_RR_SPREAD_MAX = 1.60; // allow moderate variability

// Filter / detector state
var hrBaseline = 0;
var hrFilt = 0;
var hrAmpEma = 0;

var hrPrev2 = 0;
var hrPrev1 = 0;

var hrValley = 0;
var hrHaveValley = 0;

var hrLastBeat = 0;
var hrLastAcceptedPeak = 0;

// RR history
var hrRR = [];
var hrLastReliableAt = 0;

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

// Keep the watch awake while running, normal timeout while stopped
function updateAwake() {
  if (running)
    face[0].offms = 86400000; // 24h while running
  else
    face[0].offms = 600000;   // 10m while stopped
}

// Align redraws to exact second boundaries
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

// Use handler-provided i2c bus only
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

// CH0 raw sample assembly
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

  // Verified working config on your watch
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
  hrLastAcceptedPeak = 0;

  hrRR = [];
  hrLastReliableAt = 0;

  if (clearValue)
    hrBpm = null;
}

function hrPushRR(ibi) {

  hrRR.push(ibi);

  if (hrRR.length > HR_RR_BUF_N)
    hrRR.shift();
}

// Display BPM sooner and more reliably than the first strict Option A version
function hrUpdateDisplayFromRR() {

  if (hrRR.length < 2)
    return;

  // Show provisional BPM once we have 2 plausible intervals
  if (hrRR.length == 2) {

    var quickAvg = (hrRR[0] + hrRR[1]) / 2;
    var quickBpm = 60000 / quickAvg;

    if (quickBpm >= 40 && quickBpm <= 200) {
      hrBpm = hrBpm ? ((0.7 * hrBpm) + (0.3 * quickBpm)) : quickBpm;
      hrBpm = hrBpm | 0;
      hrLastReliableAt = Date.now();
    }

    return;
  }

  // With 3+ intervals, require only moderate consistency
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

  var avg = sum / hrRR.length;
  var bpm = 60000 / avg;

  if (bpm >= 40 && bpm <= 200) {
    hrBpm = hrBpm ? ((0.75 * hrBpm) + (0.25 * bpm)) : bpm;
    hrBpm = hrBpm | 0;
    hrLastReliableAt = Date.now();
  }
}

// ----------------------
// Option A HR processing
// ----------------------

function hrTick() {

  var bus = getBus();
  if (!bus || !hrOn)
    return;

  var raw = hrReadCH0(bus);
  hrRaw = raw;

  // initialize baseline on first sample
  if (!hrBaseline) {
    hrBaseline = raw;
    hrFilt = 0;
    hrPrev2 = 0;
    hrPrev1 = 0;
    hrValley = 0;
    hrHaveValley = 1;
    return;
  }

  // 1) Slow EMA baseline (DC/drift removal)
  hrBaseline = hrBaseline + HR_BASELINE_ALPHA * (raw - hrBaseline);

  // 2) Short smoothing EMA on AC component
  var ac = raw - hrBaseline;
  hrFilt = hrFilt + HR_SMOOTH_ALPHA * (ac - hrFilt);

  // 3) Adaptive amplitude estimate
  hrAmpEma = hrAmpEma + HR_AMP_ALPHA * (Math.abs(hrFilt) - hrAmpEma);

  var now = Date.now();

  // track local valley continuously
  if (!hrHaveValley || hrFilt < hrValley) {
    hrValley = hrFilt;
    hrHaveValley = 1;
  }

  // 3-point local peak test:
  // peak occurs at hrPrev1 if hrPrev1 > hrPrev2 and hrPrev1 >= hrFilt
  if (hrPrev1 > hrPrev2 && hrPrev1 >= hrFilt) {

    var peak = hrPrev1;
    var amp = peak - hrValley;
    var dynAmpThr = Math.max(HR_MIN_AMP, hrAmpEma * HR_AMP_MUL);

    // accept only if valley->peak amplitude is strong enough
    if (amp > dynAmpThr) {

      if (!hrLastBeat) {

        // first plausible beat primes the detector
        hrLastBeat = now;
        hrLastAcceptedPeak = peak;

      } else {

        var ibi = now - hrLastBeat;

        if (ibi >= HR_MIN_IBI && ibi <= HR_MAX_IBI) {
          hrLastBeat = now;
          hrLastAcceptedPeak = peak;

          hrPushRR(ibi);
          hrUpdateDisplayFromRR();

          // reset valley after accepted beat so next beat needs a fresh rise
          hrValley = hrFilt;
        }
      }
    }
  }

  // if we haven't had a reliable update in a while, blank the display
  if (hrLastReliableAt && (now - hrLastReliableAt) > 8000) {
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

  // all white text
  G.setColor(1, 15);

  // main time
  G.setFont("Vector", 46);
  G.drawString(line1, ((W - G.stringWidth(line1)) / 2) + 6, 72);

  // status
  G.setFont("Vector", 18);
  G.drawString(line3, (W - G.stringWidth(line3)) / 2, 135);

  // HR
  G.setFont("Vector", 24);
  G.drawString(line2, (W - G.stringWidth(line2)) / 2, 165);

  // hint
  G.setFont("Vector", 14);
  var hint = running ? "TAP: STOP  BTN: EXIT" : "TAP: START  LONG: RESET";
  G.drawString(hint, (W - G.stringWidth(hint)) / 2, 205);

  G.flip();
}

// redraw loop synchronized to second boundaries
function drawLoop() {

  draw(false);

  if (drawTid)
    clearTimeout(drawTid);

  // no redraw loop while stopped
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

  // HR only while timing
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

  // stop HR immediately when stopping
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
// eucWatch face
// ----------------------

face[0] = {
  offms: 600000,

  init: function () {

    hardCleanup(true);

    running = 0;
    acc = 0;
    t0 = 0;
    hrBpm = null;
    lastLine = "";
    ignoreTapUntil = 0;

    updateAwake();
    draw(true);

    // no draw loop until stopwatch starts
    return 1;
  },

  show: function () {

    // keep watch awake while running
    if (running && touchHandler && touchHandler.timeout)
      touchHandler.timeout();

    return 1;
  },

  clear: function () {
    hardCleanup(true);
    return 1;
  },

  off: function () {
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

  if (e == 1) {
    this.timeout();
    return;
  }

  if (e == 12) {
    resetSW();

    // suppress follow-up tap
    ignoreTapUntil = now + 1200;

    this.timeout();
    return;
  }

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
