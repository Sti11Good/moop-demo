// script.js
// Revised client script for MooLite — robust initialization, clearer connection/status UI,
// safer DOM access, and compatibility with the LAN-friendly server (0.0.0.0).
//
// Key fixes included:
// - Initialize only after DOMContentLoaded to avoid getContext null errors.
// - Guard against missing DOM elements (graceful fallback logging).
// - Show connection status in-page and in console.
// - Use location.host for WS path (works when server is on host IP and bound to 0.0.0.0).
// - Fallback/heartbeat reconnect logic and clearer error messages for LAN troubleshooting.
// - Keep client-side prediction and interpolation simple and robust.
//
// Replace your current script.js with this file, reload the page, then open DevTools Console
// to confirm startup logs and connection attempts.

(() => {
  "use strict";

  // Wait for DOM ready before querying canvas / elements
  document.addEventListener("DOMContentLoaded", init);

  function init() {
    console.log("[MooLite] init");

    // ---- Config / Emoji mapping ----
    const CONFIG = {
      TILE_SIZE: 48,
      WORLD_W: 3000,
      WORLD_H: 2000,
      SNAP_RATE_MS: 1000 / 20,
      PLAYER_SPEED: 220,
      INTERP_MS: 120,
      VIEWPORT_PAD: 80,
      ACTION_RANGE: 80
    };

    const EMOJI = {
      tree: "🌳",
      rock: "🪨",
      berry: "🍓",
      wood: "🪵",
      wall: "🧱",
      camp: "🏠",
      player: "😃",
      axe: "🪓",
      sword: "⚔️"
    };

    // ---- DOM references ----
    const canvas = document.getElementById("game");
    const minimapCanvas = document.getElementById("minimap");
    const invWood = document.getElementById("inv-wood");
    const invStone = document.getElementById("inv-stone");
    const invFood = document.getElementById("inv-food");
    const playersList = document.getElementById("players-list");
    const chatLog = document.getElementById("chat-log");
    const chatForm = document.getElementById("chat-form");
    const chatInput = document.getElementById("chat-input");
    const nameInput = document.getElementById("name-input");
    const setNameBtn = document.getElementById("set-name");
    const buildWallBtn = document.getElementById("build-wall");
    const buildHomeBtn = document.getElementById("build-home");
    const connStatus = createStatusElement();

    if (!canvas) {
      console.error("[MooLite] ERROR: canvas#game missing from DOM. Game cannot run.");
      return;
    }
    const ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx) {
      console.error("[MooLite] ERROR: 2D context not available on canvas.");
      return;
    }
    const miniCtx = minimapCanvas && minimapCanvas.getContext ? minimapCanvas.getContext("2d") : null;

    // ---- Basic state ----
    let ws = null;
    let myId = null;
    let username = localStorage.getItem("moolite_name") || ("Player" + Math.floor(Math.random() * 999));
    nameInput && (nameInput.value = username);

    // Authoritative-ish mirrored data (populated by snapshots)
    let worldState = { players: {}, nodes: [], buildings: [] };
    let snapshots = [];

    // Local predicted state for the client player
    let local = { x: 100, y: 100, hp: 100, inventory: { wood: 0, stone: 0, food: 0 } };

    // Input state
    const inputState = { up: false, down: false, left: false, right: false, mouse: { x: 0, y: 0, down: false } };

    // Camera
    const cam = { x: 0, y: 0, w: 800, h: 600 };

    // Resize canvas to available area
    function resize() {
      // Keep room for HUD (right panel width ~320 + padding)
      canvas.width = Math.max(320, window.innerWidth - 360);
      canvas.height = Math.max(320, window.innerHeight - 92);
      cam.w = canvas.width;
      cam.h = canvas.height;
    }
    window.addEventListener("resize", resize);
    resize();

    // ---- Networking: connect to server (LAN-friendly) ----
    // The server should be run locally and bound to 0.0.0.0 (see server.js).
    function connect() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${location.host}/ws`;
      console.log("[MooLite] attempting WS:", url);
      setStatus("Connecting...");
      try {
        ws = new WebSocket(url);
      } catch (e) {
        console.error("[MooLite] WebSocket constructor error:", e);
        setStatus("WebSocket error");
        ws = null;
        return;
      }
      ws.addEventListener("open", () => {
        console.log("[MooLite] ws open");
        setStatus("Connected");
        // send join with username
        ws.send(JSON.stringify({ type: "join", name: username }));
      });
      ws.addEventListener("message", (ev) => onMessageSafe(ev.data));
      ws.addEventListener("close", () => {
        console.warn("[MooLite] ws closed");
        setStatus("Disconnected");
        // attempt reconnect after delay
        setTimeout(connect, 2000);
      });
      ws.addEventListener("error", (err) => {
        console.warn("[MooLite] ws error", err);
        setStatus("Connection error");
      });
    }

    // Lightweight safeguard JSON parse
    function onMessageSafe(data) {
      try {
        const msg = JSON.parse(data);
        handleMessage(msg);
      } catch (e) {
        console.warn("[MooLite] bad message:", e, data);
      }
    }

    // ---- Message handling (server -> client) ----
    function handleMessage(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === "welcome") {
        myId = msg.id;
        worldState = msg.state || worldState;
        // set local position from server authoritative player if available
        if (worldState.players && worldState.players[myId]) {
          const p = worldState.players[myId];
          local.x = p.x; local.y = p.y; local.hp = p.hp; local.inventory = p.inv || local.inventory;
        }
        addChat("System", `Joined as ${username}`);
      } else if (msg.type === "state") {
        snapshots.push({ t: Date.now(), players: msg.players || {}, nodes: msg.nodes || [], buildings: msg.buildings || [] });
        // keep small buffer for interpolation
        if (snapshots.length > 12) snapshots.shift();
        // reconcile local player
        if (msg.players && myId && msg.players[myId]) {
          const s = msg.players[myId];
          const d2 = (local.x - s.x) ** 2 + (local.y - s.y) ** 2;
          if (d2 > 900) { // if >30px difference snap closer
            local.x = s.x; local.y = s.y;
          }
          local.hp = s.hp;
          local.inventory = s.inv || local.inventory;
        }
      } else if (msg.type === "chat") {
        addChat(msg.fromName || "Anon", msg.text || "");
      } else if (msg.type === "playerLeft") {
        addChat("System", `${msg.name || msg.id} left`);
      }
    }

    // ---- Send input periodically ----
    let inputSeq = 0;
    setInterval(() => {
      if (!ws || ws.readyState !== 1) return;
      const dt = 100; // ms
      const payload = {
        type: "input",
        seq: ++inputSeq,
        dt,
        keys: { up: inputState.up, down: inputState.down, left: inputState.left, right: inputState.right },
        mouse: { x: inputState.mouse.x + cam.x, y: inputState.mouse.y + cam.y, down: inputState.mouse.down }
      };
      // optimistic local prediction
      applyLocalPrediction(payload, dt / 1000);
      try { ws.send(JSON.stringify(payload)); } catch (e) { console.warn(e); }
    }, 100);

    function applyLocalPrediction(input, secs) {
      const spd = CONFIG.PLAYER_SPEED;
      let vx = 0, vy = 0;
      if (input.keys.up) vy -= 1;
      if (input.keys.down) vy += 1;
      if (input.keys.left) vx -= 1;
      if (input.keys.right) vx += 1;
      const mag = Math.hypot(vx, vy) || 1;
      vx = vx / mag * spd;
      vy = vy / mag * spd;
      local.x = clamp(local.x + vx * secs, 0, CONFIG.WORLD_W);
      local.y = clamp(local.y + vy * secs, 0, CONFIG.WORLD_H);
    }

    // ---- UI events ----
    window.addEventListener("keydown", e => {
      if (e.key === "ArrowUp" || e.key === "w") inputState.up = true;
      if (e.key === "ArrowDown" || e.key === "s") inputState.down = true;
      if (e.key === "ArrowLeft" || e.key === "a") inputState.left = true;
      if (e.key === "ArrowRight" || e.key === "d") inputState.right = true;
      if (e.key === "Enter") chatInput && chatInput.focus();
    });
    window.addEventListener("keyup", e => {
      if (e.key === "ArrowUp" || e.key === "w") inputState.up = false;
      if (e.key === "ArrowDown" || e.key === "s") inputState.down = false;
      if (e.key === "ArrowLeft" || e.key === "a") inputState.left = false;
      if (e.key === "ArrowRight" || e.key === "d") inputState.right = false;
    });

    // mouse/touch input
    canvas.addEventListener("mousemove", e => {
      const r = canvas.getBoundingClientRect();
      inputState.mouse.x = e.clientX - r.left;
      inputState.mouse.y = e.clientY - r.top;
    });
    canvas.addEventListener("mousedown", e => {
      inputState.mouse.down = true;
      const worldX = inputState.mouse.x + cam.x, worldY = inputState.mouse.y + cam.y;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "action", action: "click", x: worldX, y: worldY }));
    });
    canvas.addEventListener("mouseup", () => { inputState.mouse.down = false; });
    canvas.addEventListener("touchstart", e => {
      const t = e.touches[0];
      const r = canvas.getBoundingClientRect();
      const mx = t.clientX - r.left, my = t.clientY - r.top;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "action", action: "tapMove", x: mx + cam.x, y: my + cam.y }));
    });

    // chat
    chatForm && chatForm.addEventListener("submit", e => {
      e.preventDefault();
      if (!chatInput) return;
      const text = String(chatInput.value || "").trim();
      if (!text) return;
      const clean = sanitize(text);
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "chat", text: clean }));
      chatInput.value = "";
    });

    // name set
    setNameBtn && setNameBtn.addEventListener("click", () => {
      const newName = (nameInput && nameInput.value.trim()) || username;
      username = newName;
      localStorage.setItem("moolite_name", username);
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "setName", name: username }));
    });

    // build buttons
    buildWallBtn && buildWallBtn.addEventListener("click", () => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "place", kind: "wall", x: local.x + 50, y: local.y }));
    });
    buildHomeBtn && buildHomeBtn.addEventListener("click", () => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "place", kind: "camp", x: local.x + 50, y: local.y }));
    });

    // ---- Rendering ----
    let lastFrame = performance.now();
    function loop(nowTime) {
      const dt = Math.min(64, nowTime - lastFrame) / 1000;
      lastFrame = nowTime;

      // camera following local player
      cam.x = clamp(local.x - cam.w / 2, 0, CONFIG.WORLD_W - cam.w);
      cam.y = clamp(local.y - cam.h / 2, 0, CONFIG.WORLD_H - cam.h);

      // clear
      ctx.fillStyle = "#092e2b";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      drawGrid();
      drawNodes();
      drawBuildings();
      drawPlayers();
      drawHUD();

      if (miniCtx) drawMinimap();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    function drawGrid() {
      ctx.strokeStyle = "rgba(255,255,255,0.02)";
      ctx.lineWidth = 1;
      const step = CONFIG.TILE_SIZE;
      const startX = - (cam.x % step);
      const startY = - (cam.y % step);
      for (let x = startX; x < canvas.width; x += step) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
      }
      for (let y = startY; y < canvas.height; y += step) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
      }
    }

    function getLatestSnapshot() {
      return snapshots[snapshots.length - 1] || { players: worldState.players, nodes: worldState.nodes || [], buildings: worldState.buildings || [] };
    }

    function drawNodes() {
      const snap = getLatestSnapshot();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "28px serif";
      for (const n of snap.nodes || []) {
        if (!inView(n.x, n.y)) continue;
        const sx = n.x - cam.x, sy = n.y - cam.y;
        let emoji = EMOJI.tree;
        if (n.type === "rock") emoji = EMOJI.rock;
        if (n.type === "berry") emoji = EMOJI.berry;
        if (n.type === "wood") emoji = EMOJI.wood;
        ctx.fillText(emoji, sx, sy);
        if (n.hp !== undefined) {
          const w = 36, h = 5; const px = sx - w / 2, py = sy + 22;
          ctx.fillStyle = "#333"; ctx.fillRect(px, py, w, h);
          ctx.fillStyle = "#6be76b"; ctx.fillRect(px, py, clamp((n.hp / Math.max(1, n.maxHp)) * w, 0, w), h);
        }
      }
    }

    function drawBuildings() {
      const snap = getLatestSnapshot();
      ctx.font = "28px serif";
      for (const b of snap.buildings || []) {
        if (!inView(b.x, b.y)) continue;
        const sx = b.x - cam.x, sy = b.y - cam.y;
        const emoji = b.kind === "wall" ? EMOJI.wall : EMOJI.camp;
        ctx.fillText(emoji, sx, sy);
      }
    }

    function drawPlayers() {
      const latest = getLatestSnapshot();
      const players = latest.players || {};
      for (const id in players) {
        const isMe = id === myId;
        let px = local.x, py = local.y, hp = local.hp, name = username;
        if (!isMe) {
          // attempt interpolation between last two snapshots
          if (snapshots.length >= 2) {
            const b = snapshots[snapshots.length - 2];
            const a = snapshots[snapshots.length - 1];
            const pa = a.players[id], pb = b.players[id];
            if (pa && pb) {
              const nowt = Date.now();
              const span = a.t - b.t || 1;
              const alpha = clamp((nowt - a.t + CONFIG.INTERP_MS) / CONFIG.INTERP_MS, 0, 1);
              px = pa.x * (1 - alpha) + pb.x * alpha;
              py = pa.y * (1 - alpha) + pb.y * alpha;
              hp = pa.hp; name = pa.name;
            } else if (pa) {
              px = pa.x; py = pa.y; hp = pa.hp; name = pa.name;
            }
          } else if (players[id]) {
            px = players[id].x; py = players[id].y; hp = players[id].hp; name = players[id].name;
          }
        } else {
          px = local.x; py = local.y; hp = local.hp; name = username;
        }

        if (!inView(px, py) && !isMe) continue;
        const sx = px - cam.x, sy = py - cam.y;
        ctx.beginPath();
        ctx.fillStyle = isMe ? "#ffd166" : "#9ad3bc";
        ctx.arc(sx, sy, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = "18px serif";
        ctx.fillText(EMOJI.player, sx, sy - 28);
        ctx.font = "12px sans-serif";
        ctx.fillStyle = "#ffffff";
        ctx.fillText(name, sx, sy - 40);
        const w = 40, h = 6;
        ctx.fillStyle = "#333"; ctx.fillRect(sx - w / 2, sy + 20, w, h);
        ctx.fillStyle = "#ff6b6b"; ctx.fillRect(sx - w / 2, sy + 20, clamp((hp / 100) * w, 0, w), h);
      }
    }

    function drawHUD() {
      ctx.font = "14px sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.textAlign = "left";
      ctx.fillText(`Players: ${Object.keys((getLatestSnapshot().players || {})).length}`, 10, 20);
    }

    function drawMinimap() {
      if (!miniCtx || !minimapCanvas) return;
      miniCtx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
      miniCtx.fillStyle = "#072a28";
      miniCtx.fillRect(0, 0, minimapCanvas.width, minimapCanvas.height);
      const sx = minimapCanvas.width / CONFIG.WORLD_W;
      const sy = minimapCanvas.height / CONFIG.WORLD_H;
      const snap = getLatestSnapshot();
      for (const n of snap.nodes || []) {
        miniCtx.fillStyle = n.type === "rock" ? "#aaaaaa" : "#4caf50";
        miniCtx.fillRect(n.x * sx, n.y * sy, 2, 2);
      }
      for (const b of snap.buildings || []) {
        miniCtx.fillStyle = "#c78900";
        miniCtx.fillRect(b.x * sx, b.y * sy, 3, 3);
      }
      for (const id in (snap.players || {})) {
        const p = snap.players[id];
        miniCtx.fillStyle = id === myId ? "#ffd166" : "#9ad3bc";
        miniCtx.fillRect(p.x * sx, p.y * sy, 3, 3);
      }
    }

    function inView(x, y) {
      return x > cam.x - CONFIG.VIEWPORT_PAD && x < cam.x + cam.w + CONFIG.VIEWPORT_PAD &&
        y > cam.y - CONFIG.VIEWPORT_PAD && y < cam.y + cam.h + CONFIG.VIEWPORT_PAD;
    }

    // ---- HUD updates and chat ----
    function updateHUD() {
      invWood && (invWood.textContent = local.inventory?.wood || 0);
      invStone && (invStone.textContent = local.inventory?.stone || 0);
      invFood && (invFood.textContent = local.inventory?.food || 0);

      if (!playersList) return;
      playersList.innerHTML = "";
      const latestPlayers = (getLatestSnapshot().players) || {};
      for (const id in latestPlayers) {
        const p = latestPlayers[id];
        const el = document.createElement("div");
        el.textContent = `${p.name} ${id === myId ? "(you)" : ""} — HP:${p.hp} K:${p.kills} W:${(p.inv && p.inv.wood) || 0}`;
        playersList.appendChild(el);
      }
    }
    setInterval(updateHUD, 300);

    function addChat(from, text) {
      if (!chatLog) return;
      const div = document.createElement("div");
      div.className = "msg";
      div.innerHTML = `<strong>${sanitize(String(from))}:</strong> ${sanitize(String(text))}`;
      chatLog.appendChild(div);
      chatLog.scrollTop = chatLog.scrollHeight;
    }

    // ---- simple helpers ----
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function sanitize(s) { return String(s).replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

    // ---- Connection status UI ----
    function createStatusElement() {
      // small floating status near top-left to help debugging
      const el = document.createElement("div");
      el.style.position = "fixed";
      el.style.left = "12px";
      el.style.top = "56px";
      el.style.padding = "6px 8px";
      el.style.background = "rgba(0,0,0,0.45)";
      el.style.borderRadius = "6px";
      el.style.color = "#bfe8e0";
      el.style.fontSize = "12px";
      el.style.zIndex = 9999;
      el.textContent = "Status: starting...";
      document.body.appendChild(el);
      return el;
    }
    function setStatus(txt) {
      if (connStatus) connStatus.textContent = `Status: ${txt}`;
      console.log("[MooLite] status:", txt);
    }

    // ---- start ----
    setStatus("Starting");
    connect();

    // keepalive / reconnect if ws dies (also attempts recon in close handler)
    setInterval(() => {
      if (!ws || ws.readyState > 1) {
        if (!ws || ws.readyState === WebSocket.CLOSED) {
          setStatus("Reconnecting...");
          connect();
        }
      } else {
        // send ping to keep connection alive
        try { ws.send(JSON.stringify({ type: "ping" })); } catch (e) { /* ignore */ }
      }
    }, 5000);

    // End init()
    console.log("[MooLite] client initialized");
  } // end init
})(); // end IIFE
