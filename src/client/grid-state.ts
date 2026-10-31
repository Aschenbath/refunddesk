import type { GridState } from "ag-grid-community";
import type { DeskCase } from "../core/types.js";
export const viewNames = ["Needs attention", "Risky", "Ready to approve", "Refunded", "All"] as const;
export type QueueView = typeof viewNames[number];
export function memberships(value: DeskCase): QueueView[] {
  const active = !["refunded", "rejected"].includes(value.status);
  const result: QueueView[] = ["All"];
  if (active && (value.status === "new" || value.status === "needs_human" || value.status === "failed" || value.check?.kind === "blocked" || value.ambiguous)) result.push("Needs attention");
  if (active && (value.check?.kind === "blocked" || value.check?.kind === "adjusted" || value.ambiguous || (value.proposal?.confidence ?? 1) < 0.6 || (value.proposal?.proposed_total ?? 0) > (value.proposedCheck?.computedCents ?? value.check?.computedCents ?? 0))) result.push("Risky");
  if (active && value.status === "ready" && value.proposal && value.check && value.check.kind !== "blocked" && !value.attempt) result.push("Ready to approve");
  if (value.status === "refunded") result.push("Refunded");
  return result;
}
export interface StoredLayout { state: GridState; view?: QueueView; views?: Partial<Record<QueueView, GridState>> }
export function readLayout(key: string): StoredLayout | undefined {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : undefined; } catch { return undefined; }
}
export function writeLayout(key: string, value: StoredLayout) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Keep working when storage is blocked or full. */ }
}
export function clearLayout(key: string) {
  try { localStorage.removeItem(key); } catch { /* Visible reset still works. */ }
}
export function presetState(base: GridState, view: QueueView): GridState {
  return { ...base, rowSelection: undefined, focusedCell: undefined, scroll: undefined,
    filter: { filterModel: view === "All" ? {} : { workflow: { filterType: "text", type: "contains", filter: view } } },
    sort: { sortModel: view === "Risky" ? [{ colId: "confidence", sort: "asc" }] : [{ colId: "createdAt", sort: "asc" }] },
  };
}
// Counts for saved views include their editable native/custom filter models.
export function matchesFilterModel(values: Record<string, unknown>, models: Record<string, any>): boolean {
  const matches = (value: unknown, model: any): boolean => {
    if (!model) return true;
    if (model.conditions) return model.operator === "OR" ? model.conditions.some((condition: any) => matches(value, condition)) : model.conditions.every((condition: any) => matches(value, condition));
    if (model.values) return model.values.includes(String(value));
    if (model.type === "blank") return value == null || value === "";
    if (model.type === "notBlank") return value != null && value !== "";
    if (model.filterType === "number") {
      if (value == null || value === "") return false;
      const number = Number(value), from = Number(model.filter), to = Number(model.filterTo);
      switch (model.type) {
        case "equals": return number === from;
        case "notEqual": return number !== from;
        case "lessThan": return number < from;
        case "lessThanOrEqual": return number <= from;
        case "greaterThan": return number > from;
        case "greaterThanOrEqual": return number >= from;
        // AG Grid excludes both ends unless inRangeInclusive is set, which this grid never does.
        case "inRange": return number > from && number < to;
      }
    }
    const text = String(value ?? "").toLowerCase(), filter = String(model.filter ?? "").toLowerCase();
    switch (model.type) {
      case "equals": return text === filter;
      case "notEqual": return text !== filter;
      case "notContains": return !text.includes(filter);
      case "startsWith": return text.startsWith(filter);
      case "endsWith": return text.endsWith(filter);
      default: return text.includes(filter);
    }
  };
  return Object.entries(models).every(([key, model]) => matches(values[key], model));
}
