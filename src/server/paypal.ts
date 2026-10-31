import { createHash } from "node:crypto";
import { centsToDecimal, decimalToCents } from "../core/money.js";

export interface PayPalMoney {
  currency_code: string;
  value: string;
}
export interface PayPalCapture {
  id: string;
  status: string;
  amount: PayPalMoney;
  links?: { rel: string; href: string }[];
  supplementary_data?: { related_ids?: { order_id?: string } };
  invoice_id?: string;
}
export interface PayPalRefund {
  id: string;
  status: string;
  amount: PayPalMoney;
  invoice_id?: string;
  custom_id?: string;
  supplementary_data?: {
    related_ids?: { capture_id?: string; order_id?: string };
  };
  links?: { rel: string; href: string }[];
}
export interface PayPalOrder {
  id: string;
  status: string;
  purchase_units?: {
    invoice_id?: string;
    payments?: { captures?: PayPalCapture[]; refunds?: PayPalRefund[] };
  }[];
}
export class PayPalError extends Error {
  readonly status: number;
  readonly paypalName: string;
  readonly issue: string | null;
  readonly debugId: string | null;
  constructor(
    status: number,
    body: {
      name?: string;
      message?: string;
      details?: { issue?: string }[];
      debug_id?: string;
    },
  ) {
    super(`PayPalError (HTTP ${status})`);
    this.name = "PayPalError";
    this.status = status;
    this.paypalName = "PayPalError";
    this.issue = null;
    this.debugId = null;
  }
  toJSON() {
    return {
      message: this.message,
      name: this.paypalName,
      status: this.status,
    };
  }
}
export function requestId(caseId: string): string {
  return `rd-${createHash("sha256").update(caseId).digest("hex").slice(0, 32)}`;
}
export class PayPalClient {
  private clientId: string;
  private secret: string;
  private fetcher: typeof fetch;
  private token: { value: string; expires: number } | null = null;
  private pendingToken: Promise<string> | null = null;
  readonly baseUrl = "https://api-m.sandbox.paypal.com";
  constructor(clientId: string, secret: string, fetcher: typeof fetch = fetch) {
    this.clientId = clientId;
    this.secret = secret;
    this.fetcher = fetcher;
  }
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expires) return this.token.value;
    if (this.pendingToken) return this.pendingToken;
    this.pendingToken = (async () => {
      if (!this.clientId || !this.secret)
        throw new Error(
          "Sandbox credentials are missing. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.",
        );
      const response = await this.fetcher(`${this.baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.secret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "PayPal-Request-Id": requestId("oauth"),
          Prefer: "return=representation",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(30000),
      });
      const body = (await response.json()) as {
        access_token: string;
        expires_in: number;
        name?: string;
        message?: string;
      };
      if (!response.ok) throw new PayPalError(response.status, body);
      this.token = {
        value: body.access_token,
        expires: Date.now() + Math.max(0, body.expires_in - 60) * 1000,
      };
      return body.access_token;
    })();
    try {
      return await this.pendingToken;
    } finally {
      this.pendingToken = null;
    }
  }
  private async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    key?: string,
  ): Promise<T> {
    const token = await this.accessToken();
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(method === "POST"
          ? {
              Prefer: "return=representation",
              "PayPal-Request-Id":
                key || requestId(path + JSON.stringify(body)),
            }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    const payload = await response.json();
    if (!response.ok) {
      if (response.status === 401) this.token = null;
      throw new PayPalError(response.status, payload);
    }
    return payload as T;
  }
  async createAndCapture(
    amountCents: number,
    reference: string,
    key: string,
    onCreated?: (order: PayPalOrder) => void,
  ): Promise<{ order: PayPalOrder; capture: PayPalCapture }> {
    const created = await this.request<PayPalOrder>(
      "/v2/checkout/orders",
      "POST",
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: reference,
            invoice_id: reference,
            custom_id: reference,
            amount: {
              currency_code: "USD",
              value: centsToDecimal(amountCents),
            },
          },
        ],
        payment_source: {
          card: {
            number: "4032039317984658",
            expiry: "2030-12",
            security_code: "123",
            name: "Fernleaf Sandbox Buyer",
          },
        },
      },
      key,
    );
    onCreated?.(created);
    const captured = created.purchase_units?.[0]?.payments?.captures?.[0];
    const order = captured
      ? created
      : await this.captureOrder(created.id, `${key}-cap`);
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    if (
      !capture ||
      capture.status !== "COMPLETED" ||
      capture.amount.currency_code !== "USD" ||
      decimalToCents(capture.amount.value) !== amountCents
    )
      throw new Error(
        "PayPal did not return the requested completed sandbox capture.",
      );
    return { order, capture };
  }
  captureOrder(id: string, key: string) {
    return this.request<PayPalOrder>(
      `/v2/checkout/orders/${encodeURIComponent(id)}/capture`,
      "POST",
      {},
      key,
    );
  }
  refund(
    captureId: string,
    cents: number,
    currency: string,
    key: string,
    attemptId = key,
  ) {
    return this.request<PayPalRefund>(
      `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      "POST",
      {
        amount: { currency_code: currency, value: centsToDecimal(cents) },
        invoice_id: attemptId,
        custom_id: attemptId,
      },
      key,
    );
  }
  getCapture(id: string) {
    return this.request<PayPalCapture>(
      `/v2/payments/captures/${encodeURIComponent(id)}`,
    );
  }
  getOrder(id: string) {
    return this.request<PayPalOrder>(
      `/v2/checkout/orders/${encodeURIComponent(id)}`,
    );
  }
  getRefund(id: string) {
    return this.request<PayPalRefund>(
      `/v2/payments/refunds/${encodeURIComponent(id)}`,
    );
  }
  async findCaptureByInvoice(
    invoiceId: string,
    since: string,
  ): Promise<{ order: PayPalOrder; capture: PayPalCapture } | null> {
    // PayPal has no v2 order-list endpoint. Reporting is the supported invoice lookup.
    // Reporting can lag; callers must not create again outside the request-id window.
    const start = new Date(
      Math.max(Date.parse(since) - 60_000, Date.now() - 30 * 86400000),
    ).toISOString();
    const end = new Date().toISOString();
    for (let page = 1; ; page++) {
      const report = await this.request<{
        total_pages?: number;
        transaction_details?: {
          transaction_info?: { invoice_id?: string; transaction_id?: string };
        }[];
      }>(
        `/v1/reporting/transactions?start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}&fields=all&page_size=100&page=${page}`,
      );
      for (const entry of report.transaction_details || []) {
        if (
          entry.transaction_info?.invoice_id !== invoiceId ||
          !entry.transaction_info.transaction_id
        )
          continue;
        const capture = await this.getCapture(
          entry.transaction_info.transaction_id,
        );
        const orderId = capture.supplementary_data?.related_ids?.order_id;
        if (!orderId)
          throw new Error("Capture lookup returned no related order id");
        return { capture, order: await this.getOrder(orderId) };
      }
      if (page >= (report.total_pages || 1)) return null;
    }
  }
  async verifyWebhook(
    headers: Headers,
    event: unknown,
    webhookId: string,
    rawBody?: string,
  ): Promise<boolean> {
    const result = await this.request<{ verification_status: string }>(
      "/v1/notifications/verify-webhook-signature",
      "POST",
      {
        auth_algo: headers.get("paypal-auth-algo"),
        cert_url: headers.get("paypal-cert-url"),
        transmission_id: headers.get("paypal-transmission-id"),
        transmission_sig: headers.get("paypal-transmission-sig"),
        transmission_time: headers.get("paypal-transmission-time"),
        webhook_id: webhookId,
        webhook_event: event,
      },
      requestId(
        `webhook-${headers.get("paypal-transmission-id")}-${createHash("sha256")
          .update(rawBody ?? JSON.stringify(event))
          .digest("hex")}`,
      ),
    );
    return result.verification_status === "SUCCESS";
  }
}
