// script.js
// Client-side game logic: rendering, input, websocket, interpolation, HUD.
// Emoji mapping used as "sprites" for nodes/buildings/players.
const CONFIG = {
  TILE_SIZE: 48,      // purely visual scale
  WORLD_W: 3000,
  WORLD_H: 2000,
  SNAP_RATE: 1000 / 20, // ms between snapshots expected (server ~=20Hz)
  PLAYER_SPEED: 220,  // px per second
  INTERP_MS: 120,     // interpolation buffer for players
  RESOURCE_RESPAWN: 30_000, // server-side but client may use for display
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

// ---- Basic DOM references ----
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const minimapCanvas = document.getElementById("minimap");
const miniCtx = minimapCanvas.getContext("2d");
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

// ---- networking ----
let ws;
let myId = null;
let serverTick = 0;
let lastServerTime = Date.now();
let pendingInputs = []; // for client-side prediction (simple)
let username = localStorage.getItem("moolite_name") || ("Player" + Math.floor(Math.random()*999));
nameInput.value = username;

// Client-side state mirrored from server snapshots
let worldState = {
  players: {},    // id -> {x,y,hp,name,kills,inv}
  nodes: [],      // resources/buildings
  buildings: []
};

// Client interpolation buffer for remote players
let snapshots = []; // each snapshot: {t, players, nodes, buildings}

// Local predicted state for local player (quick immediate movement)
let local = {
  x: 100, y: 100, vx: 0, vy: 0, hp: 100, inventory:{wood:0,stone:0,food:0}
};

// Input state
const inputState = {up:false,down:false,left:false,right:false,mouse:{x:0,y:0,down:false}};

// Camera
let cam = {x:0,y:0,w:800,h:600};

// Resize handling
function resize(){
  canvas.width = window.innerWidth - 360;
  canvas.height = window.innerHeight - 92;
  cam.w = canvas.width;
  cam.h = canvas.height;
}
window.addEventListener("resize", resize);

// ---- Utilities ----
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function now(){return Date.now();}

// Sanitize chat text simply by escaping <>
function sanitize(text){ return text.replace(/</g, "&lt;").replace(/>/g,"&gt;"); }

// ---- Networking: message format (JSON) ----
// Outgoing types:
// - join: {type:"join", name: string}
// - input: {type:"input", seq: number, dt:ms, keys:{up,down,left,right}, mouse:{x,y,down} }
// - chat: {type:"chat", text: string}
// - place: {type:"place", kind:"wall"|"camp", x, y}
// Incoming types:
// - welcome: {type:"welcome", id, state, tick}
// - state: {type:"state", tick, players:{}, nodes:[], buildings:[]}
// - chat: {type:"chat", fromName, text}
// - died/res: small messages (handled in state)

/* Connect to server */
function connect(){
  const url = `${location.protocol.replace("http","ws")}//${location.host}/ws`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    console.log("ws open, sending join");
    ws.send(JSON.stringify({type:"join", name: username}));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    handleMessage(msg);
  };
  ws.onclose = ()=> {
    addChat("System","Disconnected from server");
  };
}
connect();

