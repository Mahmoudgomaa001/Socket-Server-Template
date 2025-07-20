const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: 8080 });

const clients = new Map();             // id => WebSocket
const passwords = new Map();           // id => password
const awaitingResponses = new Map();   // commandId => Set of WebSockets
const lastUsedEspByClient = new Map(); // WebSocket => ESP ID

console.log("✅ WebSocket server started on port 8080");

wss.on("connection", (ws) => {
  console.log("🔌 New client connected");

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      console.log("❌ Invalid JSON:", data);
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
            auth: storedPassword === device.password
          };
        });

        ws.send(JSON.stringify({
          type: "check_results",
          results: results
        }));
        break;

      case "command":
        const targetClient = clients.get(msg.targetId);
        const correctPassword = passwords.get(msg.targetId);

        if (!targetClient) {
          ws.send(JSON.stringify({
            type: "error",
            message: "ESP not online"
          }));
        } else if (correctPassword !== msg.password) {
          ws.send(JSON.stringify({
            type: "error",
            message: "Wrong password"
          }));
        } else {
          const commandId = Math.random().toString(36).substr(2, 6);

          const lastEspId = lastUsedEspByClient.get(ws);
          if (lastEspId && lastEspId !== msg.targetId) {
            const previousEsp = clients.get(lastEspId);
            if (previousEsp && previousEsp.readyState === WebSocket.OPEN) {
              previousEsp.send(JSON.stringify({
                type: "disconnect",
                reason: "client switched ESP"
              }));
            }
          }

          lastUsedEspByClient.set(ws, msg.targetId);

          // Clear any previous command awaiting responses from this client
          for (const [oldCommandId, clientSet] of awaitingResponses.entries()) {
            if (clientSet.has(ws)) {
              clientSet.delete(ws);
              if (clientSet.size === 0) {
                awaitingResponses.delete(oldCommandId);
              }
            }
          }

          // Register this client for response
          awaitingResponses.set(commandId, new Set([ws]));

          // Send command to ESP
          targetClient.send(JSON.stringify({
            type: "command",
            commandId: commandId,
            message: msg.message
          }));
        }
        break;

      case "response":
        if (typeof msg.response !== "string") {
          console.log("⚠️ Invalid response format from ESP");
          return;
        }

        const parts = msg.response.split("::");
        if (parts.length < 2) {
          console.log("⚠️ Malformed response payload:", msg.response);
          return;
        }

        const commandId = parts[0];
        const payload = parts.slice(1).join("::");

        const responseClients = awaitingResponses.get(commandId);

        if (responseClients && responseClients.size > 0) {
          responseClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(payload); // ✅ Send raw payload only (no wrapping)
            }
          });

          awaitingResponses.delete(commandId);
        } else {
          console.log("⚠️ No client awaiting commandId:", commandId);
        }
        break;

      default:
        console.log("⚠️ Unknown message type:", msg.type);
        break;
    }
  });

  ws.on("close", () => {
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
        lastEsp.send(JSON.stringify({
          type: "disconnect",
          reason: "client disconnected"
        }));
      }
      lastUsedEspByClient.delete(ws);
    }
  });
});
