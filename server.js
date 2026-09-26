const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const TOTAL_ROUNDS = 5;
const TICK_HZ = 30;
const DT = 1 / TICK_HZ;
const AVATARS = ['😎','😂','🤡','🗿','👻','🐸','🦄','🐙','🍕','👽'];

const GAME_INFO = {
  race:    { name:'CRAZY RACE',      emoji:'🏁', howto:'Move up! Avoid red blocks, grab boosts, ice is slippery.' },
  chaos:   { name:"DON'T LAUGH",     emoji:'😂', howto:'Tap the right colour. WAIT / DON\'T PRESS = do nothing!' },
  memory:  { name:'MEMORY CHAOS',    emoji:'🧠', howto:'Memorise the order, then tap it back.' },
  finger:  { name:'FASTEST FINGER',  emoji:'⚡', howto:'Tap when it turns GREEN. Early tap = penalty.' },
  troll:   { name:'TROLL BUTTON',    emoji:'🎲', howto:'Risky buttons. Some help, some hurt.' },
  saboteur:{ name:'SECRET SABOTEUR', emoji:'🕵️', howto:'Tap to repair. One player is secretly a saboteur.' },
  floor:   { name:'FALLING FLOOR',   emoji:'🕳️', howto:'Tiles flash then fall. Last one standing wins.' },
  team:    { name:'TEAM CHAOS',      emoji:'🤝', howto:'Collect stars with your team. Most stars wins.' }
};
const ALL_GAMES = Object.keys(GAME_INFO);

const server = http.createServer((req, res) => {
  const p = (req.url || '/').split('?')[0];
  if (p === '/' || p === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('index.html missing'); return; }
      res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
      res.end(data);
    });
  } else { res.writeHead(404); res.end('Not found'); }
});
const wss = new WebSocketServer({ server });

