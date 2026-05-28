// stopwatch.js
// Cardio stopwatch (with HR placeholder) for eucWatch/P8/P22

var G = w.gfx;
var running = 0;       // 0/1
var t0 = 0;            // start timestamp (ms)
var acc = 0;           // accumulated elapsed (ms) when paused
var tid = -1;          // show loop timer

// Optional: store last drawn values to reduce redraw work
var lastTxt = "";
var lastHr = "";

function fmt(ms) {
  // mm:ss.hh (hundredths)
  if (ms < 0) ms = 0;
  var cs = (ms / 10) | 0;            // centiseconds
  var ss = (cs / 100) | 0;
  cs = cs % 100;
  var mm = (ss / 60) | 0;
  ss = ss % 60;

  return (mm < 10 ? "0" : "") + mm + ":" +
         (ss < 10 ? "0" : "") + ss + "." +
         (cs < 10 ? "0" : "") + cs;
}

// --- Heart rate integration point ---
// For now we show “HR --”. Later we’ll replace getHR() with real sensor reads.
function getHR() {
  // Replace this once we know the HR API on your watch build.
  // Return a number (bpm) or null if unavailable.
  return null;
}

function draw(force) {
  var now = Date.now();
  var elapsed = acc + (running ? (now - t0) : 0);

  var txt = fmt(elapsed);

  // HR line
  var hr = getHR();
  var hrTxt = (hr === null || hr === undefined) ? "HR --" : ("HR " + hr);

  if (!force && txt === lastTxt && hrTxt === lastHr) return;
  lastTxt = txt;
  lastHr = hrTxt;

  // Background (do not rely on G.clear() behavior)
  var W = (G.getWidth ? G.getWidth() : 240);
  var H = (G.getHeight ? G.getHeight() : 240);
  G.setColor(0, 0);
  G.fillRect(0, 0, W - 1, H - 1);

  // Main time
  G.setColor(1, 15);
  G.setFont("Vector", 60);
  G.drawString(txt, (W - G.stringWidth(txt)) / 2, 65);

  // Status
  G.setFont("Vector", 18);
  var st = running ? "RUNNING" : "STOPPED";
  G.drawString(st, (W - G.stringWidth(st)) / 2, 135);

  // HR underneath
  G.setFont("Vector", 22);
  G.setColor(1, 14);
  G.drawString(hrTxt, (W - G.stringWidth(hrTxt)) / 2, 165);

  // Hint line
  G.setFont("Vector", 14);
  G.setColor(1, 13);
  var hint = running ? "TAP: STOP   LONG: RESET (when stopped)" : "TAP: START   LONG: RESET";
  G.drawString(hint, (W - G.stringWidth(hint)) / 2, 205);

  G.flip();
}

function loop() {
  // ~10 fps is plenty for hundredths without burning battery
  draw(false);

  tid = setTimeout(function () {
    tid = -1;
    loop();
  }, 100);
}

function start() {
  if (running) return;
  running = 1;
  t0 = Date.now();
  if (buzzer && buzzer.sys) buzzer.sys(80);
  draw(true);
}

function stop() {
  if (!running) return;
  acc += (Date.now() - t0);
  running = 0;
  if (buzzer && buzzer.sys) buzzer.sys([80, 120, 80]); // odd-length pattern, safe
  draw(true);
}

function resetSW() {
  // Only allow reset when not running (prevents accidental mid-session reset)
  if (running) {
    if (buzzer && buzzer.sys) buzzer.sys(40);
    return;
  }
  acc = 0;
  t0 = 0;
  if (buzzer && buzzer.sys) buzzer.sys([100, 50, 80]);
  draw(true);
}

face[0] = {
  offms: 600000, // 10 minutes

  init: function () {
    running = 0; acc = 0; t0 = 0;
    lastTxt = ""; lastHr = "";
    draw(true);
    loop();
    return 1;
  },

  show: function () {
    // The loop() is already handling redraw; leave show() minimal.
    // Still keep watch awake while running:
    if (running && touchHandler && touchHandler.timeout) touchHandler.timeout();
    return 1;
  },

  clear: function () {
    if (tid >= 0) clearTimeout(tid);
    tid = -1;
    return 1;
  },

  off: function () {
    G.off();
    this.clear();
  }
};

// Touch events: follow the same eucWatch touch-handler pattern as calc.
// e==5 tap, e==12 long press, e==1 swipe down/back, etc. [1](https://amwater-my.sharepoint.com/personal/jesse_quadrel_amwater_com).js)
touchHandler[0] = function (e, x, y) {
  if (e == 5) {
    // Tap: toggle start/stop
    if (running) stop();
    else start();
  } else if (e == 12) {
    // Long press: reset (only when stopped)
    resetSW();
  } else if (e == 1) {
    // Swipe down/back: exit to main
    face.go("main", 0);
    return;
  }

  this.timeout();
};
