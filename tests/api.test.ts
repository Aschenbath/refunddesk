import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, money, parseRetryAfter } from "../src/client/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("money display", () => {
  it("keeps USD formatting and makes other currencies explicit without rounding away cents", () => {
    expect(money(14000)).toBe("$140.00");
    expect(money(-100, "USD")).toBe("-$1.00");
    expect(money(14000, "EUR")).toBe("EUR 140.00");
    expect(money(99, "JPY")).toBe("JPY 0.99");
    expect(money(14000, "CAD")).toBe("CAD 140.00");
    expect(money(null, "EUR")).toBe("—");
  });
  it.each([null, "", "not a currency"])("does not guess a currency for %j", (currency) => {
    expect(money(14000, currency)).toBe("14,000 minor units · currency unknown");
  });
});

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
