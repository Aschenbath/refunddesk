import { describe, expect, it, vi } from "vitest";
import { clearLayout, readLayout, writeLayout, presetState, memberships, matchesFilterModel } from "../src/client/grid-state.js";
import type { DeskCase } from "../src/core/types.js";
describe("saved view state", () => {
  it("counts a saved view using its text, numeric and multiselect filters", () => {
    const model = { sender: { filterType: "text", type: "contains", filter: "maya" }, amount: { filterType: "number", type: "greaterThan", filter: 20 }, status: { values: ["ready", "needs_human"] } };
    expect(matchesFilterModel({ sender: "Maya Chen", amount: 24, status: "ready" }, model)).toBe(true);
    expect(matchesFilterModel({ sender: "Maya Chen", amount: 19, status: "ready" }, model)).toBe(false);
    expect(matchesFilterModel({ sender: "Luis Romero", amount: 24, status: "ready" }, model)).toBe(false);
    expect(matchesFilterModel({ sender: "Maya Chen", amount: 24, status: "refunded" }, model)).toBe(false);
  });
  it("counts an in-range filter the way the grid does, without the endpoints", () => {
    const model = { amount: { filterType: "number", type: "inRange", filter: 10, filterTo: 20 } };
    expect([10, 15, 20].map((amount) => matchesFilterModel({ amount }, model))).toEqual([false, true, false]);
  });
  it("persists state and keeps reset usable when browser storage is blocked", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    try {
      const state = { columnSizing: { columnSizingModel: [{ colId: "sender", width: 200 }] } };
      writeLayout("grid", { state, view: "Risky" }); expect(readLayout("grid")).toEqual({ state, view: "Risky" });
      clearLayout("grid"); expect(readLayout("grid")).toBeUndefined();
      vi.stubGlobal("localStorage", { getItem: () => { throw new Error("Blocked"); }, setItem: () => { throw new Error("Full"); }, removeItem: () => { throw new Error("Blocked"); } });
      expect(readLayout("grid")).toBeUndefined(); expect(() => writeLayout("grid", { state })).not.toThrow(); expect(() => clearLayout("grid")).not.toThrow();
    } finally { vi.unstubAllGlobals(); }
  });
  it("preserves column state in presets and marks risky cases by all supported signals", () => {
    const base = { columnOrder: { orderedColIds: ["sender", "amount"] } };
    expect(presetState(base, "Risky").columnOrder).toEqual(base.columnOrder);
    expect(presetState(base, "Risky").sort?.sortModel).toEqual([{ colId: "confidence", sort: "asc" }]);
    for (const value of [{ status: "needs_human", check: { kind: "blocked" } }, { status: "ready", check: { kind: "adjusted" } }, { status: "ready", ambiguous: true }, { status: "ready", proposal: { proposed_total: 200, confidence: 0.9 }, proposedCheck: { computedCents: 100 } }, { status: "ready", proposal: { confidence: 0.5 } }])
      expect(memberships(value as DeskCase)).toContain("Risky");
  });
});
