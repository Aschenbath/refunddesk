// Provider messages can contain prompts, request bodies and credentials.
export function redactError(error: unknown): string {
  const status =
    error && typeof error === "object"
      ? ((error as { status?: unknown; statusCode?: unknown }).status ??
        (error as { statusCode?: unknown }).statusCode)
      : undefined;
  const name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(error.name)
      ? error.name
      : "ProviderError";
  return `${name}${typeof status === "number" ? ` (HTTP ${status})` : ""}`;
}
