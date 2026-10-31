import { serve } from "@hono/node-server";
import { config, validateOwnerConfiguration } from "./config.js";
import { Store } from "./db.js";
import { PayPalClient } from "./paypal.js";
import { DeskService } from "./service.js";
import { createApp } from "./app.js";
validateOwnerConfiguration();
const store = new Store(config.dbPath);
const service = new DeskService(
  store,
  new PayPalClient(config.paypalClientId, config.paypalClientSecret),
);
service.recoverInterrupted();
const server = serve(
  { fetch: createApp(service).fetch, port: config.port, hostname: "0.0.0.0" },
  () => console.log(`RefundDesk sandbox: http://localhost:${config.port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () =>
    server.close(() => {
      store.close();
      process.exit(0);
    }),
  );
