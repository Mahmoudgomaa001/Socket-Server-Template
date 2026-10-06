const express = require("express");
const WebSocket = require("ws");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

const QUIET = process.env.QUIET === "1";
function log(...a)  { if (!QUIET) console.log(...a); }
function warn(...a) { console.warn(...a); }

app.use(express.json({ limit: "32kb" }));
app.use(express.static("public"));

app.get("/firmware.bin", async (req, res) => {
  const url = "https://raw.githubusercontent.com/Mahmoudgomaa001/yono_qr_update/main/firmware.bin";
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error("GitHub fetch failed");
    const buf = await r.buffer();
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Connection", "close");
    res.send(buf);
  } catch (e) {
    warn("Firmware fetch:", e.message);
    res.status(500).send("Firmware fetch failed");
  }
});

const usageLog = [];
app.post("/log", (req, res) => {
  const { device, tag, action, duration } = req.body || {};
  if (!device || !action) return res.status(400).json({ ok: false });
  usageLog.unshift({
    ts: new Date().toISOString(),
    device: String(device).toUpperCase().slice(0, 32),
    tag: String(tag || "").slice(0, 32),
    action: String(action).slice(0, 16),
    duration: Number(duration) || 0
  });
  if (usageLog.length > 1000) usageLog.length = 1000;
  res.json({ ok: true });
});
app.get("/log", (req, res) => {
  const device = String(req.query.device || "").toUpperCase();
  const limit  = Math.min(200, Math.max(1, Number(req.query.limit) || 20));
  const rows = (device ? usageLog.filter(r => r.device === device) : usageLog).slice(0, limit);
  res.json({ ok: true, rows });
});

app.get("/health", (req, res) => {
  const now = Date.now();
  const rows = [];
  for (const [id, ws] of clients.entries()) {
    const seenAt = lastSeen.get(ws) || 0;
    const ageSec = Math.round((now - seenAt) / 1000);
    rows.push({
      id,
      online: ws.readyState === WebSocket.OPEN,
      lastSeenSec: ageSec,
      healthy: ws.readyState === WebSocket.OPEN && ageSec < 45,
      timeouts: (recentTimeouts.get(id) || []).length,
      session: sessions.get(id) || null,
      outboundBuffer: ws.bufferedAmount || 0
    });
  }
  res.json({ ok: true, espCount: rows.length, rows });
});

const server = app.listen(PORT, () => console.log("HTTP on", PORT));
const wss = new WebSocket.Server({ server, skipUTF8Validation: true });

const clients           = new Map();
const passwords         = new Map();
const awaitingResponses = new Map();
const lastSeen          = new Map();
const recentTimeouts    = new Map();
const sessions          = new Map();
const viewers           = new Map();

const ESP_STALE_MS       = 90000;
const WATCHDOG_TICK_MS   = 20000;
const COMMAND_TIMEOUT_MS = 20000;
const TIMEOUT_WINDOW_MS  = 60000;
const TIMEOUT_KILL_COUNT = 3;

// Flow control
const BROWSER_BACKPRESSURE_LIMIT = 200000;  // bytes
const ACK_MAX_DELAY_MS           = 300;     // cap
const ACK_DELAY_LOG_MS           = 100;     // only warn above this

const commandTimeouts = new Map();

function broadcastSession(espId, kind, extra) {
  const set = viewers.get(espId);
  if (!set || !set.size) return;
  const payload = JSON.stringify({
    type: kind, espId,
    session: sessions.get(espId) || null,
    ...(extra || {})
  });
  set.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(payload); });
}

function safeSend(ws, msg) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > BROWSER_BACKPRESSURE_LIMIT) return;
  ws.send(msg, err => { if (err) warn("send err:", err.message); });
}

function armCommandTimeout(commandId, espId) {
  const old = commandTimeouts.get(commandId);
  if (old) clearTimeout(old);
  const t = setTimeout(() => {
    const waiters = awaitingResponses.get(commandId);
    if (waiters) waiters.forEach(c => {
      if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: "error", message: "timeout" }));
    });
    awaitingResponses.delete(commandId);
    commandTimeouts.delete(commandId);
    if (espId) {
      const now = Date.now();
      let arr = (recentTimeouts.get(espId) || []).filter(x => now - x < TIMEOUT_WINDOW_MS);
      arr.push(now);
      recentTimeouts.set(espId, arr);
      if (arr.length >= TIMEOUT_KILL_COUNT) {
        const sock = clients.get(espId);
        if (sock) {
          warn(`💥 ${espId} timed out ${arr.length}x — forcing reconnect`);
          try { sock.terminate(); } catch {}
          clients.delete(espId);
          passwords.delete(espId);
          lastSeen.delete(sock);
        }
        recentTimeouts.delete(espId);
      }
    }
    warn(`⏱️ Command timeout: ${commandId} (esp=${espId || "?"})`);
  }, COMMAND_TIMEOUT_MS);
  commandTimeouts.set(commandId, t);
}
function clearCommandTimeout(id) {
  const t = commandTimeouts.get(id);
  if (t) { clearTimeout(t); commandTimeouts.delete(id); }
}

