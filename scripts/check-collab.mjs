// Verify realtime sync: two clients on the same room exchange a Yjs update.
// Usage: node scripts/check-collab.mjs [wsUrl]
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

const url = process.argv[2] ?? "ws://127.0.0.1:1234";
const room = `check-${Date.now()}`;

const a = new Y.Doc();
const b = new Y.Doc();
const pa = new WebsocketProvider(url, room, a);
const pb = new WebsocketProvider(url, room, b);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await wait(1000);
a.getMap("shared").set("hello", "from A");
await wait(1000);
const received = b.getMap("shared").get("hello");
console.log(`client B received: ${received ?? "(nothing)"} (expect "from A")`);

let awarenessSeen = false;
pb.awareness.on("change", () => {
  awarenessSeen = true;
});
pa.awareness.setLocalStateField("user", { name: "A" });
await wait(600);
console.log(`awareness relayed: ${awarenessSeen}`);

pa.destroy();
pb.destroy();
await wait(200);
process.exit(received === "from A" ? 0 : 1);
