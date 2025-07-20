const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: 8080 });

const clients = new Map(); // id => WebSocket
const passwords = new Map(); // id => password
const awaitingResponses = new Map(); // commandId => WebSocket
const lastUsedEspByClient = new Map(); // WebSocket => ESP ID
const clientCommandMap = new Map(); // WebSocket => commandId

console.log("WebSocket server started on port 8080");

wss.on("connection", (ws) => {
  console.log("🔌 New client connected:", {
    remoteAddress: ws._socket.remoteAddress,
    remotePort: ws._socket.remotePort
  });

  ws.on("error", (error) => {
    console.error("❌ WebSocket error:", error.message);
    ws.close(1007, "Invalid UTF-8");
  });

  ws.on("message", (data, isBinary) => {
    const utf8String = data.toString("utf8").trim();
    console.log("📥 Incoming:", utf8String);

    if (isBinary) return;

    let msg = null;

    try {
      msg = JSON.parse(utf8String);
      console.log("✅ Parsed JSON Message:", msg);
    } catch {
      // Raw ESP response like: abc123::SOMETHING
      const parts = utf8String.split("::");
      if (parts.length >= 2) {
        const commandId = parts[0];
        const payload = parts.slice(1).join("::");

        const targetClient = awaitingResponses.get(commandId);
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
          targetClient.send(JSON.stringify({
            type: "response",
            commandId,
            response: payload
          }));
          awaitingResponses.delete(commandId);
          clientCommandMap.delete(targetClient);
        } else {
          console.warn("⚠️ No client awaiting commandId:", commandId);
        }
      } else {
        console.warn("⚠️ Unrecognized raw message format.");
      }
      return;
    }

    switch (msg.type) {
      case "register_esp": {
        if (clients.has(msg.id)) {
          const oldClient = clients.get(msg.id);
          if (oldClient.readyState === WebSocket.OPEN) {
            oldClient.send(JSON.stringify({
              type: "disconnect",
              reason: "new connection replaced old one"
            }));
            oldClient.close();
          }
        }
        clients.set(msg.id, ws);
        passwords.set(msg.id, msg.password);
        console.log(`✅ ESP registered: ${msg.id}`);
        break;
      }

      case "check_esps": {
        const results = msg.devices.map((device) => {
          const client = clients.get(device.id);
          const storedPassword = passwords.get(device.id);
          return {
            id: device.id,
            online: !!client,
            auth: storedPassword === device.password
          };
        });
        ws.send(JSON.stringify({ type: "check_results", results }));
        break;
      }

      case "command": {
        const targetClient = clients.get(msg.targetId);
        const correctPassword = passwords.get(msg.targetId);

        if (!targetClient) {
          return ws.send(JSON.stringify({
            type: "error",
            message: `ESP ${msg.targetId} not online`
          }));
        }

        if (correctPassword !== msg.password) {
          return ws.send(JSON.stringify({
            type: "error",
            message: "Wrong password"
          }));
        }

        const commandId = Math.random().toString(36).substring(2, 10);

        // Replace old commandId for this client
        const oldCmdId = clientCommandMap.get(ws);
        if (oldCmdId) awaitingResponses.delete(oldCmdId);

        // Register this command
        awaitingResponses.set(commandId, ws);
        clientCommandMap.set(ws, commandId);
        lastUsedEspByClient.set(ws, msg.targetId);

        // Send command to ESP
        targetClient.send(JSON.stringify({
          type: "command",
          commandId,
          message: msg.message
        }));

        // Acknowledge to client
        ws.send(JSON.stringify({
          type: "command_sent",
          commandId,
          targetId: msg.targetId,
          message: `Command sent to ESP ${msg.targetId}`
        }));
        break;
      }

      case "ping":
        ws.send(JSON.stringify({ type: "pong", message: "Pong response" }));
        break;

      default:
        console.log("❓ Unknown message type:", msg.type);
    }
  });

  ws.on("close", () => {
    // Remove from ESP list if it's one
    for (const [id, client] of clients.entries()) {
      if (client === ws) {
        clients.delete(id);
        passwords.delete(id);
        console.log(`📴 ESP disconnected: ${id}`);
      }
    }

    // Remove from waiting lists
    const lastCmd = clientCommandMap.get(ws);
    if (lastCmd) {
      awaitingResponses.delete(lastCmd);
      clientCommandMap.delete(ws);
    }

    const lastEspId = lastUsedEspByClient.get(ws);
    if (lastEspId) {
      const espSocket = clients.get(lastEspId);
      if (espSocket && espSocket.readyState === WebSocket.OPEN) {
        espSocket.send(JSON.stringify({
          type: "disconnect",
          reason: "client disconnected"
        }));
      }
      lastUsedEspByClient.delete(ws);
    }
  });
});
