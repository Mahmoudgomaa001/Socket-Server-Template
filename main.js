const express = require("express");
const WebSocket = require("ws");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// -------- Middleware --------
app.use(express.json({ limit: "32kb" }));
app.use(express.static("public"));

// -------- Serve firmware file --------
app.get("/firmware.bin", async (req, res) => {
  const githubUrl =
    "https://raw.githubusercontent.com/Mahmoudgomaa001/yono_qr_update/main/firmware.bin";
  try {
    const response = await fetch(githubUrl);
    if (!response.ok) throw new Error("Failed to fetch from GitHub");

    const buffer = await response.buffer();
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Connection", "close");
    res.send(buffer);
  } catch (err) {
    console.error("❌ Firmware fetch error:", err.message);
    res.status(500).send("Firmware fetch failed");
  }
});

// ============================================================
// Usage log (in-memory, last 1000 entries)
// ============================================================
const usageLog = [];

app.post("/log", (req, res) => {
  const { device, tag, action, duration } = req.body || {};
  if (!device || !action) {
    return res.status(400).json({ ok: false, error: "device & action required" });
  }
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
  const rows = (device ? usageLog.filter(r => r.device === device) : usageLog)
    .slice(0, limit);
  res.json({ ok: true, rows });
});

// -------- HTTP Server --------
const server = app.listen(PORT, () => {
  console.log("✅ HTTP server running on port", PORT);
});

// -------- WebSocket Server --------
const wss = new WebSocket.Server({
  server,
  skipUTF8Validation: true,
});

const clients = new Map();             // espId -> ws  (ESP sockets)
const passwords = new Map();           // espId -> password
const awaitingResponses = new Map();   // commandId -> Set<ws>
const lastUsedEspByClient = new Map(); // ws -> espId
const lastSeen = new Map();            // ws -> timestamp (last message)

// ============ Live sync state ============
const sessions = new Map();  // espId -> { running, endTimeUTC, startedBy, durationMin }
const viewers  = new Map();  // espId -> Set<ws>

// ============ Timing constants ============
const PING_WATCHDOG_MS  = 120000;      // ESP considered dead after 120s silence
const WATCHDOG_TICK_MS  = 30000;       // check every 30s
const COMMAND_TIMEOUT_MS = 10000;      // reply must arrive within 10s

function broadcastSession(espId, kind, extra) {
  const set = viewers.get(espId);
  if (!set || !set.size) return;
  const payload = JSON.stringify({
    type: kind,
    espId,
    session: sessions.get(espId) || null,
    ...(extra || {})
  });
  set.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(payload); });
}

console.log("✅ WebSocket server started");

// -------- Safe send --------
function safeSend(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(message, (err) => {
      if (err) console.error("❌ Send failed:", err.message);
    });
  }
}

// -------- Command timeout helper --------
function armCommandTimeout(commandId) {
  const old = commandTimeouts.get(commandId);
  if (old) clearTimeout(old);
  const t = setTimeout(() => {
    const waiters = awaitingResponses.get(commandId);
    if (waiters) {
      waiters.forEach((c) => {
        if (c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify({ type: "error", message: "timeout" }));
        }
      });
    }
    awaitingResponses.delete(commandId);
    commandTimeouts.delete(commandId);
    console.warn(`⏱️ Command timeout: ${commandId}`);
  }, COMMAND_TIMEOUT_MS);
  commandTimeouts.set(commandId, t);
}
const commandTimeouts = new Map();      // commandId -> Timeout handle

function clearCommandTimeout(commandId) {
  const t = commandTimeouts.get(commandId);
  if (t) { clearTimeout(t); commandTimeouts.delete(commandId); }
}

