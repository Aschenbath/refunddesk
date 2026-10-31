import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { config } from "./config.js";

export interface OwnerConfig {
  ownerPassword: string;
  sessionSecret: string;
  publicOrigin: string;
  nodeEnv: string;
  getIp?: (c: Context) => string;
}
export const ownerConfig = (
  options: Partial<OwnerConfig> = {},
): OwnerConfig => ({ ...config, ...options });
const digest = (value: string) => createHash("sha256").update(value).digest();
export const passwordMatches = (actual: string, expected: string) =>
  timingSafeEqual(digest(actual), digest(expected));
export function peerIp(c: Context, options: OwnerConfig): string {
  if (options.getIp) return options.getIp(c);
  try {
    return getConnInfo(c).remote.address || "unknown";
  } catch {
    return "unknown";
  }
}
export function isLoopback(ip: string) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
function signature(payload: string, options: OwnerConfig) {
  return createHmac("sha256", options.sessionSecret)
    .update(digest(options.ownerPassword))
    .update(payload)
    .digest("base64url");
}
export function hasSession(c: Context, options: OwnerConfig): boolean {
  if (!options.ownerPassword)
    return options.nodeEnv !== "production" && isLoopback(peerIp(c, options));
  const cookie = getCookie(c, "refunddesk_session");
  if (!cookie) return false;
  const [payload, sig, extra] = cookie.split(".");
  if (
    !payload ||
    !sig ||
    extra ||
    !passwordMatches(sig, signature(payload, options))
  )
    return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return (
      data.role === "owner" &&
      Number.isSafeInteger(data.exp) &&
      data.exp > Date.now()
    );
  } catch {
    return false;
  }
}
export function signIn(c: Context, options: OwnerConfig) {
  const payload = Buffer.from(
    JSON.stringify({
      role: "owner",
      exp: Date.now() + 8 * 3600000,
      nonce: randomBytes(16).toString("hex"),
    }),
  ).toString("base64url");
  setCookie(
    c,
    "refunddesk_session",
    `${payload}.${signature(payload, options)}`,
    {
      httpOnly: true,
      sameSite: "Strict",
      secure:
        options.publicOrigin.startsWith("https:") ||
        new URL(c.req.url).protocol === "https:",
      path: "/",
      maxAge: 8 * 3600,
    },
  );
}
export function signOut(c: Context) {
  deleteCookie(c, "refunddesk_session", { path: "/" });
}
export class RateLimits {
  private entries = new Map<string, { count: number; expires: number }>();
  allow(key: string, limit: number, now = Date.now()) {
    for (const [id, value] of this.entries)
      if (value.expires <= now) this.entries.delete(id);
    const value = this.entries.get(key) || { count: 0, expires: now + 60_000 };
    value.count++;
    this.entries.set(key, value);
    return value.count <= limit;
  }
}
export class BodyLimitError extends Error {}
export async function boundedBody(
  request: Request,
  maxBytes = 1_000_000,
): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new BodyLimitError("Request is too large");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}
