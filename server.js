// server.js
/**
 * Simple authoritative game server for MooLite:
 * - Serves static files via express
 * - Provides a WebSocket endpoint for game clients using 'ws'
 *
 * Run:
 *  npm install express ws
 *  node server.js
 *
 * Protocol (JSON messages):
 * Client -> Server:
 *  - {type:"join", name: "PlayerName"}
 *  - {type:"input", seq: number, dt: ms, keys:{up,down,left,right}, mouse:{x,y,down}}
 *  - {type:"chat", text: string}
 *  - {type:"place", kind:"wall"|"camp", x, y}
 *  - {type:"action", action:"click"|"tapMove", x, y}
 *
 * Server -> Client:
 *  - {type:"welcome", id, state, tick}
 *  - {type:"state", tick, players:{...}, nodes:[...], buildings:[...]}
 *  - {type:"chat", fromName, text}
 *  - {type:"playerLeft", id, name}
 *
 * Server authoritative rules:
 * - Validates distances for actions/placing (max 80 px)
 * - Nodes respawn on timers
 * - Broadcasts snapshots at SNAPSHOT_RATE
 *
 * Configuration below.
 */
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const app = express();

const PORT = process.env.PORT || 3000;
app.use(express.static(__dirname)); // serve index.html, styles.css, script.js, README.md

const server = http.createServer(app);
const wss = new WebSocket.Server({server, path: "/ws"});

// Game world config
const WORLD = {W:3000, H:2000};
const SNAPSHOT_RATE = 20; // Hz
const TICK_RATE = 20; // server physics ticks per second
const PLAYER_SPEED = 220; // px per second
const ACTION_RANGE = 80; // px
const RES_NODE_TYPES = ["tree","rock","berry","wood"];

let nextPlayerId = 1;
let clients = new Map(); // ws -> playerId

// Authoritative state
let state = {
  players: {},    // id -> {id,x,y,hp,name,kills,inv,lastActive,spawnAt}
  nodes: [],      // resource nodes {id,type,x,y,hp,maxHp,respawnAt}
  buildings: []   // {id,kind,x,y,owner}
};

// Create initial random nodes
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
    lastActive: Date.now(),
    spawnAt: 0
  };
  state.players[id] = p;
  return p;
}

// Minimal distance helper
function dist(a,b){ return Math.hypot(a.x - b.x, a.y - b.y); }