const rooms = new Map();
let nextPlayerId = 1;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randCode() {
  let s;
  do { s = ''; for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; }
  while (rooms.has(s));
  return s;
}
function cleanNick(s) {
  if (typeof s !== 'string') return null;
  s = s.trim().replace(/[<>&"']/g, '').slice(0, 12);
  return s.length ? s : null;
}
const now = () => Date.now();

class Room {
  constructor(code) {
    this.code = code; this.players = []; this.hostId = null;
    this.phase = 'lobby'; this.round = 0; this.usedGames = [];
    this.currentGame = null; this.gameState = null;
    this.timers = []; this.tick = null; this.playDur = 0;
    this.lastExtra = null; this.destroyed = false;
  }
  addPlayer(ws, name, avatar) {
    const connected = this.players.filter(p => p.connected);
    if (connected.length >= MAX_PLAYERS) return { error: 'Room is full.' };
    if (connected.some(p => p.name.toLowerCase() === name.toLowerCase())) return { error: 'Nickname already taken.' };
    if (this.phase === 'playing' || this.phase === 'results') return { error: 'Game already in progress.' };
    const id = 'p' + (nextPlayerId++);
    const p = { id, name, avatar: avatar || AVATARS[0], ready: false, connected: true, ws, score: 0, input: { x: 0, y: 0 } };
    this.players.push(p);
    if (!this.hostId) this.hostId = id;
    return { player: p };
  }
  removePlayer(id) {
    const p = this.players.find(x => x.id === id);
    if (!p) return;
    p.connected = false; p.ws = null; p.ready = false;
    if (this.hostId === id) {
      const next = this.players.find(x => x.connected);
      if (next) this.hostId = next.id;
    }
    if (this.gameState && Array.isArray(this.gameState.players)) {
      this.gameState.players = this.gameState.players.filter(gp => gp.id !== id);
    }
    this.broadcastLobby();
    const anyConn = this.players.some(x => x.connected);
    if (!anyConn) setTimeout(() => { if (!this.destroyed && !this.players.some(x => x.connected)) this.destroy(); }, 60000);
    if (this.phase === 'playing' && this.players.filter(x => x.connected).length < 1) this.endRound();
  }
  destroy() { this.destroyed = true; this.clearAll(); rooms.delete(this.code); }
  clearAll() { this.timers.forEach(t => clearTimeout(t)); this.timers = []; if (this.tick) { clearInterval(this.tick); this.tick = null; } }
  schedule(fn, ms) { const t = setTimeout(() => { if (this.destroyed) return; try { fn(); } catch(e){ console.error(e); } }, ms); this.timers.push(t); return t; }
  getPublic() { return this.players.map(p => ({ id:p.id, name:p.name, avatar:p.avatar, ready:p.ready, connected:p.connected, score:p.score })); }
  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const p of this.players) if (p.connected && p.ws && p.ws.readyState === 1) { try { p.ws.send(s); } catch(e){} }
  }
  sendTo(id, obj) { const p = this.players.find(x => x.id === id); if (p && p.ws && p.ws.readyState === 1) { try { p.ws.send(JSON.stringify(obj)); } catch(e){} } }
  broadcastLobby() { this.broadcast({ t:'lobby', code:this.code, hostId:this.hostId, max:MAX_PLAYERS, players:this.getPublic() }); }
  pop(text, kind) { this.broadcast({ t:'pop', text, kind }); }
  toast(msg, kind) { this.broadcast({ t:'toast', msg, kind }); }
  award(id, delta) { const p = this.players.find(x => x.id === id); if (!p) return; p.score += delta; p.lastDelta = (p.lastDelta || 0) + delta; }
  startMatch() {
    const conn = this.players.filter(p => p.connected);
    if (conn.length < 2) return;
    this.phase = 'playing'; this.round = 0; this.usedGames = [];
    this.players.forEach(p => { p.score = 0; p.lastDelta = 0; });
    this.nextRound();
  }
  nextRound() {
    this.round++;
    if (this.round > TOTAL_ROUNDS) { this.endMatch(); return; }
    const avail = ALL_GAMES.filter(g => !this.usedGames.includes(g));
    if (!avail.length) { this.endMatch(); return; }
    const game = avail[Math.floor(Math.random() * avail.length)];
    this.usedGames.push(game); this.currentGame = game;
    const info = GAME_INFO[game];
    this.broadcast({ t:'round', round:this.round, total:TOTAL_ROUNDS, game, name:info.name, emoji:info.emoji, howto:info.howto });
    this.schedule(() => this.startCountdown(), 3200);
  }
  startCountdown() {
    let n = 3;
    const step = () => {
      this.broadcast({ t:'cd', n });
      if (n === 0) { this.schedule(() => this.startGame(), 500); return; }
      n--; this.schedule(step, 800);
    };
    step();
  }
  startGame() {
    const game = this.currentGame;
    const mod = GAME_MODULES[game];
    if (!mod) { this.endRound(); return; }
    const dur = { race:45, floor:40, team:35, chaos:40, memory:60, finger:45, troll:40, saboteur:65 }[game] || 45;
    this.playDur = dur;
    this.broadcast({ t:'playstart', dur });
    this.gameState = mod.init(this) || {};
    mod.start(this);
  }
  endRound() {
    if (this.phase !== 'playing') return;
    this.phase = 'results'; this.clearAll();
    const scores = {}, deltas = {};
    for (const p of this.players) { scores[p.id] = p.score; deltas[p.id] = p.lastDelta || 0; p.lastDelta = 0; }
    this.broadcast({ t:'results', round:this.round, total:TOTAL_ROUNDS, scores, deltas, extra:this.lastExtra });
    this.lastExtra = null;
    if (this.round >= TOTAL_ROUNDS) this.schedule(() => this.endMatch(), 4500);
    else this.schedule(() => { this.phase = 'playing'; this.nextRound(); }, 4500);
  }
  endMatch() {
    this.phase = 'final';
    const scores = {};
    for (const p of this.players) scores[p.id] = p.score;
    this.broadcast({ t:'final', scores });
  }
  resetForRematch() {
    this.phase = 'lobby'; this.round = 0; this.usedGames = [];
    this.currentGame = null; this.gameState = null; this.lastExtra = null;
    this.clearAll();
    this.players.forEach(p => { p.score = 0; p.ready = false; p.lastDelta = 0; p.input = { x:0, y:0 }; });
    this.broadcastLobby();
  }
}

const GAME_MODULES = {};

