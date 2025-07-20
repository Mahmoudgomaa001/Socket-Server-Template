const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: 8080 });

const clients = new Map(); // id => WebSocket
const passwords = new Map(); // id => password
const awaitingResponses = new Map(); // commandId => WebSocket
const lastUsedEspByClient = new Map(); // WebSocket => ESP ID

console.log("WebSocket server started on port 8080");

wss.on("connection", (ws) => {
  console.log("New client connected:", {
    remoteAddress: ws._socket.remoteAddress,
    remotePort: ws._socket.remotePort
  });

  ws.on("error", (error) => {
    console.error("WebSocket error from client:", {
      remoteAddress: ws._socket.remoteAddress,
      remotePort: ws._socket.remotePort,
      error: error.message
    });
    ws.close(1007, "Invalid UTF-8 sequence received");
  });

  ws.on("message", (data, isBinary) => {
    console.log("\n📥 New message received");

    if (isBinary) {
      console.warn("🧾 Binary Data Received (hex):", data.toString("hex"));
      return;
    }

    const utf8String = data.toString("utf8");
    console.log("📝 UTF-8 Decoded String:", utf8String);

    let msg = null;

    try {
      msg = JSON.parse(utf8String);
      console.log("✅ Parsed JSON Message:", msg);
    } catch (err) {
      console.warn("⚠️ Not valid JSON. Treating as raw text.");
      console.log("📄 Raw message:", utf8String);
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
          console.log(`Replaced existing ESP: ${msg.id}`);
        }
        clients.set(msg.id, ws);
        passwords.set(msg.id, msg.password);
        console.log(`Registered ESP: ${msg.id}`);
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
          ws.send(JSON.stringify({
            type: "error",
            message: `ESP ${msg.targetId} not online`
          }));
        } else if (correctPassword !== msg.password) {
          ws.send(JSON.stringify({ type: "error", message: "Wrong password" }));
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

          for (const [oldCommandId, clientWs] of awaitingResponses.entries()) {
            if (clientWs === ws) {
              awaitingResponses.delete(oldCommandId);
              break;
            }
          }

          awaitingResponses.set(commandId, ws);

          targetClient.send(JSON.stringify({
            type: "command",
            commandId,
            message: msg.message
          }));

          ws.send(JSON.stringify({
            type: "command_sent",
            commandId,
            targetId: msg.targetId,
            message: `Command successfully sent to ESP ${msg.targetId}`
          }));
        }
        break;
      }

      case "response": {
        const targetWs = awaitingResponses.get(msg.commandId);

        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify({
            type: "response",
            commandId: msg.commandId,
            response: msg.response
          }));
          awaitingResponses.delete(msg.commandId);
        } else {
          console.warn(`No client awaiting commandId ${msg.commandId}`);
        }
        break;
      }

      case "ping": {
        ws.send(JSON.stringify({ type: "pong", message: "Pong response" }));
        break;
      }

      default: {
        console.log("Unknown message type:", msg.type);
        console.log("Message:", msg);
        break;
      }
    }
  });

  ws.on("close", () => {
    for (const [id, client] of clients.entries()) {
      if (client === ws) {
        clients.delete(id);
        passwords.delete(id);
        console.log(`ESP disconnected: ${id}`);
        break;
      }
    }

    for (const [commandId, clientWs] of awaitingResponses.entries()) {
      if (clientWs === ws) {
        awaitingResponses.delete(commandId);
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
