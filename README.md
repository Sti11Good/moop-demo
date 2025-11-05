# moop-demo
<!-- README.md -->
# MooLite — Small LAN Multiplayer Emoji Game

A tiny MooMoo-like local/LAN multiplayer game using emoji for graphics. Runs locally and on a LAN.

Features
- Top-down 2D canvas world with emoji resources (🌳, 🪨, 🍓, 🪵) and buildings (🧱, 🏠)
- Movement (WASD / arrows), left-click to harvest/attack/place
- Inventory (wood, stone, food), simple building placement and combat
- Server authoritative with WebSocket (ws), clients interpolate remote players
- Chat, scoreboard, minimap
- Single-page client (index.html + styles.css + script.js) and Node server (server.js)

Requirements
- Node.js (v14+ recommended)
- Network: devices must be on the same LAN to connect across devices

Setup and Run (quick)
1. Place the files (index.html, styles.css, script.js, server.js, README.md) in a folder.
2. Open a terminal in that folder.
3. Install dependencies:
   npm install express ws
4. Start server:
   node server.js
5. On the host machine open a browser to:
   http://localhost:3000
6. On another device in the same LAN open:
   http://<host-ip>:3000
   Replace <host-ip> with the local IP address of the machine running the server.

How to find your host IP
- Windows: run `ipconfig` in Command Prompt and look for IPv4 Address under your active adapter (e.g., 192.168.1.10).
- macOS / Linux: run `ifconfig` or `ip a` in Terminal and look for the local LAN IP (usually 192.168.x.x or 10.x.x.x).

Troubleshooting
- If other devices cannot connect, check firewall settings to allow Node.js / port 3000.
- If the page loads but players don't see each other, ensure both browsers loaded the same host address and there are no network isolation/VLANs.
- To change the port, set environment variable PORT before running:
  PORT=4000 node server.js

Protocol summary (JSON)
- Client -> Server:
  - join: {type:"join", name: "PlayerName"}
  - input: {type:"input", seq:number, dt:ms, keys:{up,down,left,right}, mouse:{x,y,down}}
  - chat: {type:"chat", text: string}
  - place: {type:"place", kind:"wall"|"camp", x, y}
  - action: {type:"action", action:"click"|"tapMove", x, y}
  - setName: {type:"setName", name: "NewName"}
- Server -> Client:
  - welcome: {type:"welcome", id, state, tick}
  - state: {type:"state", tick, players:{...}, nodes:[...], buildings:[...]}
  - chat: {type:"chat", fromName, text}
  - playerLeft: {type:"playerLeft", id, name}

Notes on networking & prediction
- Client predicts local movement for responsiveness and sends inputs to the server.
- Server is authoritative and sends periodic snapshots. Client applies simple reconciliation (snaps if large discrepancy).
- Remote players are interpolated between snapshots to reduce jitter.

Code structure & customization
- client: script.js (rendering, input, websocket client)
- server: server.js (express + ws, authoritative world)
- Adjust rates in server.js (SNAPSHOT_RATE, TICK_RATE) for more/less bandwidth.

License & credits
- Minimal demo created for local/LAN play and learning.
- No external images; uses emojis as textures.

Enjoy — play across devices on your local network!
