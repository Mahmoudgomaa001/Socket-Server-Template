const WebSocket = require("ws");
const wss = new WebSocket.Server({ port: 8080 });

// Maps
const clients = new Map();              // ESP id => WebSocket
const passwords = new Map();           // ESP id => password
const awaitingResponses = new Map();   // commandId => WebSocket (client)
const clientCommandMap = new Map();    // client WebSocket => commandId

console.log("✅ WebSocket server started on port 8080");

wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    const msgText = data.toString();

    // Check if ESP is sending back a response (format: commandId::payload)
    const splitIndex = msgText.indexOf("::");
    if (splitIndex > 0) {
      const commandId = msgText.slice(0, splitIndex);
      const payload = msgText.slice(splitIndex + 2);

      const client = awaitingResponses.get(commandId);
      if (client && client.readyState === WebSocket.OPEN) {
        client.send(payload); // Send raw payload
      } else {
        console.warn("⚠️ No client awaiting commandId:", commandId);
      }

      // Clean up
      awaitingResponses.delete(commandId);
      return;
    }

    // Handle JSON messages
    let msg;
    try {
      msg = JSON.parse(msgText);
    } catch (err) {
      console.warn("❌ Invalid JSON from", ws._socket.remoteAddress);
      return;
    }

    // ESP Registration
    if (msg.type === "register_esp" && msg.id && msg.password) {
      clients.set(msg.id, ws);
      passwords.set(msg.id, msg.password);
      console.log(`✅ ESP registered: ${msg.id}`);
      return;
    }

    // Client sends command
    if (msg.type === "command" && msg.targetId && msg.password && msg.message) {
      const targetESP = clients.get(msg.targetId);
      const correctPassword = passwords.get(msg.targetId);

      if (!targetESP || correctPassword !== msg.password) {
        console.warn("❌ Invalid targetId or password for command");
        return;
      }

      // Generate unique commandId
      const commandId = Math.random().toString(36).substring(2, 10);

      // Clear old command from this client
      const oldCmd = clientCommandMap.get(ws);
      if (oldCmd) awaitingResponses.delete(oldCmd);

      // Save new command
      clientCommandMap.set(ws, commandId);
      awaitingResponses.set(commandId, ws);

      // Send command to ESP
      targetESP.send(JSON.stringify({
        type: "command",
        commandId,
        message: msg.message,
      }));

      console.log(`➡️ Command sent to ESP ${msg.targetId} with commandId ${commandId}`);
      return;
    }
  });

  ws.on("close", () => {
    // Cleanup command
    const oldCmd = clientCommandMap.get(ws);
    if (oldCmd) {
      awaitingResponses.delete(oldCmd);
      clientCommandMap.delete(ws);
    }

    // Cleanup ESPs
    for (const [id, sock] of clients.entries()) {
      if (sock === ws) {
        clients.delete(id);
        passwords.delete(id);
        console.log(`❌ ESP ${id} disconnected`);
        break;
      }
    }
  });
});
