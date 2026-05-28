// sail
// 3-minute sailing race start timer for eucWatch/P8/P22

var T = 180;       // total countdown seconds
var R = 180;       // remaining seconds
var A = 0;         // active/running flag
var S = 0;         // start timestamp
var I = -1;        // show loop timeout id
var G = w.gfx;     // eucWatch graphics object

function F() {
  var m = R / 60 | 0;
  var s = R % 60;
  var t = m + ":" + ("0" + s).substr(-2);

  // Determine screen size (fallback to 240x240)
  var W = (G.getWidth ? G.getWidth() : 240);
  var H = (G.getHeight ? G.getHeight() : 240);

  // Explicit background fill (do NOT rely on G.clear())
  G.setColor(0, 0);
  G.fillRect(0, 0, W - 1, H - 1);

  // Foreground text
  G.setColor(1, 15);
  G.setFont("Vector", 60);
  G.drawString(t, (W - G.stringWidth(t)) / 2, 70);

  G.setFont("Vector", 20);
  var status = A ? "RUN" : "TAP";
  G.drawString(status, (W - G.stringWidth(status)) / 2, 160);

  G.flip();
}

function B(x) {
  if (buzzer && buzzer.sys) {
    buzzer.sys(x);
  }
}

function C() {
  if (R == 180) {
    B(700);
  } else if (R == 120) {
    B([180, 120, 180]);
  } else if (R == 60) {
    B(700);
  } else if (R == 30) {
    B(250);
  } else if (R <= 10 && R > 0) {
    B(120);
  } else if (R == 0) {
    B([800, 250, 800]);
  }
}

function N() {
  if (!A) return 1000;

  var e = Date.now() - S;
  var d = 1000 - (e % 1000);

  if (d < 20) d += 1000;

  return d + 5;
}

face[0] = {
  offms: 300000,

  init: function () {
    A = 0;
    R = T;
    S = Date.now();
    F();
    return 1;
  },

  show: function () {
    if (A) {
      if (touchHandler.timeout) touchHandler.timeout();

      var n = T - ((Date.now() - S) / 1000 | 0);

      if (n < 0) n = 0;

      if (n != R) {
        R = n;
        C();
        F();
      }

      if (R == 0) A = 0;
    }

    I = setTimeout(function () {
      face[0].show();
    }, N());
  },

  clear: function () {
    if (I >= 0) clearTimeout(I);
    I = -1;
    return 1;
  },

  off: function () {
    G.off();
    this.clear();
  }
};

touchHandler[0] = function (e, x, y) {
  if (e == 5) {
    // Tap: start if idle, reset if running
    if (A) {
      A = 0;
      R = T;
    } else {
      R = T;
      S = Date.now();
      A = 1;
      C();
    }

    F();
  } else if (e == 12) {
    // Long press: reset
    A = 0;
    R = T;
    F();
    B([100, 50, 80]);
  } else if (e == 1) {
    // Swipe down/back: return to main
    face.go("main", 0);
  }

  this.timeout();
};
