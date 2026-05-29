// sail.js
// 3-minute sailing race start timer for eucWatch / P8 / P22
//
// Stability-focused version:
// - side button is the supported exit path
// - swipe ignored
// - stronger cleanup
// - guaranteed single timer loop
// - safer long-press behavior
// - no accidental reset while running
// - after countdown finishes, auto-timeout after ~10 seconds if untouched

var T = 180;   // total countdown seconds
var R = 180;   // remaining seconds
var A = 0;     // active/running flag
var S = 0;     // start timestamp
var I = -1;    // show loop timeout id

var G = w.gfx;

// suppress stray tap after long press
var ignoreTapUntil = 0;

// ----------------------
// Cleanup
// ----------------------

function X() {
  if (I >= 0) {
    clearTimeout(I);
    I = -1;
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

  // explicit background fill
  G.setColor(0, 0);
  G.fillRect(0, 0, W - 1, H - 1);

  // all-white display
  G.setColor(1, 15);

  G.setFont("Vector", 60);
  G.drawString(t, (W - G.stringWidth(t)) / 2, 70);

  G.setFont("Vector", 20);

  var status;
  if (A)
    status = "RUN";
  else if (R < T)
    status = "DONE";
  else
    status = "TAP";

  G.drawString(status, (W - G.stringWidth(status)) / 2, 160);

  G.setFont("Vector", 14);

  var hint;
  if (A)
    hint = "TIMER RUNNING";
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

// align updates to next second boundary
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
// Timer controls
// ----------------------

function setRunAwake() {
  // keep awake during countdown
  face[0].offms = 300000; // 5 min
}

function setDoneAwake() {
  // after finish, shut off quickly if untouched
  face[0].offms = 10000; // 10 sec
}

function setIdleAwake() {
  // before timer starts / after manual reset
  face[0].offms = 300000; // 5 min
}

function startTimer() {
  if (A)
    return;

  R = T;
  S = Date.now();
  A = 1;

  setRunAwake();

  C();
  F();
}

function resetTimer() {
  // only allow reset while stopped
  if (A) {
    B(40);
    return;
  }

  R = T;
  setIdleAwake();

  B([100,50,80]);
  F();
}

// ----------------------
// eucWatch face
// ----------------------

face[0] = {

  offms: 300000,

  init: function () {
    X();

    R = T;
    S = Date.now();
    ignoreTapUntil = 0;

    setIdleAwake();
    F();

    return 1;
  },

  show: function () {

    if (A) {

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
        A = 0;

        // after the gun, allow only ~10 seconds before auto-off
        setDoneAwake();

        // reset the inactivity timer starting NOW
        if (touchHandler.timeout)
          touchHandler.timeout();

        F();
      }
    }

    // guarantee only one loop exists
    if (I >= 0)
      clearTimeout(I);

    I = setTimeout(function () {
      face[0].show();
    }, N());
  },

  clear: function () {
    X();
    return 1;
  },

  off: function () {
    X();
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

    // only reset when stopped
    resetTimer();

    // suppress follow-up tap
    ignoreTapUntil = now + 1200;

    this.timeout();
    return;
  }

  // tap start
  if (e == 5) {

    // ignore synthetic tap after long press
    if (now < ignoreTapUntil) {
      this.timeout();
      return;
    }

    // start only if idle
    if (!A) {
      startTimer();
    } else {
      B(40);
    }
  }

  this.timeout();
};
