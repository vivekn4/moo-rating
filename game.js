// Moo Rating — a cow clicker about milking a herd until it revolts.
// Click a cow to make Milk. Click too fast and the herd remembers it.
// Every 45 seconds a herd event forces a choice. At 5,000 total Milk,
// the ending depends on the Moo Rating.
//
// The numbers never change for presentation: one state object, one render
// pass, one tick. Animation, particles and sound are layered on top.

(function () {
  "use strict";

  var canvas = document.getElementById("gameCanvas");
  var ctx = canvas.getContext("2d");

  var MILK_GOAL = 5000;
  var EVENT_INTERVAL = 45;
  var FAST_CLICK_LIMIT = 4; // clicks per second before the herd stresses

  var state = freshState();

  function freshState() {
    return {
      milk: 0,
      totalMilk: 0,
      rating: 60,
      cows: 1,
      milkerLevel: 1,
      gwendolynAnger: 0, // 0 calm .. 5 furious
      herdMemory: 0, // how much the cows remember being rushed; decays over time
      streak: 0, // consecutive calm clicks; display only
      clickTimes: [],
      eventCountdown: EVENT_INTERVAL,
      eventActive: false,
      gameOver: false,
      started: false,
      paused: false,
      muted: false,
      volume: loadVolume(),
      shakeUntil: 0,
      squashUntil: 0,
      blinkUntil: 0,
      nextBlinkAt: Date.now() + 2500,
      grazeUntil: 0,
      nextGrazeAt: Date.now() + 8000,
      mood: null, // { type: "happy" | "angry" | "sad", until: ms }
      bubble: null, // { text, until }
      flashUntil: 0,
      lastMilestone: 0,
      nextIdleMooAt: Date.now() + 15000,
      nextBirdAt: Date.now() + 9000,
      nextButterflyAt: Date.now() + 4000,
      floaters: [], // floating "+N Milk" texts
      particles: [], // milk, hearts, puffs, stars, rings, confetti, rain, drops
      butterflies: [],
      birds: [],
      clouds: [
        { x: 80, y: 48, s: 1.0, v: 6 },
        { x: 380, y: 34, s: 0.7, v: 9 },
        { x: 580, y: 62, s: 0.85, v: 7 }
      ],
      lastTick: Date.now()
    };
  }

  function loadVolume() {
    try {
      var v = parseFloat(localStorage.getItem("moo-rating-volume"));
      if (!isNaN(v) && v >= 0 && v <= 100) { return v; }
    } catch (e) { /* storage unavailable; use the default */ }
    return 70;
  }
  function saveVolume() {
    try { localStorage.setItem("moo-rating-volume", String(state.volume)); } catch (e) { /* ignore */ }
  }

  // --- Sprite loading -------------------------------------------------------
  // The cow sprite is optional: if assets/sprites/cow.png loads, it is drawn
  // at 200 x 150. If it is missing or fails to load, the procedural cow
  // drawn in code is used instead.
  var cowImage = new Image();
  var cowImageReady = false;
  cowImage.onload = function () { cowImageReady = true; };
  cowImage.onerror = function () { cowImageReady = false; };
  cowImage.src = "assets/sprites/cow.png";

  // --- Sound (Web Audio, synthesized — no audio files) ----------------------
  var audioCtx = null;
  var masterGain = null;
  var noiseBuffer = null;

  function ensureAudio() {
    if (state.muted) { return null; }
    try {
      var AC = (typeof AudioContext !== "undefined") ? AudioContext
        : (typeof webkitAudioContext !== "undefined") ? webkitAudioContext : null;
      if (!AC) { return null; }
      if (!audioCtx) {
        audioCtx = new AC();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = (state.volume / 100) * 0.9;
        masterGain.connect(audioCtx.destination);
        var len = Math.floor(audioCtx.sampleRate * 0.5);
        noiseBuffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
        var data = noiseBuffer.getChannelData(0);
        for (var i = 0; i < len; i++) { data[i] = Math.random() * 2 - 1; }
      }
      if (audioCtx.state === "suspended") { audioCtx.resume(); }
      return audioCtx;
    } catch (e) { return null; }
  }

  function applyVolume() {
    if (masterGain && audioCtx) {
      try { masterGain.gain.setTargetAtTime((state.volume / 100) * 0.9, audioCtx.currentTime, 0.02); } catch (e) { /* ignore */ }
    }
  }

  function tone(freqStart, freqEnd, duration, type, volume, delay) {
    var ac = ensureAudio();
    if (!ac) { return; }
    try {
      var t0 = ac.currentTime + (delay || 0);
      var osc = ac.createOscillator();
      var gain = ac.createGain();
      osc.type = type || "sine";
      osc.frequency.setValueAtTime(freqStart, t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + duration);
      gain.gain.setValueAtTime(volume || 0.08, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
      osc.connect(gain);
      gain.connect(masterGain);
      osc.start(t0);
      osc.stop(t0 + duration);
    } catch (e) { /* sound is decoration; never break the game */ }
  }

  function noiseBurst(duration, filterFreq, volume, delay) {
    var ac = ensureAudio();
    if (!ac || !noiseBuffer) { return; }
    try {
      var t0 = ac.currentTime + (delay || 0);
      var src = ac.createBufferSource();
      src.buffer = noiseBuffer;
      var filter = ac.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = filterFreq || 1200;
      filter.Q.value = 1.2;
      var gain = ac.createGain();
      gain.gain.setValueAtTime(volume || 0.08, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(masterGain);
      src.start(t0);
      src.stop(t0 + duration);
    } catch (e) { /* ignore */ }
  }

  function soundTick() { tone(900, 700, 0.05, "square", 0.03); }
  function soundPop() { tone(520, 760, 0.08, "square", 0.04); }
  function soundSquirt() { noiseBurst(0.22, 1800, 0.05); tone(300, 520, 0.12, "sine", 0.03); }
  function soundCoin() { tone(988, 988, 0.09, "sine", 0.06); tone(1319, 1319, 0.16, "sine", 0.06, 0.08); }
  function soundMunch() { noiseBurst(0.07, 700, 0.07); noiseBurst(0.07, 500, 0.07, 0.12); noiseBurst(0.09, 600, 0.06, 0.24); }
  function soundThud() { tone(120, 45, 0.18, "sine", 0.12); noiseBurst(0.1, 300, 0.06); }
  function soundBuzz() { tone(140, 70, 0.25, "sawtooth", 0.05); }

  function soundMoo() {
    // A proper moo: two detuned voices sliding down through a lowpass
    // filter, with a slow vibrato wobble — the closest a synth gets to a cow.
    var ac = ensureAudio();
    if (!ac) { return; }
    try {
      var t0 = ac.currentTime;
      var filter = ac.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(900, t0);
      filter.frequency.exponentialRampToValueAtTime(300, t0 + 0.6);
      filter.connect(masterGain);
      [0, 4].forEach(function (detune) {
        var osc = ac.createOscillator();
        var gain = ac.createGain();
        var lfo = ac.createOscillator();
        var lfoGain = ac.createGain();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(165 + detune, t0);
        osc.frequency.exponentialRampToValueAtTime(95, t0 + 0.6);
        lfo.type = "sine";
        lfo.frequency.value = 5.5;
        lfoGain.gain.value = 6;
        lfo.connect(lfoGain);
        lfoGain.connect(osc.frequency);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.05, t0 + 0.12);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.65);
        osc.connect(gain);
        gain.connect(filter);
        osc.start(t0);
        osc.stop(t0 + 0.7);
        lfo.start(t0);
        lfo.stop(t0 + 0.7);
      });
    } catch (e) { /* ignore */ }
  }

  function soundChime() { tone(660, 660, 0.12, "sine", 0.06); tone(880, 880, 0.18, "sine", 0.06, 0.11); }
  function soundSting() { tone(311, 311, 0.2, "triangle", 0.07); tone(233, 233, 0.3, "triangle", 0.07, 0.14); tone(466, 466, 0.12, "sine", 0.04, 0.28); }
  function soundHappy() { tone(523, 523, 0.1, "sine", 0.05); tone(659, 659, 0.1, "sine", 0.05, 0.09); tone(784, 784, 0.16, "sine", 0.05, 0.18); }
  function soundFanfare() {
    [523, 659, 784, 1047].forEach(function (f, i) { tone(f, f, 0.22, "triangle", 0.07, i * 0.12); });
    tone(1319, 1319, 0.4, "sine", 0.05, 0.5);
  }
  function soundSadTrombone() {
    [392, 370, 349, 311].forEach(function (f, i) { tone(f, f * 0.94, 0.32, "sawtooth", 0.045, i * 0.3); });
  }
  function soundChirp() {
    var base = 2200 + Math.random() * 1200;
    tone(base, base * 1.4, 0.09, "sine", 0.02);
    tone(base * 1.2, base * 0.9, 0.07, "sine", 0.015, 0.12);
  }

  // --- DOM helpers ----------------------------------------------------------
  function el(id) { return document.getElementById(id); }
  function setText(id, text) { el(id).textContent = text; }

  function log(message) {
    var box = el("log");
    var p = document.createElement("p");
    p.textContent = message;
    box.appendChild(p);
    while (box.children.length > 40) { box.removeChild(box.firstChild); }
    box.scrollTop = box.scrollHeight;
  }

  function showMessage(text) {
    setText("message", text);
  }

  function showBanner(text) {
    var banner = el("milestoneBanner");
    banner.textContent = text;
    banner.classList.add("show");
    setTimeout(function () { banner.classList.remove("show"); }, 2600);
  }

  // --- Derived values -------------------------------------------------------
  function milkPerClick() {
    var base = state.milkerLevel * state.cows;
    // The cows remember: a stressed herd gives less milk per click.
    var memoryPenalty = Math.min(0.5, state.herdMemory * 0.05);
    return Math.max(1, Math.round(base * (1 - memoryPenalty)));
  }

  function milkerCost() { return 100 * state.milkerLevel; }
  function cowCost() { return 150 * state.cows; }
  function feedCost() { return 40; }

  function gwendolynMood() {
    if (state.gwendolynAnger <= 0) { return "Calm"; }
    if (state.gwendolynAnger === 1) { return "Annoyed"; }
    if (state.gwendolynAnger === 2) { return "Cross"; }
    if (state.gwendolynAnger === 3) { return "Angry"; }
    return "Furious";
  }

  function setMood(type, ms) {
    state.mood = { type: type, until: Date.now() + ms };
  }

  function changeRating(amount) {
    state.rating = Math.max(0, Math.min(100, state.rating + amount));
    if (state.rating === 0) {
      showMessage("The herd has revolted! Feed them to calm things down.");
      log("The herd has revolted — the cows refuse to be milked until they are fed.");
      soundBuzz();
    }
  }

  function checkMilestones() {
    var reached = Math.floor(state.totalMilk / 1000);
    if (reached > state.lastMilestone && reached < 5) {
      state.lastMilestone = reached;
      showBanner("🎉 " + (reached * 1000).toLocaleString("en-US") + " Milk! The herd is on a roll.");
      spawnParticles(360, 120, "star", 16);
      soundFanfare();
      log("Milestone: " + (reached * 1000).toLocaleString("en-US") + " total Milk!");
    }
  }

  // --- Particles ------------------------------------------------------------
  function spawnParticles(x, y, type, count) {
    for (var i = 0; i < count; i++) {
      state.particles.push({
        x: x + (Math.random() - 0.5) * 40,
        y: y + (Math.random() - 0.5) * 20,
        vx: (Math.random() - 0.5) * 60,
        vy: type === "heart" ? -45 - Math.random() * 25 : type === "confetti" ? 20 + Math.random() * 40 : type === "rain" ? 320 : -20 - Math.random() * 60,
        life: 1,
        decay: type === "confetti" || type === "rain" ? 0.35 : 0.9 + Math.random() * 0.7,
        size: 4 + Math.random() * 5,
        type: type,
        color: ["#ff6b9d", "#ffd25e", "#7ec8ff", "#9dff6b", "#c9a7eb"][Math.floor(Math.random() * 5)],
        spin: (Math.random() - 0.5) * 8
      });
    }
    if (state.particles.length > 220) { state.particles.splice(0, state.particles.length - 220); }
  }

  function spawnRing(x, y) {
    state.particles.push({ x: x, y: y, vx: 0, vy: 0, life: 1, decay: 2.2, size: 6, type: "ring", color: "#fff", spin: 0 });
  }

  function spawnStream(x, y) {
    // A milk stream arcing from the udder down into the bucket.
    for (var i = 0; i < 7; i++) {
      state.particles.push({
        x: x + (Math.random() - 0.5) * 8,
        y: y + (Math.random() - 0.5) * 6,
        vx: 55 + Math.random() * 35,
        vy: 30 + Math.random() * 30,
        life: 1,
        decay: 2.4,
        size: 3 + Math.random() * 2.5,
        type: "drop",
        color: "#fff",
        spin: 0
      });
    }
  }

  // --- Colour helpers ---------------------------------------------------------
  function lerpColor(c1, c2, k) {
    var r = Math.round(c1[0] + (c2[0] - c1[0]) * k);
    var g = Math.round(c1[1] + (c2[1] - c1[1]) * k);
    var b = Math.round(c1[2] + (c2[2] - c1[2]) * k);
    return "rgb(" + r + "," + g + "," + b + ")";
  }

  // --- Rendering ------------------------------------------------------------
  function drawBackground(t) {
    // Day cycle: the sky warms toward sunset as the season nears 5,000 Milk.
    var p = Math.min(1, state.totalMilk / MILK_GOAL);
    var skyTop = lerpColor([142, 207, 238], [255, 179, 107], p);
    var skyLow = lerpColor([168, 216, 168], [255, 205, 140], p);
    ctx.fillStyle = skyTop;
    ctx.fillRect(0, 0, canvas.width, 190);
    ctx.fillStyle = skyLow;
    ctx.fillRect(0, 190, canvas.width, 60);
    ctx.fillStyle = lerpColor([111, 175, 94], [146, 138, 74], p);
    ctx.fillRect(0, 250, canvas.width, 170);

    // Sun arcs across the sky and turns orange by evening.
    var sunX = 90 + p * 540;
    var sunY = 95 - Math.sin(p * Math.PI) * 45;
    ctx.strokeStyle = "rgba(255, 223, 107, 0.7)";
    ctx.lineWidth = 3;
    for (var r = 0; r < 8; r++) {
      var a = (r / 8) * Math.PI * 2 + t * 0.0001;
      ctx.beginPath();
      ctx.moveTo(sunX + Math.cos(a) * 38, sunY + Math.sin(a) * 38);
      ctx.lineTo(sunX + Math.cos(a) * 50, sunY + Math.sin(a) * 50);
      ctx.stroke();
    }
    ctx.fillStyle = lerpColor([255, 223, 107], [255, 150, 80], p);
    ctx.beginPath();
    ctx.arc(sunX, sunY, 32, 0, Math.PI * 2);
    ctx.fill();

    // Drifting clouds.
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    for (var i = 0; i < state.clouds.length; i++) {
      var c = state.clouds[i];
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, 55 * c.s, 18 * c.s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(c.x + 30 * c.s, c.y + 4, 38 * c.s, 14 * c.s, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Birds crossing the sky.
    ctx.strokeStyle = "#3a3a3a";
    ctx.lineWidth = 2;
    for (var b = 0; b < state.birds.length; b++) {
      var bird = state.birds[b];
      var flap = Math.sin(t * 0.02 + b * 3) * 5;
      ctx.beginPath();
      ctx.moveTo(bird.x - 9, bird.y + flap);
      ctx.quadraticCurveTo(bird.x, bird.y - 4 - flap, bird.x + 9, bird.y + flap);
      ctx.stroke();
    }

    // Distant hills.
    ctx.fillStyle = lerpColor([127, 176, 105], [150, 140, 90], p);
    ctx.beginPath();
    ctx.ellipse(120, 252, 190, 42, 0, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = lerpColor([138, 181, 115], [158, 148, 98], p);
    ctx.beginPath();
    ctx.ellipse(560, 252, 230, 48, 0, Math.PI, 0);
    ctx.fill();

    // Red barn, left edge.
    ctx.fillStyle = "#a93226";
    ctx.fillRect(8, 168, 92, 82);
    ctx.fillStyle = "#7b241c";
    ctx.beginPath();
    ctx.moveTo(0, 170);
    ctx.lineTo(54, 128);
    ctx.lineTo(108, 170);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#fdf6e3";
    ctx.fillRect(38, 205, 32, 45);
    ctx.strokeStyle = "#7b241c";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(38, 205);
    ctx.lineTo(70, 250);
    ctx.moveTo(70, 205);
    ctx.lineTo(38, 250);
    ctx.stroke();
    ctx.fillStyle = "#fdf6e3";
    ctx.fillRect(20, 182, 16, 14);
    ctx.fillRect(74, 182, 16, 14);

    // Fence.
    ctx.fillStyle = "#8b5a2b";
    ctx.fillRect(0, 250, canvas.width, 6);
    ctx.fillRect(0, 278, canvas.width, 6);
    for (var fx = 30; fx < canvas.width; fx += 120) {
      ctx.fillRect(fx, 238, 10, 62);
    }

    // Butterflies.
    for (var bf = 0; bf < state.butterflies.length; bf++) {
      var bu = state.butterflies[bf];
      var flap = Math.sin(t * 0.03 + bu.phase) * 0.9;
      ctx.save();
      ctx.translate(bu.x, bu.y);
      ctx.fillStyle = bu.color;
      ctx.beginPath();
      ctx.ellipse(-4, -flap * 3, 5, 7, -0.4 - flap * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(4, flap * 3, 5, 7, 0.4 + flap * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Swaying grass tufts and flowers.
    for (var g = 0; g < 14; g++) {
      var gx = 20 + g * 50 + Math.sin(t * 0.001 + g) * 3;
      var gy = 315 + (g % 3) * 32;
      ctx.strokeStyle = "#3e7a32";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.quadraticCurveTo(gx + Math.sin(t * 0.001 + g) * 4, gy - 10, gx + 3, gy - 16);
      ctx.stroke();
      if (g % 4 === 0) {
        ctx.fillStyle = ["#ff8fb3", "#ffd25e", "#c9a7eb"][g % 3];
        ctx.beginPath();
        ctx.arc(gx + 3, gy - 19, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawBucket() {
    // The milk bucket under Gwendolyn: its fill shows the Milk on hand.
    var bx = 392, by = 238, bw = 52, bh = 38;
    var fill = Math.max(0, Math.min(1, state.milk / 150));
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.beginPath();
    ctx.ellipse(bx + bw / 2, by + bh + 2, bw / 2 + 4, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#9aa5ad";
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + bw, by);
    ctx.lineTo(bx + bw - 6, by + bh);
    ctx.lineTo(bx + 6, by + bh);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#7d8891";
    ctx.fillRect(bx, by, bw, 5);
    if (fill > 0.02) {
      var milkH = (bh - 8) * fill;
      ctx.fillStyle = "#fff";
      ctx.fillRect(bx + 4, by + bh - 4 - milkH, bw - 8, milkH);
      ctx.fillStyle = "#dff2ff";
      ctx.fillRect(bx + 4, by + bh - 4 - milkH, bw - 8, 3);
    }
    ctx.strokeStyle = "#5d6b73";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + bw, by);
    ctx.lineTo(bx + bw - 6, by + bh);
    ctx.lineTo(bx + 6, by + bh);
    ctx.closePath();
    ctx.stroke();
  }

  function drawProceduralCow(x, y, w, h, withBow, t, grazing) {
    var s = w / 200; // scale relative to the 200 x 150 drawing
    var blink = Date.now() < state.blinkUntil;
    var chew = Math.sin(t * 0.004) * 2;
    var grazeDrop = grazing ? 26 : 0;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);

    // Soft shadow.
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    ctx.beginPath();
    ctx.ellipse(100, 146, 88, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    // Legs with shading.
    ctx.fillStyle = "#e8e8e8";
    ctx.fillRect(30, 105, 16, 35);
    ctx.fillRect(70, 105, 16, 35);
    ctx.fillRect(125, 105, 16, 35);
    ctx.fillRect(160, 105, 16, 35);
    ctx.fillStyle = "#333";
    ctx.fillRect(30, 135, 16, 6);
    ctx.fillRect(70, 135, 16, 6);
    ctx.fillRect(125, 135, 16, 6);
    ctx.fillRect(160, 135, 16, 6);

    // Tail, swishing.
    var tailSway = Math.sin(t * 0.003) * 8;
    ctx.strokeStyle = "#f5f5f5";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(12, 45);
    ctx.quadraticCurveTo(2 + tailSway, 80, 10 + tailSway, 105);
    ctx.stroke();
    ctx.fillStyle = "#333";
    ctx.beginPath();
    ctx.arc(10 + tailSway, 108, 7, 0, Math.PI * 2);
    ctx.fill();

    // Body with a soft belly shade.
    ctx.fillStyle = "#f5f5f5";
    ctx.beginPath();
    ctx.ellipse(100, 75, 92, 52, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.06)";
    ctx.beginPath();
    ctx.ellipse(100, 105, 70, 20, 0, 0, Math.PI * 2);
    ctx.fill();

    // Spots.
    ctx.fillStyle = "#222";
    ctx.beginPath();
    ctx.ellipse(70, 60, 22, 15, 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(125, 90, 18, 12, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(45, 92, 12, 9, 0, 0, Math.PI * 2);
    ctx.fill();

    // Udder.
    ctx.fillStyle = "#f2a5b7";
    ctx.beginPath();
    ctx.ellipse(100, 118, 26, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#d97b92";
    ctx.fillRect(88, 122, 5, 8);
    ctx.fillRect(98, 124, 5, 8);
    ctx.fillRect(108, 122, 5, 8);

    // Head group: drops down to the grass while grazing.
    ctx.save();
    ctx.translate(0, grazeDrop);
    ctx.rotate(grazing ? 0.18 : 0);

    // Head.
    ctx.fillStyle = "#f5f5f5";
    ctx.beginPath();
    ctx.ellipse(188, 45, 30, 34, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#222";
    ctx.beginPath();
    ctx.ellipse(172, 26, 9, 6, -0.4, 0, Math.PI * 2);
    ctx.fill();

    // Horns.
    ctx.fillStyle = "#e8d9a8";
    ctx.beginPath();
    ctx.moveTo(172, 18);
    ctx.lineTo(164, 2);
    ctx.lineTo(178, 10);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(198, 16);
    ctx.lineTo(206, 0);
    ctx.lineTo(210, 16);
    ctx.closePath();
    ctx.fill();

    // Ears (right ear flicks now and then).
    var flick = (Math.sin(t * 0.0013) > 0.96) ? -6 : 0;
    ctx.fillStyle = "#f5f5f5";
    ctx.beginPath();
    ctx.ellipse(160, 38, 12, 7, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(214, 36 + flick, 12, 7, 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f2a5b7";
    ctx.beginPath();
    ctx.ellipse(160, 38, 6, 3.5, -0.5, 0, Math.PI * 2);
    ctx.fill();

    // Muzzle, chewing.
    ctx.fillStyle = "#f2a5b7";
    ctx.beginPath();
    ctx.ellipse(192, 62 + chew, 20, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#333";
    ctx.beginPath();
    ctx.arc(185, 60 + chew, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(199, 60 + chew, 3, 0, Math.PI * 2);
    ctx.fill();

    // Eyes (wide when the herd is stressed, closed when blinking).
    ctx.fillStyle = "#111";
    if (blink) {
      ctx.fillRect(174, 37, 8, 2);
      ctx.fillRect(194, 35, 8, 2);
    } else {
      ctx.beginPath();
      ctx.arc(178, 38, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(198, 36, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(179, 36, 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(199, 34, 1.5, 0, Math.PI * 2);
      ctx.fill();
      // Lashes.
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(174, 34);
      ctx.lineTo(172, 31);
      ctx.moveTo(178, 33);
      ctx.lineTo(178, 30);
      ctx.stroke();
    }

    if (withBow) {
      // Gwendolyn's red bow, between the ears.
      ctx.fillStyle = "#c0392b";
      ctx.beginPath();
      ctx.moveTo(186, 14);
      ctx.lineTo(172, 6);
      ctx.lineTo(172, 22);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(188, 14);
      ctx.lineTo(202, 6);
      ctx.lineTo(202, 22);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(187, 14, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore(); // head group

    ctx.restore();
  }

  function drawCow(x, y, w, h, withBow, flip, t, grazing) {
    // Squash-and-stretch right after a click, idle bob otherwise.
    // A happy cow bounces a little higher; a sad one barely moves.
    var now = Date.now();
    var squash = 1;
    if (now < state.squashUntil) {
      var k = (state.squashUntil - now) / 150;
      squash = 1 - 0.12 * k;
    }
    var moodAmp = 1;
    if (state.mood && now < state.mood.until) {
      if (state.mood.type === "happy") { moodAmp = 1.8; }
      if (state.mood.type === "sad") { moodAmp = 0.4; }
    }
    var bob = Math.sin(t * 0.002) * 3 * moodAmp;
    var drawY = y + bob + (h * (1 - squash));

    ctx.save();
    if (flip) {
      ctx.translate(x + w, drawY);
      ctx.scale(-1, squash);
      if (cowImageReady) {
        ctx.drawImage(cowImage, 0, 0, w, h);
      } else {
        drawProceduralCow(0, 0, w, h, withBow, t, grazing);
      }
    } else {
      ctx.translate(x, drawY);
      ctx.scale(1, squash);
      if (grazing && cowImageReady) {
        // The sprite can't lower its head, so it dips and tilts to graze.
        ctx.translate(w / 2, h);
        ctx.rotate(0.1);
        ctx.translate(-w / 2, -h + 10);
      }
      if (cowImageReady) {
        ctx.drawImage(cowImage, 0, 0, w, h);
      } else {
        drawProceduralCow(0, 0, w, h, withBow, t, grazing);
      }
      if (withBow && cowImageReady) {
        // Bow on the sprite cow, near the head (top right of the image).
        ctx.fillStyle = "#c0392b";
        var bx = w * 0.86, by = h * 0.08;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx - 12, by - 6);
        ctx.lineTo(bx - 12, by + 6);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + 12, by - 6);
        ctx.lineTo(bx + 12, by + 6);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.arc(bx, by, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawBubble() {
    if (!state.bubble || Date.now() >= state.bubble.until) { return; }
    var text = state.bubble.text;
    ctx.font = "bold 15px Georgia, serif";
    var tw = 0;
    try { tw = ctx.measureText(text).width; } catch (e) { tw = text.length * 8; }
    var bx = 470, by = 48, bw = tw + 24, bh = 32;
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#6b4226";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bx + 8, by);
    ctx.lineTo(bx + bw - 8, by);
    ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + 8);
    ctx.lineTo(bx + bw, by + bh - 8);
    ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - 8, by + bh);
    ctx.lineTo(bx + 30, by + bh);
    ctx.lineTo(bx + 18, by + bh + 12);
    ctx.lineTo(bx + 18, by + bh);
    ctx.lineTo(bx + 8, by + bh);
    ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - 8);
    ctx.lineTo(bx, by + 8);
    ctx.quadraticCurveTo(bx, by, bx + 8, by);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#4a2c14";
    ctx.textAlign = "center";
    ctx.fillText(text, bx + bw / 2, by + 21);
  }

  function drawParticles(dt) {
    for (var i = state.particles.length - 1; i >= 0; i--) {
      var p = state.particles[i];
      if (p.type === "confetti") {
        p.vy += 60 * dt;
        p.x += (p.vx + Math.sin(Date.now() * 0.004 + i) * 30) * dt;
        p.y += p.vy * dt;
      } else if (p.type === "rain") {
        p.y += p.vy * dt;
        p.x += p.vx * dt;
      } else {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += (p.type === "drop" ? 500 : 30) * dt;
      }
      p.life -= p.decay * dt;
      if (p.life <= 0 || p.y > canvas.height + 20) { state.particles.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      if (p.type === "milk" || p.type === "drop") {
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#bfe3ff";
        ctx.beginPath();
        ctx.arc(p.x - 1, p.y - 1, p.size * 0.5, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.type === "heart") {
        ctx.fillStyle = "#ff6b9d";
        ctx.font = p.size * 3 + "px Georgia, serif";
        ctx.textAlign = "center";
        ctx.fillText("♥", p.x, p.y);
      } else if (p.type === "puff") {
        ctx.fillStyle = "#999";
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 1.4, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.type === "star") {
        ctx.fillStyle = "#ffd25e";
        ctx.font = p.size * 3 + "px Georgia, serif";
        ctx.textAlign = "center";
        ctx.fillText("★", p.x, p.y);
      } else if (p.type === "ring") {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size + (1 - p.life) * 46, 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.type === "confetti") {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin * (1 - p.life));
        ctx.fillStyle = p.color;
        ctx.fillRect(-4, -2, 8, 5);
        ctx.restore();
      } else if (p.type === "rain") {
        ctx.strokeStyle = "rgba(120,160,220,0.8)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - 3, p.y + 14);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawScene(t, dt) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawBackground(t);

    // Shake when the herd is stressed.
    var shakeX = 0, shakeY = 0;
    if (Date.now() < state.shakeUntil) {
      shakeX = (Math.random() - 0.5) * 10;
      shakeY = (Math.random() - 0.5) * 6;
    }

    var grazing = Date.now() < state.grazeUntil;

    // Main cow: the one you click. Gwendolyn wears the bow.
    drawCow(260 + shakeX, 95 + shakeY, 200, 150, true, false, t, grazing);
    ctx.fillStyle = "#4a2c14";
    ctx.font = "bold 15px Georgia, serif";
    ctx.textAlign = "center";
    ctx.fillText("Gwendolyn", 360 + shakeX, 265 + shakeY);

    // The milk bucket under Gwendolyn.
    drawBucket();

    // The rest of the herd, one small cow per extra cow.
    for (var i = 1; i < state.cows; i++) {
      var hx = 60 + ((i - 1) % 4) * 160;
      var hy = 310 + Math.floor((i - 1) / 4) * 10;
      drawCow(hx, hy, 120, 90, false, i % 2 === 0, t + i * 700, false);
    }

    drawParticles(dt);
    drawBubble();

    // Floating "+N Milk" texts.
    ctx.textAlign = "center";
    for (var f = 0; f < state.floaters.length; f++) {
      var fl = state.floaters[f];
      ctx.globalAlpha = Math.max(0, fl.life);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 20px Georgia, serif";
      ctx.fillText(fl.text, fl.x, fl.y);
      ctx.fillStyle = "#2e5d34";
      ctx.font = "bold 18px Georgia, serif";
      ctx.fillText(fl.text, fl.x, fl.y);
    }
    ctx.globalAlpha = 1;

    // Screen flash on herd events.
    if (Date.now() < state.flashUntil) {
      ctx.fillStyle = "rgba(255,255,255," + ((state.flashUntil - Date.now()) / 300 * 0.3) + ")";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Low-rating warning: the edges of the world pulse red.
    if (state.started && !state.gameOver && state.rating < 35) {
      var pulse = 0.10 + 0.08 * Math.sin(t * 0.006);
      ctx.fillStyle = "rgba(220,40,40," + pulse + ")";
      ctx.fillRect(0, 0, canvas.width, 14);
      ctx.fillRect(0, canvas.height - 14, canvas.width, 14);
      ctx.fillRect(0, 0, 14, canvas.height);
      ctx.fillRect(canvas.width - 14, 0, 14, canvas.height);
    }

    // Paused veil.
    if (state.paused) {
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 30px Georgia, serif";
      ctx.textAlign = "center";
      ctx.fillText("Paused", canvas.width / 2, canvas.height / 2);
      ctx.font = "16px Georgia, serif";
      ctx.fillText("Press P or Resume to keep milking", canvas.width / 2, canvas.height / 2 + 30);
    }
  }

  function updateStats() {
    setText("milk", Math.floor(state.milk));
    setText("totalMilk", Math.floor(state.totalMilk));
    setText("rating", state.rating);
    var bar = el("ratingBarInner");
    bar.style.width = state.rating + "%";
    bar.style.background = state.rating >= 60 ? "#4caf50" : state.rating >= 35 ? "#ff9800" : "#f44336";
    setText("cows", state.cows);
    setText("milker", "Lv " + state.milkerLevel);
    setText("gwendolyn", gwendolynMood() + (state.herdMemory > 0 ? " (remembers " + state.herdMemory + ")" : ""));
    setText("streak", state.streak);
    setText("eventTimer", state.eventActive ? "now!" : Math.ceil(state.eventCountdown) + "s");
    el("eventBarFill").style.width = state.eventActive ? "0%" : Math.max(0, (state.eventCountdown / EVENT_INTERVAL) * 100) + "%";
    el("progressFill").style.width = Math.min(100, (state.totalMilk / MILK_GOAL) * 100) + "%";
    setText("progressText", Math.floor(state.totalMilk) + " / " + MILK_GOAL);
    el("buyMilker").textContent = "Better Milker — " + milkerCost() + " Milk (Lv " + (state.milkerLevel + 1) + ")";
    el("buyCow").textContent = "Add a Cow — " + cowCost() + " Milk (" + state.cows + " → " + (state.cows + 1) + ")";
    el("buyCow").disabled = state.cows >= 8;
    el("feedHerd").textContent = "Feed the Herd — " + feedCost() + " Milk (+12 Rating)";
    el("buyMilker").disabled = state.milk < milkerCost();
    el("buyCow").disabled = state.cows >= 8 || state.milk < cowCost();
    el("feedHerd").disabled = state.milk < feedCost();
    el("pauseButton").textContent = state.paused ? "▶ Resume" : "⏸ Pause";
    el("muteButton").textContent = state.muted ? "🔇 Muted" : "🔊 Sound on";
    var slider = el("volumeSlider");
    if (slider && String(slider.value) !== String(state.volume)) { slider.value = state.volume; }
  }

  // --- Clicking ----------------------------------------------------------------
  function cowHitZones() {
    var zones = [{ x: 260, y: 95, w: 200, h: 150 }];
    for (var i = 1; i < state.cows; i++) {
      zones.push({
        x: 60 + ((i - 1) % 4) * 160,
        y: 310 + Math.floor((i - 1) / 4) * 10,
        w: 120, h: 90
      });
    }
    return zones;
  }

  function milkAt(clientX, clientY) {
    if (!state.started || state.paused || state.gameOver || state.eventActive) { return; }
    var rect = canvas.getBoundingClientRect();
    var scaleX = canvas.width / rect.width;
    var scaleY = canvas.height / rect.height;
    var x = (clientX - rect.left) * scaleX;
    var y = (clientY - rect.top) * scaleY;

    var hit = null;
    var zones = cowHitZones();
    for (var i = 0; i < zones.length; i++) {
      var z = zones[i];
      if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) { hit = z; break; }
    }
    if (!hit) { return; }

    if (state.rating === 0) {
      showMessage("The herd has revolted! Feed them before milking again.");
      return;
    }

    var now = Date.now();
    state.clickTimes.push(now);
    state.clickTimes = state.clickTimes.filter(function (t) { return now - t < 1000; });

    // A little buzz on the phone, if it supports it.
    try { if (typeof navigator !== "undefined" && navigator.vibrate) { navigator.vibrate(8); } } catch (e) { /* ignore */ }

    if (state.clickTimes.length > FAST_CLICK_LIMIT) {
      // Too fast: the herd stresses, the rating drops, and the cows remember.
      changeRating(-1);
      state.herdMemory = Math.min(10, state.herdMemory + 1);
      state.streak = 0;
      state.shakeUntil = now + 300;
      setMood("angry", 1200);
      spawnParticles(hit.x + hit.w / 2, hit.y + 20, "puff", 5);
      spawnParticles(hit.x + hit.w / 2, hit.y + hit.h, "puff", 3);
      soundBuzz();
      showMessage("Too fast! The herd is stressed — the cows remember this.");
      if (state.herdMemory === 5) {
        log("The cows are keeping count. Slow down, or every click will earn less.");
      }
    } else {
      state.streak += 1;
    }

    var gained = milkPerClick();
    state.milk += gained;
    state.totalMilk += gained;
    state.floaters.push({ x: hit.x + hit.w / 2, y: hit.y + 10, text: "+" + gained + " Milk", life: 1 });
    spawnParticles(hit.x + hit.w / 2, hit.y + hit.h - 10, "milk", 6);
    spawnRing(x, y);
    // Milk streams from the udder into the bucket on main-cow clicks.
    if (hit.x === 260) { spawnStream(365, 225); }
    state.squashUntil = now + 150;
    soundPop();
    soundSquirt();
    if (state.streak > 0 && state.streak % 25 === 0) {
      log(state.streak + " calm clicks in a row. Gwendolyn approves of this pace.");
      state.bubble = { text: "Moo-velous pace!", until: now + 1800 };
    }

    updateStats();
    checkMilestones();
    checkEnding();
  }

  canvas.addEventListener("click", function (event) { milkAt(event.clientX, event.clientY); });
  canvas.addEventListener("touchstart", function (event) {
    if (event.touches && event.touches.length > 0) {
      event.preventDefault();
      milkAt(event.touches[0].clientX, event.touches[0].clientY);
    }
  }, { passive: false });

  // Keyboard: Space milks the main cow, P / Escape pauses.
  document.addEventListener("keydown", function (event) {
    if (event.code === "Space" || event.key === " ") {
      if (!state.started || state.paused) { return; }
      var rect = canvas.getBoundingClientRect();
      event.preventDefault();
      milkAt(rect.left + rect.width / 2, rect.top + rect.height * 0.4);
    } else if (event.key === "p" || event.key === "P" || event.key === "Escape") {
      togglePause();
    }
  });

  // --- Start / pause / mute / volume ---------------------------------------------
  function togglePause() {
    if (!state.started || state.gameOver) { return; }
    state.paused = !state.paused;
    soundTick();
    showMessage(state.paused ? "Paused. Take a breath — the cows are waiting." : "");
    updateStats();
  }

  el("playButton").addEventListener("click", function () {
    el("startBox").classList.remove("show");
    state.started = true;
    ensureAudio();
    soundMoo();
    state.bubble = { text: "Moo!", until: Date.now() + 1600 };
    log("A new season begins. One cow, one bucket, and Gwendolyn watching.");
    showMessage("Click Gwendolyn to milk her!");
    updateStats();
  });

  el("pauseButton").addEventListener("click", togglePause);

  el("muteButton").addEventListener("click", function () {
    state.muted = !state.muted;
    if (!state.muted) { ensureAudio(); soundPop(); }
    updateStats();
  });

  el("volumeSlider").addEventListener("input", function (event) {
    var v = parseFloat(event.target.value);
    if (isNaN(v)) { v = 70; }
    state.volume = Math.max(0, Math.min(100, v));
    if (state.volume > 0 && state.muted) { state.muted = false; }
    applyVolume();
    saveVolume();
    updateStats();
  });

  // --- Shop --------------------------------------------------------------------
  el("buyMilker").addEventListener("click", function () {
    if (!state.started || state.gameOver || state.milk < milkerCost()) { return; }
    state.milk -= milkerCost();
    state.milkerLevel += 1;
    soundCoin();
    log("Bought a better milker. Now Lv " + state.milkerLevel + " — " + milkPerClick() + " Milk per click.");
    updateStats();
  });

  el("buyCow").addEventListener("click", function () {
    if (!state.started || state.gameOver || state.cows >= 8 || state.milk < cowCost()) { return; }
    state.milk -= cowCost();
    state.cows += 1;
    soundMoo();
    state.bubble = { text: "Moo! Hello!", until: Date.now() + 1800 };
    log("A new cow joins the herd. The herd is now " + state.cows + " cows strong.");
    updateStats();
  });

  el("feedHerd").addEventListener("click", function () {
    if (!state.started || state.gameOver || state.milk < feedCost()) { return; }
    state.milk -= feedCost();
    changeRating(12);
    state.gwendolynAnger = Math.max(0, state.gwendolynAnger - 1);
    state.herdMemory = Math.max(0, state.herdMemory - 2);
    setMood("happy", 2000);
    spawnParticles(360, 180, "heart", 8);
    soundMunch();
    setTimeout(soundHappy, 350);
    log("You fed the herd. Moo Rating rises, and Gwendolyn softens a little.");
    showMessage("The herd munches happily. Moo Rating up!");
    updateStats();
  });

  // --- Herd events ---------------------------------------------------------------
  var EVENT_TEXTS = [
    "The herd gathers at the gate and lows together. Gwendolyn stamps a hoof. Something has to give.",
    "A storm is rolling in and the cows are restless. Gwendolyn stares at you, waiting for a decision.",
    "The herd has stopped chewing and is watching you as one. Even the flies have gone quiet."
  ];

  function triggerEvent() {
    state.eventActive = true;
    state.flashUntil = Date.now() + 300;
    el("eventText").textContent = EVENT_TEXTS[Math.floor(Math.random() * EVENT_TEXTS.length)];
    el("eventAppease").disabled = state.milk < 50;
    el("eventAppease").textContent = state.milk < 50
      ? "Appease the herd — costs 50 Milk (not enough Milk)"
      : "Appease the herd — costs 50 Milk";
    el("eventBox").classList.add("show");
    spawnParticles(360, 150, "star", 10);
    soundSting();
    updateStats();
  }

  function resolveEvent(choice) {
    el("eventBox").classList.remove("show");
    state.eventActive = false;
    state.eventCountdown = EVENT_INTERVAL;

    if (choice === "appease") {
      state.milk = Math.max(0, state.milk - 50);
      changeRating(8);
      state.gwendolynAnger = Math.max(0, state.gwendolynAnger - 2);
      state.herdMemory = Math.max(0, state.herdMemory - 2);
      setMood("happy", 2000);
      spawnParticles(360, 180, "heart", 8);
      soundHappy();
      log("You shared out hay and kind words. The herd settles. Moo Rating +8.");
      showMessage("The herd is appeased. Gwendolyn flicks an ear, satisfied.");
    } else if (choice === "ignore") {
      changeRating(-10);
      state.gwendolynAnger = Math.min(5, state.gwendolynAnger + 1);
      setMood("angry", 1500);
      state.shakeUntil = Date.now() + 400;
      spawnParticles(360, 150, "puff", 6);
      spawnParticles(360, 250, "puff", 4);
      soundThud();
      soundBuzz();
      log("You ignored the herd. Moo Rating -10. Gwendolyn is " + gwendolynMood().toLowerCase() + " now.");
      showMessage("Ignored. Gwendolyn will remember that.");
    } else if (choice === "exploit") {
      state.milk += 100;
      state.totalMilk += 100;
      changeRating(-12);
      state.gwendolynAnger = Math.min(5, state.gwendolynAnger + 1);
      setMood("angry", 1500);
      spawnParticles(360, 180, "milk", 10);
      soundBuzz();
      log("You milked through the unrest and pocketed 100 Milk. Moo Rating -12.");
      showMessage("100 Milk gained — but the herd noticed.");
    }
    updateStats();
    checkMilestones();
    checkEnding();
  }

  el("eventAppease").addEventListener("click", function () { resolveEvent("appease"); });
  el("eventIgnore").addEventListener("click", function () { resolveEvent("ignore"); });
  el("eventExploit").addEventListener("click", function () { resolveEvent("exploit"); });

  // --- Ending ----------------------------------------------------------------------
  function checkEnding() {
    if (state.gameOver || state.totalMilk < MILK_GOAL) { return; }
    state.gameOver = true;

    var title, text;
    if (state.rating >= 75) {
      title = "Pastoral Ending";
      text = "5,000 Milk, and the herd still loves you. Gwendolyn leads the cows out to the greenest field, the sun is warm, and the farm hums along at exactly the right pace. This is the good life — milk, grass, and a herd that trusts you.";
      spawnParticles(360, 60, "confetti", 90);
      soundFanfare();
    } else if (state.rating <= 35) {
      title = "Gigafarm Ending";
      text = "5,000 Milk — but at what cost? The herd is a machine now, Gwendolyn has not met your eye in days, and the farm runs on noise and fences. The milk flows. Nothing else does.";
      spawnParticles(360, 0, "rain", 60);
      soundSadTrombone();
    } else {
      title = "Balanced Farm Ending";
      text = "5,000 Milk, and the farm is still standing. Not perfect, not ruined — a working farm with a herd that tolerates you and a Gwendolyn who has decided, for now, to stay. There is room to do better next season.";
      spawnParticles(360, 120, "star", 24);
      soundFanfare();
    }

    setText("endingTitle", title);
    setText("endingText", text);
    setText("endingStats", "Total Milk: " + Math.floor(state.totalMilk) +
      "  •  Final Moo Rating: " + state.rating +
      "  •  Cows: " + state.cows +
      "  •  Milker: Lv " + state.milkerLevel +
      "  •  Gwendolyn: " + gwendolynMood() +
      "  •  Best steady streak: " + state.streak);
    el("endingBox").classList.add("show");
    soundMoo();
    log("The season ends: " + title + " (Moo Rating " + state.rating + ").");
  }

  el("playAgain").addEventListener("click", function () {
    el("endingBox").classList.remove("show");
    var muted = state.muted;
    var volume = state.volume;
    state = freshState();
    state.muted = muted;
    state.volume = volume;
    state.started = true;
    showMessage("");
    el("log").innerHTML = "";
    log("A new season begins. One cow, one bucket, and Gwendolyn watching.");
    updateStats();
  });

  // --- Main loop --------------------------------------------------------------------
  function tick() {
    var now = Date.now();
    var rawDt = (now - state.lastTick) / 1000;
    var dt = Math.min(0.1, rawDt); // capped for animation; logic uses rawDt
    state.lastTick = now;

    // Clouds always drift, even on the title screen.
    for (var ci = 0; ci < state.clouds.length; ci++) {
      var c = state.clouds[ci];
      c.x += c.v * dt;
      if (c.x - 70 > canvas.width) { c.x = -70; }
    }

    // Blinking.
    if (now >= state.nextBlinkAt) {
      state.blinkUntil = now + 140;
      state.nextBlinkAt = now + 2200 + Math.random() * 2500;
    }

    // Grazing: now and then Gwendolyn puts her head down to eat.
    if (state.started && !state.paused && !state.gameOver && !state.eventActive) {
      if (now >= state.nextGrazeAt && state.grazeUntil <= now) {
        state.grazeUntil = now + 2200;
        state.nextGrazeAt = now + 9000 + Math.random() * 9000;
      }
    }

    // Butterflies drift in on a breeze.
    if (now >= state.nextButterflyAt && state.butterflies.length < 3) {
      state.butterflies.push({
        x: -20, y: 280 + Math.random() * 60,
        vx: 14 + Math.random() * 12,
        phase: Math.random() * 6,
        color: ["#ff8fb3", "#ffd25e", "#c9a7eb", "#7ec8ff"][Math.floor(Math.random() * 4)]
      });
      state.nextButterflyAt = now + 7000 + Math.random() * 8000;
    }
    for (var bi = state.butterflies.length - 1; bi >= 0; bi--) {
      var bu = state.butterflies[bi];
      bu.x += bu.vx * dt;
      bu.y += Math.sin(now * 0.003 + bu.phase) * 12 * dt;
      if (bu.x > canvas.width + 20) { state.butterflies.splice(bi, 1); }
    }

    // A bird crosses the sky now and then.
    if (now >= state.nextBirdAt && state.birds.length < 2) {
      state.birds.push({ x: -20, y: 60 + Math.random() * 70, vx: 55 + Math.random() * 25 });
      state.nextBirdAt = now + 14000 + Math.random() * 12000;
    }
    for (var bd = state.birds.length - 1; bd >= 0; bd--) {
      state.birds[bd].x += state.birds[bd].vx * dt;
      if (state.birds[bd].x > canvas.width + 20) { state.birds.splice(bd, 1); }
    }

    // Gwendolyn moos to herself now and then.
    if (state.started && !state.paused && !state.gameOver && !state.eventActive && now >= state.nextIdleMooAt) {
      state.nextIdleMooAt = now + 18000 + Math.random() * 17000;
      soundMoo();
      state.bubble = { text: "Moo.", until: now + 1600 };
    }

    // A soft bird chirp from somewhere off-screen, once in a while.
    if (state.started && !state.paused && !state.muted && Math.random() < dt / 25) {
      soundChirp();
    }

    // A sad herd droops when the rating is low.
    if (state.started && state.rating < 35 && !state.mood) {
      setMood("sad", 1500);
    }

    if (state.started && !state.paused && !state.gameOver) {
      // Passive milk from the herd, a trickle per cow.
      var passive = state.cows * 0.2 * rawDt;
      state.milk += passive;
      state.totalMilk += passive;

      // The cows slowly forget being rushed.
      if (state.herdMemory > 0 && Math.random() < rawDt / 10) {
        state.herdMemory -= 1;
      }

      // Herd event timer.
      if (!state.eventActive) {
        state.eventCountdown -= rawDt;
        if (state.eventCountdown <= 0) {
          triggerEvent();
        }
      }

      checkMilestones();
      checkEnding();
      updateStats();
    }

    // Floating texts rise and fade.
    for (var i = state.floaters.length - 1; i >= 0; i--) {
      state.floaters[i].y -= 30 * dt;
      state.floaters[i].life -= dt * 1.2;
      if (state.floaters[i].life <= 0) { state.floaters.splice(i, 1); }
    }

    drawScene(now, dt);
    requestAnimationFrame(tick);
  }

  log("Welcome to Moo Rating. Click Gwendolyn to milk her. Reach 5,000 total Milk.");
  log("Careful: faster than 4 clicks a second stresses the herd, and the cows remember.");
  updateStats();
  requestAnimationFrame(tick);
})();
