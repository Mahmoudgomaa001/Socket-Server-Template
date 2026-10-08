const express = require("express");
const WebSocket = require("ws");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

const QUIET = process.env.QUIET === "1";

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}]`;
}
function log(...a) {
  if (!QUIET) console.log(ts(), ...a);
}
function warn(...a) {
  console.log(ts(), ...a);
}
function brief(s, max = 180) {
  if (typeof s !== "string") s = String(s);
  return s.length <= max ? s : s.slice(0, max) + `…(+${s.length - max}B)`;
}

app.use(express.json({ limit: "32kb" }));
app.use(express.static("public"));

app.get("/firmware.bin", async (req, res) => {
  const url =
    "https://raw.githubusercontent.com/Mahmoudgomaa001/yono_qr_update/main/firmware.bin";
  log("[HTTP] /firmware.bin requested");
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error("GitHub fetch failed");
    const buf = await r.buffer();
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Connection", "close");
    res.send(buf);
    log(`[HTTP] /firmware.bin sent ${buf.length}B`);
  } catch (e) {
    warn("❌ [HTTP] Firmware fetch:", e.message);
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
    duration: Number(duration) || 0,
  });
  if (usageLog.length > 1000) usageLog.length = 1000;
  log(`[HTTP] /log POST device=${device} action=${action}`);
  res.json({ ok: true });
});
app.get("/log", (req, res) => {
  const device = String(req.query.device || "").toUpperCase();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 20));
  const rows = (
    device ? usageLog.filter((r) => r.device === device) : usageLog
  ).slice(0, limit);
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
      healthy: ws.readyState === WebSocket.OPEN && ageSec < 200,
      timeouts: (recentTimeouts.get(id) || []).length,
      session: sessions.get(id) || null,
      outboundBuffer: ws.bufferedAmount || 0,
    });
  }
  log(`[HTTP] /health → ${rows.length} ESPs`);
  res.json({ ok: true, espCount: rows.length, rows });
});

const server = app.listen(PORT, () => log(`[HTTP] listening on ${PORT}`));
const wss = new WebSocket.Server({ server, skipUTF8Validation: true });

const clients = new Map();
const passwords = new Map();
const awaitingResponses = new Map();
const lastSeen = new Map();
const recentTimeouts = new Map();
const sessions = new Map();
const viewers = new Map();
const pingCount = new Map();
const wsId = new Map();
const wsRole = new Map();
let wsCounter = 0;

// ---- Timing ----
// ESP_STALE_MS = 300s = 5 min. Old ESPs ping every 60s → 5x margin, safe.
const ESP_STALE_MS = 300000;
const WATCHDOG_TICK_MS = 20000;
const COMMAND_TIMEOUT_MS = 25000;
const TIMEOUT_WINDOW_MS = 60000;
const TIMEOUT_KILL_COUNT = 3;

const BROWSER_BACKPRESSURE_LIMIT = 200000;
const ACK_MAX_DELAY_MS = 500;
const ACK_MIN_DELAY_MS = 150;
const ACK_DELAY_LOG_MS = 50;

const commandTimeouts = new Map();
const ackStats = new Map();

function shortWs(ws) {
  let id = wsId.get(ws);
  if (!id) {
    id = `ws${++wsCounter}`;
    wsId.set(ws, id);
  }
  return id;
}
function roleOf(ws) {
  return wsRole.get(ws) || "unknown";
}

function safeSend(ws, msg, why) {
  if (ws.readyState !== WebSocket.OPEN) {
    log(`❌ [SEND] ${shortWs(ws)} not OPEN why=${why}`);
    return false;
  }
  if (ws.bufferedAmount > BROWSER_BACKPRESSURE_LIMIT) {
    log(`❌ [SEND] ${shortWs(ws)} buffer full why=${why}`);
    return false;
  }
  ws.send(msg, (err) => {
    if (err) warn(`❌ [SEND] ${shortWs(ws)}: ${err.message}`);
    else log(`[SEND] ${shortWs(ws)} ${brief(msg)} why=${why}`);
  });
  return true;
}

function armCommandTimeout(commandId, espId) {
  const old = commandTimeouts.get(commandId);
  if (old) clearTimeout(old);
  const t = setTimeout(() => {
    const waiters = awaitingResponses.get(commandId);
    if (waiters)
      waiters.forEach((c) => {
        if (c.readyState === WebSocket.OPEN)
          c.send(JSON.stringify({ type: "error", message: "timeout" }));
      });
    awaitingResponses.delete(commandId);
    commandTimeouts.delete(commandId);
    ackStats.delete(commandId);
    if (espId) {
      const now = Date.now();
      let arr = (recentTimeouts.get(espId) || []).filter(
        (x) => now - x < TIMEOUT_WINDOW_MS,
      );
      arr.push(now);
      recentTimeouts.set(espId, arr);
      if (arr.length >= TIMEOUT_KILL_COUNT) {
        const sock = clients.get(espId);
        if (sock) {
          warn(`💥 [TIMEOUT] ${espId} 3x in 60s — terminating`);
          try {
            sock.terminate();
          } catch {}
          clients.delete(espId);
          passwords.delete(espId);
          lastSeen.delete(sock);
        }
        recentTimeouts.delete(espId);
      }
    }
    warn(`⏱️  [TIMEOUT] ${commandId} (esp=${espId || "?"})`);
  }, COMMAND_TIMEOUT_MS);
  commandTimeouts.set(commandId, t);
}
function clearCommandTimeout(id) {
  const t = commandTimeouts.get(id);
  if (t) {
    clearTimeout(t);
    commandTimeouts.delete(id);
  }
}
function espIdForSocket(ws) {
  for (const [id, s] of clients.entries()) if (s === ws) return id;
  return null;
}
function isTagChunk(p) {
  return p.startsWith('{"tags"') || p.startsWith('{"cloneTags"');
}

function broadcastSession(espId, kind, extra) {
  const set = viewers.get(espId);
  if (!set || !set.size) return;
  const payload = JSON.stringify({
    type: kind,
    espId,
    session: sessions.get(espId) || null,
    ...(extra || {}),
  });
  set.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  });
  log(`[SESSION] broadcast ${kind} ${espId} → ${set.size} viewer(s)`);
}

wss.on("connection", (ws) => {
  const id = shortWs(ws);
  lastSeen.set(ws, Date.now());
  log(`🟢 [CONN] ${id} connected`);

  ws.on("error", (err) => warn(`❌ [CONN] ${id}: ${err.message}`));

  ws.on("message", (data, isBinary) => {
    lastSeen.set(ws, Date.now());
    if (isBinary) return;

    let text;
    try {
      text = data.toString("utf8");
    } catch {
      return;
    }
    if (!text || text.length > 5000) return;

    // ---- RAW ESP ----
    if (text.includes("::")) {
      const i = text.indexOf("::");
      const commandId = text.substring(0, i);
      const payload = text.substring(i + 2);
      const fromEsp = espIdForSocket(ws);
      const isTag = isTagChunk(payload);

      if (isTag) {
        const stats = ackStats.get(commandId) || { count: 0 };
        stats.count++;
        ackStats.set(commandId, stats);
        log(
          `[RX] ${id} (${fromEsp || "?"}) tag #${stats.count} ${brief(payload, 100)}`,
        );
      } else {
        log(`[RX] ${id} (${fromEsp || "?"}) ${commandId}:: ${brief(payload)}`);
      }

      clearCommandTimeout(commandId);

      if (commandId === "auto_off") {
        const espId = payload.trim().toUpperCase();
        if (espId && sessions.has(espId)) {
          sessions.delete(espId);
          broadcastSession(espId, "session_end", { reason: "auto" });
          log(`[AUTO] ${espId} auto-off`);
        }
        return;
      }

      const waiters = awaitingResponses.get(commandId);

      let maxBuffered = 0;
      if (waiters && waiters.size)
        waiters.forEach(
          (c) => (maxBuffered = Math.max(maxBuffered, c.bufferedAmount || 0)),
        );

      if (waiters) {
        waiters.forEach((client) => {
          if (client.readyState !== WebSocket.OPEN) return;
          if (isTag && client.bufferedAmount > BROWSER_BACKPRESSURE_LIMIT) {
            warn(`❌ [FWD] ${shortWs(client)} buffer full — chunk dropped`);
            return;
          }
          client.send(payload);
          if (!isTag) log(`[FWD] → ${shortWs(client)} ${brief(payload)}`);
        });
      }

      // Adaptive ack
      if (isTag && ws.readyState === WebSocket.OPEN) {
        const bufRatio = maxBuffered / BROWSER_BACKPRESSURE_LIMIT;
        const dynamicDelay = Math.floor(bufRatio * ACK_MAX_DELAY_MS);
        const ackDelay = Math.min(
          ACK_MAX_DELAY_MS,
          Math.max(ACK_MIN_DELAY_MS, dynamicDelay),
        );
        if (ackDelay > ACK_DELAY_LOG_MS)
          log(`[ACK] ${commandId} delay=${ackDelay}ms buf=${maxBuffered}B`);
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "ack", commandId }));
        }, ackDelay);
      } else if (!isTag && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ack", commandId }));
      }
      return;
    }

    // ---- JSON ----
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    log(`[RX] ${id} JSON type=${msg.type}`);

    switch (msg.type) {
      case "register_esp": {
        const oldSock = clients.get(msg.id);
        if (oldSock && oldSock !== ws) {
          warn(`🔁 [REG] ${msg.id} replacing old socket`);
          try {
            oldSock.terminate();
          } catch {}
          lastSeen.delete(oldSock);
        }
        clients.set(msg.id, ws);
        passwords.set(msg.id, msg.password);
        recentTimeouts.delete(msg.id);
        wsRole.set(ws, `esp:${msg.id}`);
        log(`📡 [REG] ${msg.id} registered`);
        break;
      }
      case "ping": {
        const cnt = (pingCount.get(ws) || 0) + 1;
        pingCount.set(ws, cnt);
        if (cnt % 4 === 0)
          log(`💓 [PING] ${espIdForSocket(ws) || "?"} #${cnt}`);
        safeSend(ws, JSON.stringify({ type: "pong" }), "pong");
        break;
      }
      case "check_esps": {
        const results = msg.devices.map((d) => ({
          id: d.id,
          online: !!clients.get(d.id),
          auth: passwords.get(d.id) === d.password,
        }));
        safeSend(
          ws,
          JSON.stringify({ type: "check_results", results }),
          "check_results",
        );
        break;
      }
      case "command": {
        const target = clients.get(msg.targetId);
        const pass = passwords.get(msg.targetId);
        if (!target)
          return safeSend(
            ws,
            JSON.stringify({ type: "error", message: "ESP not online" }),
            "err-offline",
          );
        if (pass !== msg.password)
          return safeSend(
            ws,
            JSON.stringify({ type: "error", message: "Wrong password" }),
            "err-pw",
          );

        const commandId = Math.random().toString(36).substr(2, 6);
        for (const [id2, set] of awaitingResponses.entries()) {
          if (set.has(ws)) {
            set.delete(ws);
            if (!set.size) {
              awaitingResponses.delete(id2);
              clearCommandTimeout(id2);
            }
          }
        }
        awaitingResponses.set(commandId, new Set([ws]));
        armCommandTimeout(commandId, msg.targetId);
        ackStats.delete(commandId);

        target.send(
          JSON.stringify({ type: "command", commandId, message: msg.message }),
          (err) => {
            if (err) warn(`❌ [CMD] send failed: ${err.message}`);
          },
        );
        log(
          `📤 [CMD] ${shortWs(ws)} → ${msg.targetId} (${commandId}): ${msg.message}`,
        );
        break;
      }
      case "watch_esp": {
        const espId = String(msg.espId || "").toUpperCase();
        if (!espId) return;
        if (!viewers.has(espId)) viewers.set(espId, new Set());
        viewers.get(espId).add(ws);
        safeSend(
          ws,
          JSON.stringify({
            type: "session_snapshot",
            espId,
            session: sessions.get(espId) || null,
            online: !!clients.get(espId),
          }),
          "snapshot",
        );
        log(`[WATCH] ${id} watching ${espId}`);
        break;
      }
      case "session_start": {
        const espId = String(msg.espId || "").toUpperCase();
        const minutes = Math.max(1, Math.min(600, Number(msg.minutes) || 0));
        const tag = String(msg.tag || "").slice(0, 32);
        if (!espId || !minutes) return;
        const target = clients.get(espId);
        const pass = passwords.get(espId);
        if (!target)
          return safeSend(
            ws,
            JSON.stringify({ type: "error", message: "ESP not online" }),
            "err-offline",
          );
        if (pass !== msg.password)
          return safeSend(
            ws,
            JSON.stringify({ type: "error", message: "Wrong password" }),
            "err-pw",
          );
        const existing = sessions.get(espId);
        if (existing?.running && Date.parse(existing.endTimeUTC) > Date.now()) {
          const left = Math.ceil(
            (Date.parse(existing.endTimeUTC) - Date.now()) / 60000,
          );
          return safeSend(
            ws,
            JSON.stringify({
              type: "error",
              message: "Device busy, " + left + " min left",
            }),
            "err-busy",
          );
        }
        sessions.set(espId, {
          running: true,
          endTimeUTC: new Date(Date.now() + minutes * 60000).toISOString(),
          startedBy: tag,
          durationMin: minutes,
        });
        target.send(
          JSON.stringify({
            type: "command",
            commandId: "s" + Math.random().toString(36).slice(2, 8),
            message: "m1r_on:" + minutes,
          }),
        );
        broadcastSession(espId, "session_start", {});
        log(`▶️  [SESSION] start ${espId} ${minutes}m by ${tag}`);
        break;
      }
      case "session_stop": {
        const espId = String(msg.espId || "").toUpperCase();
        const tag = String(msg.tag || "").slice(0, 32);
        if (!espId) return;
        const target = clients.get(espId);
        const pass = passwords.get(espId);
        if (!target || pass !== msg.password)
          return safeSend(
            ws,
            JSON.stringify({ type: "error", message: "Cannot stop" }),
            "err-stop",
          );
        sessions.delete(espId);
        target.send(
          JSON.stringify({
            type: "command",
            commandId: "s" + Math.random().toString(36).slice(2, 8),
            message: "m1r_off",
          }),
        );
        broadcastSession(espId, "session_end", {
          byTag: tag,
          reason: "manual",
        });
        log(`⏹️  [SESSION] stop ${espId} by ${tag}`);
        break;
      }
      default:
        warn(`⚠️  [RX] ${id} unknown type="${msg.type}"`);
    }
  });

  ws.on("close", (code) => {
    const role = roleOf(ws);
    log(`🔴 [CONN] ${id} closed code=${code} role=${role}`);
    if (code === 1007) return;

    for (const [espId, client] of clients.entries()) {
      if (client === ws) {
        clients.delete(espId);
        passwords.delete(espId);
        recentTimeouts.delete(espId);
        log(`📴 [REG] ${espId} unregistered`);
        break;
      }
    }
    for (const [cmd, set] of awaitingResponses.entries()) {
      if (set.has(ws)) {
        set.delete(ws);
        if (!set.size) {
          awaitingResponses.delete(cmd);
          clearCommandTimeout(cmd);
        }
      }
    }
    for (const [espId, set] of viewers.entries()) {
      set.delete(ws);
      if (!set.size) viewers.delete(espId);
    }
    lastSeen.delete(ws);
    pingCount.delete(ws);
    wsId.delete(ws);
    wsRole.delete(ws);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, sock] of clients.entries()) {
    const seen = lastSeen.get(sock);
    if (seen === undefined) continue;
    const age = now - seen;
    if (age > ESP_STALE_MS) {
      warn(`💀 [WATCHDOG] ${id} silent ${Math.round(age / 1000)}s — dropping`);
      try {
        sock.terminate();
      } catch {}
      clients.delete(id);
      passwords.delete(id);
      lastSeen.delete(sock);
      recentTimeouts.delete(id);
    } else if (age > 120000) {
      log(`⏳ [WATCHDOG] ${id} silent ${Math.round(age / 1000)}s`);
    }
  }
}, WATCHDOG_TICK_MS);

setInterval(() => {
  log(
    `[STATE] ESPs=${clients.size} sessions=${sessions.size} viewers=${viewers.size} pending=${awaitingResponses.size}`,
  );
  for (const [id, ws] of clients.entries()) {
    const ageSec = Math.round((Date.now() - (lastSeen.get(ws) || 0)) / 1000);
    log(`[STATE]   ${id} buffered=${ws.bufferedAmount}B lastSeen=${ageSec}s`);
  }
}, 60000);

log(`[BOOT] ✅ WS server started`);
