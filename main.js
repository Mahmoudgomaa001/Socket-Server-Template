const express = require("express");
const WebSocket = require("ws");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// -------- Serve firmware file from GitHub as a proxy --------
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

// -------- Start Express HTTP Server --------
const server = app.listen(PORT, () => {
  console.log("✅ HTTP server running on port", PORT);
});

// -------- WebSocket Server --------
const wss = new WebSocket.Server({
  server,
  skipUTF8Validation: true, // ✅ PREVENT UTF-8 CRASH
});

const clients = new Map();
const passwords = new Map();
const awaitingResponses = new Map();
const lastUsedEspByClient = new Map();

console.log("✅ WebSocket server started");

// -------- Safe send helper --------
function safeSend(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(message, (err) => {
      if (err) {
        console.error("❌ Send failed:", err.message);
      } else {
        console.log("📤 Message sent:", message);
      }
    });
  } else {
    console.warn("⚠️ Tried to send to closed client");
  }
}

// -------- WebSocket Connection Handler --------
wss.on("connection", (ws) => {
  console.log("🔌 New client connected");

  // ✅ PREVENT SERVER CRASH
  ws.on("error", (err) => {
    console.error("⚠️ WebSocket error:", err.message);
  });

  ws.on("message", (data, isBinary) => {
    let text;

    // ✅ Ignore binary garbage
    if (isBinary) {
      console.warn("⚠️ Ignored binary message");
      return;
    }

    // ✅ Safe decode
    try {
      text = data.toString("utf8");
    } catch (e) {
      console.error("❌ Invalid UTF-8 message dropped");
      return;
    }

    if (!text || text.length > 5000) {
      console.warn("⚠️ Suspicious message dropped");
      return;
    }

    console.log("📨 Incoming message:", text);

    // -------- RAW ESP RESPONSE (:: format) --------
    if (text.includes("::")) {
      const delimiterIndex = text.indexOf("::");
      const commandId = text.substring(0, delimiterIndex);
      const payload = text.substring(delimiterIndex + 2);

      console.log(`📩 Raw ESP response for commandId: ${commandId}`);
      console.log(`🧾 Payload: ${payload}`);

      const responseClients = awaitingResponses.get(commandId);

      if (responseClients && responseClients.size > 0) {
        responseClients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(payload, (err) => {
              if (err) {
                console.error(`❌ Failed to send to client: ${err.message}`);
              } else {
                console.log(`✅ Sent to client (${commandId}):`, payload);
              }
            });
          }
        });
      } else {
        console.log("⚠️ No client awaiting commandId:", commandId);
      }
      return;
    }

    // -------- JSON HANDLING --------
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      console.log("❌ Invalid JSON:", text);
      return;
    }

    switch (msg.type) {
      case "register_esp":
        clients.set(msg.id, ws);
        passwords.set(msg.id, msg.password);
        console.log(`📡 Registered ESP: ${msg.id}`);
        break;

      case "check_esps":
        const results = msg.devices.map((device) => {
          const client = clients.get(device.id);
          const storedPassword = passwords.get(device.id);

          return {
            id: device.id,
            online: !!client,
            auth: storedPassword === device.password,
          };
        });

        safeSend(
          ws,
          JSON.stringify({
            type: "check_results",
            results: results,
          }),
        );
        break;

      case "command":
        const targetClient = clients.get(msg.targetId);
        const correctPassword = passwords.get(msg.targetId);

        if (!targetClient) {
          safeSend(
            ws,
            JSON.stringify({
              type: "error",
              message: "ESP not online",
            }),
          );
          return;
        }

        if (correctPassword !== msg.password) {
          safeSend(
            ws,
            JSON.stringify({
              type: "error",
              message: "Wrong password",
            }),
          );
          return;
        }

        const commandId = Math.random().toString(36).substr(2, 6);

        // Disconnect from previous ESP
        const lastEspId = lastUsedEspByClient.get(ws);
        if (lastEspId && lastEspId !== msg.targetId) {
          const previousEsp = clients.get(lastEspId);
          if (previousEsp && previousEsp.readyState === WebSocket.OPEN) {
            previousEsp.send(
              JSON.stringify({
                type: "disconnect",
                reason: "client switched ESP",
              }),
            );
          }
        }

        lastUsedEspByClient.set(ws, msg.targetId);

        // Clear old waiting
        for (const [oldCommandId, clientSet] of awaitingResponses.entries()) {
          if (clientSet.has(ws)) {
            clientSet.delete(ws);
            if (clientSet.size === 0) {
              awaitingResponses.delete(oldCommandId);
            }
          }
        }

        awaitingResponses.set(commandId, new Set([ws]));

        // Send command
        targetClient.send(
          JSON.stringify({
            type: "command",
            commandId: commandId,
            message: msg.message,
          }),
          (err) => {
            if (err) {
              console.error(`❌ Failed to send command: ${err.message}`);
            } else {
              console.log(
                `📤 Command sent to ESP ${msg.targetId} (${commandId})`,
              );
            }
          },
        );

        break;

      default:
        console.log("⚠️ Unknown message type:", msg.type);
        break;
    }
  });

  ws.on("close", () => {
    console.log("🔌 Client disconnected");

    for (const [id, client] of clients.entries()) {
      if (client === ws) {
        clients.delete(id);
        passwords.delete(id);
        console.log(`📴 ESP disconnected: ${id}`);
        break;
      }
    }

    for (const [commandId, clientSet] of awaitingResponses.entries()) {
      if (clientSet.has(ws)) {
        clientSet.delete(ws);
        if (clientSet.size === 0) {
          awaitingResponses.delete(commandId);
        }
      }
    }

    const lastEspId = lastUsedEspByClient.get(ws);
    if (lastEspId) {
      const lastEsp = clients.get(lastEspId);
      if (lastEsp && lastEsp.readyState === WebSocket.OPEN) {
        lastEsp.send(
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
