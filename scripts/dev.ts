import { createServer } from "vite";
import "../src/server/index.js";
const vite = await createServer();
await vite.listen();
vite.printUrls();
process.on("SIGINT", () => {
  void vite.close();
});
