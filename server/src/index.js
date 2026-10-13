// Game rooms for Quartz Dice Scorer.
// The Worker routes /room/<CODE> WebSocket connections to one Durable Object per room code.
// The room keeps the players, saves them, and sends the full state to every phone on each change.
// Each connection may only edit its own player. Counts stay hidden until every player is done.
//
// Abuse limits, to keep a misbehaving client from using up the free plan's daily quota:
// each connection may send RATE_PER_SEC messages a second (bursts up to RATE_BURST) or it is disconnected,
// a room accepts at most MAX_SOCKETS connections, and saves are batched to one write per SAVE_DELAY_MS.
// Batching is safe because phones re-send their own entry whenever they reconnect.
import { DurableObject } from "cloudflare:workers";

const KEYS = ["quartz", "rubellite", "emerald", "sapphire", "ruby", "amber", "unstable", "chest"];
const MAX_PLAYERS = 6;
const MAX_SOCKETS = 12;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 2000;
const RATE_PER_SEC = 10;
const RATE_BURST = 30;
const PID_RE = /^[a-z0-9]{8,32}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/room\/([A-Za-z]{4})$/);
    if (!match) return new Response("Quartz rooms server", { status: 404 });
    const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
    if (!allowed.includes(request.headers.get("Origin"))) return new Response("Forbidden", { status: 403 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const code = match[1].toUpperCase();
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
  },
};

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // room is null until a host creates it: { created, players: [{ pid, name, counts, done }] }
    this.room = null;
    this.saveTimer = null;
    this.buckets = new WeakMap(); // ws -> { tokens, at } for rate limiting; resets if the room hibernates, which is fine
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get("room")) || null;
    });
  }

  async fetch() {
    if (this.openSockets().length >= MAX_SOCKETS) return new Response("Room busy", { status: 429 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Token bucket per connection. Returns false once a connection sends faster than the limit.
  allow(ws) {
    const now = Date.now();
    const b = this.buckets.get(ws) || { tokens: RATE_BURST, at: now };
    b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.at) / 1000) * RATE_PER_SEC) - 1;
    b.at = now;
    this.buckets.set(ws, b);
    return b.tokens >= 0;
  }

  async webSocketMessage(ws, raw) {
    if (!this.allow(ws)) return ws.close(4008, "Too many messages");
    if (typeof raw !== "string" || raw.length > 2000) return this.fail(ws, "bad");
    let msg;
    try { msg = JSON.parse(raw); } catch { return this.fail(ws, "bad"); }

    if (msg.t === "hello") return this.hello(ws, msg);

    const pid = ws.deserializeAttachment()?.pid;
    const me = pid && this.room?.players.find((p) => p.pid === pid);
    if (!me) return this.fail(ws, "nope");

    if (msg.t === "set") {
      if (typeof msg.name === "string") me.name = cleanName(msg.name) || me.name;
      if (msg.counts && typeof msg.counts === "object") me.counts = cleanCounts(msg.counts);
      if (typeof msg.done === "boolean") me.done = msg.done;
    } else if (msg.t === "leave") {
      this.room.players = this.room.players.filter((p) => p !== me);
      ws.serializeAttachment({});
    } else if (msg.t === "remove") {
      // Anyone may remove a player whose phone isn't connected, so one dead phone can't block the reveal.
      const target = this.room.players[msg.index];
      if (!target || target === me || this.onlinePids().has(target.pid)) return this.fail(ws, "online");
      this.room.players = this.room.players.filter((p) => p !== target);
    } else {
      return this.fail(ws, "bad");
    }
    this.save();
    this.broadcast();
  }

  async hello(ws, msg) {
    if (!PID_RE.test(msg.pid || "")) return this.fail(ws, "bad");
    const create = !!msg.create;
    if (create) {
      // A host picked this code at random; if a live room already has it, the host picks another.
      if (this.room) return this.fail(ws, "taken");
      this.room = { created: Date.now(), players: [] };
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    }
    if (!this.room) return this.fail(ws, "nope");
    let me = this.room.players.find((p) => p.pid === msg.pid);
    if (!me) {
      if (this.room.players.length >= MAX_PLAYERS) return this.fail(ws, "full");
      me = { pid: msg.pid, name: cleanName(msg.name) || `Player ${this.room.players.length + 1}`, counts: cleanCounts({}), done: false };
      this.room.players.push(me);
    }
    ws.serializeAttachment({ pid: msg.pid });
    // A new room is saved straight away so the code works for joiners even if the room restarts.
    if (create) await this.saveNow();
    else this.save();
    this.broadcast();
  }

  async webSocketClose() {
    this.broadcast();
  }

  async webSocketError() {
    this.broadcast();
  }

  async alarm() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.room = null;
    for (const ws of this.ctx.getWebSockets()) ws.close(4000, "Room expired");
    await this.ctx.storage.deleteAll();
  }

  // Batch changes into one storage write every SAVE_DELAY_MS.
  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.room) this.ctx.storage.put("room", this.room);
    }, SAVE_DELAY_MS);
  }

  async saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.ctx.storage.put("room", this.room);
  }

  fail(ws, code) {
    ws.send(JSON.stringify({ t: "error", code }));
  }

  openSockets() {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  onlinePids() {
    return new Set(this.openSockets().map((ws) => ws.deserializeAttachment()?.pid).filter(Boolean));
  }

  // Everyone gets the same view, except that counts are only included once all players are done.
  broadcast() {
    if (!this.room) return;
    const sockets = this.openSockets();
    const online = this.onlinePids();
    const players = this.room.players;
    const revealed = players.length > 0 && players.every((p) => p.done);
    for (const ws of sockets) {
      const you = ws.deserializeAttachment()?.pid;
      if (!you) continue;
      const view = players.map((p) => ({
        pid: p.pid === you ? p.pid : undefined,
        you: p.pid === you,
        name: p.name,
        done: p.done,
        online: online.has(p.pid),
        counts: revealed || p.pid === you ? p.counts : undefined,
      }));
      ws.send(JSON.stringify({ t: "state", revealed, players: view, expires: this.room.created + ROOM_TTL_MS }));
    }
  }
}

function cleanName(name) {
  return String(name || "").replace(/\s+/g, " ").trim().slice(0, 24);
}

function cleanCounts(counts) {
  const out = {};
  for (const k of KEYS) {
    const n = Math.floor(Number(counts[k]));
    out[k] = Number.isFinite(n) ? Math.max(0, Math.min(30, n)) : 0;
  }
  return out;
}
