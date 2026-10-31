export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = result.error;
    throw new Error(
      `${error?.message || "Request failed"}${error?.issue ? ` · ${error.issue}` : ""}${error?.debug_id ? ` · PayPal debug ${error.debug_id}` : ""}`,
    );
  }
  return result as T;
}
export function money(cents: number | null | undefined, currency = "USD") {
  return cents === undefined || cents === null
    ? "—"
    : new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
        cents / 100,
      );
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
