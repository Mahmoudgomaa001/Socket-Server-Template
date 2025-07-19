const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: 8080 });

const clients = new Map(); // id => WebSocket
const passwords = new Map(); // id => password
const awaitingResponses = new Map(); // commandId => Set of WebSockets
const lastUsedEspByClient = new Map(); // WebSocket => ESP ID

console.log("WebSocket server started on port 8080");

wss.on("connection", (ws) => {
  console.log("New client connected:", {
    remoteAddress: ws._socket.remoteAddress,
    remotePort: ws._socket.remotePort
  });

  // Handle WebSocket errors (catches invalid UTF-8 frames)
  ws.on("error", (error) => {
    console.error("WebSocket error from client:", {
      remoteAddress: ws._socket.remoteAddress,
      remotePort: ws._socket.remotePort,
      error: error.message
    });
    ws.close(1007, "Invalid UTF-8 sequence received");
  });

  ws.on("message", (data, isBinary) => {
    // Log raw data for debugging
    console.log("Raw data (hex):", data.toString("hex"));
    console.log("Is binary:", isBinary);

    if (isBinary) {
      console.warn("Received binary data. Ignoring.");
      return;
    }

    let msg;
    try {
      // Attempt to decode as UTF-8
      const jsonStr = data.toString("utf8");
      console.log("Decoded string:", jsonStr); // Log decoded string for debugging

      // Check if the string is likely JSON
      if (!jsonStr.trim().startsWith("{")) {
        throw new Error("Not JSON");
      }

      // Parse JSON
      msg = JSON.parse(jsonStr);
    } catch (e) {
      console.error("❌ Invalid JSON or UTF-8 from client:");
      console.error("Data (hex):", data.toString("hex"));
      console.error("Error:", e.message);
      ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
      return;
    }

    console.log("Received:", msg);

    switch (msg.type) {
      case "register_esp":
        if (clients.has(msg.id)) {
          const oldClient = clients.get(msg.id);
          if (oldClient.readyState === WebSocket.OPEN) {
            oldClient.send(
              JSON.stringify({
                type: "disconnect",
                reason: "new connection replaced old one"
              })
            );
            oldClient.close();
          }
          console.log(`Replaced existing ESP: ${msg.id}`);
        }
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

        ws.send(JSON.stringify({ type: "check_results", results: results }));
        break;

      case "command":
        const targetClient = clients.get(msg.targetId);
        const correctPassword = passwords.get(msg.targetId);

        if (!targetClient) {
          console.log(`Command failed: ESP ${msg.targetId} not online`);
          ws.send(
            JSON.stringify({
              type: "error",
              message: `ESP ${msg.targetId} not online`
            })
          );
        } else if (correctPassword !== msg.password) {
          console.log(`Command failed: Wrong password for ESP ${msg.targetId}`);
          ws.send(JSON.stringify({ type: "error", message: "Wrong password" }));
        } else {
          const commandId = msg.commandId || Math.random().toString(36).substr(2, 6);

          const lastEspId = lastUsedEspByClient.get(ws);
          if (lastEspId && lastEspId !== msg.targetId) {
            const previousEsp = clients.get(lastEspId);
            if (previousEsp && previousEsp.readyState === WebSocket.OPEN) {
              previousEsp.send(
                JSON.stringify({
                  type: "disconnect",
                  reason: "client switched ESP"
                })
              );
            }
          }

          lastUsedEspByClient.set(ws, msg.targetId);

          for (const [oldCommandId, clientSet] of awaitingResponses.entries()) {
            if (clientSet.has(ws)) {
              clientSet.delete(ws);
              if (clientSet.size === 0) {
                awaitingResponses.delete(oldCommandId);
              }
            }
          }

          awaitingResponses.set(commandId, new Set([ws]));

          console.log(`Sending command to ESP ${msg.targetId}:`, {
            commandId,
            message: msg.message
          });
          targetClient.send(
            JSON.stringify({
              type: "command",
              commandId: commandId,
              message: msg.message
            })
          );

          console.log(
            `Command confirmation sent to client for ESP ${msg.targetId}, commandId: ${commandId}`
          );
          ws.send(
            JSON.stringify({
              type: "command_sent",
              commandId: commandId,
              targetId: msg.targetId,
              message: `Command successfully sent to ESP ${msg.targetId}`
            })
          );
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
          console.log("[RESPONSE] Sending:", responseString);

          responseClients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(responseString);
            }
          });
        }
        break;

      case "ping":
        console.log(`Received ping from client`);
        ws.send(JSON.stringify({ type: "pong", message: "Pong response" }));
        break;

      default:
        console.log("Unknown message type:", msg.type);
        console.log("Message:", msg);
        break;
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
        lastEsp.send(
          JSON.stringify({
            type: "disconnect",
            reason: "client disconnected"
          })
        );
      }
      lastUsedEspByClient.delete(ws);
    }
  });
});