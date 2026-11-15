// Moo Rating — a cow clicker about milking a herd until it revolts.
// Click a cow to make Milk. Click too fast and the herd remembers it.
// Every 45 seconds a herd event forces a choice. At 5,000 total Milk,
// the ending depends on the Moo Rating.

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
      clickTimes: [],
      eventCountdown: EVENT_INTERVAL,
      eventActive: false,
      gameOver: false,
      shakeUntil: 0,
      floaters: [], // floating "+N Milk" texts
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
    }
  }

  // --- Rendering ------------------------------------------------------------
  function drawProceduralCow(x, y, w, h, withBow) {
    var s = w / 200; // scale relative to the 200 x 150 drawing
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);

    // Legs
    ctx.fillStyle = "#f5f5f5";
    ctx.fillRect(30, 105, 16, 35);
    ctx.fillRect(70, 105, 16, 35);
    ctx.fillRect(125, 105, 16, 35);
    ctx.fillRect(160, 105, 16, 35);
    ctx.fillStyle = "#333";
    ctx.fillRect(30, 135, 16, 6);
    ctx.fillRect(70, 135, 16, 6);
    ctx.fillRect(125, 135, 16, 6);
    ctx.fillRect(160, 135, 16, 6);

    // Tail
    ctx.strokeStyle = "#f5f5f5";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(12, 45);
    ctx.quadraticCurveTo(2, 80, 10, 105);
    ctx.stroke();
    ctx.fillStyle = "#333";
    ctx.beginPath();
    ctx.arc(10, 108, 7, 0, Math.PI * 2);
    ctx.fill();

    // Body
    ctx.fillStyle = "#f5f5f5";
    ctx.beginPath();
    ctx.ellipse(100, 75, 92, 52, 0, 0, Math.PI * 2);
    ctx.fill();

    // Spots
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

    // Udder
    ctx.fillStyle = "#f2a5b7";
    ctx.beginPath();
    ctx.ellipse(100, 118, 26, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#d97b92";
    ctx.fillRect(88, 122, 5, 8);
    ctx.fillRect(98, 124, 5, 8);
    ctx.fillRect(108, 122, 5, 8);

    // Head
    ctx.fillStyle = "#f5f5f5";
    ctx.beginPath();
    ctx.ellipse(188, 45, 30, 34, 0, 0, Math.PI * 2);
    ctx.fill();

    // Horns
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

    // Ears
    ctx.fillStyle = "#f5f5f5";
    ctx.beginPath();
    ctx.ellipse(160, 38, 12, 7, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(214, 36, 12, 7, 0.5, 0, Math.PI * 2);
    ctx.fill();

    // Muzzle
    ctx.fillStyle = "#f2a5b7";
    ctx.beginPath();
    ctx.ellipse(192, 62, 20, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#333";
    ctx.beginPath();
    ctx.arc(185, 60, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(199, 60, 3, 0, Math.PI * 2);
    ctx.fill();

    // Eyes (wide when the herd is stressed, calm otherwise)
    var eyeH = state.rating < 35 ? 7 : 4;
    ctx.fillStyle = "#111";
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

  function drawCow(x, y, w, h, withBow, flip) {
    ctx.save();
    if (flip) {
      ctx.translate(x + w, y);
      ctx.scale(-1, 1);
      if (cowImageReady) {
        ctx.drawImage(cowImage, 0, 0, w, h);
      } else {
        drawProceduralCow(0, 0, w, h, withBow);
      }
    } else {
      if (cowImageReady) {
        ctx.drawImage(cowImage, x, y, w, h);
      } else {
        drawProceduralCow(x, y, w, h, withBow);
      }
      if (withBow && cowImageReady) {
        // Bow on the sprite cow, near the head (top right of the image).
        ctx.fillStyle = "#c0392b";
        var bx = x + w * 0.86, by = y + h * 0.08;
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

  function drawScene() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Sun and clouds
    ctx.fillStyle = "#ffdf6b";
    ctx.beginPath();
    ctx.arc(640, 55, 32, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.ellipse(140, 55, 55, 18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(420, 40, 45, 15, 0, 0, Math.PI * 2);
    ctx.fill();

    // Fence
    ctx.fillStyle = "#8b5a2b";
    ctx.fillRect(0, 250, canvas.width, 6);
    ctx.fillRect(0, 278, canvas.width, 6);
    for (var fx = 30; fx < canvas.width; fx += 120) {
      ctx.fillRect(fx, 238, 10, 62);
    }

    // Ground line
    ctx.fillStyle = "#4c8a3f";
    ctx.fillRect(0, 300, canvas.width, 4);

    // Shake when the herd is stressed
    var shakeX = 0, shakeY = 0;
    if (Date.now() < state.shakeUntil) {
      shakeX = (Math.random() - 0.5) * 10;
      shakeY = (Math.random() - 0.5) * 6;
    }

    // Main cow: the one you click. Gwendolyn wears the bow.
    drawCow(260 + shakeX, 95 + shakeY, 200, 150, true, false);
    ctx.fillStyle = "#4a2c14";
    ctx.font = "bold 15px Georgia, serif";
    ctx.textAlign = "center";
    ctx.fillText("Gwendolyn", 360 + shakeX, 265 + shakeY);

    // The rest of the herd, one small cow per extra cow.
    for (var i = 1; i < state.cows; i++) {
      var hx = 60 + ((i - 1) % 4) * 160;
      var hy = 310 + Math.floor((i - 1) / 4) * 10;
      drawCow(hx, hy, 120, 90, false, i % 2 === 0);
    }

    // Floating "+N Milk" texts
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
    setText("eventTimer", state.eventActive ? "now!" : Math.ceil(state.eventCountdown) + "s");
    el("buyMilker").textContent = "Better Milker — " + milkerCost() + " Milk (Lv " + (state.milkerLevel + 1) + ")";
    el("buyCow").textContent = "Add a Cow — " + cowCost() + " Milk (" + state.cows + " → " + (state.cows + 1) + ")";
    el("buyCow").disabled = state.cows >= 8;
    el("feedHerd").textContent = "Feed the Herd — " + feedCost() + " Milk (+12 Rating)";
    el("buyMilker").disabled = state.milk < milkerCost();
    el("buyCow").disabled = state.cows >= 8 || state.milk < cowCost();
    el("feedHerd").disabled = state.milk < feedCost();
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

  function onCanvasClick(event) {
    if (state.gameOver || state.eventActive) { return; }
    var rect = canvas.getBoundingClientRect();
    var scaleX = canvas.width / rect.width;
    var scaleY = canvas.height / rect.height;
    var x = (event.clientX - rect.left) * scaleX;
    var y = (event.clientY - rect.top) * scaleY;

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
      state.shakeUntil = now + 300;
      showMessage("Too fast! The herd is stressed — the cows remember this.");
      if (state.herdMemory === 5) {
        log("The cows are keeping count. Slow down, or every click will earn less.");
      }
    }

    var gained = milkPerClick();
    state.milk += gained;
    state.totalMilk += gained;
    state.floaters.push({ x: hit.x + hit.w / 2, y: hit.y + 10, text: "+" + gained + " Milk", life: 1 });

    updateStats();
    checkEnding();
  }

  canvas.addEventListener("click", onCanvasClick);

  // --- Shop --------------------------------------------------------------------
  el("buyMilker").addEventListener("click", function () {
    if (state.gameOver || state.milk < milkerCost()) { return; }
    state.milk -= milkerCost();
    state.milkerLevel += 1;
    log("Bought a better milker. Now Lv " + state.milkerLevel + " — " + milkPerClick() + " Milk per click.");
    updateStats();
  });

  el("buyCow").addEventListener("click", function () {
    if (state.gameOver || state.cows >= 8 || state.milk < cowCost()) { return; }
    state.milk -= cowCost();
    state.cows += 1;
    log("A new cow joins the herd. The herd is now " + state.cows + " cows strong.");
    updateStats();
  });

  el("feedHerd").addEventListener("click", function () {
    if (state.gameOver || state.milk < feedCost()) { return; }
    state.milk -= feedCost();
    changeRating(12);
    state.gwendolynAnger = Math.max(0, state.gwendolynAnger - 1);
    state.herdMemory = Math.max(0, state.herdMemory - 2);
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
      log("You shared out hay and kind words. The herd settles. Moo Rating +8.");
      showMessage("The herd is appeased. Gwendolyn flicks an ear, satisfied.");
    } else if (choice === "ignore") {
      changeRating(-10);
      state.gwendolynAnger = Math.min(5, state.gwendolynAnger + 1);
      log("You ignored the herd. Moo Rating -10. Gwendolyn is " + gwendolynMood().toLowerCase() + " now.");
      showMessage("Ignored. Gwendolyn will remember that.");
    } else if (choice === "exploit") {
      state.milk += 100;
      state.totalMilk += 100;
      changeRating(-12);
      state.gwendolynAnger = Math.min(5, state.gwendolynAnger + 1);
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
      "  •  Gwendolyn: " + gwendolynMood());
    el("endingBox").classList.add("show");
    log("The season ends: " + title + " (Moo Rating " + state.rating + ").");
  }

  el("playAgain").addEventListener("click", function () {
    el("endingBox").classList.remove("show");
    state = freshState();
    showMessage("");
    el("log").innerHTML = "";
    log("A new season begins. One cow, one bucket, and Gwendolyn watching.");
    updateStats();
  });

  // --- Main loop --------------------------------------------------------------------
  function tick() {
    var now = Date.now();
    var dt = (now - state.lastTick) / 1000;
    state.lastTick = now;

    if (!state.gameOver) {
      // Passive milk from the herd, a trickle per cow.
      var passive = state.cows * 0.2 * dt;
      state.milk += passive;
      state.totalMilk += passive;

      // The cows slowly forget being rushed.
      if (state.herdMemory > 0 && Math.random() < dt / 10) {
        state.herdMemory -= 1;
      }

      // Herd event timer.
      if (!state.eventActive) {
        state.eventCountdown -= dt;
        if (state.eventCountdown <= 0) {
          triggerEvent();
        }
      }

      // Floating texts rise and fade.
      for (var i = state.floaters.length - 1; i >= 0; i--) {
        state.floaters[i].y -= 30 * dt;
        state.floaters[i].life -= dt * 1.2;
        if (state.floaters[i].life <= 0) { state.floaters.splice(i, 1); }
      }

      checkEnding();
      updateStats();
    }

    drawScene();
    requestAnimationFrame(tick);
  }

  log("Welcome to Moo Rating. Click Gwendolyn to milk her. Reach 5,000 total Milk.");
  log("Careful: faster than 4 clicks a second stresses the herd, and the cows remember.");
  updateStats();
  requestAnimationFrame(tick);
})();
