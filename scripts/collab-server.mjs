// Minimal Yjs WebSocket server (y-websocket wire protocol) for Noema.
// Usage: node scripts/collab-server.mjs   (env: PORT=1234 HOST=0.0.0.0)
//
// One Y.Doc per room (room = page id). Documents are kept in memory and
// broadcast to every other connection. Awareness (cursors/presence) is
// relayed and cleaned up on disconnect.
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const PORT = Number(process.env.PORT ?? 1234);
const HOST = process.env.HOST ?? "0.0.0.0";

/** @type {Map<string, {doc: Y.Doc, awareness: awarenessProtocol.Awareness, conns: Map<any, Set<number>>}>} */
const docs = new Map();

function getRoom(name) {
  const existing = docs.get(name);
  if (existing) return existing;

  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null); // the server holds no presence of its own
  const conns = new Map();

  const sendAll = (message, origin) => {
    for (const conn of conns.keys()) {
      if (conn !== origin) conn.send(message);
    }
  };

  doc.on("update", (update, origin) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    sendAll(encoding.toUint8Array(encoder), origin);
  });

  awareness.on("update", ({ added, updated, removed }, origin) => {
    const changed = added.concat(updated, removed);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
    );
    sendAll(encoding.toUint8Array(encoder), origin);
  });

  const room = { doc, awareness, conns };
  docs.set(name, room);
  return room;
}

const wss = new WebSocketServer({ host: HOST, port: PORT });

wss.on("connection", (conn, request) => {
  const roomName =
    decodeURIComponent((request.url ?? "/").slice(1).split("?")[0]) || "default";
  const { doc, awareness, conns } = getRoom(roomName);
  const controlledIds = new Set();
  conns.set(conn, controlledIds);

  // Send our state to the client (sync step 1 + current presence).
  {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    conn.send(encoding.toUint8Array(encoder));
  }
  const states = awareness.getStates();
  if (states.size > 0) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [...states.keys()]),
    );
    conn.send(encoding.toUint8Array(encoder));
  }

  awareness.on("update", ({ added, removed }, origin) => {
    if (origin !== conn) return;
    for (const id of added) controlledIds.add(id);
    for (const id of removed) controlledIds.delete(id);
  });

  conn.on("message", (data) => {
    const message = new Uint8Array(data);
    const decoder = decoding.createDecoder(message);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
      if (encoding.length(encoder) > 1) conn.send(encoding.toUint8Array(encoder));
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        awareness,
        decoding.readVarUint8Array(decoder),
        conn,
      );
    }
  });

  conn.on("close", () => {
    conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(awareness, [...controlledIds], null);
  });

  conn.on("error", () => {
    conns.delete(conn);
  });
});

console.log(`Noema collaboration server listening on ws://${HOST}:${PORT}`);