GAME_MODULES.race = {
  init(room) {
    const alive = room.players.filter(p => p.connected);
    const players = alive.map(p => ({ id:p.id, x:50, y:220, vx:0, vy:0, stun:0, boost:0, done:false, finish:0 }));
    const obstacles = [];
    for (let y = 30; y < 195; y += 22) {
      obstacles.push({ x: 6 + Math.random() * 72, y, w: 14, h: 7 });
      if (Math.random() < 0.55) obstacles.push({ x: 10 + Math.random() * 70, y: y + 8, w: 10, h: 6 });
    }
    const slip = [];
    for (let i = 0; i < 4; i++) slip.push({ x: 8 + Math.random() * 66, y: 40 + Math.random() * 140, w: 24, h: 18 });
    const boosts = [];
    for (let i = 0; i < 5; i++) boosts.push({ x: 8 + Math.random() * 74, y: 25 + Math.random() * 165, w: 10, h: 10 });
    return { players, obstacles, slip, boosts, finished: [], startT: now() };
  },
  start(room) {
    const gs = room.gameState;
    const startT = now(); let lastSend = 0;
    room.tick = setInterval(() => {
      if (room.destroyed || room.phase !== 'playing') return;
      const t = now();
      for (const gp of gs.players) {
        if (gp.done) continue;
        const pl = room.players.find(x => x.id === gp.id && x.connected);
        if (!pl) continue;
        const inp = pl.input || { x: 0, y: 0 };
        let onSlip = false;
        for (const s of gs.slip) if (gp.x > s.x && gp.x < s.x + s.w && gp.y > s.y && gp.y < s.y + s.h) { onSlip = true; break; }
        if (gp.stun > 0) gp.stun -= DT;
        else { const accel = onSlip ? 90 : 220; gp.vx += inp.x * accel * DT; gp.vy += inp.y * accel * DT; }
        const maxV = gp.boost > 0 ? 165 : 95;
        const v = Math.hypot(gp.vx, gp.vy);
        if (v > maxV) { gp.vx = gp.vx / v * maxV; gp.vy = gp.vy / v * maxV; }
        gp.vx *= 0.9; gp.vy *= 0.9;
        gp.x += gp.vx * DT; gp.y += gp.vy * DT;
        gp.x = Math.max(5, Math.min(95, gp.x)); gp.y = Math.max(10, Math.min(235, gp.y));
        if (gp.boost > 0) gp.boost -= DT;
        for (const o of gs.obstacles) {
          if (gp.x + 4 > o.x && gp.x - 4 < o.x + o.w && gp.y + 4 > o.y && gp.y - 4 < o.y + o.h) {
            if (gp.stun <= 0) { gp.stun = 1.2; gp.y += 5; room.pop(pl.avatar + ' HIT', 'bad'); }
          }
        }
        for (const b of gs.boosts) {
          if (gp.x > b.x - 4 && gp.x < b.x + 4 && gp.y > b.y - 4 && gp.y < b.y + 4) {
            gp.boost = 1.6; b.x = 8 + Math.random() * 74; b.y = 25 + Math.random() * 165;
          }
        }
        if (gp.y <= 14) {
          gp.done = true; gp.finish = t - startT; gs.finished.push(gp.id);
          const place = gs.finished.length;
          const pts = [100, 70, 50, 30][place - 1] || 20;
          room.award(gp.id, pts);
          const medal = ['1st','2nd','3rd','4th'][place - 1] || 'FIN';
          room.pop(pl.avatar + ' ' + medal + ' +' + pts, 'good');
        }
      }
      if (t - lastSend > 50) {
        lastSend = t;
        room.broadcast({ t:'gs', g:'race', p: gs.players.map(p => [p.id, +p.x.toFixed(1), +p.y.toFixed(1), p.stun > 0, p.boost > 0, p.done]), o: gs.obstacles, s: gs.slip, b: gs.boosts });
      }
      if (gs.finished.length >= gs.players.length || t - startT > 50000) {
        clearInterval(room.tick); room.tick = null;
        room.schedule(() => room.endRound(), 1200);
      }
    }, 1000 / TICK_HZ);
  }
};

