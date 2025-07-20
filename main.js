const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: 8080 });

const clients = new Map(); // id => WebSocket
const passwords = new Map(); // id => password
const awaitingResponses = new Map(); // commandId => WebSocket
const clientCommandMap = new Map(); // WebSocket => commandId

console.log("✅ WebSocket server started on port 8080");

wss.on("connection", (ws) => {
  console.log("🔌 New connection established");

  ws.on("message", (data) => {
    try {
      const msgText = data.toString();
      // Check if it's a raw ESP response like: "commandId::data"
      const colonIndex = msgText.indexOf("::");
      if (colonIndex > 0) {
        const commandId = msgText.substring(0, colonIndex);
        const payload = msgText.substring(colonIndex + 2);

        console.log(`📥 Incoming: ${msgText}`);

        const targetClient = awaitingResponses.get(commandId);
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
          targetClient.send(payload);
        } else {
          console.warn(`⚠️ No client awaiting commandId: ${commandId}`);
        }
        return;
      }

      // Parse JSON message
      const msg = JSON.parse(msgText);
      console.log("✅ Parsed JSON Message:", msg);

      // Handle different message types
      switch (msg.type) {
        case "register_esp": {
          if (!msg.id || !msg.password) {
            ws.send(JSON.stringify({ error: "Missing id or password" }));
            return;
          }
          clients.set(msg.id, ws);
          passwords.set(msg.id, msg.password);
          ws.clientId = msg.id;
          ws.isESP = true;
          // ws.send(JSON.stringify({ success: "ESP registered successfully" }));
          break;
        }

        case "command": {
          const { targetId, password, message } = msg;

          const targetClient = clients.get(targetId);
          const storedPassword = passwords.get(targetId);

          if (!targetClient || !storedPassword || storedPassword !== password) {
            ws.send(JSON.stringify({ error: "Invalid targetId or password" }));
            return;
          }

          const commandId = Math.random().toString(36).substring(2, 10);

          // Remove old commandId from this client
          const oldCmdId = clientCommandMap.get(ws);
          if (oldCmdId) {
            awaitingResponses.delete(oldCmdId);
          }

          // Save new commandId
          awaitingResponses.set(commandId, ws);
          clientCommandMap.set(ws, commandId);

          // Forward to ESP
          targetClient.send(JSON.stringify({
            type: "command",
            commandId,
            message
          }));

          console.log(`➡️ Forwarded commandId ${commandId} to ESP ${targetId}`);
          break;
        }

        case "ping":
          ws.send(JSON.stringify({ pong: true }));
          break;

        default:
          // ws.send(JSON.stringify({ error: "Unknown message type" }));
          break;
      }

    } catch (err) {
      console.error("❌ Error handling message:", err.message);
      // ws.send(JSON.stringify({ error: "Invalid message format" }));
    }
  });

  ws.on("close", () => {
    console.log("❌ Connection closed");

    const oldCmdId = clientCommandMap.get(ws);
    if (oldCmdId) {
      awaitingResponses.delete(oldCmdId);
      clientCommandMap.delete(ws);
    }

    // Remove client ID if it was registered
    for (const [id, socket] of clients.entries()) {
      if (socket === ws) {
        clients.delete(id);
        passwords.delete(id);
        break;
      }
    }
  });
});
