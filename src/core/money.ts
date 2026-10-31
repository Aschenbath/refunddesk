export function decimalToCents(value: string): number {
  if (!/^\d+\.\d{2}$/.test(value))
    throw new Error("Expected a nonnegative two-decimal money value");
  const [whole, fraction] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(result))
    throw new Error("Money exceeds safe integer range");
  return result;
}
export function centsToDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0)
    throw new Error("Expected nonnegative integer cents");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