// -------- Connection --------
wss.on("connection", (ws) => {
  console.log("🔌 New client connected");
  lastSeen.set(ws, Date.now());

  ws.on("error", (err) => {
    console.warn("⚠️ WS error ignored:", err.message);
  });

  ws.on("message", (data, isBinary) => {
    // Any message from this socket refreshes its liveness.
    lastSeen.set(ws, Date.now());

    let text;

    if (isBinary) {
      console.warn("⚠️ Ignored binary message");
      return;
    }

    try {
      text = data.toString("utf8");
    } catch (e) {
      console.warn("⚠️ Invalid UTF-8 dropped");
      return;
    }

    if (!text || text.length > 5000) {
      console.warn("⚠️ Suspicious message dropped");
      return;
    }

    // ---- RAW ESP (::) — no logging clutter for normal tags stream ----
    if (text.includes("::")) {
      const i = text.indexOf("::");
      const commandId = text.substring(0, i);
      const payload = text.substring(i + 2);

      // Clear any pending timeout for this command id.
      clearCommandTimeout(commandId);

      // ESP auto-stopped itself
      if (commandId === "auto_off") {
        const espId = payload.trim().toUpperCase();
        if (espId && sessions.has(espId)) {
          sessions.delete(espId);
          broadcastSession(espId, "session_end", { reason: "auto" });
          console.log(`⏱️  auto_off ${espId}`);
        }
        return;
      }

      // Forward the reply to whoever is waiting on this commandId
      const responseClients = awaitingResponses.get(commandId);
      if (responseClients) {
        responseClients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) client.send(payload);
        });
        awaitingResponses.delete(commandId);
      }
      return;
    }

    // ---- JSON ----
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      console.warn("⚠️ Invalid JSON ignored");
      return;
    }

    switch (msg.type) {
      // ---- ESP registration ----
      case "register_esp": {
        // If this ESP was already registered on a different (dead) socket,
        // remove the old one so we don't hold onto zombies.
        const oldSock = clients.get(msg.id);
        if (oldSock && oldSock !== ws) {
          try { oldSock.terminate(); } catch {}
          lastSeen.delete(oldSock);
          console.log(`🔁 Replaced old socket for ${msg.id}`);
        }
        clients.set(msg.id, ws);
        passwords.set(msg.id, msg.password);
        console.log(`📡 Registered ESP: ${msg.id}`);
        break;
      }

      // ---- Heartbeat (NEW: reply with pong) ----
      // Old ESPs send {"type":"ping"} every 60s. Old servers replied nothing.
      // New server replies {"type":"pong"} — old ESPs ignore unknown types.
      case "ping":
        safeSend(ws, JSON.stringify({ type: "pong" }));
        break;

      // ---- Legacy login check ----
      case "check_esps": {
        const results = msg.devices.map((d) => ({
          id: d.id,
          online: !!clients.get(d.id),
          auth: passwords.get(d.id) === d.password,
        }));
        safeSend(ws, JSON.stringify({ type: "check_results", results }));
        break;
      }

      // ---- Legacy raw command ----
      case "command": {
        const target = clients.get(msg.targetId);
        const pass = passwords.get(msg.targetId);

        if (!target) {
          safeSend(ws, JSON.stringify({ type: "error", message: "ESP not online" }));
          return;
        }
        if (pass !== msg.password) {
          safeSend(ws, JSON.stringify({ type: "error", message: "Wrong password" }));
          return;
        }

        const commandId = Math.random().toString(36).substr(2, 6);

        const lastEsp = lastUsedEspByClient.get(ws);
        if (lastEsp && lastEsp !== msg.targetId) {
          const prev = clients.get(lastEsp);
          if (prev && prev.readyState === WebSocket.OPEN) {
            prev.send(JSON.stringify({
              type: "disconnect",
              reason: "client switched ESP"
            }));
          }
        }
        lastUsedEspByClient.set(ws, msg.targetId);

        // Detach this ws from any previous pending command
        for (const [id, set] of awaitingResponses.entries()) {
          if (set.has(ws)) {
            set.delete(ws);
            if (!set.size) { awaitingResponses.delete(id); clearCommandTimeout(id); }
          }
        }
        awaitingResponses.set(commandId, new Set([ws]));
        armCommandTimeout(commandId);      // NEW: auto-fail if no reply in 10s

        target.send(JSON.stringify({
          type: "command",
          commandId,
          message: msg.message
        }));

        console.log(`📤 Command sent to ESP ${msg.targetId} (${commandId})`);
        break;
      }

      // ---- Browser subscribes to live state for an ESP ----
      case "watch_esp": {
        const espId = String(msg.espId || "").toUpperCase();
        if (!espId) return;
        if (!viewers.has(espId)) viewers.set(espId, new Set());
        viewers.get(espId).add(ws);

        safeSend(ws, JSON.stringify({
          type: "session_snapshot",
          espId,
          session: sessions.get(espId) || null,
          online: !!clients.get(espId)
        }));
        console.log(`👁️  viewer watching ${espId}`);
        break;
      }

      // ---- Start a session ----
      case "session_start": {
        const espId = String(msg.espId || "").toUpperCase();
        const minutes = Math.max(1, Math.min(600, Number(msg.minutes) || 0));
        const tag = String(msg.tag || "").slice(0, 32);
        if (!espId || !minutes) return;

        const target = clients.get(espId);
        const pass = passwords.get(espId);

        if (!target) {
          safeSend(ws, JSON.stringify({ type: "error", message: "ESP not online" }));
          return;
        }
        if (pass !== msg.password) {
          safeSend(ws, JSON.stringify({ type: "error", message: "Wrong password" }));
          return;
        }

        const existing = sessions.get(espId);
        if (existing && existing.running &&
            Date.parse(existing.endTimeUTC) > Date.now()) {
          const left = Math.ceil((Date.parse(existing.endTimeUTC) - Date.now()) / 60000);
          safeSend(ws, JSON.stringify({
            type: "error",
            message: "Device busy, " + left + " min left"
          }));
          return;
        }

        const endTimeUTC = new Date(Date.now() + minutes * 60000).toISOString();
        sessions.set(espId, {
          running: true,
          endTimeUTC,
          startedBy: tag,
          durationMin: minutes
        });

        target.send(JSON.stringify({
          type: "command",
          commandId: "s" + Math.random().toString(36).slice(2, 8),
          message: "m1r_on:" + minutes
        }));

        broadcastSession(espId, "session_start", {});
        console.log(`▶️  session_start ${espId} ${minutes}m by ${tag}`);
        break;
      }

      // ---- Stop a session manually ----
      case "session_stop": {
        const espId = String(msg.espId || "").toUpperCase();
        const tag = String(msg.tag || "").slice(0, 32);
        if (!espId) return;

        const target = clients.get(espId);
        const pass = passwords.get(espId);
        if (!target || pass !== msg.password) {
          safeSend(ws, JSON.stringify({ type: "error", message: "Cannot stop" }));
          return;
        }

        sessions.delete(espId);
        target.send(JSON.stringify({
          type: "command",
          commandId: "s" + Math.random().toString(36).slice(2, 8),
          message: "m1r_off"
        }));

        broadcastSession(espId, "session_end", { byTag: tag, reason: "manual" });
        console.log(`⏹️  session_stop ${espId} by ${tag}`);
        break;
      }

      default:
        console.warn("⚠️ Unknown type:", msg.type);
    }
  });

  // -------- CLOSE --------
  ws.on("close", (code) => {
    console.warn(`⚠️ Closed (code ${code})`);

    if (code === 1007) {
      console.warn("⚠️ Ignored UTF-8 closure (ESP kept logically connected)");
      return;
    }

    console.log("🔌 Client disconnected");

    // Remove ESP registration — only if this ws is still the registered one.
    // (Prevents a stale socket close from un-registering a live ESP.)
    for (const [id, client] of clients.entries()) {
      if (client === ws) {
        clients.delete(id);
        passwords.delete(id);
        console.log(`📴 ESP disconnected: ${id}`);
        break;
      }
    }

    // Clear every pending command timeout that was waiting on this ws
    for (const [cmd, set] of awaitingResponses.entries()) {
      if (set.has(ws)) {
        set.delete(ws);
        if (!set.size) {
          awaitingResponses.delete(cmd);
          clearCommandTimeout(cmd);
        }
      }
    }

    // Remove from viewers
    for (const [espId, set] of viewers.entries()) {
      set.delete(ws);
      if (!set.size) viewers.delete(espId);
    }

    // Legacy "switch ESP" cleanup
    const lastEsp = lastUsedEspByClient.get(ws);
    if (lastEsp) {
      const esp = clients.get(lastEsp);
      if (esp && esp.readyState === WebSocket.OPEN) {
        esp.send(JSON.stringify({
          type: "disconnect",
          reason: "client disconnected"
        }));
      }
      lastUsedEspByClient.delete(ws);
    }

    lastSeen.delete(ws);
  });
});

// ============================================================
// Zombie watchdog — removes ESPs that stop sending messages
// ============================================================
setInterval(() => {
  const now = Date.now();
  for (const [id, sock] of clients.entries()) {
    const seen = lastSeen.get(sock);
    if (seen === undefined) continue;   // never seen — leave alone for now
    const age = now - seen;
    if (age > PING_WATCHDOG_MS) {
      console.warn(`💀 Zombie removed: ${id} (silent ${Math.round(age/1000)}s)`);
      try { sock.terminate(); } catch {}
      clients.delete(id);
      passwords.delete(id);
      lastSeen.delete(sock);
    }
  }
}, WATCHDOG_TICK_MS);