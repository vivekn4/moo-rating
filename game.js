// Moo Rating — a cow clicker about milking a herd until it revolts.
// Click a cow to make Milk. Click too fast and the herd remembers it.
// Every 45 seconds a herd event forces a choice. At 5,000 total Milk,
// the ending depends on the Moo Rating.
//
// Mechanics are deliberately simple and readable: one state object, one
// render pass, one tick. Presentation (animation, particles, sound) is
// layered on top and never changes the numbers.

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
      shakeUntil: 0,
      squashUntil: 0,
      blinkUntil: 0,
      nextBlinkAt: Date.now() + 2500,
      floaters: [], // floating "+N Milk" texts
      particles: [], // milk drops, hearts, puffs, stars
      clouds: [
        { x: 80, y: 48, s: 1.0, v: 6 },
        { x: 380, y: 34, s: 0.7, v: 9 },
        { x: 580, y: 62, s: 0.85, v: 7 }
      ],
      lastTick: Date.now()
    };
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
  function ensureAudio() {
    if (state.muted) { return null; }
    try {
      var AC = (typeof AudioContext !== "undefined") ? AudioContext
        : (typeof webkitAudioContext !== "undefined") ? webkitAudioContext : null;
      if (!AC) { return null; }
      if (!audioCtx) { audioCtx = new AC(); }
      if (audioCtx.state === "suspended") { audioCtx.resume(); }
      return audioCtx;
    } catch (e) { return null; }
  }
  function tone(freqStart, freqEnd, duration, type, volume) {
    var ac = ensureAudio();
    if (!ac) { return; }
    try {
      var osc = ac.createOscillator();
      var gain = ac.createGain();
      var now = ac.currentTime;
      osc.type = type || "sine";
      osc.frequency.setValueAtTime(freqStart, now);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), now + duration);
      gain.gain.setValueAtTime(volume || 0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(now);
      osc.stop(now + duration);
    } catch (e) { /* sound is decoration; never break the game */ }
  }
  function soundPop() { tone(520, 760, 0.08, "square", 0.04); }
  function soundMoo() {
    // A low, wobbly moo: two detuned sawtooth voices sliding down.
    tone(160, 95, 0.55, "sawtooth", 0.05);
    tone(155, 90, 0.55, "triangle", 0.05);
  }
  function soundChime() { tone(660, 660, 0.12, "sine", 0.06); setTimeout(function () { tone(880, 880, 0.18, "sine", 0.06); }, 110); }
  function soundHappy() { tone(523, 523, 0.1, "sine", 0.05); setTimeout(function () { tone(659, 659, 0.1, "sine", 0.05); }, 90); setTimeout(function () { tone(784, 784, 0.16, "sine", 0.05); }, 180); }
  function soundBuzz() { tone(140, 70, 0.25, "sawtooth", 0.05); }

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

  function changeRating(amount) {
    state.rating = Math.max(0, Math.min(100, state.rating + amount));
    if (state.rating === 0) {
      showMessage("The herd has revolted! Feed them to calm things down.");
      log("The herd has revolted — the cows refuse to be milked until they are fed.");
      soundBuzz();
    }
  }

  // --- Particles ------------------------------------------------------------
  function spawnParticles(x, y, type, count) {
    for (var i = 0; i < count; i++) {
      state.particles.push({
        x: x + (Math.random() - 0.5) * 40,
        y: y + (Math.random() - 0.5) * 20,
        vx: (Math.random() - 0.5) * 60,
        vy: type === "heart" ? -45 - Math.random() * 25 : -20 - Math.random() * 60,
        life: 1,
        decay: 0.9 + Math.random() * 0.7,
        size: 4 + Math.random() * 5,
        type: type
      });
    }
    if (state.particles.length > 120) { state.particles.splice(0, state.particles.length - 120); }
  }

  // --- Rendering ------------------------------------------------------------
  function drawBackground(t) {
    // Sky, two bands.
    ctx.fillStyle = "#8ecfee";
    ctx.fillRect(0, 0, canvas.width, 190);
    ctx.fillStyle = "#a8d8a8";
    ctx.fillRect(0, 190, canvas.width, 60);
    ctx.fillStyle = "#6faf5e";
    ctx.fillRect(0, 250, canvas.width, 170);

    // Sun with slow-turning rays.
    var sx = 640, sy = 55;
    ctx.strokeStyle = "rgba(255, 223, 107, 0.7)";
    ctx.lineWidth = 3;
    for (var r = 0; r < 8; r++) {
      var a = (r / 8) * Math.PI * 2 + t * 0.0001;
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(a) * 38, sy + Math.sin(a) * 38);
      ctx.lineTo(sx + Math.cos(a) * 50, sy + Math.sin(a) * 50);
      ctx.stroke();
    }
    ctx.fillStyle = "#ffdf6b";
    ctx.beginPath();
    ctx.arc(sx, sy, 32, 0, Math.PI * 2);
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

    // Distant hills.
    ctx.fillStyle = "#7fb069";
    ctx.beginPath();
    ctx.ellipse(120, 252, 190, 42, 0, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = "#8ab573";
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

  function drawProceduralCow(x, y, w, h, withBow, t) {
    var s = w / 200; // scale relative to the 200 x 150 drawing
    var blink = Date.now() < state.blinkUntil;
    var chew = Math.sin(t * 0.004) * 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);

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

    ctx.restore();
  }

  function drawCow(x, y, w, h, withBow, flip, t) {
    // Squash-and-stretch right after a click, idle bob otherwise.
    var squash = 1;
    var now = Date.now();
    if (now < state.squashUntil) {
      var k = (state.squashUntil - now) / 150;
      squash = 1 - 0.12 * k;
    }
    var bob = Math.sin(t * 0.002) * 3;
    var drawY = y + bob + (h * (1 - squash));

    ctx.save();
    if (flip) {
      ctx.translate(x + w, drawY);
      ctx.scale(-1, squash);
      if (cowImageReady) {
        ctx.drawImage(cowImage, 0, 0, w, h);
      } else {
        drawProceduralCow(0, 0, w, h, withBow, t);
      }
    } else {
      ctx.translate(x, drawY);
      ctx.scale(1, squash);
      if (cowImageReady) {
        ctx.drawImage(cowImage, 0, 0, w, h);
      } else {
        drawProceduralCow(0, 0, w, h, withBow, t);
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

  function drawParticles(dt) {
    for (var i = state.particles.length - 1; i >= 0; i--) {
      var p = state.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 30 * dt;
      p.life -= p.decay * dt;
      if (p.life <= 0) { state.particles.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, p.life);
      if (p.type === "milk") {
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

    // Main cow: the one you click. Gwendolyn wears the bow.
    drawCow(260 + shakeX, 95 + shakeY, 200, 150, true, false, t);
    ctx.fillStyle = "#4a2c14";
    ctx.font = "bold 15px Georgia, serif";
    ctx.textAlign = "center";
    ctx.fillText("Gwendolyn", 360 + shakeX, 265 + shakeY);

    // The rest of the herd, one small cow per extra cow.
    for (var i = 1; i < state.cows; i++) {
      var hx = 60 + ((i - 1) % 4) * 160;
      var hy = 310 + Math.floor((i - 1) / 4) * 10;
      drawCow(hx, hy, 120, 90, false, i % 2 === 0, t + i * 700);
    }

    drawParticles(dt);

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

    if (state.clickTimes.length > FAST_CLICK_LIMIT) {
      // Too fast: the herd stresses, the rating drops, and the cows remember.
      changeRating(-1);
      state.herdMemory = Math.min(10, state.herdMemory + 1);
      state.streak = 0;
      state.shakeUntil = now + 300;
      spawnParticles(hit.x + hit.w / 2, hit.y + 20, "puff", 5);
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
    state.squashUntil = now + 150;
    soundPop();
    if (state.streak > 0 && state.streak % 25 === 0) {
      log(state.streak + " calm clicks in a row. Gwendolyn approves of this pace.");
    }

    updateStats();
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

  // --- Start / pause / mute -------------------------------------------------------
  function togglePause() {
    if (!state.started || state.gameOver) { return; }
    state.paused = !state.paused;
    showMessage(state.paused ? "Paused. Take a breath — the cows are waiting." : "");
    updateStats();
  }

  el("playButton").addEventListener("click", function () {
    el("startBox").classList.remove("show");
    state.started = true;
    ensureAudio();
    soundMoo();
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

  // --- Shop --------------------------------------------------------------------
  el("buyMilker").addEventListener("click", function () {
    if (!state.started || state.gameOver || state.milk < milkerCost()) { return; }
    state.milk -= milkerCost();
    state.milkerLevel += 1;
    soundHappy();
    log("Bought a better milker. Now Lv " + state.milkerLevel + " — " + milkPerClick() + " Milk per click.");
    updateStats();
  });

  el("buyCow").addEventListener("click", function () {
    if (!state.started || state.gameOver || state.cows >= 8 || state.milk < cowCost()) { return; }
    state.milk -= cowCost();
    state.cows += 1;
    soundMoo();
    log("A new cow joins the herd. The herd is now " + state.cows + " cows strong.");
    updateStats();
  });

  el("feedHerd").addEventListener("click", function () {
    if (!state.started || state.gameOver || state.milk < feedCost()) { return; }
    state.milk -= feedCost();
    changeRating(12);
    state.gwendolynAnger = Math.max(0, state.gwendolynAnger - 1);
    state.herdMemory = Math.max(0, state.herdMemory - 2);
    spawnParticles(360, 180, "heart", 8);
    soundHappy();
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
    el("eventText").textContent = EVENT_TEXTS[Math.floor(Math.random() * EVENT_TEXTS.length)];
    el("eventAppease").disabled = state.milk < 50;
    el("eventAppease").textContent = state.milk < 50
      ? "Appease the herd — costs 50 Milk (not enough Milk)"
      : "Appease the herd — costs 50 Milk";
    el("eventBox").classList.add("show");
    spawnParticles(360, 150, "star", 10);
    soundChime();
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
      spawnParticles(360, 180, "heart", 8);
      soundHappy();
      log("You shared out hay and kind words. The herd settles. Moo Rating +8.");
      showMessage("The herd is appeased. Gwendolyn flicks an ear, satisfied.");
    } else if (choice === "ignore") {
      changeRating(-10);
      state.gwendolynAnger = Math.min(5, state.gwendolynAnger + 1);
      spawnParticles(360, 150, "puff", 6);
      soundBuzz();
      log("You ignored the herd. Moo Rating -10. Gwendolyn is " + gwendolynMood().toLowerCase() + " now.");
      showMessage("Ignored. Gwendolyn will remember that.");
    } else if (choice === "exploit") {
      state.milk += 100;
      state.totalMilk += 100;
      changeRating(-12);
      state.gwendolynAnger = Math.min(5, state.gwendolynAnger + 1);
      spawnParticles(360, 180, "milk", 10);
      soundBuzz();
      log("You milked through the unrest and pocketed 100 Milk. Moo Rating -12.");
      showMessage("100 Milk gained — but the herd noticed.");
    }
    updateStats();
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
    } else if (state.rating <= 35) {
      title = "Gigafarm Ending";
      text = "5,000 Milk — but at what cost? The herd is a machine now, Gwendolyn has not met your eye in days, and the farm runs on noise and fences. The milk flows. Nothing else does.";
    } else {
      title = "Balanced Farm Ending";
      text = "5,000 Milk, and the farm is still standing. Not perfect, not ruined — a working farm with a herd that tolerates you and a Gwendolyn who has decided, for now, to stay. There is room to do better next season.";
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
    spawnParticles(360, 150, "star", 16);
    soundMoo();
    soundChime();
    log("The season ends: " + title + " (Moo Rating " + state.rating + ").");
  }

  el("playAgain").addEventListener("click", function () {
    el("endingBox").classList.remove("show");
    var muted = state.muted;
    state = freshState();
    state.muted = muted;
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
