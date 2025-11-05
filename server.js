// server.js
/**
 * MooLite server (LAN-friendly)
 *
 * Key LAN fixes:
 * - Binds the HTTP server to 0.0.0.0 so it accepts connections from other machines on the same network.
 * - Prints likely LAN IP addresses on startup so you can connect from another device:
 *     http://<host-ip>:3000
 *
 * Usage:
 *  npm install express ws
 *  node server.js
 *
 * If other devices cannot connect, check firewall or router isolation settings.
 */

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const os = require("os");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// serve static files from current directory (index.html, styles.css, script.js, README.md)
app.use(express.static(path.join(__dirname)));

// create HTTP server and bind to 0.0.0.0 to accept LAN connections
const server = http.createServer(app);

// WebSocket server on path /ws
const wss = new WebSocket.Server({ server, path: "/ws" });

// ----- Simple authoritative world (kept intentionally small) -----
const WORLD = { W: 3000, H: 2000 };
const SNAPSHOT_RATE = 20; // Hz
const PLAYER_SPEED = 220;
const ACTION_RANGE = 80;

let nextPlayerId = 1;
let state = {
  players: {},
  nodes: [],
  buildings: []
};

// small set of resource types
const RES_NODE_TYPES = ["tree","rock","berry","wood"];

// seed nodes randomly
function seedNodes(){
  for(let i=0;i<80;i++){
    const type = RES_NODE_TYPES[Math.floor(Math.random()*RES_NODE_TYPES.length)];
    state.nodes.push({
      id: "n"+i,
      type,
      x: Math.random()*WORLD.W,
      y: Math.random()*WORLD.H,
      hp: 30 + Math.floor(Math.random()*50),
      maxHp: 30 + Math.floor(Math.random()*50),
      respawnAt: 0
    });
  }
}
seedNodes();

function createPlayer(name){
  const id = "p"+(nextPlayerId++);
  const p = {
    id,
    name: name || ("Player"+id),
    x: Math.random()*WORLD.W,
    y: Math.random()*WORLD.H,
    hp: 100,
    kills: 0,
    inv: {wood:0, stone:0, food:0},
    lastActive: Date.now()
  };
  state.players[id] = p;
  return p;
}

function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function sanitize(s){ return String(s).replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

// ----- WebSocket events -----
wss.on("connection", (ws, req) => {
  let pid = null;

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if(msg.type === "join"){
        const p = createPlayer(sanitize(msg.name || ("Player"+nextPlayerId)));
        pid = p.id;
        // welcome with full state snapshot
        ws.send(JSON.stringify({type:"welcome", id: p.id, state: snapshotState(), tick: Date.now()}));
        broadcast({type:"chat", fromName:"System", text:`${p.name} joined`});
      } else {
        // route other messages to handler
        if(!pid) return;
        const player = state.players[pid];
        if(!player) return;
        player.lastActive = Date.now();
        handleClientMessage(player, msg);
      }
    } catch (e){
      console.warn("Invalid WS message:", e);
    }
  });

  ws.on("close", () => {
    if(pid && state.players[pid]){
      const name = state.players[pid].name;
      delete state.players[pid];
      broadcast({type:"playerLeft", id: pid, name});
    }
  });
});