function espIdForSocket(ws) {
  for (const [id, s] of clients.entries()) if (s === ws) return id;
  return null;
}

function isTagChunk(payload) {
  return payload.startsWith("{\"tags\"") || payload.startsWith("{\"cloneTags\"");
}

wss.on("connection", ws => {
  lastSeen.set(ws, Date.now());

  ws.on("error", err => {
    if (!QUIET) warn("ws err:", err.message);
  });

  ws.on("message", (data, isBinary) => {
    lastSeen.set(ws, Date.now());
    if (isBinary) return;

    let text;
    try { text = data.toString("utf8"); } catch { return; }
    if (!text || text.length > 5000) return;

    // ---- RAW ESP ----
    if (text.includes("::")) {
      const i = text.indexOf("::");
      const commandId = text.substring(0, i);
      const payload   = text.substring(i + 2);
      clearCommandTimeout(commandId);

      if (commandId === "auto_off") {
        const espId = payload.trim().toUpperCase();
        if (espId && sessions.has(espId)) {
          sessions.delete(espId);
          broadcastSession(espId, "session_end", { reason: "auto" });
          log(`⏱️ auto_off ${espId}`);
        }
        return;
      }

      const waiters = awaitingResponses.get(commandId);
      const isTag = isTagChunk(payload);

      // Compute max browser buffered across this command's waiters.
      let maxBuffered = 0;
      if (waiters && waiters.size) {
        waiters.forEach(c => {
          maxBuffered = Math.max(maxBuffered, c.bufferedAmount || 0);
        });
      }

      // Forward to browser(s).
      if (waiters) {
        waiters.forEach(client => {
          if (client.readyState !== WebSocket.OPEN) return;
          if (isTag && client.bufferedAmount > BROWSER_BACKPRESSURE_LIMIT) return;
          client.send(payload);
        });
      }

      // Adaptive ack back to the ESP (tag chunks only).
      // The ESP waits for this before sending the next chunk.
      if (isTag && ws.readyState === WebSocket.OPEN) {
        const ackDelay = Math.min(
          ACK_MAX_DELAY_MS,
          Math.floor(maxBuffered / (BROWSER_BACKPRESSURE_LIMIT / ACK_MAX_DELAY_MS))
        );
        if (ackDelay > ACK_DELAY_LOG_MS) {
          log(`⏳ ack delayed ${ackDelay}ms (browser buffer ${maxBuffered}B)`);
        }
        if (ackDelay === 0) {
          ws.send(JSON.stringify({ type: "ack", commandId }));
        } else {
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "ack", commandId }));
            }
          }, ackDelay);
        }
      }
      return;
    }

    // ---- JSON ----
    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    switch (msg.type) {
      case "register_esp": {
        const oldSock = clients.get(msg.id);
        if (oldSock && oldSock !== ws) {
          try { oldSock.terminate(); } catch {}
          lastSeen.delete(oldSock);
          log(`🔁 replaced socket for ${msg.id}`);
        }
        clients.set(msg.id, ws);
        passwords.set(msg.id, msg.password);
        recentTimeouts.delete(msg.id);
        log(`📡 ESP registered: ${msg.id}`);
        break;
      }

      case "ping":
        safeSend(ws, JSON.stringify({ type: "pong" }));
        break;

      case "check_esps": {
        const results = msg.devices.map(d => ({
          id: d.id,
          online: !!clients.get(d.id),
          auth: passwords.get(d.id) === d.password,
        }));
        safeSend(ws, JSON.stringify({ type: "check_results", results }));
        break;
      }

      case "command": {
        const target = clients.get(msg.targetId);
        const pass   = passwords.get(msg.targetId);
        if (!target) return safeSend(ws, JSON.stringify({ type: "error", message: "ESP not online" }));
        if (pass !== msg.password) return safeSend(ws, JSON.stringify({ type: "error", message: "Wrong password" }));

        const commandId = Math.random().toString(36).substr(2, 6);

        for (const [id, set] of awaitingResponses.entries()) {
          if (set.has(ws)) {
            set.delete(ws);
            if (!set.size) { awaitingResponses.delete(id); clearCommandTimeout(id); }
          }
        }
        awaitingResponses.set(commandId, new Set([ws]));
        armCommandTimeout(commandId, msg.targetId);

        target.send(JSON.stringify({ type: "command", commandId, message: msg.message }));
        // Only log non-tag commands — tags stream is very chatty.
        log(`📤 → ${msg.targetId} (${commandId}): ${msg.message}`);
        break;
      }

      case "watch_esp": {
        const espId = String(msg.espId || "").toUpperCase();
        if (!espId) return;
        if (!viewers.has(espId)) viewers.set(espId, new Set());
        viewers.get(espId).add(ws);
        safeSend(ws, JSON.stringify({
          type: "session_snapshot", espId,
          session: sessions.get(espId) || null,
          online: !!clients.get(espId)
        }));
        break;
      }

      case "session_start": {
        const espId = String(msg.espId || "").toUpperCase();
        const minutes = Math.max(1, Math.min(600, Number(msg.minutes) || 0));
        const tag = String(msg.tag || "").slice(0, 32);
        if (!espId || !minutes) return;
        const target = clients.get(espId);
        const pass   = passwords.get(espId);
        if (!target) return safeSend(ws, JSON.stringify({ type: "error", message: "ESP not online" }));
        if (pass !== msg.password) return safeSend(ws, JSON.stringify({ type: "error", message: "Wrong password" }));

        const existing = sessions.get(espId);
        if (existing?.running && Date.parse(existing.endTimeUTC) > Date.now()) {
          const left = Math.ceil((Date.parse(existing.endTimeUTC) - Date.now()) / 60000);
          return safeSend(ws, JSON.stringify({ type: "error", message: "Device busy, " + left + " min left" }));
        }
        sessions.set(espId, {
          running: true,
          endTimeUTC: new Date(Date.now() + minutes * 60000).toISOString(),
          startedBy: tag, durationMin: minutes
        });
        target.send(JSON.stringify({
          type: "command",
          commandId: "s" + Math.random().toString(36).slice(2, 8),
          message: "m1r_on:" + minutes
        }));
        broadcastSession(espId, "session_start", {});
        log(`▶️ session_start ${espId} ${minutes}m by ${tag}`);
        break;
      }

      case "session_stop": {
        const espId = String(msg.espId || "").toUpperCase();
        const tag = String(msg.tag || "").slice(0, 32);
        if (!espId) return;
        const target = clients.get(espId);
        const pass   = passwords.get(espId);
        if (!target || pass !== msg.password) return safeSend(ws, JSON.stringify({ type: "error", message: "Cannot stop" }));
        sessions.delete(espId);
        target.send(JSON.stringify({
          type: "command",
          commandId: "s" + Math.random().toString(36).slice(2, 8),
          message: "m1r_off"
        }));
        broadcastSession(espId, "session_end", { byTag: tag, reason: "manual" });
        log(`⏹️ session_stop ${espId} by ${tag}`);
        break;
      }

      default:
        break;
    }
  });

  ws.on("close", code => {
    if (code === 1007) return;

    for (const [id, client] of clients.entries()) {
      if (client === ws) {
        clients.delete(id);
        passwords.delete(id);
        recentTimeouts.delete(id);
        log(`📴 ESP disconnected: ${id} (code ${code})`);
        break;
      }
    }
    for (const [cmd, set] of awaitingResponses.entries()) {
      if (set.has(ws)) {
        set.delete(ws);
        if (!set.size) { awaitingResponses.delete(cmd); clearCommandTimeout(cmd); }
      }
    }
    for (const [espId, set] of viewers.entries()) {
      set.delete(ws);
      if (!set.size) viewers.delete(espId);
    }
    lastSeen.delete(ws);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, sock] of clients.entries()) {
    const seen = lastSeen.get(sock);
    if (seen === undefined) continue;
    if (now - seen > ESP_STALE_MS) {
      warn(`💀 ${id} silent ${Math.round((now - seen)/1000)}s — dropping`);
      try { sock.terminate(); } catch {}
      clients.delete(id);
      passwords.delete(id);
      lastSeen.delete(sock);
      recentTimeouts.delete(id);
    }
  }
}, WATCHDOG_TICK_MS);

console.log("✅ WebSocket server started");