GAME_MODULES.chaos = {
  init(room) { return { round: 0, total: 15, current: null, currentAt: 0 }; },
  start(room) {
    const gs = room.gameState;
    const colors = ['red','blue','green','yellow'];
    const fire = () => {
      if (room.destroyed || room.phase !== 'playing') return;
      if (gs.round >= gs.total) { room.schedule(() => room.endRound(), 800); return; }
      gs.round++;
      const r = Math.random();
      let mode, color, text;
      if (r < 0.42) { mode='press'; color=colors[Math.floor(Math.random()*4)]; text='TAP '+color.toUpperCase()+'!'; }
      else if (r < 0.60) { mode='wait'; color=null; text='WAIT...'; }
      else if (r < 0.80) { mode='dont'; color=colors[Math.floor(Math.random()*4)]; text="DON'T TAP "+color.toUpperCase()+'!'; }
      else { mode='press'; color=colors[Math.floor(Math.random()*4)]; text='PRESS '+color.toUpperCase(); }
      gs.current = { mode, color, answered: new Set() }; gs.currentAt = now();
      room.broadcast({ t:'prompt', text, mode, color });
      const dur = 1100 + Math.random() * 700;
      room.schedule(fire, dur);
    };
    fire();
  },
  action(room, pid, m) {
    if (m.a !== 'tap') return;
    const gs = room.gameState;
    if (!gs.current) return;
    if (gs.current.answered.has(pid)) return;
    gs.current.answered.add(pid);
    const pl = room.players.find(x => x.id === pid);
    if (!pl) return;
    const mode = gs.current.mode;
    if (mode === 'press' && m.color === gs.current.color) {
      const rt = now() - gs.currentAt;
      const bonus = rt < 500 ? 8 : (rt < 900 ? 4 : 0);
      const pts = 12 + bonus;
      room.award(pid, pts); room.pop(pl.avatar + ' +' + pts, 'good');
    } else {
      room.award(pid, -10); room.pop(pl.avatar + ' -10', 'bad');
    }
  }
};

GAME_MODULES.memory = {
  init(room) { return { round: 0, total: 5, seq: [], phase: 'show', startedAt: 0 }; },
  start(room) {
    const gs = room.gameState;
    const palette = ['🍎','🐸','⭐','🐔','🧸','🍕'];
    const playRound = () => {
      if (room.destroyed || room.phase !== 'playing') return;
      if (gs.round >= gs.total) { room.schedule(() => room.endRound(), 800); return; }
      gs.round++;
      const len = 3 + gs.round;
      const seq = [];
      for (let i = 0; i < len; i++) seq.push(palette[Math.floor(Math.random() * palette.length)]);
      gs.seq = seq; gs.phase = 'show'; gs.startedAt = now();
      room.broadcast({ t:'memround', seq });
      const showMs = 1200 + len * 350;
      room.schedule(() => {
        gs.phase = 'input'; gs.startedAt = now();
        room.broadcast({ t:'meminput', len });
        room.schedule(() => playRound(), 4000 + len * 200);
      }, showMs);
    };
    playRound();
  },
  action(room, pid, m) {
    if (m.a !== 'mem') return;
    const gs = room.gameState;
    if (gs.phase !== 'input') return;
    const arr = Array.isArray(m.seq) ? m.seq.slice(0, gs.seq.length) : [];
    if (arr.length !== gs.seq.length) { room.award(pid, -3); return; }
    let correct = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] === gs.seq[i]) correct++;
    const perfect = correct === gs.seq.length;
    const speedBonus = perfect ? Math.max(0, 12 - Math.floor((now() - gs.startedAt) / 200)) : 0;
    const pts = correct * 6 + (perfect ? 10 : 0) + speedBonus;
    room.award(pid, pts);
    const pl = room.players.find(x => x.id === pid);
    if (pl) room.pop(pl.avatar + (perfect ? ' PERFECT! ' : ' ') + '+' + pts, perfect ? 'good' : '');
  }
};

