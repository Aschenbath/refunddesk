import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, parseRetryAfter } from "../src/client/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("API rate-limit metadata", () => {
  it("parses Retry-After seconds and HTTP dates without treating malformed numbers as dates", () => {
    const now = Date.parse("Mon, 09 Nov 2026 10:00:00 GMT");
    expect(parseRetryAfter("60", now)).toBe(60_000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
    expect(parseRetryAfter("Mon, 09 Nov 2026 10:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Mon, 09 Nov 2026 09:59:59 GMT", now)).toBe(0);
    for (const value of [null, "", "-1", "1.5", "not a date"]) expect(parseRetryAfter(value, now)).toBeNull();
  });

  it("retains Retry-After on a 429 without automatically retrying a payment request", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Too many requests" } }), {
      status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" },
    }));
    vi.stubGlobal("fetch", fetch);
    await expect(api("/cases/case-1/approve", "POST", { revision: 1, approvedCents: 100 })).rejects.toMatchObject({
      message: "Too many requests", status: 429, retryAfterMs: 60_000,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves existing error details when no retry header is present", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Approval failed", issue: "DECLINED", debug_id: "debug-1" } }), { status: 502 })));
    await expect(api("/cases/case-1/approve", "POST")).rejects.toEqual(new ApiError("Approval failed · DECLINED · PayPal debug debug-1", 502));
  });
});
