import { describe, expect, it, vi } from "vitest";
import fixtures from "./fixtures/paypal.json" with { type: "json" };
import recorded from "./fixtures/paypal-recorded.json" with { type: "json" };
import { PayPalClient, PayPalError, requestId } from "../src/server/paypal.js";

function mock(responses: unknown[]) {
  const fetcher = vi.fn(async () => {
    const data = responses.shift();
    return new Response(JSON.stringify(data), {
      status: data === fixtures.error ? 422 : 200,
    });
  });
  return {
    fetcher,
    client: new PayPalClient(
      "fixture-client",
      "fixture-secret",
      fetcher as typeof fetch,
    ),
  };
}
describe("PayPal REST fixtures", () => {
  it("reads a real recorded sandbox capture, order and refund", async () => {
    const { client } = mock([
      fixtures.token,
      recorded.capture,
      recorded.order,
      recorded.refund,
    ]);
    const capture = await client.getCapture(recorded.capture.id);
    const order = await client.getOrder(recorded.order.id);
    const refund = await client.getRefund(recorded.refund.id);
    expect(capture).toMatchObject({
      status: "PARTIALLY_REFUNDED",
      amount: { currency_code: "USD", value: "36.00" },
    });
    expect(refund).toMatchObject({
      status: "COMPLETED",
      amount: { value: "8.00" },
    });
    expect(
      order.purchase_units?.[0]?.payments?.refunds?.some(
        (value) => value.id === refund.id,
      ),
    ).toBe(true);
  });
  it("caches tokens and sends representation and idempotency headers on each POST", async () => {
    const { client, fetcher } = mock([
      fixtures.token,
      fixtures.order,
      fixtures.refund,
      fixtures.capture,
    ]);
    const created = await client.createAndCapture(
      5600,
      "FC-1001",
      "create-key",
    );
    expect(created.capture.id).toBe(fixtures.capture.id);
    await client.refund(created.capture.id, 800, "USD", requestId("case-1"));
    await client.getCapture(created.capture.id);
    expect(fetcher).toHaveBeenCalledTimes(4);
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    for (const [, options] of calls.filter(
      ([, options]) => options.method === "POST",
    )) {
      expect((options.headers as Record<string, string>).Prefer).toBe(
        "return=representation",
      );
      expect(
        (options.headers as Record<string, string>)["PayPal-Request-Id"],
      ).toBeTruthy();
    }
    expect(JSON.parse(calls[2][1].body as string).amount.value).toBe("8.00");
    expect(JSON.parse(calls[2][1].body as string)).toMatchObject({
      invoice_id: requestId("case-1"),
      custom_id: requestId("case-1"),
    });
  });
  it("captures an approved order when direct create did not capture", async () => {
    const { client, fetcher } = mock([
      fixtures.token,
      fixtures.approvedOrder,
      fixtures.order,
    ]);
    await client.createAndCapture(5600, "FC-1001", "fallback-key");
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls[2][0]).toContain("/capture");
    expect(
      (calls[2][1].headers as Record<string, string>)["PayPal-Request-Id"],
    ).toBe("fallback-key-cap");
  });
  it("surfaces the error class and HTTP status without provider text", async () => {
    const { client } = mock([fixtures.token, fixtures.error]);
    try {
      await client.refund("capture", 99999, "USD", "key");
      throw new Error("Expected error");
    } catch (error) {
      expect(error).toBeInstanceOf(PayPalError);
      expect((error as PayPalError).toJSON()).toMatchObject({
        name: "PayPalError",
        status: 422,
      });
    }
  });
  it("coalesces concurrent token requests and verifies webhook signatures", async () => {
    const fetcher = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(url).includes("oauth2")
              ? fixtures.token
              : String(url).includes("verify-webhook")
                ? { verification_status: "SUCCESS" }
                : fixtures.capture,
          ),
        ),
    );
    const client = new PayPalClient("id", "secret", fetcher as typeof fetch);
    await Promise.all([client.getCapture("a"), client.getCapture("b")]);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("oauth2")),
    ).toHaveLength(1);
    expect(
      await client.verifyWebhook(
        new Headers({ "paypal-transmission-id": "test" }),
        { id: "event" },
        "webhook-id",
      ),
    ).toBe(true);
  });
  it("keeps derived request ids stable and distinct", () => {
    expect(requestId("a")).toBe(requestId("a"));
    expect(requestId("a")).not.toBe(requestId("b"));
    expect(requestId("a").length).toBeLessThanOrEqual(38);
  });
});