GAME_MODULES.finger = {
  init(room) { return { round: 0, total: 5, times: {}, phase: 'wait', goAt: 0, readyAt: 0 }; },
  start(room) {
    const gs = room.gameState;
    const playRound = () => {
      if (room.destroyed || room.phase !== 'playing') return;
      if (gs.round >= gs.total) { room.schedule(() => room.endRound(), 800); return; }
      gs.times = {}; gs.phase = 'wait';
      room.broadcast({ t:'fready', r: gs.round });
      const waitMs = 900 + Math.random() * 1800;
      room.schedule(() => {
        gs.phase = 'go'; gs.goAt = now();
        room.broadcast({ t:'fgo', r: gs.round });
        room.schedule(() => {
          const entries = Object.entries(gs.times).map(([id, t]) => [id, t - gs.goAt]).sort((a,b) => a[1] - b[1]);
          entries.forEach(([id, dt], i) => {
            const pts = [40, 25, 15, 8][i] || 4;
            room.award(id, pts);
            const pl = room.players.find(x => x.id === id);
            if (pl) room.pop(pl.avatar + ' ' + Math.round(dt) + 'ms +' + pts, 'good');
          });
          room.broadcast({ t:'fresult', r: gs.round, times: Object.fromEntries(Object.entries(gs.times).map(([id, t]) => [id, t - gs.goAt])) });
          gs.round++;
          room.schedule(playRound, 1400);
        }, 2500);
      }, waitMs);
    };
    playRound();
  },
  action(room, pid, m) {
    if (m.a !== 'finger') return;
    const gs = room.gameState;
    if (gs.phase === 'go' && !gs.times[pid]) gs.times[pid] = now();
    else if (gs.phase === 'wait') {
      room.award(pid, -20);
      const pl = room.players.find(x => x.id === pid);
      if (pl) room.pop(pl.avatar + ' TOO EARLY -20', 'bad');
      gs.phase = 'penalised';
      room.schedule(() => { if (gs.phase === 'penalised') gs.phase = 'wait'; }, 400);
    }
  }
};

const TROLL_OUTCOMES = [
  { text:'+40', good:true, pts: 40 }, { text:'+20', good:true, pts: 20 },
  { text:'+8', good:true, pts: 8 }, { text:'0', good:true, pts: 0 },
  { text:'-15', good:false, pts:-15 }, { text:'-25', good:false, pts:-25 },
  { text:'shrink', good:false, pts:-8 }, { text:'spin', good:false, pts:-5 }
];
GAME_MODULES.troll = {
  init(room) { return { total: 25, round: 0 }; },
  start(room) {
    const gs = room.gameState;
    room.tick = setInterval(() => {
      if (room.destroyed || room.phase !== 'playing') return;
      if (gs.round >= gs.total) {
        clearInterval(room.tick); room.tick = null;
        room.schedule(() => room.endRound(), 800); return;
      }
      gs.round++;
      const pts = {};
      for (const p of room.players) pts[p.id] = p.lastDelta || 0;
      room.broadcast({ t:'tscores', pts });
    }, 1200);
    setTimeout(() => {
      if (room.tick) { clearInterval(room.tick); room.tick = null; }
      if (room.phase === 'playing') room.schedule(() => room.endRound(), 600);
    }, 40000);
  },
  action(room, pid, m) {
    if (m.a !== 'troll') return;
    const pl = room.players.find(x => x.id === pid);
    if (!pl) return;
    const o = TROLL_OUTCOMES[Math.floor(Math.random() * TROLL_OUTCOMES.length)];
    room.award(pid, o.pts);
    room.broadcast({ t:'treveal', pid, i: m.i, text: o.text, good: o.good });
    room.pop(pl.avatar + ' ' + o.text, o.good ? 'good' : 'bad');
  }
};

