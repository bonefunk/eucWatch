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

  // stop timer loop
  if (I >= 0) {
    clearTimeout(I);
    I = -1;
  }

  // fully reset runtime state
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

  // main countdown
  G.setFont("Vector", 60);
  G.drawString(t, (W - G.stringWidth(t)) / 2, 70);

  // status line
  G.setFont("Vector", 20);

  var status;

  if (A)
    status = "RUN";
  else if (R < T)
    status = "DONE";
  else
    status = "TAP";

  G.drawString(status, (W - G.stringWidth(status)) / 2, 160);

  // hint line
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

// race countdown cues
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
// Stopwatch controls
// ----------------------

function startTimer() {

  if (A)
    return;

  R = T;
  S = Date.now();
  A = 1;

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

  B([100,50,80]);

  F();
}

// ----------------------
// eucWatch face
// ----------------------

face[0] = {

  offms: 300000,

  init: function () {

    // defensive cleanup
    X();

    R = T;
    S = Date.now();
    ignoreTapUntil = 0;

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

      if (R == 0)
        A = 0;
    }

    // ensure only one active timer loop exists
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

    G.off();

    X();
  }
};

// ----------------------
// Touch handling
// ----------------------
//
// eucWatch touch model follows the same general
// pattern used by calculator:
//
// e==5  tap
// e==12 long press
// e==1  swipe down
//
// Swipe is intentionally ignored here because
// swipe behavior was unreliable on this build

touchHandler[0] = function (e, x, y) {

  var now = Date.now();

  // ignore swipe for now
  // side button is the supported exit path
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

    // ignore synthetic tap after long press
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
