import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
if (process.env.DEMO_MODE !== "replay" && existsSync(".env")) process.loadEnvFile(".env");
export const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  demoMode: process.env.DEMO_MODE || "",
  ownerPassword: process.env.OWNER_PASSWORD || "",
  sessionSecret: process.env.SESSION_SECRET || randomBytes(32).toString("hex"),
  publicOrigin: process.env.PUBLIC_ORIGIN || "",
  port: Number(process.env.PORT || 15480),
  dbPath: process.env.DB_PATH || "data/refunddesk.sqlite",
  paypalClientId: process.env.PAYPAL_CLIENT_ID || "",
  paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET || "",
  paypalEnv: process.env.PAYPAL_ENV || "sandbox",
  webhookId: process.env.PAYPAL_WEBHOOK_ID || "",
  aiMode: process.env.AI_MODE || "offline",
  aiBaseUrl: process.env.AI_BASE_URL || "",
  aiApiKey: process.env.AI_API_KEY || "",
  aiModel: process.env.AI_MODEL || "",
};
export function validateOwnerConfiguration(value = config) {
  if (value.nodeEnv === "production" && !value.ownerPassword)
    throw new Error(
      "OWNER_PASSWORD must be set in production. RefundDesk refuses to start without owner authentication.",
    );
  if (value.nodeEnv === "production" && !value.publicOrigin)
    throw new Error(
      "PUBLIC_ORIGIN must be set to the public HTTPS origin in production.",
    );
  if (
    value.publicOrigin &&
    new URL(value.publicOrigin).origin !== value.publicOrigin
  )
    throw new Error(
      "PUBLIC_ORIGIN must be an origin without a path or trailing slash.",
    );
}
if (config.paypalEnv !== "sandbox")
  throw new Error("RefundDesk only supports PayPal sandbox.");
/** Sandbox tools (seed, live, snapshot) talk to PayPal; refuse to run them under the replay flag. */
export function requireSandboxMode(tool: string, value = config) {
  if (value.demoMode === "replay") throw new Error(`${tool} uses the PayPal sandbox and cannot run with DEMO_MODE=replay.`);
}