// WebSocket handling
wss.on("connection", (ws, req) => {
  let pid = null;
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      handleClientMessage(ws, msg);
    } catch(e){
      console.warn("Invalid message", e);
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

function handleClientMessage(ws, msg){
  if(msg.type === "join"){
    const p = createPlayer(msg.name);
    clients.set(ws, p.id);
    // send welcome with full state
    ws.send(JSON.stringify({type:"welcome", id: p.id, state: snapshotState(), tick: Date.now()}));
    // notify others
    broadcast({type:"chat", fromName:"System", text: `${p.name} joined`});
  } else {
    const pid = clients.get(ws);
    const player = state.players[pid];
    if(!player) return;
    player.lastActive = Date.now();

    if(msg.type === "input"){
      // Basic movement integration server-side for authoritative correction
      // msg.dt in ms
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
      // handle mouse down action: attack/harvest (we process 'action' messages instead)
    } else if(msg.type === "chat"){
      const text = sanitize(msg.text).slice(0,200);
      broadcast({type:"chat", fromName: player.name, text});
    } else if(msg.type === "place"){
      // validate resources & range
      const kind = msg.kind;
      const cost = kind==="wall" ? {wood:5} : {wood:10, stone:5};
      const enough = Object.keys(cost).every(k=> (player.inv[k]||0) >= cost[k]);
      if(!enough) return;
      const dx = player.x - msg.x, dy = player.y - msg.y;
      if(Math.hypot(dx,dy) > ACTION_RANGE) return;
      // consume resources
      for(const k in cost) player.inv[k] -= cost[k];
      const b = {id: "b"+Date.now()+Math.random().toString(36).slice(2,6), kind: kind==="wall"?"wall":"camp", x: msg.x, y: msg.y, owner: player.id};
      state.buildings.push(b);
    } else if(msg.type === "action"){
      if(msg.action === "click"){
        // find node within range
        const mpos = {x: msg.x, y: msg.y};
        // check players first (attack)
        for(const oid in state.players){
          if(oid === player.id) continue;
          const other = state.players[oid];
          if(Math.hypot(other.x - mpos.x, other.y - mpos.y) < 40){
            // attack!
            other.hp -= 20;
            if(other.hp <= 0){
              player.kills = (player.kills || 0) + 1;
              // drop some resources
              const dropWood = Math.min(5, other.inv.wood || 0);
              player.inv.wood += Math.floor(dropWood/2);
              // respawn other
              other.hp = 100;
              other.inv.wood = Math.max(0, (other.inv.wood || 0) - dropWood);
              other.x = Math.random()*WORLD.W; other.y = Math.random()*WORLD.H;
            }
            return;
          }
        }
        // otherwise attempt harvest node
        for(const node of state.nodes){
          if(node.hp > 0 && Math.hypot(node.x - mpos.x, node.y - mpos.y) < 50 && Math.hypot(player.x - node.x, player.y - node.y) < ACTION_RANGE){
            node.hp -= 15;
            if(node.hp <= 0){
              // give resources based on type
              if(node.type === "tree"){ player.inv.wood = (player.inv.wood||0) + 5; }
              if(node.type === "rock"){ player.inv.stone = (player.inv.stone||0) + 3; }
              if(node.type === "berry"){ player.inv.food = (player.inv.food||0) + 4; }
              if(node.type === "wood"){ player.inv.wood = (player.inv.wood||0) + 8; }
              // set respawn
              node.respawnAt = Date.now() + 30_000;
              node.hp = 0;
              node.maxHp = node.maxHp;
            }
            return;
          }
        }
      } else if(msg.action === "tapMove"){
        // simple teleport-ish command for mobile: server nudges player toward tapped point slightly
        const dx = msg.x - player.x, dy = msg.y - player.y;
        const dist = Math.hypot(dx,dy);
        if(dist > 0){
          const factor = Math.min(1, 40/dist);
          player.x += dx * factor;
          player.y += dy * factor;
        }
      }
    } else if(msg.type === "setName"){
      player.name = String(msg.name).slice(0,16);
    } else if(msg.type === "ping"){
      // ignore
    }
  }
}

// broadcast helper
function broadcast(obj){
  const s = JSON.stringify(obj);
  wss.clients.forEach(c => {
    if(c.readyState === WebSocket.OPEN) c.send(s);
  });
}

// snapshot of state sent to clients
function snapshotState(){
  // shallow copy but small
  const players = {};
  for(const id in state.players){
    const p = state.players[id];
    players[id] = {id: p.id, x: p.x, y: p.y, hp: p.hp, name: p.name, kills: p.kills, inv: p.inv};
  }
  // send nodes & buildings simply
  const nodes = state.nodes.map(n => ({id:n.id,type:n.type,x:n.x,y:n.y,hp:n.hp,maxHp:n.maxHp,respawnAt:n.respawnAt}));
  const buildings = state.buildings.map(b => ({id:b.id,kind:b.kind,x:b.x,y:b.y,owner:b.owner}));
  return {players, nodes, buildings};
}

// Respawn nodes when timer hits
function processRespawns(){
  const nowt = Date.now();
  for(const n of state.nodes){
    if(n.hp <= 0 && n.respawnAt && n.respawnAt <= nowt){
      n.hp = n.maxHp || (30 + Math.floor(Math.random()*50));
      n.respawnAt = 0;
      // randomize position slightly to reduce stacking
      n.x = clamp(n.x + (Math.random()-0.5)*80, 0, WORLD.W);
      n.y = clamp(n.y + (Math.random()-0.5)*80, 0, WORLD.H);
    }
  }
}

// Regular tick loop for server-side authoritative updates
setInterval(()=>{
  // process respawns
  processRespawns();
  // simple inactivity cleanup
  const cutoff = Date.now() - 1000*60*10;
  for(const id in state.players){
    if(state.players[id].lastActive < cutoff){
      delete state.players[id];
      broadcast({type:"playerLeft", id, name: state.players[id]?.name || id});
    }
  }
}, 1000);

// Snapshot broadcast loop
setInterval(()=>{
  const snap = snapshotState();
  broadcast({type:"state", tick: Date.now(), players: snap.players, nodes: snap.nodes, buildings: snap.buildings});
}, 1000 / SNAPSHOT_RATE);

// Simple helper functions
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function sanitize(s){ return String(s).replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

// Start server
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
  console.log(`Open http://<host-ip>:${PORT} on other devices in LAN to play`);
});
