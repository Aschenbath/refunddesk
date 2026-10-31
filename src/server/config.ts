import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
export const config = {
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
if (config.paypalEnv !== "sandbox")
  throw new Error("RefundDesk only supports PayPal sandbox.");
