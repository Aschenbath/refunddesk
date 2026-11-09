export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  const text = value?.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const milliseconds = Number(text) * 1000;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  // Reject malformed numeric values instead of treating them as calendar dates.
  if (!/^[A-Za-z]/.test(text)) return null;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = result.error;
    throw new ApiError(
      `${error?.message || "Request failed"}${error?.issue ? ` · ${error.issue}` : ""}${error?.debug_id ? ` · PayPal debug ${error.debug_id}` : ""}`,
      response.status,
      parseRetryAfter(response.headers.get("Retry-After")),
    );
  }
  return result as T;
}
export function money(cents: number | null | undefined, currency: string | null = "USD") {
  if (cents === undefined || cents === null) return "—";
  if (!currency || !/^[A-Z]{3}$/.test(currency))
    return `${cents.toLocaleString("en-US")} minor units · currency unknown`;
  // The app stores integer cents. Keep that precision even for a model's
  // unsupported currency, and avoid ambiguous dollar symbols outside USD.
  if (currency === "USD") return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  const amount = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
  return `${currency} ${amount}`;
}
export function age(date?: string) {
  if (!date) return "—";
  const hours = Math.floor((Date.now() - Date.parse(date)) / 3600000);
  return hours < 1
    ? "Just now"
    : hours < 24
      ? `${hours}h`
      : `${Math.floor(hours / 24)}d`;
}
export function parseAmount(value: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}
