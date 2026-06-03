// sail.js
// 3-minute sailing race start timer for eucWatch / P8 / P22
//
// Framework-compatible version:
// - proper face[1] redirect face
// - side button is the supported exit path
// - swipe ignored
// - stronger cleanup
// - guaranteed single timer loop
// - no accidental reset while running
// - after countdown finishes, auto-return to main after ~10 seconds
// - accel wake / raise-to-wake disabled while app is active
//   and restored on exit

var T = 180;   // total countdown seconds
var R = 180;   // remaining seconds
var A = 0;     // active/running flag
var S = 0;     // start timestamp

var I = -1;    // countdown show-loop timeout
var D = -1;    // post-finish delayed return timeout

var G = w.gfx;

var ignoreTapUntil = 0;

// ----------------------
// Accel wake control
// ----------------------

// Uploaded accel handlers show that raise-to-wake can directly call face.off()
// based on wrist orientation, so disable it while Sail is active
// and restore the user's normal accel setting on exit. 

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
// Cleanup
// ----------------------

function X() {

  // stop countdown loop
  if (I >= 0) {
    clearTimeout(I);
    I = -1;
  }

  // stop delayed auto-return
  if (D >= 0) {
    clearTimeout(D);
    D = -1;
  }

  A = 0;
}

// ----------------------
// Drawing
// ----------------------

function F() {

  var m = (R / 60) | 0;
  var s = R % 60;
  var t = m + ":" + ("0" + s).substr(-2);

  var W = (G.getWidth ? G.getWidth() : 240);
  var H = (G.getHeight ? G.getHeight() : 240);

  G.setColor(0, 0);
  G.fillRect(0, 0, W - 1, H - 1);

  // white UI
  G.setColor(1, 15);

  // main countdown
  G.setFont("Vector", 60);
  G.drawString(t, (W - G.stringWidth(t)) / 2, 70);

  // status
  G.setFont("Vector", 20);

  var status;
  if (A)
    status = "RUN";
  else if (R === 0)
    status = "DONE";
  else
    status = "TAP";

  G.drawString(status, (W - G.stringWidth(status)) / 2, 160);

  // hint
  G.setFont("Vector", 14);

  var hint;
  if (A)
    hint = "TIMER RUNNING";
  else if (R === 0)
    hint = "AUTO EXIT IN 10S";
  else
    hint = "TAP START  LONG RESET";

  G.drawString(hint, (W - G.stringWidth(hint)) / 2, 205);

  G.flip();
}

// ----------------------
// Buzzer helpers
// ----------------------

function B(x) {
  if (buzzer && buzzer.sys)
    buzzer.sys(x);
}

// Race countdown cues
function C() {

  if (R == 180) {
    B(700);
  } else if (R == 120) {
    B([180,120,180]);
  } else if (R == 60) {
    B(700);
  } else if (R == 30) {
    B(250);
  } else if (R <= 10 && R > 0) {
    B(120);
  } else if (R == 0) {
    B([800,250,800]);
  }
}

// Align updates to next second boundary
function N() {

  if (!A)
    return 1000;

  var e = Date.now() - S;
  var d = 1000 - (e % 1000);

  if (d < 20)
    d += 1000;

  return d + 5;
}

// ----------------------
// Face timeout policy
// ----------------------

function setIdleAwake() {
  face[0].offms = 300000;   // normal idle timeout
}

function setRunAwake() {
  face[0].offms = 86400000; // effectively no timeout while countdown is active
}

// ----------------------
// Lifecycle helpers
// ----------------------

function scheduleDoneExit() {

  if (D >= 0)
    clearTimeout(D);

  D = setTimeout(function () {

    D = -1;

    // Cleanly leave Sail and restore normal accel behavior
    X();
    resumeAccelWake();

    ignoreTapUntil = Date.now() + 500;

    face.go("clock", 0);

  }, 10000);
}

