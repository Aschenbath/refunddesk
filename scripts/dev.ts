import { createServer } from "vite";
import "../src/server/index.js";
const vite = await createServer();
await vite.listen();
vite.printUrls();
console.log(`\nOpen the app: ${vite.resolvedUrls?.local[0] ?? "http://localhost:15481/"}`);
process.on("SIGINT", () => {
  void vite.close();
});