GAME_MODULES.saboteur = {
  init(room) {
    const alive = room.players.filter(p => p.connected);
    const sab = alive[Math.floor(Math.random() * alive.length)].id;
    return { sab, target: 120, progress: 0, glitchLeft: 3, glitchUsed: 0, votes: {}, phase: 'play', glitchAt: 0 };
  },
  start(room) {
    const gs = room.gameState;
    for (const p of room.players) if (p.connected) room.sendTo(p.id, { t:'role', sab: p.id === gs.sab });
    room.schedule(() => {
      room.broadcast({ t:'sabinit', target: gs.target });
      room.broadcast({ t:'sabplay' });
      const playMs = 25000;
      room.schedule(() => {
        gs.phase = 'vote';
        room.broadcast({ t:'sabvote' });
        room.schedule(() => {
          const tally = {};
          for (const [voter, target] of Object.entries(gs.votes)) tally[target] = (tally[target] || 0) + 1;
          let most = null, best = -1;
          for (const [k, v] of Object.entries(tally)) if (v > best) { best = v; most = k; }
          const sab = room.players.find(p => p.id === gs.sab);
          const sabCaught = most === gs.sab;
          const repaired = gs.progress >= gs.target;
          if (sab) room.award(gs.sab, (repaired ? 0 : 40) + (sabCaught ? 0 : 25));
          for (const p of room.players) {
            if (!p.connected || p.id === gs.sab) continue;
            if (sabCaught) room.award(p.id, 20);
            if (repaired) room.award(p.id, 15);
          }
          room.lastExtra = { type:'saboteur', sab: gs.sab, won: repaired, caught: sabCaught };
          room.schedule(() => room.endRound(), 2500);
        }, 8000);
      }, playMs);
    }, 500);
  },
  action(room, pid, m) {
    const gs = room.gameState;
    if (!gs) return;
    if (m.a === 'sabtap' && gs.phase === 'play') {
      gs.progress = Math.min(gs.target + 20, gs.progress + 1);
      room.broadcast({ t:'sabprogress', p: gs.progress, t: gs.target });
      if (gs.progress >= gs.target && gs.phase === 'play') {
        gs.phase = 'done';
        room.toast('REPAIRED! The crew wins unless the saboteur escapes.', 'good');
      }
      return;
    }
    if (m.a === 'sabglitch' && gs.phase === 'play' && pid === gs.sab) {
      if (gs.glitchLeft <= 0) return;
      gs.glitchLeft--;
      gs.progress = Math.max(0, gs.progress - 12);
      const messages = ['A pipe bursts!','System glitch!','Power flickers!','Tools malfunction!'];
      const msg = messages[Math.floor(Math.random() * messages.length)];
      room.broadcast({ t:'sabglitch', msg });
      room.broadcast({ t:'sabprogress', p: gs.progress, t: gs.target });
      return;
    }
    if (m.a === 'sabvote' && gs.phase === 'vote') {
      if (!gs.votes[pid]) gs.votes[pid] = m.id;
      return;
    }
  }
};

GAME_MODULES.floor = {
  init(room) {
    const N = 10;
    const tiles = new Array(N * N).fill('0');
    for (let i = 0; i < N; i++) {
      tiles[i] = '2'; tiles[(N - 1) * N + i] = '2';
      tiles[i * N] = '2'; tiles[i * N + N - 1] = '2';
    }
    const alive = room.players.filter(p => p.connected);
    const players = alive.map((p, i) => {
      const angle = (i / alive.length) * Math.PI * 2;
      return { id:p.id, x: 50 + Math.cos(angle) * 20, y: 50 + Math.sin(angle) * 20, out:false, place:0 };
    });
    return { tiles, players, N, TS: 10, out: [], round: 0 };
  },
  start(room) {
    const gs = room.gameState;
    const startT = now();
    let warnTimer = 0, killTimer = 0, lastSend = 0;
    room.tick = setInterval(() => {
      if (room.destroyed || room.phase !== 'playing') return;
      const t = now();
      const elapsed = (t - startT) / 1000;
      for (const gp of gs.players) {
        if (gp.out) continue;
        const pl = room.players.find(x => x.id === gp.id && x.connected);
        if (!pl) continue;
        const inp = pl.input || { x:0, y:0 };
        const speed = 40;
        gp.x += inp.x * speed * DT; gp.y += inp.y * speed * DT;
        gp.x = Math.max(10, Math.min(90, gp.x)); gp.y = Math.max(10, Math.min(90, gp.y));
      }
      if (t - warnTimer > 1400) {
        warnTimer = t;
        const count = 2 + Math.floor(Math.random() * 4);
        let picked = 0;
        for (let i = 0; i < gs.tiles.length && picked < count; i++) {
          if (gs.tiles[i] === '0') { gs.tiles[i] = '1'; picked++; }
        }
      }
      if (t - killTimer > 700) {
        killTimer = t;
        for (let i = 0; i < gs.tiles.length; i++) if (gs.tiles[i] === '1') gs.tiles[i] = '2';
      }
      for (const gp of gs.players) {
        if (gp.out) continue;
        const tx = Math.floor(gp.x / gs.TS);
        const ty = Math.floor(gp.y / gs.TS);
        if (tx < 0 || ty < 0 || tx >= gs.N || ty >= gs.N) { gp.out = true; continue; }
        if (gs.tiles[ty * gs.N + tx] === '2') {
          gp.out = true; gs.out.push(gp.id); gp.place = gs.out.length;
          const pl = room.players.find(x => x.id === gp.id);
          if (pl) room.pop(pl.avatar + ' OUT', 'bad');
        }
      }
      if (t - lastSend > 50) {
        lastSend = t;
        room.broadcast({ t:'gs', g:'floor', t: gs.tiles.join(''), p: gs.players.map(p => [p.id, +p.x.toFixed(1), +p.y.toFixed(1), p.out]) });
      }
      const remaining = gs.players.filter(p => !p.out);
      if (remaining.length <= 1 || elapsed > 55) {
        const survivors = gs.players.filter(p => !p.out);
        survivors.forEach(p => room.award(p.id, 60));
        gs.out.forEach((id, i) => { const pts = Math.max(5, 25 - i * 5); room.award(id, pts); });
        clearInterval(room.tick); room.tick = null;
        room.schedule(() => room.endRound(), 1200);
      }
    }, 1000 / TICK_HZ);
  }
};

