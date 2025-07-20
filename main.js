const WebSocket = require("ws");
const { randomUUID } = require("crypto");

const wss = new WebSocket.Server({ port: 8080 });

const clients = new Map(); // id => WebSocket
const passwords = new Map(); // id => password
const awaitingResponses = new Map(); // commandId => WebSocket
const lastCommandByClient = new Map(); // WebSocket => commandId
const lastUsedEspByClient = new Map(); // WebSocket => ESP ID

console.log("🚀 WebSocket server started on port 8080");

wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    try {
      const text = data.toString();
      
      // Handle ESP responses in format: commandId::payload
      if (text.includes("::")) {
        const [commandId, payload] = text.split("::");
        console.log("📥 Incoming ESP response:", commandId, payload);

        const client = awaitingResponses.get(commandId);
        if (client && client.readyState === WebSocket.OPEN) {
          client.send(payload);
        } else {
          console.warn("⚠️ No client awaiting commandId:", commandId);
        }
        return;
      }

      // Try to parse JSON messages
      const msg = JSON.parse(text);
      console.log("✅ Parsed JSON Message:", msg);

      // ESP Registration
      if (msg.type === "register_esp" && msg.id && msg.password) {
        clients.set(msg.id, ws);
        passwords.set(msg.id, msg.password);
        console.log(`✅ ESP registered: ${msg.id}`);
        return;
      }

      // Client sends a command
      if (msg.type === "command" && msg.targetId && msg.password && msg.message) {
        const espWs = clients.get(msg.targetId);
        const espPw = passwords.get(msg.targetId);

        if (!espWs || espPw !== msg.password) {
          ws.send(JSON.stringify({ type: "error", message: "ESP not found or wrong password" }));
          return;
        }

        const commandId = randomUUID();

        // Clean up any previous command from this client
        const oldCommandId = lastCommandByClient.get(ws);
        if (oldCommandId) awaitingResponses.delete(oldCommandId);

        // Register new command
        awaitingResponses.set(commandId, ws);
        lastCommandByClient.set(ws, commandId);
        lastUsedEspByClient.set(ws, msg.targetId);

        espWs.send(`${commandId}::${msg.message}`);
        console.log(`➡️ Forwarded command ${commandId} to ESP ${msg.targetId}`);
        return;
      }

      // Client requests list of active ESPs
      if (msg.type === "check_esps") {
        const espList = Array.from(clients.keys());
        ws.send(JSON.stringify({ type: "esps", list: espList }));
        return;
      }

      // Simple ping handler
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

    } catch (err) {
      console.error("❌ Error handling message:", err);
    }
  });

  // Cleanup on disconnect
  ws.on("close", () => {
    for (const [id, sock] of clients) {
      if (sock === ws) {
        clients.delete(id);
        passwords.delete(id);
        console.log(`❌ ESP disconnected: ${id}`);
      }
    }

    const cmdId = lastCommandByClient.get(ws);
    if (cmdId) awaitingResponses.delete(cmdId);

    lastCommandByClient.delete(ws);
    lastUsedEspByClient.delete(ws);
  });
});
