const WebSocket = require("ws");
const wss = new WebSocket.Server({ port: 8080 });

const clients = new Map();              // id => WebSocket
const passwords = new Map();           // id => password
const awaitingResponses = new Map();   // commandId => WebSocket
const clientCommandMap = new Map();    // WebSocket => commandId

console.log("✅ Server started on port 8080");

wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    const msgText = data.toString();

    // 📦 Check if this is ESP response: commandId::json
    const doubleColonIndex = msgText.indexOf("::");
    if (doubleColonIndex > 0) {
      const commandId = msgText.substring(0, doubleColonIndex);
      const payload = msgText.substring(doubleColonIndex + 2);

      console.log(`📥 Incoming from ESP: ${msgText}`);

      const client = awaitingResponses.get(commandId);
      if (client && client.readyState === WebSocket.OPEN) {
        client.send(payload); // send raw payload
      } else {
        console.warn(`⚠️ No client awaiting commandId: ${commandId}`);
      }
      return;
    }

    // 📦 Try to parse as JSON
    let msg;
    try {
      msg = JSON.parse(msgText);
    } catch (err) {
      console.warn("⚠️ Invalid JSON:", msgText);
      return;
    }

    console.log("✅ Parsed JSON:", msg);

    // 🔧 Handle ESP registration
    if (msg.type === "register_esp" && msg.id && msg.password) {
      clients.set(msg.id, ws);
      passwords.set(msg.id, msg.password);
      console.log(`✅ Registered ESP: ${msg.id}`);
      return;
    }

    // 🧠 Handle client command
    if (msg.type === "command" && msg.targetId && msg.password && msg.message) {
      const targetESP = clients.get(msg.targetId);
      const expectedPass = passwords.get(msg.targetId);

      if (!targetESP || expectedPass !== msg.password) {
        console.warn("❌ Invalid target or password");
        return;
      }

      // 🎯 Generate new commandId
      const commandId = Math.random().toString(36).substring(2, 10);

      // 🧹 Remove old commandId from this client
      const oldCmdId = clientCommandMap.get(ws);
      if (oldCmdId) awaitingResponses.delete(oldCmdId);

      // 🔐 Register this new commandId
      clientCommandMap.set(ws, commandId);
      awaitingResponses.set(commandId, ws);

      // 🚀 Send to ESP
      targetESP.send(JSON.stringify({
        type: "command",
        commandId,
        message: msg.message,
      }));

      console.log(`➡️ Sent commandId ${commandId} to ESP ${msg.targetId}`);
      return;
    }
  });

  ws.on("close", () => {
    const oldCmdId = clientCommandMap.get(ws);
    if (oldCmdId) {
      awaitingResponses.delete(oldCmdId);
      clientCommandMap.delete(ws);
    }

    // 🔌 Remove any registered ESP
    for (const [id, sock] of clients.entries()) {
      if (sock === ws) {
        clients.delete(id);
        passwords.delete(id);
        console.log(`🔌 ESP ${id} disconnected`);
        break;
      }
    }
  });
});
