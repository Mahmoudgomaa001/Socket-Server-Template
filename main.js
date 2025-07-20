const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: 8080 });

const clients = new Map();            // id => WebSocket
const passwords = new Map();          // id => password
const awaitingResponses = new Map();  // commandId => Set of WebSockets
const lastUsedEspByClient = new Map(); // WebSocket => ESP ID

console.log("✅ WebSocket server started on port 8080");

wss.on("connection", (ws) => {
  console.log("📡 New client connected");

  ws.on("message", (data) => {
    let msg;
    let rawString = data.toString("utf8");

    try {
      msg = JSON.parse(rawString);
    } catch (e) {
      // Non-JSON: check if it's from an ESP and forward to client
      for (const [espId, espSocket] of clients.entries()) {
        if (espSocket === ws) {
          // Find last client for this ESP
          for (const [commandId, clientSet] of awaitingResponses.entries()) {
            for (const client of clientSet) {
              if (client.readyState === WebSocket.OPEN) {
                client.send(rawString); // Forward raw as-is
              }
            }
          }
          return;
        }
      }
      console.log("⚠️ Invalid JSON and not from registered ESP:", rawString);
      return;
    }

    console.log("📥 Received:", msg);

    switch (msg.type) {
      case "register_esp":
        clients.set(msg.id, ws);
        passwords.set(msg.id, msg.password);
        console.log(`🔌 Registered ESP: ${msg.id}`);
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
          const commandId = msg.commandId || Math.random().toString(36).substr(2, 6);

          // Disconnect old ESP if changed
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

          // Remove ws from all old commandId sets
          for (const [oldCmd, set] of awaitingResponses.entries()) {
            if (set.has(ws)) {
              set.delete(ws);
              if (set.size === 0) awaitingResponses.delete(oldCmd);
            }
          }

          // Set current client as waiting
          if (!awaitingResponses.has(commandId)) {
            awaitingResponses.set(commandId, new Set());
          }
          awaitingResponses.get(commandId).add(ws);

          // Send command to target ESP
          targetClient.send(JSON.stringify({
            type: "command",
            commandId: commandId,
            message: msg.message
          }));

          console.log(`📤 Sent command to ${msg.targetId} with ID ${commandId}`);
        }
        break;

      case "response":
        console.log(`📨 Got response for command: ${msg.commandId}`);
        const waitingClients = awaitingResponses.get(msg.commandId);

        if (waitingClients && waitingClients.size > 0) {
          waitingClients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              // Send only the content, without commandId
              if (msg.response) {
                client.send(JSON.stringify(msg.response));
              } else {
                client.send(JSON.stringify(msg));
              }
            }
          });
          // Optionally clear after response
          // awaitingResponses.delete(msg.commandId);
        }
        break;

      default:
        console.log("⚠️ Unknown message type:", msg.type);
        break;
    }
  });

  ws.on("close", () => {
    // Cleanup ESP registration
    for (const [id, client] of clients.entries()) {
      if (client === ws) {
        clients.delete(id);
        passwords.delete(id);
        console.log(`❌ ESP disconnected: ${id}`);
        break;
      }
    }

    // Cleanup response waiting
    for (const [cmdId, clientSet] of awaitingResponses.entries()) {
      if (clientSet.has(ws)) {
        clientSet.delete(ws);
        if (clientSet.size === 0) {
          awaitingResponses.delete(cmdId);
        }
      }
    }

    // Notify last ESP that client disconnected
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
