const express = require("express");
const WebSocket = require("ws");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

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

// -------- HTTP Server --------
const server = app.listen(PORT, () => {
  console.log("✅ HTTP server running on port", PORT);
});

// -------- WebSocket Server --------
const wss = new WebSocket.Server({
  server,
  skipUTF8Validation: true, // ✅ prevent UTF-8 crash
});

const clients = new Map();
const passwords = new Map();
const awaitingResponses = new Map();
const lastUsedEspByClient = new Map();

console.log("✅ WebSocket server started");

// -------- Safe send --------
function safeSend(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(message, (err) => {
      if (err) {
        console.error("❌ Send failed:", err.message);
      } else {
        console.log("📤 Message sent:", message);
      }
    });
  }
}

// -------- Connection --------
wss.on("connection", (ws) => {
  console.log("🔌 New client connected");

  // ✅ Ignore errors (DO NOT CLOSE)
  ws.on("error", (err) => {
    console.warn("⚠️ WS error ignored:", err.message);
  });

  // -------- MESSAGE --------
  ws.on("message", (data, isBinary) => {
    let text;

    // ❌ Ignore binary garbage
    if (isBinary) {
      console.warn("⚠️ Ignored binary message");
      return;
    }

    // ❌ Safe decode
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

    console.log("📨 Incoming message:", text);

    // -------- RAW ESP (::) --------
    if (text.includes("::")) {
      const i = text.indexOf("::");
      const commandId = text.substring(0, i);
      const payload = text.substring(i + 2);

      const responseClients = awaitingResponses.get(commandId);

      if (responseClients) {
        responseClients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
          }
        });
      }

      return;
    }

    // -------- JSON --------
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      console.warn("⚠️ Invalid JSON ignored");
      return;
    }

    switch (msg.type) {
      case "register_esp":
        clients.set(msg.id, ws);
        passwords.set(msg.id, msg.password);
        console.log(`📡 Registered ESP: ${msg.id}`);
        break;

      case "check_esps":
        const results = msg.devices.map((d) => ({
          id: d.id,
          online: !!clients.get(d.id),
          auth: passwords.get(d.id) === d.password,
        }));

        safeSend(
          ws,
          JSON.stringify({
            type: "check_results",
            results,
          }),
        );
        break;

      case "command":
        const target = clients.get(msg.targetId);
        const pass = passwords.get(msg.targetId);

        if (!target) {
          safeSend(
            ws,
            JSON.stringify({ type: "error", message: "ESP not online" }),
          );
          return;
        }

        if (pass !== msg.password) {
          safeSend(
            ws,
            JSON.stringify({ type: "error", message: "Wrong password" }),
          );
          return;
        }

        const commandId = Math.random().toString(36).substr(2, 6);

        // switch ESP
        const lastEsp = lastUsedEspByClient.get(ws);
        if (lastEsp && lastEsp !== msg.targetId) {
          const prev = clients.get(lastEsp);
          if (prev && prev.readyState === WebSocket.OPEN) {
            prev.send(
              JSON.stringify({
                type: "disconnect",
                reason: "client switched ESP",
              }),
            );
          }
        }

        lastUsedEspByClient.set(ws, msg.targetId);

        // clear old waits
        for (const [id, set] of awaitingResponses.entries()) {
          if (set.has(ws)) {
            set.delete(ws);
            if (!set.size) awaitingResponses.delete(id);
          }
        }

        awaitingResponses.set(commandId, new Set([ws]));

        target.send(
          JSON.stringify({
            type: "command",
            commandId,
            message: msg.message,
          }),
        );

        console.log(`📤 Command sent to ESP ${msg.targetId} (${commandId})`);
        break;

      default:
        console.warn("⚠️ Unknown type:", msg.type);
    }
  });

  // -------- CLOSE --------
  ws.on("close", (code, reason) => {
    console.warn(`⚠️ Closed (code ${code})`);

    // ✅ IGNORE UTF-8 ERROR CLOSE
    if (code === 1007) {
      console.warn("⚠️ Ignored UTF-8 closure (ESP kept logically connected)");
      return;
    }

    console.log("🔌 Client disconnected");

    // cleanup
    for (const [id, client] of clients.entries()) {
      if (client === ws) {
        clients.delete(id);
        passwords.delete(id);
        console.log(`📴 ESP disconnected: ${id}`);
        break;
      }
    }

    for (const [cmd, set] of awaitingResponses.entries()) {
      if (set.has(ws)) {
        set.delete(ws);
        if (!set.size) awaitingResponses.delete(cmd);
      }
    }

    const lastEsp = lastUsedEspByClient.get(ws);
    if (lastEsp) {
      const esp = clients.get(lastEsp);
      if (esp && esp.readyState === WebSocket.OPEN) {
        esp.send(
          JSON.stringify({
            type: "disconnect",
            reason: "client disconnected",
          }),
        );
      }
      lastUsedEspByClient.delete(ws);
    }
  });
});
