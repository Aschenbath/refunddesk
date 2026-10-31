import { serve } from "@hono/node-server";
import { config, validateOwnerConfiguration } from "./config.js";
import { Store } from "./db.js";
import { PayPalClient } from "./paypal.js";
import { DeskService } from "./service.js";
import { createApp } from "./app.js";
import { loadSnapshot, hydrateReplay, ReplayPayPalClient } from "./replay.js";
validateOwnerConfiguration();
const replay = config.demoMode === "replay";
const store = new Store(replay ? ":memory:" : config.dbPath);
const snapshot = replay ? loadSnapshot() : null;
if (snapshot) hydrateReplay(store, snapshot);
const service = new DeskService(
  store,
  snapshot ? new ReplayPayPalClient(store, snapshot) : new PayPalClient(config.paypalClientId, config.paypalClientSecret),
  replay ? { aiMode: "offline" } : {},
);
service.recoverInterrupted();
const server = serve(
  { fetch: createApp(service).fetch, port: config.port, hostname: "0.0.0.0" },
  () => console.log(`RefundDesk ${replay ? "replay demo — no money moves, no keys needed" : "sandbox"}: http://localhost:${config.port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () =>
    server.close(() => {
      store.close();
      process.exit(0);
    }),
  );