// Handle incoming messages
function handleMessage(msg){
  if(msg.type === "welcome"){
    myId = msg.id;
    // initial authoritative state
    worldState = msg.state;
    serverTick = msg.tick;
    lastServerTime = now();
    // place local predicted position from server
    if(worldState.players[myId]){
      local.x = worldState.players[myId].x;
      local.y = worldState.players[myId].y;
      local.hp = worldState.players[myId].hp;
      local.inventory = {...worldState.players[myId].inv};
      updateHUD();
    }
    addChat("System","Joined as " + username);
  } else if(msg.type === "state"){
    // keep snapshots for interpolation
    snapshots.push({t: now(), tick: msg.tick, players: msg.players, nodes: msg.nodes, buildings: msg.buildings});
    // keep last 10
    if(snapshots.length > 10) snapshots.shift();
    // reconcile local player: accept authoritative position & HP
    if(msg.players[myId]){
      const s = msg.players[myId];
      // simple reconciliation: snap local to server if far
      const d2 = (local.x - s.x)**2 + (local.y - s.y)**2;
      if(d2 > 400) { // if >20px difference
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

// ---- Send inputs at fixed rate ----
let inputSeq = 0;
setInterval(()=>{
  if(!ws || ws.readyState!==1) return;
  const dt = 100; // ms chunk
  const payload = {
    type:"input",
    seq: ++inputSeq,
    dt,
    keys: {up:inputState.up, down:inputState.down, left:inputState.left, right:inputState.right},
    mouse: {x: inputState.mouse.x + cam.x, y: inputState.mouse.y + cam.y, down: inputState.mouse.down}
  };
  // client-side prediction for local player
  applyLocalInputPrediction(payload, dt/1000);
  ws.send(JSON.stringify(payload));
}, 100);

// Apply immediate local movement prediction for responsiveness
function applyLocalInputPrediction(input, secs){
  const spd = CONFIG.PLAYER_SPEED;
  let vx = 0, vy = 0;
  if(input.keys.up) vy -= 1;
  if(input.keys.down) vy += 1;
  if(input.keys.left) vx -= 1;
  if(input.keys.right) vx += 1;
  // normalize
  const mag = Math.hypot(vx,vy) || 1;
  vx = vx / mag * spd;
  vy = vy / mag * spd;
  local.x += vx * secs;
  local.y += vy * secs;
  // clamp world
  local.x = clamp(local.x, 0, CONFIG.WORLD_W);
  local.y = clamp(local.y, 0, CONFIG.WORLD_H);
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

// Display chat messages
function addChat(from, text){
  const div = document.createElement("div");
  div.className = "msg";
  div.innerHTML = `<strong>${sanitize(from)}:</strong> ${sanitize(text)}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// ---- HUD / UI actions ----
setNameBtn.addEventListener("click", ()=>{
  username = nameInput.value.trim() || username;
  localStorage.setItem("moolite_name", username);
  if(ws && ws.readyState===1) ws.send(JSON.stringify({type:"setName", name: username}));
});

buildWallBtn.addEventListener("click", ()=>{
  // request place at mouse position (center)
  const x = local.x + 50;
  const y = local.y;
  if(ws && ws.readyState===1) ws.send(JSON.stringify({type:"place", kind:"wall", x,y}));
});
buildHomeBtn.addEventListener("click", ()=>{
  const x = local.x + 50;
  const y = local.y;
  if(ws && ws.readyState===1) ws.send(JSON.stringify({type:"place", kind:"camp", x,y}));
});

// Update inventory display and players list
function updateHUD(){
  invWood.textContent = local.inventory?.wood || 0;
  invStone.textContent = local.inventory?.stone || 0;
  invFood.textContent = local.inventory?.food || 0;

  // players list from latest snapshot if available
  const last = snapshots[snapshots.length-1];
  const players = last ? last.players : worldState.players;
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

// Mouse & touch
canvas.addEventListener("mousemove", (e)=>{
  const rect = canvas.getBoundingClientRect();
  inputState.mouse.x = e.clientX - rect.left;
  inputState.mouse.y = e.clientY - rect.top;
});
canvas.addEventListener("mousedown", (e)=>{
  inputState.mouse.down = true;
  // On click, send an action to server: attempt harvest/attack at world pos
  const worldX = inputState.mouse.x + cam.x;
  const worldY = inputState.mouse.y + cam.y;
  if(ws && ws.readyState===1) ws.send(JSON.stringify({type:"action", action:"click", x:worldX, y:worldY}));
});
canvas.addEventListener("mouseup", (e)=>{ inputState.mouse.down = false; });

// Mobile touch move: set destination by tapping
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
let lastFrame = now();
function gameLoop(){
  const t = now();
  const dt = Math.min(60, t - lastFrame) / 1000;
  lastFrame = t;

  // update camera to center on predicted local player
  cam.x = clamp(local.x - cam.w/2, 0, CONFIG.WORLD_W - cam.w);
  cam.y = clamp(local.y - cam.h/2, 0, CONFIG.WORLD_H - cam.h);

  // render world
  ctx.clearRect(0,0,canvas.width,canvas.height);
  drawBackground();
  drawNodes();
  drawBuildings();
  drawPlayers();
  drawHUDOverlay();

  // minimap
  drawMinimap();

  requestAnimationFrame(gameLoop);
}
window.addEventListener("load", ()=>{
  resize();
  gameLoop();
});

// Simple background grid/ground
function drawBackground(){
  // draw faint grid
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

// Draw resource nodes (from latest snapshot)
function getLatestSnapshot(){
  return snapshots[snapshots.length-1] || {players: worldState.players, nodes: worldState.nodes || [], buildings: worldState.buildings || []};
}
function drawNodes(){
  const snap = getLatestSnapshot();
  for(const n of snap.nodes){
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
    // health bar for node
    if(n.hp !== undefined){
      const w = 36, h = 5;
      const px = sx - w/2, py = sy + 22;
      ctx.fillStyle = "#333"; ctx.fillRect(px,py,w,h);
      ctx.fillStyle = "#6be76b"; ctx.fillRect(px,py,(n.hp/n.maxHp)*w,h);
    }
  }
}

function drawBuildings(){
  const snap = getLatestSnapshot();
  for(const b of snap.buildings){
    if(!isInView(b.x, b.y)) continue;
    const sx = b.x - cam.x;
    const sy = b.y - cam.y;
    let emoji = b.kind === "wall" ? EMOJI.wall : EMOJI.camp;
    ctx.font = "28px serif";
    ctx.fillText(emoji, sx, sy);
  }
}

// Draw players (interpolated for others, local predicted for self)
function drawPlayers(){
  // Interpolate each remote player using two latest snapshots
  const snapCount = snapshots.length;
  const latest = snapshots[snapCount-1];
  for(const id in (latest? latest.players : worldState.players)){
    const isMe = id === myId;
    let px=local.x, py=local.y, hp=local.hp, name = username, kills=0, inv = local.inventory;
    if(!isMe){
      // try to interpolate using two latest
      if(snapshots.length >= 2){
        const b = snapshots[snapshots.length-2];
        const a = snapshots[snapshots.length-1];
        const pa = a.players[id];
        const pb = b.players[id];
        if(pa && pb){
          // linear interpolation based on time between snapshots
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
    // body
    ctx.beginPath();
    ctx.fillStyle = isMe ? "#ffd166" : "#9ad3bc";
    ctx.arc(sx, sy, 16, 0, Math.PI*2);
    ctx.fill();
    // emoji label
    ctx.font = "18px serif";
    ctx.textAlign = "center";
    ctx.fillText(EMOJI.player, sx, sy - 28);
    // name
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(name, sx, sy - 40);
    // health bar
    const w = 40, h = 6;
    ctx.fillStyle = "#333"; ctx.fillRect(sx - w/2, sy + 20, w, h);
    ctx.fillStyle = "#ff6b6b"; ctx.fillRect(sx - w/2, sy + 20, (hp/100)*w, h);
  }
}

// Draw optional crosshair or action reticule
function drawHUDOverlay(){
  ctx.font = "14px sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.textAlign = "left";
  ctx.fillText(`Ping: ~${Math.round(Math.random()*50)}ms`, 10, 20); // rough
}

// Minimap
function drawMinimap(){
  const w = minimapCanvas.width, h = minimapCanvas.height;
  miniCtx.clearRect(0,0,w,h);
  // background
  miniCtx.fillStyle = "#072a28";
  miniCtx.fillRect(0,0,w,h);
  // scale
  const sx = w / CONFIG.WORLD_W;
  const sy = h / CONFIG.WORLD_H;
  // draw nodes
  const snap = getLatestSnapshot();
  for(const n of snap.nodes){
    miniCtx.fillStyle = n.type==="rock"?"#aaaaaa":"#4caf50";
    miniCtx.fillRect(n.x*sx, n.y*sy, 3, 3);
  }
  // buildings
  for(const b of snap.buildings){
    miniCtx.fillStyle = "#c78900";
    miniCtx.fillRect(b.x*sx, b.y*sy, 4, 4);
  }
  // players
  for(const id in (snap.players || {})){
    const p = snap.players[id];
    miniCtx.fillStyle = id===myId? "#ffd166" : "#9ad3bc";
    miniCtx.fillRect(p.x*sx, p.y*sy, 4, 4);
  }
}

// Check if world position inside view plus padding
function isInView(x,y){
  return x > cam.x - CONFIG.VIEWPORT_PAD && x < cam.x + cam.w + CONFIG.VIEWPORT_PAD &&
         y > cam.y - CONFIG.VIEWPORT_PAD && y < cam.y + cam.h + CONFIG.VIEWPORT_PAD;
}

// Periodically update HUD from latest snapshot
setInterval(updateHUD, 250);

// Keepalive / reconnect logic
setInterval(()=>{
  if(!ws || ws.readyState > 1){
    connect();
  } else {
    try{ ws.send(JSON.stringify({type:"ping"})); }catch(e){}
  }
}, 5000);