GAME_MODULES.team = {
  init(room) {
    const alive = room.players.filter(p => p.connected);
    const shuffled = alive.slice().sort(() => Math.random() - 0.5);
    const teamMap = {};
    const half = Math.ceil(shuffled.length / 2);
    shuffled.forEach((p, i) => { teamMap[p.id] = i < half ? 'A' : 'B'; });
    const coins = [];
    for (let i = 0; i < 18; i++) coins.push([10 + Math.random() * 80, 10 + Math.random() * 80, 1]);
    const players = alive.map((p, i) => {
      const team = teamMap[p.id];
      const bx = team === 'A' ? 20 : 80;
      const by = 50 + (i % 3 - 1) * 12;
      return { id:p.id, x:bx, y:by };
    });
    return { tm: teamMap, c: coins, players, ts: [0, 0], startT: now() };
  },
  start(room) {
    const gs = room.gameState;
    let lastSend = 0;
    room.tick = setInterval(() => {
      if (room.destroyed || room.phase !== 'playing') return;
      const t = now();
      for (const gp of gs.players) {
        const pl = room.players.find(x => x.id === gp.id && x.connected);
        if (!pl) continue;
        const inp = pl.input || { x:0, y:0 };
        const speed = 38;
        gp.x += inp.x * speed * DT; gp.y += inp.y * speed * DT;
        gp.x = Math.max(4, Math.min(96, gp.x)); gp.y = Math.max(4, Math.min(96, gp.y));
        for (const c of gs.c) {
          if (c[2] && Math.hypot(c[0] - gp.x, c[1] - gp.y) < 4) {
            c[2] = 0;
            const team = gs.tm[gp.id];
            if (team === 'A') gs.ts[0]++; else gs.ts[1]++;
          }
        }
      }
      if (gs.c.filter(c => c[2]).length < 6) {
        for (const c of gs.c) if (!c[2]) { c[0] = 8 + Math.random() * 84; c[1] = 8 + Math.random() * 84; c[2] = 1; }
      }
      if (t - lastSend > 50) {
        lastSend = t;
        room.broadcast({ t:'gs', g:'team', p: gs.players.map(p => [p.id, +p.x.toFixed(1), +p.y.toFixed(1)]), c: gs.c, tm: gs.tm, ts: gs.ts });
      }
      const elapsed = (t - gs.startT) / 1000;
      if (elapsed > 35) {
        clearInterval(room.tick); room.tick = null;
        const [a, b] = gs.ts;
        const winner = a > b ? 'A' : b > a ? 'B' : 'TIE';
        for (const p of room.players) {
          if (!p.connected) continue;
          const team = gs.tm[p.id];
          if (winner === 'TIE') room.award(p.id, 20);
          else if (team === winner) room.award(p.id, 40);
          else room.award(p.id, 15);
        }
        room.toast(
          winner === 'TIE' ? 'TIE! Everyone +20' :
          (winner === 'A' ? 'TEAM A wins! +40' : 'TEAM B wins! +40'),
          winner === 'TIE' ? '' : 'good'
        );
        room.schedule(() => room.endRound(), 1500);
      }
    }, 1000 / TICK_HZ);
  }
};

