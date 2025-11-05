// script.js
// Client-side game logic: rendering, input, websocket, interpolation, HUD.
// Wrapped to initialize after DOMContentLoaded to avoid null getContext errors.
// Emoji mapping used as "sprites" for nodes/buildings/players.

document.addEventListener("DOMContentLoaded", () => {

  const CONFIG = {
    TILE_SIZE: 48,
    WORLD_W: 3000,
    WORLD_H: 2000,
    SNAP_RATE: 1000 / 20,
    PLAYER_SPEED: 220,
    INTERP_MS: 120,
    RESOURCE_RESPAWN: 30_000,
    VIEWPORT_PAD: 80
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

  // ---- Basic DOM references (now safe) ----
  const canvas = document.getElementById("game");
  const ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
  const minimapCanvas = document.getElementById("minimap");
  const miniCtx = minimapCanvas && minimapCanvas.getContext ? minimapCanvas.getContext("2d") : null;
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

  if(!canvas || !ctx){
    console.error("Canvas #game not found or not supported in this browser.");
    return;
  }
  if(!minimapCanvas || !miniCtx){
    console.warn("Minimap not available; continuing without minimap.");
  }

  // ---- networking ----
  let ws;
  let myId = null;
  let serverTick = 0;
  let lastServerTime = Date.now();
  let pendingInputs = [];

  let worldState = { players: {}, nodes: [], buildings: [] };
  let snapshots = [];

  let local = { x: 100, y: 100, vx: 0, vy: 0, hp: 100, inventory:{wood:0,stone:0,food:0} };
  const inputState = {up:false,down:false,left:false,right:false,mouse:{x:0,y:0,down:false}};
  let cam = {x:0,y:0,w:800,h:600};
  let lastFrame = Date.now();

  // Resize handling
  function resize(){
    canvas.width = Math.max(300, window.innerWidth - 360);
    canvas.height = Math.max(300, window.innerHeight - 92);
    cam.w = canvas.width;
    cam.h = canvas.height;
  }
  window.addEventListener("resize", resize);
  resize();

  // ---- Utilities ----
  function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
  function now(){return Date.now();}
  function sanitize(text){ return String(text).replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  // ---- Networking connect ----
  function connect(){
    const url = `${location.protocol.replace("http","ws")}//${location.host}/ws`;
    ws = new WebSocket(url);
    ws.onopen = () => {
      ws.send(JSON.stringify({type:"join", name: username}));
    };
    ws.onmessage = (ev) => {
      try{
        const msg = JSON.parse(ev.data);
        handleMessage(msg);
      }catch(e){
        console.warn("Bad WS message", e);
      }
    };
    ws.onclose = ()=> {
      addChat("System","Disconnected from server");
      // attempt reconnect later (handled by keepalive)
    };
  }

  // ---- State & UI ----
  let username = localStorage.getItem("moolite_name") || ("Player" + Math.floor(Math.random()*999));
  nameInput.value = username;

  function handleMessage(msg){
    if(msg.type === "welcome"){
      myId = msg.id;
      worldState = msg.state;
      serverTick = msg.tick;
      lastServerTime = now();
      if(worldState.players[myId]){
        local.x = worldState.players[myId].x;
        local.y = worldState.players[myId].y;
        local.hp = worldState.players[myId].hp;
        local.inventory = {...worldState.players[myId].inv};
        updateHUD();
      }
      addChat("System","Joined as " + username);
    } else if(msg.type === "state"){
      snapshots.push({t: now(), tick: msg.tick, players: msg.players, nodes: msg.nodes, buildings: msg.buildings});
      if(snapshots.length > 12) snapshots.shift();
      if(msg.players && myId && msg.players[myId]){
        const s = msg.players[myId];
        const d2 = (local.x - s.x)**2 + (local.y - s.y)**2;
        if(d2 > 900) { // >30px
          local.x = s.x; local.y = s.y;
        }
        local.hp = s.hp;
        local.inventory = {...s.inv};
        updateHUD();
      }
    } else if(msg.type === "chat"){
      addChat(msg.fromName, msg.text);
    } else if(msg.type === "playerLeft"){
      addChat("System", `${msg.name} left`);
    }
  }

  // ---- Input sending ----
  let inputSeq = 0;
  setInterval(()=>{
    if(!ws || ws.readyState!==1) return;
    const dt = 100;
    const payload = {
      type:"input",
      seq: ++inputSeq,
      dt,
      keys: {up:inputState.up, down:inputState.down, left:inputState.left, right:inputState.right},
      mouse: {x: inputState.mouse.x + cam.x, y: inputState.mouse.y + cam.y, down: inputState.mouse.down}
    };
    applyLocalInputPrediction(payload, dt/1000);
    try { ws.send(JSON.stringify(payload)); } catch(e){}
  }, 100);

  function applyLocalInputPrediction(input, secs){
    const spd = CONFIG.PLAYER_SPEED;
    let vx = 0, vy = 0;
    if(input.keys.up) vy -= 1;
    if(input.keys.down) vy += 1;
    if(input.keys.left) vx -= 1;
    if(input.keys.right) vx += 1;
    const mag = Math.hypot(vx,vy) || 1;
    vx = vx / mag * spd;
    vy = vy / mag * spd;
    local.x = clamp(local.x + vx * secs, 0, CONFIG.WORLD_W);
    local.y = clamp(local.y + vy * secs, 0, CONFIG.WORLD_H);
  }

  // ---- Chat ----
  chatForm.addEventListener("submit", e=>{
    e.preventDefault();
    const text = chatInput.value.trim();
    if(!text) return;
    const clean = sanitize(text);
    if(ws && ws.readyState===1) ws.send(JSON.stringify({type:"chat", text: clean}));
    chatInput.value = "";
  });
  function addChat(from, text){
    if(!chatLog) return;
    const div = document.createElement("div");
    div.className = "msg";
    div.innerHTML = `<strong>${sanitize(from)}:</strong> ${sanitize(text)}`;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  // ---- UI actions ----
  setNameBtn.addEventListener("click", ()=>{
    username = nameInput.value.trim() || username;
    localStorage.setItem("moolite_name", username);
    if(ws && ws.readyState===1) ws.send(JSON.stringify({type:"setName", name: username}));
  });

  buildWallBtn.addEventListener("click", ()=>{
    const x = local.x + 50;
    const y = local.y;
    if(ws && ws.readyState===1) ws.send(JSON.stringify({type:"place", kind:"wall", x,y}));
  });
  buildHomeBtn.addEventListener("click", ()=>{
    const x = local.x + 50;
    const y = local.y;
    if(ws && ws.readyState===1) ws.send(JSON.stringify({type:"place", kind:"camp", x,y}));
  });

  function updateHUD(){
    if(invWood) invWood.textContent = local.inventory?.wood || 0;
    if(invStone) invStone.textContent = local.inventory?.stone || 0;
    if(invFood) invFood.textContent = local.inventory?.food || 0;

    const last = snapshots[snapshots.length-1];
    const players = last ? last.players : worldState.players;
    if(!playersList) return;
    playersList.innerHTML = "";
    for(const id in players){
      const p = players[id];
      const el = document.createElement("div");
      el.textContent = `${p.name} ${id===myId? "(you)": ""} — HP:${p.hp} K:${p.kills} W:${p.inv.wood || 0}`;
      playersList.appendChild(el);
    }
  }

  // ---- Input handling ----
  window.addEventListener("keydown", (e)=>{
    if(e.key === "ArrowUp" || e.key === "w") inputState.up = true;
    if(e.key === "ArrowDown" || e.key === "s") inputState.down = true;
    if(e.key === "ArrowLeft" || e.key === "a") inputState.left = true;
    if(e.key === "ArrowRight" || e.key === "d") inputState.right = true;
    if(e.key === "Enter") {
      chatInput.focus();
    }
  });
  window.addEventListener("keyup", (e)=>{
    if(e.key === "ArrowUp" || e.key === "w") inputState.up = false;
    if(e.key === "ArrowDown" || e.key === "s") inputState.down = false;
    if(e.key === "ArrowLeft" || e.key === "a") inputState.left = false;
    if(e.key === "ArrowRight" || e.key === "d") inputState.right = false;
  });

  canvas.addEventListener("mousemove", (e)=>{
    const rect = canvas.getBoundingClientRect();
    inputState.mouse.x = e.clientX - rect.left;
    inputState.mouse.y = e.clientY - rect.top;
  });
  canvas.addEventListener("mousedown", (e)=>{
    inputState.mouse.down = true;
    const worldX = inputState.mouse.x + cam.x;
    const worldY = inputState.mouse.y + cam.y;
    if(ws && ws.readyState===1) ws.send(JSON.stringify({type:"action", action:"click", x:worldX, y:worldY}));
  });
  canvas.addEventListener("mouseup", ()=>{ inputState.mouse.down = false; });
  canvas.addEventListener("touchstart", (e)=>{
    const t = e.touches[0];
    const rect = canvas.getBoundingClientRect();
    const mx = t.clientX - rect.left;
    const my = t.clientY - rect.top;
    const worldX = mx + cam.x;
    const worldY = my + cam.y;
    if(ws && ws.readyState===1) ws.send(JSON.stringify({type:"action", action:"tapMove", x:worldX, y:worldY}));
  });

  // ---- Rendering ----
  function gameLoop(){
    const t = now();
    const dt = Math.min(60, t - lastFrame) / 1000;
    lastFrame = t;

    cam.x = clamp(local.x - cam.w/2, 0, CONFIG.WORLD_W - cam.w);
    cam.y = clamp(local.y - cam.h/2, 0, CONFIG.WORLD_H - cam.h);

    ctx.clearRect(0,0,canvas.width,canvas.height);
    drawBackground();
    drawNodes();
    drawBuildings();
    drawPlayers();
    drawHUDOverlay();
    if(miniCtx) drawMinimap();
    requestAnimationFrame(gameLoop);
  }
  requestAnimationFrame(gameLoop);

  function drawBackground(){
    ctx.fillStyle = "#092e2b";
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.strokeStyle = "rgba(255,255,255,0.02)";
    ctx.lineWidth = 1;
    const step = CONFIG.TILE_SIZE;
    const startX = - (cam.x % step);
    const startY = - (cam.y % step);
    for(let x = startX; x < canvas.width; x += step){
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke();
    }
    for(let y = startY; y < canvas.height; y += step){
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); ctx.stroke();
    }
  }

  function getLatestSnapshot(){
    return snapshots[snapshots.length-1] || {players: worldState.players, nodes: worldState.nodes || [], buildings: worldState.buildings || []};
  }
  function drawNodes(){
    const snap = getLatestSnapshot();
    for(const n of snap.nodes || []){
      if(!isInView(n.x, n.y)) continue;
      const sx = n.x - cam.x;
      const sy = n.y - cam.y;
      ctx.font = "28px serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      let emoji = EMOJI.tree;
      if(n.type === "rock") emoji = EMOJI.rock;
      if(n.type === "berry") emoji = EMOJI.berry;
      if(n.type === "wood") emoji = EMOJI.wood;
      ctx.fillText(emoji, sx, sy);
      if(n.hp !== undefined){
        const w = 36, h = 5;
        const px = sx - w/2, py = sy + 22;
        ctx.fillStyle = "#333"; ctx.fillRect(px,py,w,h);
        ctx.fillStyle = "#6be76b"; ctx.fillRect(px,py,(Math.max(0,n.hp)/Math.max(1,n.maxHp))*w,h);
      }
    }
  }

  function drawBuildings(){
    const snap = getLatestSnapshot();
    for(const b of snap.buildings || []){
      if(!isInView(b.x, b.y)) continue;
      const sx = b.x - cam.x;
      const sy = b.y - cam.y;
      let emoji = b.kind === "wall" ? EMOJI.wall : EMOJI.camp;
      ctx.font = "28px serif";
      ctx.fillText(emoji, sx, sy);
    }
  }

  function drawPlayers(){
    const latest = snapshots[snapshots.length-1] || {players: worldState.players};
    for(const id in (latest.players || {})){
      const isMe = id === myId;
      let px=local.x, py=local.y, hp=local.hp, name = username, kills=0, inv = local.inventory;
      if(!isMe){
        if(snapshots.length >= 2){
          const b = snapshots[snapshots.length-2];
          const a = snapshots[snapshots.length-1];
          const pa = a.players[id];
          const pb = b.players[id];
          if(pa && pb){
            const ta = a.t, tb = b.t;
            const nowt = now();
            const span = ta - tb || 1;
            const alpha = clamp((nowt - ta + CONFIG.INTERP_MS)/CONFIG.INTERP_MS, 0, 1);
            px = pa.x * (1-alpha) + pb.x * alpha;
            py = pa.y * (1-alpha) + pb.y * alpha;
            hp = pa.hp; name = pa.name; kills = pa.kills; inv = pa.inv;
          } else if(pa){
            px = pa.x; py = pa.y; hp = pa.hp; name = pa.name; kills = pa.kills; inv = pa.inv;
          }
        } else {
          const st = worldState.players[id];
          if(st){ px = st.x; py = st.y; hp = st.hp; name = st.name; kills = st.kills; inv = st.inv; }
        }
      } else {
        px = local.x; py = local.y; hp = local.hp; name = username; inv = local.inventory;
      }

      if(!isInView(px,py) && !isMe) continue;
      const sx = px - cam.x;
      const sy = py - cam.y;
      ctx.beginPath();
      ctx.fillStyle = isMe ? "#ffd166" : "#9ad3bc";
      ctx.arc(sx, sy, 16, 0, Math.PI*2);
      ctx.fill();
      ctx.font = "18px serif";
      ctx.textAlign = "center";
      ctx.fillText(EMOJI.player, sx, sy - 28);
      ctx.font = "12px sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(name, sx, sy - 40);
      const w = 40, h = 6;
      ctx.fillStyle = "#333"; ctx.fillRect(sx - w/2, sy + 20, w, h);
      ctx.fillStyle = "#ff6b6b"; ctx.fillRect(sx - w/2, sy + 20, (Math.max(0,hp)/100)*w, h);
    }
  }

  function drawHUDOverlay(){
    ctx.font = "14px sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.textAlign = "left";
    ctx.fillText(`Players: ${Object.keys((snapshots[snapshots.length-1]||{players:worldState.players}).players || worldState.players).length}`, 10, 20);
  }

  function drawMinimap(){
    if(!miniCtx || !minimapCanvas) return;
    const w = minimapCanvas.width, h = minimapCanvas.height;
    miniCtx.clearRect(0,0,w,h);
    miniCtx.fillStyle = "#072a28";
    miniCtx.fillRect(0,0,w,h);
    const sx = w / CONFIG.WORLD_W;
    const sy = h / CONFIG.WORLD_H;
    const snap = getLatestSnapshot();
    for(const n of snap.nodes || []){
      miniCtx.fillStyle = n.type==="rock"?"#aaaaaa":"#4caf50";
      miniCtx.fillRect(n.x*sx, n.y*sy, 3, 3);
    }
    for(const b of snap.buildings || []){
      miniCtx.fillStyle = "#c78900";
      miniCtx.fillRect(b.x*sx, b.y*sy, 4, 4);
    }
    for(const id in (snap.players || {})){
      const p = snap.players[id];
      miniCtx.fillStyle = id===myId? "#ffd166" : "#9ad3bc";
      miniCtx.fillRect(p.x*sx, p.y*sy, 4, 4);
    }
  }

  function isInView(x,y){
    return x > cam.x - CONFIG.VIEWPORT_PAD && x < cam.x + cam.w + CONFIG.VIEWPORT_PAD &&
           y > cam.y - CONFIG.VIEWPORT_PAD && y < cam.y + cam.h + CONFIG.VIEWPORT_PAD;
  }

  // Periodic HUD update
  setInterval(updateHUD, 300);

  // Keepalive / reconnect
  setInterval(()=>{
    if(!ws || ws.readyState > 1){
      connect();
    } else {
      try{ ws.send(JSON.stringify({type:"ping"})); }catch(e){}
    }
  }, 5000);

  // Start connection
  connect();

});
