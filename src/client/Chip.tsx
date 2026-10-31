import type { ReactNode } from "react";
export function Chip({ kind, children }: { kind: string; children?: ReactNode }) {
  return <span className={`chip ${kind}`}>{children || kind.replaceAll("_", " ")}</span>;
}
