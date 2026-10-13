// Plays a game against a running server (default: `npm run dev` on localhost:8787).
// Usage: node test/rooms.test.mjs [ws://host:port]
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const BASE = process.argv[2] || "ws://localhost:8787";
const ORIGIN = "http://localhost:8765";
const code = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]).join("");
const pid = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);

// A simulated phone: connects, collects messages, and can wait for the next one matching a test.
function phone(roomCode = code, origin = ORIGIN) {
  const ws = new WebSocket(`${BASE}/room/${roomCode}`, { headers: { Origin: origin } });
  const inbox = [];
  const waiters = [];
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    const i = waiters.findIndex((w) => w.test(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("socket error")));
  });
  const closed = new Promise((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
  return {
    ws,
    opened,
    closed,
    send: (m) => ws.send(JSON.stringify(m)),
    next(test = () => true, ms = 3000) {
      const i = inbox.findIndex(test);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { test, resolve };
        waiters.push(w);
        setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error("timed out waiting for message")); }, ms);
      });
    },
    drain() { inbox.length = 0; },
  };
}

const isState = (m) => m.t === "state";
const results = [];
async function test(name, fn) {
  try { await fn(); results.push(`ok   ${name}`); }
  catch (e) { results.push(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

const host = phone(); const hostPid = pid();
const guest = phone(); const guestPid = pid();

await test("rejects a page from another site", async () => {
  const p = phone(code, "https://evil.example");
  await assert.rejects(p.opened);
});

await test("joining a room that doesn't exist fails", async () => {
  const p = phone("ZZZQ"); await p.opened;
  p.send({ t: "hello", pid: pid(), name: "Lost" });
  assert.deepEqual(await p.next(), { t: "error", code: "nope" });
  p.ws.close();
});

await test("host creates the room", async () => {
  await host.opened;
  host.send({ t: "hello", pid: hostPid, name: "Bryn", create: true });
  const s = await host.next(isState);
  assert.equal(s.players.length, 1);
  assert.equal(s.players[0].name, "Bryn");
  assert.equal(s.players[0].you, true);
  assert.equal(s.revealed, false);
});

await test("creating a code that's already live fails", async () => {
  const p = phone(); await p.opened;
  p.send({ t: "hello", pid: pid(), name: "Copycat", create: true });
  assert.deepEqual(await p.next(), { t: "error", code: "taken" });
  p.ws.close();
});

await test("guest joins and both phones see two players", async () => {
  await guest.opened;
  guest.send({ t: "hello", pid: guestPid, name: "Thora" });
  const g = await guest.next(isState);
  assert.deepEqual(g.players.map((p) => p.name), ["Bryn", "Thora"]);
  const h = await host.next((m) => isState(m) && m.players.length === 2);
  assert.ok(h.players.every((p) => p.online));
});

await test("counts are cleaned and hidden from other players until all are done", async () => {
  host.send({ t: "set", counts: { quartz: 3, ruby: 1, amber: 99, chest: -4, bogus: 5 } });
  const h = await host.next((m) => isState(m) && m.players[0].counts.quartz === 3);
  assert.deepEqual(h.players[0].counts, { quartz: 3, rubellite: 0, emerald: 0, sapphire: 0, ruby: 1, amber: 30, unstable: 0, chest: 0 });
  guest.drain();
  host.send({ t: "set", name: "Bryn" });
  const g = await guest.next(isState);
  assert.equal(g.players[0].counts, undefined, "guest must not see host's counts yet");
  assert.equal(g.players[0].pid, undefined, "guest must not see host's player id");
});

await test("a phone can only change its own player", async () => {
  // The pid in the message is ignored: the server applies it to the sender's own player.
  guest.send({ t: "set", pid: hostPid, counts: { emerald: 7 } });
  const g = await guest.next((m) => isState(m) && m.players[1].counts?.emerald === 7);
  assert.equal(g.players[1].name, "Thora");
  const h = await host.next((m) => isState(m) && m.players[0].counts.quartz === 3);
  assert.equal(h.players[0].counts.emerald, 0);
});

await test("everyone done reveals all counts", async () => {
  host.send({ t: "set", done: true });
  const mid = await guest.next((m) => isState(m) && m.players[0].done);
  assert.equal(mid.revealed, false);
  guest.send({ t: "set", counts: { rubellite: 4, chest: 2 }, done: true });
  const g = await guest.next((m) => isState(m) && m.revealed);
  assert.equal(g.players[0].counts.quartz, 3);
  const h = await host.next((m) => isState(m) && m.revealed);
  assert.equal(h.players[1].counts.rubellite, 4);
});

await test("un-done hides counts again", async () => {
  guest.send({ t: "set", done: false });
  const h = await host.next((m) => isState(m) && !m.revealed);
  assert.equal(h.players[1].counts, undefined);
});

await test("a reconnecting phone gets its player back", async () => {
  guest.ws.close();
  await host.next((m) => isState(m) && !m.players[1].online);
  const again = phone(); await again.opened;
  again.send({ t: "hello", pid: guestPid, name: "ignored" });
  const s = await again.next(isState);
  assert.equal(s.players.length, 2);
  assert.equal(s.players[1].name, "Thora");
  assert.equal(s.players[1].counts.rubellite, 4);
  host.send({ t: "remove", index: 1 });
  assert.deepEqual(await host.next((m) => m.t === "error"), { t: "error", code: "online" }, "can't remove a connected player");
  again.send({ t: "leave" });
  const h = await host.next((m) => isState(m) && m.players.length === 1);
  assert.equal(h.players[0].name, "Bryn");
  again.ws.close();
});

await test("room caps at 6 players", async () => {
  const extra = [];
  for (let i = 0; i < 5; i++) {
    const p = phone(); await p.opened;
    p.send({ t: "hello", pid: pid(), name: `P${i}` });
    await p.next(isState);
    extra.push(p);
  }
  const seventh = phone(); await seventh.opened;
  seventh.send({ t: "hello", pid: pid(), name: "Seventh" });
  assert.deepEqual(await seventh.next(), { t: "error", code: "full" });
  for (const p of [...extra, seventh]) p.ws.close();
});

await test("an offline player can be removed so they don't block the reveal", async () => {
  await host.next((m) => isState(m) && m.players.length === 6 && m.players.slice(1).every((p) => !p.online), 5000);
  for (let n = 5; n >= 1; n--) {
    host.send({ t: "remove", index: n });
    await host.next((m) => isState(m) && m.players.length === n);
  }
  host.send({ t: "remove", index: 0 });
  assert.deepEqual(await host.next((m) => m.t === "error"), { t: "error", code: "online" }, "can't remove yourself this way");
});

await test("junk messages get an error, not a crash", async () => {
  const isError = (m) => m.t === "error";
  host.ws.send("not json");
  assert.deepEqual(await host.next(isError), { t: "error", code: "bad" });
  host.ws.send("x".repeat(5000));
  assert.deepEqual(await host.next(isError), { t: "error", code: "bad" });
  host.send({ t: "set", name: "Still here" });
  assert.equal((await host.next((m) => isState(m) && m.players[0].name === "Still here")).players.length, 1);
});

await test("new game keeps the players and clears everyone's counts", async () => {
  const room = "NG" + code.slice(2);
  const a = phone(room); await a.opened;
  a.send({ t: "hello", pid: pid(), name: "Ann", create: true });
  await a.next(isState);
  const b = phone(room); await b.opened;
  b.send({ t: "hello", pid: pid(), name: "Ben" });
  await b.next(isState);

  a.send({ t: "newgame" });
  assert.deepEqual(await a.next((m) => m.t === "error"), { t: "error", code: "notyet" }, "only after the reveal");

  a.send({ t: "set", round: 0, counts: { ruby: 3 }, done: true });
  b.send({ t: "set", round: 0, counts: { amber: 2 }, done: true });
  await a.next((m) => isState(m) && m.revealed);

  b.send({ t: "newgame" });
  const s = await a.next((m) => isState(m) && m.round === 1);
  assert.equal(s.revealed, false);
  assert.deepEqual(s.players.map((p) => p.name), ["Ann", "Ben"]);
  assert.ok(s.players.every((p) => !p.done));
  assert.equal(s.players[0].counts.ruby, 0, "own counts cleared");

  // A phone that slept through the new game re-sends its old counts: they must be ignored.
  a.send({ t: "set", round: 0, counts: { ruby: 3 }, done: true });
  a.send({ t: "set", round: 1, name: "Ann", counts: { quartz: 2 }, done: false });
  const after = await a.next((m) => isState(m) && m.players[0].counts.quartz === 2);
  assert.equal(after.players[0].counts.ruby, 0);
  assert.equal(after.players[0].done, false);
  a.ws.close(); b.ws.close();
});

await test("the live config only allows the GitHub Pages site", async () => {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const origins = config.match(/"ALLOWED_ORIGINS":\s*"([^"]*)"/)[1];
  assert.equal(origins, "https://punkkills.github.io");
});

await test("normal fast tapping isn't rate limited", async () => {
  // A fresh phone: the host connection has already used its allowance in earlier tests.
  const p = phone("TT" + code.slice(2)); await p.opened;
  p.send({ t: "hello", pid: pid(), name: "Tapper", create: true });
  for (let i = 1; i <= 25; i++) p.send({ t: "set", counts: { quartz: i } });
  await p.next((m) => isState(m) && m.players[0].counts.quartz === 25);
  for (let i = 1; i <= 40; i++) { p.send({ t: "set", counts: { emerald: i % 30 } }); await new Promise((r) => setTimeout(r, 125)); }
  await p.next((m) => isState(m) && m.players[0].counts.emerald === 10);
  assert.equal(p.ws.readyState, WebSocket.OPEN);
  p.ws.close();
});

await test("a flood of messages gets the connection closed", async () => {
  const room2 = code.slice(0, 3) + (code[3] === "A" ? "B" : "A");
  const p = phone(room2); await p.opened;
  for (let i = 0; i < 200; i++) p.send({ t: "hello", pid: pid(), create: false });
  assert.equal(await p.closed, 4008);
});

await test("a room refuses more than 12 connections", async () => {
  const room3 = "QQ" + code.slice(2);
  const socks = [];
  for (let i = 0; i < 12; i++) { const p = phone(room3); await p.opened; socks.push(p); }
  const extra = phone(room3);
  await assert.rejects(extra.opened);
  for (const p of socks) p.ws.close();
});

host.ws.close();
console.log(`room ${code}\n${results.join("\n")}`);
process.exit();
