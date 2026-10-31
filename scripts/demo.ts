// Set before importing config: a local demo neither reads .env nor uses live adapters.
process.env.DEMO_MODE = "replay";
process.env.AI_MODE = "offline";
process.env.NODE_ENV = "development";
process.env.OWNER_PASSWORD = "";
process.env.PUBLIC_ORIGIN = "";
process.env.DB_PATH = ":memory:";
await import("./dev.js");
