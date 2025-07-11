const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: 8080 });

const clients = new Map();            // id => WebSocket
const passwords = new Map();          // id => password
const awaitingResponses = new Map();  // commandId => Set of WebSockets
const lastUsedEspByClient = new Map(); // WebSocket => ESP ID

console.log("WebSocket server started on port 8080");

wss.on("connection", (ws) => {
  console.log("New client connected");

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      console.log("Invalid JSON:", data);
      return;
    }

    console.log("Received:", msg);

    switch (msg.type) {
      case "register_esp":
        clients.set(msg.id, ws);
        passwords.set(msg.id, msg.password);
        console.log(`Registered ESP: ${msg.id}`);
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

          // Send 'disconnect' to previous ESP if different
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

          // Track this ESP as the last used
          lastUsedEspByClient.set(ws, msg.targetId);

          // Remove this client from any previous commandId entries
          for (const [oldCommandId, clientSet] of awaitingResponses.entries()) {
            if (clientSet.has(ws)) {
              clientSet.delete(ws);
              if (clientSet.size === 0) {
                awaitingResponses.delete(oldCommandId);
              }
            }
          }

          // Set this client as waiting for the response to this command
          awaitingResponses.set(commandId, new Set([ws]));

          // Send the command to the target ESP
          targetClient.send(JSON.stringify({
            type: "command",
            commandId: commandId,
            message: msg.message
          }));
        }
        break;

      case "response":
        console.log(`Received response for command: ${msg.commandId}`);
        const responseClients = awaitingResponses.get(msg.commandId);

        if (responseClients && responseClients.size > 0) {
          console.log(`[RESPONSE] CommandID: ${msg.commandId}`);
          console.log(`[RESPONSE] Raw content:`, msg.response);

          const responseToSend = {
            type: "response",
            commandId: msg.commandId,
            response: msg.response
          };

          const responseString = JSON.stringify(responseToSend);
          console.log('[RESPONSE] Sending:', responseString);

          responseClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(responseString);
            }
          });

          // Optional: remove if response is final
          // awaitingResponses.delete(msg.commandId);
        }
        break;

      default:
        console.log("Unknown message type:", msg.type);
        break;
    }
  });

  ws.on("close", () => {
    // Clean up ESP registrations
    for (const [id, client] of clients.entries()) {
      if (client === ws) {
        clients.delete(id);
        passwords.delete(id);
        console.log(`ESP disconnected: ${id}`);
        break;
      }
    }

    // Clean up response subscriptions
    for (const [commandId, clientSet] of awaitingResponses.entries()) {
      if (clientSet.has(ws)) {
        clientSet.delete(ws);
        if (clientSet.size === 0) {
          awaitingResponses.delete(commandId);
        }
      }
    }

    // Notify last ESP that this client disconnected
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
