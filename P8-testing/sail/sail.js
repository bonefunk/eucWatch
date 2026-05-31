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
// - after countdown finishes, auto-exit to main after ~10 seconds
//   instead of relying on face.offms auto-off

var T = 180;   // total countdown seconds
var R = 180;   // remaining seconds
var A = 0;     // active/running flag
var S = 0;     // start timestamp

var I = -1;    // show loop timeout id
var D = -1;    // post-finish auto-exit timeout id

var G = w.gfx;

// suppress stray tap after long press / exit
var ignoreTapUntil = 0;

// ----------------------
// Cleanup
// ----------------------

function X() {

  // stop main timer loop
  if (I >= 0) {
    clearTimeout(I);
    I = -1;
  }

  // stop post-finish auto-exit timer
  if (D >= 0) {
    clearTimeout(D);
    D = -1;
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
  G.set