function handleClientMessage(player, msg){
  if(msg.type === "input"){
    const secs = (msg.dt || 100)/1000;
    let vx=0, vy=0;
    if(msg.keys.up) vy -= 1;
    if(msg.keys.down) vy += 1;
    if(msg.keys.left) vx -= 1;
    if(msg.keys.right) vx += 1;
    const mag = Math.hypot(vx,vy) || 1;
    vx = vx/mag*PLAYER_SPEED;
    vy = vy/mag*PLAYER_SPEED;
    player.x = clamp(player.x + vx*secs, 0, WORLD.W);
    player.y = clamp(player.y + vy*secs, 0, WORLD.H);
  } else if(msg.type === "chat"){
    const text = sanitize(String(msg.text || "")).slice(0,200);
    broadcast({type:"chat", fromName: player.name, text});
  } else if(msg.type === "place"){
    const kind = msg.kind;
    const cost = kind==="wall" ? {wood:5} : {wood:10, stone:5};
    const enough = Object.keys(cost).every(k=> (player.inv[k]||0) >= cost[k]);
    if(!enough) return;
    if(Math.hypot(player.x - msg.x, player.y - msg.y) > ACTION_RANGE) return;
    for(const k in cost) player.inv[k] -= cost[k];
    const b = {id: "b"+Date.now()+Math.random().toString(36).slice(2,6), kind: kind==="wall"?"wall":"camp", x: msg.x, y: msg.y, owner: player.id};
    state.buildings.push(b);
  } else if(msg.type === "action"){
    if(msg.action === "click"){
      const mx = msg.x, my = msg.y;
      // attack nearest player within small range
      for(const oid in state.players){
        if(oid === player.id) continue;
        const other = state.players[oid];
        if(Math.hypot(other.x - mx, other.y - my) < 40){
          other.hp -= 20;
          if(other.hp <= 0){
            player.kills = (player.kills || 0) + 1;
            const dropWood = Math.min(5, other.inv.wood || 0);
            player.inv.wood += Math.floor(dropWood/2);
            other.hp = 100;
            other.inv.wood = Math.max(0, (other.inv.wood || 0) - dropWood);
            other.x = Math.random()*WORLD.W; other.y = Math.random()*WORLD.H;
          }
          return;
        }
      }
      // otherwise harvest node
      for(const node of state.nodes){
        if(node.hp > 0 && Math.hypot(node.x - mx, node.y - my) < 50 && Math.hypot(player.x - node.x, player.y - node.y) < ACTION_RANGE){
          node.hp -= 15;
          if(node.hp <= 0){
            if(node.type === "tree"){ player.inv.wood = (player.inv.wood||0) + 5; }
            if(node.type === "rock"){ player.inv.stone = (player.inv.stone||0) + 3; }
            if(node.type === "berry"){ player.inv.food = (player.inv.food||0) + 4; }
            if(node.type === "wood"){ player.inv.wood = (player.inv.wood||0) + 8; }
            node.respawnAt = Date.now() + 30_000;
            node.hp = 0;
          }
          return;
        }
      }
    } else if(msg.action === "tapMove"){
      const dx = msg.x - player.x, dy = msg.y - player.y;
      const dist = Math.hypot(dx,dy);
      if(dist > 0){
        const factor = Math.min(1, 40/dist);
        player.x += dx * factor;
        player.y += dy * factor;
      }
    }
  } else if(msg.type === "setName"){
    player.name = String(msg.name || player.name).slice(0,16);
  }
}

function snapshotState(){
  const players = {};
  for(const id in state.players){
    const p = state.players[id];
    players[id] = {id: p.id, x: p.x, y: p.y, hp: p.hp, name: p.name, kills: p.kills, inv: p.inv};
  }
  const nodes = state.nodes.map(n => ({id:n.id, type:n.type, x:n.x, y:n.y, hp:n.hp, maxHp:n.maxHp, respawnAt:n.respawnAt}));
  const buildings = state.buildings.map(b => ({id:b.id, kind:b.kind, x:b.x, y:b.y, owner:b.owner}));
  return {players, nodes, buildings};
}

function broadcast(obj){
  const s = JSON.stringify(obj);
  wss.clients.forEach(c => {
    if(c.readyState === WebSocket.OPEN) c.send(s);
  });
}

// Respawn nodes when timer hits
function processRespawns(){
  const nowt = Date.now();
  for(const n of state.nodes){
    if(n.hp <= 0 && n.respawnAt && n.respawnAt <= nowt){
      n.hp = n.maxHp || (30 + Math.floor(Math.random()*50));
      n.respawnAt = 0;
      n.x = clamp(n.x + (Math.random()-0.5)*80, 0, WORLD.W);
      n.y = clamp(n.y + (Math.random()-0.5)*80, 0, WORLD.H);
    }
  }
}
setInterval(processRespawns, 1000);

// Snapshot broadcast
setInterval(()=>{
  const snap = snapshotState();
  broadcast({type:"state", tick: Date.now(), players: snap.players, nodes: snap.nodes, buildings: snap.buildings});
}, 1000 / SNAPSHOT_RATE);

// Helper: list likely LAN IPv4 addresses for convenience
function getLocalIPs(){
  const ifaces = os.networkInterfaces();
  const ips = [];
  for(const name in ifaces){
    for(const iface of ifaces[name]){
      if(iface.family === "IPv4" && !iface.internal){
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

// Start server and listen on 0.0.0.0
server.listen(PORT, "0.0.0.0", () => {
  const ips = getLocalIPs();
  console.log(`MooLite server listening on port ${PORT} (bound to 0.0.0.0)`);
  if(ips.length){
    console.log("Open the game in other devices on your LAN via:");
    ips.forEach(ip => console.log(`  http://${ip}:${PORT}`));
  } else {
    console.log("No LAN IPs found; connect on this machine at http://localhost:" + PORT);
  }
  console.log("If other devices cannot connect, check host firewall and ensure port", PORT, "is open.");
});