// ----------------------
// Timer controls
// ----------------------

function startTimer() {

  if (A)
    return;

  R = T;
  S = Date.now();
  A = 1;

  if (D >= 0) {
    clearTimeout(D);
    D = -1;
  }

  // Disable raise-to-wake while countdown is active
  suspendAccelWake();

  setRunAwake();

  C();
  F();

  // start countdown loop
  if (I >= 0)
    clearTimeout(I);

  I = setTimeout(function () {
    face[0].show();
  }, N());
}

function resetTimer() {

  // only allow reset while stopped
  if (A) {
    B(40);
    return;
  }

  R = T;

  if (D >= 0) {
    clearTimeout(D);
    D = -1;
  }

  setIdleAwake();

  B([100,50,80]);
  F();
}

// ----------------------
// eucWatch faces
// ----------------------

// Main Sail face (page 0)
face[0] = {

  offms: 300000,

  init: function () {

    // defensive cleanup
    X();

    // suspend accel wake while Sail is active
    suspendAccelWake();

    R = T;
    S = Date.now();
    ignoreTapUntil = 0;

    setIdleAwake();
    F();

    return 1;
  },

  show: function () {

    if (!A) {

      // no active countdown, no periodic loop needed
      if (I >= 0) {
        clearTimeout(I);
        I = -1;
      }

      return;
    }

    if (touchHandler.timeout)
      touchHandler.timeout();

    var n = T - ((Date.now() - S) / 1000 | 0);

    if (n < 0)
      n = 0;

    if (n != R) {
      R = n;
      C();
      F();
    }

    if (R == 0) {

      // countdown complete
      A = 0;

      // back to normal idle timeout
      setIdleAwake();

      // show DONE / 0:00 and then return to clock after 10s
      F();
      scheduleDoneExit();

      if (I >= 0) {
        clearTimeout(I);
        I = -1;
      }

      return;
    }

    // guarantee only one countdown loop exists
    if (I >= 0)
      clearTimeout(I);

    I = setTimeout(function () {
      face[0].show();
    }, N());
  },

  clear: function () {

    X();

    // restore user's normal accel behavior
    resumeAccelWake();

    return 1;
  },

  off: function () {

    X();

    // restore user's normal accel behavior
    resumeAccelWake();

    G.off();
  }
};

// Redirect face (page 1)
// handler_face.js routes page-0 non-clock off transitions into page 1,
// so page 1 must exist for clean lifecycle behavior. [1](https://amwater-my.sharepoint.com/personal/jesse_quadrel_amwater_com/Documents/Microsoft%20Copilot%20Chat%20Files/handler_charge.js)[2](https://amwater-my.sharepoint.com/personal/jesse_quadrel_amwater_com/Documents/Microsoft%20Copilot%20Chat%20Files/hello.js)[3](https://amwater-my.sharepoint.com/personal/jesse_quadrel_amwater_com/Documents/Microsoft%20Copilot%20Chat%20Files/dashGarage.js)
face[1] = {
  offms: 1000,

  init: function () {
    return 1;
  },

  show: function () {

    // Ensure everything is truly stopped
    X();
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
//
// e==5  tap
// e==12 long press
// e==1  swipe down
//
// Swipe is intentionally ignored.
// Side button is the supported exit path.

touchHandler[0] = function (e, x, y) {

  var now = Date.now();

  // ignore swipe for now
  if (e == 1) {
    this.timeout();
    return;
  }

  // long press reset
  if (e == 12) {

    resetTimer();

    // suppress follow-up tap
    ignoreTapUntil = now + 1200;

    this.timeout();
    return;
  }

  // tap start
  if (e == 5) {

    if (now < ignoreTapUntil) {
      this.timeout();
      return;
    }

    // start only if idle
    if (!A) {
      startTimer();
    } else {
      // optional tiny feedback when tap ignored
      B(40);
    }
  }

  this.timeout();
};