wss.on('connection', ws => {
  let myRoom = null, myId = null;
  function reply(obj) { try { ws.send(JSON.stringify(obj)); } catch(e){} }

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch(e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'create') {
      const name = cleanNick(m.name);
      if (!name) { reply({ t:'err', msg:'Invalid nickname.' }); return; }
      if (myRoom) myRoom.removePlayer(myId);
      const code = randCode();
      const room = new Room(code);
      rooms.set(code, room);
      const r = room.addPlayer(ws, name, m.avatar);
      if (r.error) { reply({ t:'err', msg: r.error }); rooms.delete(code); return; }
      myRoom = room; myId = r.player.id;
      reply({ t:'joined', you: { id: myId, name, avatar: r.player.avatar }, code, hostId: room.hostId });
      room.broadcastLobby();
      return;
    }

    if (m.t === 'join') {
      const code = String(m.code || '').toUpperCase();
      const name = cleanNick(m.name);
      if (!name) { reply({ t:'err', msg:'Invalid nickname.' }); return; }
      const room = rooms.get(code);
      if (!room) { reply({ t:'err', msg:'Room not found.' }); return; }
      if (myRoom) myRoom.removePlayer(myId);
      const r = room.addPlayer(ws, name, m.avatar);
      if (r.error) { reply({ t:'err', msg: r.error }); return; }
      myRoom = room; myId = r.player.id;
      reply({ t:'joined', you: { id: myId, name, avatar: r.player.avatar }, code: room.code, hostId: room.hostId });
      room.broadcastLobby();
      return;
    }

    if (m.t === 'rejoin') {
      const room = rooms.get(String(m.code || '').toUpperCase());
      if (!room) { reply({ t:'err', msg:'Room closed.' }); return; }
      const p = room.players.find(x => x.id === m.id);
      if (!p) { reply({ t:'err', msg:'Session expired.' }); return; }
      p.connected = true; p.ws = ws;
      myRoom = room; myId = p.id;
      reply({ t:'joined', you: { id: myId, name: p.name, avatar: p.avatar }, code: room.code, hostId: room.hostId });
      room.broadcastLobby();
      if (room.phase === 'playing' && room.gameState && ['race','floor','team'].includes(room.currentGame)) {
        const gs = room.gameState;
        if (gs && Array.isArray(gs.players) && !gs.players.find(g => g.id === myId)) {
          if (room.currentGame === 'race') gs.players.push({ id: myId, x:50, y:220, vx:0, vy:0, stun:0, boost:0, done:false, finish:0 });
          if (room.currentGame === 'floor') gs.players.push({ id: myId, x:50, y:50, out:false, place:0 });
          if (room.currentGame === 'team') {
            const counts = { A: 0, B: 0 };
            for (const id in gs.tm) counts[gs.tm[id]]++;
            const team = counts.A <= counts.B ? 'A' : 'B';
            gs.tm[myId] = team;
            gs.players.push({ id: myId, x: team === 'A' ? 20 : 80, y: 50 });
          }
        }
      }
      return;
    }

    if (!myRoom || !myId) return;

    if (m.t === 'ready') {
      const p = myRoom.players.find(x => x.id === myId);
      if (p) { p.ready = !!m.v; myRoom.broadcastLobby(); }
      return;
    }

    if (m.t === 'start') {
      if (myRoom.hostId !== myId) { reply({ t:'err', msg:'Only the host can start.' }); return; }
      if (myRoom.phase !== 'lobby') { reply({ t:'err', msg:'Already started.' }); return; }
      const conn = myRoom.players.filter(p => p.connected);
      if (conn.length < 2) { reply({ t:'err', msg:'Need at least 2 players.' }); return; }
      if (!conn.every(p => p.ready || p.id === myRoom.hostId)) { reply({ t:'err', msg:'Not all players are ready.' }); return; }
      myRoom.startMatch();
      return;
    }

    if (m.t === 'leave') { myRoom.removePlayer(myId); myRoom = null; myId = null; return; }

    if (m.t === 'rematch') {
      if (myRoom.hostId !== myId) { reply({ t:'err', msg:'Only the host can restart.' }); return; }
      myRoom.resetForRematch();
      return;
    }

    if (m.t === 'in') {
      const p = myRoom.players.find(x => x.id === myId);
      if (p) p.input = { x: Number(m.x) || 0, y: Number(m.y) || 0 };
      return;
    }

    if (m.t === 'act') {
      if (myRoom.phase !== 'playing') return;
      const mod = GAME_MODULES[myRoom.currentGame];
      if (mod && typeof mod.action === 'function') {
        try { mod.action(myRoom, myId, m); } catch(e) { console.error(e); }
      }
      return;
    }
  });

  ws.on('close', () => { if (myRoom && myId) myRoom.removePlayer(myId); });
});

server.listen(PORT, () => { console.log('CHAOS CREW running on port ' + PORT); });
