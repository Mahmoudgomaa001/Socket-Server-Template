const WebSocket = require("ws");
const { randomUUID } = require("crypto");

const wss = new WebSocket.Server({ port: 8080 });

const clients = new Map(); // id => WebSocket
const passwords = new Map(); // id => password
const awaitingResponses = new Map(); // commandId => WebSocket
const lastCommandIdByClient = new Map(); // WebSocket => commandId
const lastUsedEspByClient = new Map(); // WebSocket => ESP ID
const clientByEsp = new Map(); // ESP ID => WebSocket

console.log("✅ WebSocket server started on port 8080");

wss.on("connection", function connection(ws) {
  console.log("📡 New connection established");

  ws.on("message", function incoming(data) {
    let rawString = data.toString("utf8");
    console.log("📝 UTF-8 Decoded String:", rawString);

    let msg = null;

    // Try to extract JSON if possible
    if (rawString.includes("::")) {
      const parts = rawString.split("::");
      try {
        msg = JSON.parse(parts[1]);
        msg._prefix = parts[0];
      } catch {
        msg = null;
      }
    } else {
      try {
        msg = JSON.parse(rawString);
      } catch {
        msg = null;
      }
    }

    if (!msg || typeof msg !== "object") {
      // Not valid JSON — still forward if from ESP
      for (const [espId, espSocket] of clients.entries()) {
        if (espSocket === ws) {
          const client = clientByEsp.get(espId);
          if (client?.readyState === WebSocket.OPEN) {
            client.send(rawString);
          }
          return;
        }
      }
      return;
    }

    switch (msg.type) {
      case "register_esp": {
        const { id, password } = msg;
        clients.set(id, ws);
        passwords.set(id, password);
        console.log(`📡 ESP Registered: ${id}`);
        break;
      }

      case "check_esps": {
        const { password } = msg;
        const available = Array.from(clients.entries())
          .filter(([id]) => passwords.get(id) === password)
          .map(([id]) => id);
        ws.send(JSON.stringify({ type: "available_esps", available }));
        break;
      }

      case "command": {
        const { targetId, password, message } = msg;
        const espSocket = clients.get(targetId);

        if (!espSocket || passwords.get(targetId) !== password) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "ESP not found or wrong password",
            })
          );
          return;
        }

        const commandId = randomUUID();
        awaitingResponses.set(commandId, ws);
        lastCommandIdByClient.set(ws, commandId);
        lastUsedEspByClient.set(ws, targetId);
        clientByEsp.set(targetId, ws);

        const commandMessage = {
          type: "command",
          commandId,
          message,
        };

        espSocket.send(JSON.stringify(commandMessage));
        console.log(`📤 Sent commandId ${commandId} to ESP ${targetId}`);
        break;
      }

      case "response": {
        const { commandId } = msg;
        const client = awaitingResponses.get(commandId);

        if (client && client.readyState === WebSocket.OPEN) {
          client.send(rawString);
        } else {
          console.log("⚠️ No clients awaiting commandId", commandId);
        }
        break;
      }

      case "ping": {
        ws.send(JSON.stringify({ type: "pong" }));
        break;
      }
    }
  });

  ws.on("close", () => {
    // Remove disconnected clients and cleanup
    for (const [id, socket] of clients.entries()) {
      if (socket === ws) {
        clients.delete(id);
        passwords.delete(id);
        clientByEsp.delete(id);
        break;
      }
    }

    for (const [client, commandId] of lastCommandIdByClient.entries()) {
      if (client === ws) {
        lastCommandIdByClient.delete(client);
        awaitingResponses.delete(commandId);
        lastUsedEspByClient.delete(client);
        break;
      }
    }

    for (const [espId, clientWs] of clientByEsp.entries()) {
      if (clientWs === ws) {
        clientByEsp.delete(espId);
        break;
      }
    }
  });
});
