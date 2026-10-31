import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { calculate, businessDaysAfter } from "../src/core/calculator.js";
import { guard } from "../src/core/guardrails.js";
import { centsToDecimal, decimalToCents } from "../src/core/money.js";
import { order, proposal, context } from "./fixtures/domain.js";

describe("policy examples", () => {
  it("refunds damaged items and shipping only when all items are damaged", () => {
    expect(guard(context).computedCents).toBe(5600);
    const two = {
      ...order,
      lines: [...order.lines, { ...order.lines[0], id: "bowl" }],
      capturedCents: 10400,
    };
    expect(calculate(two, ["P1.1"], context.facts, context.now).lines).toEqual([
      { item: "mug", cents: 4800 },
    ]);
    expect(
      calculate(two, ["P1.1", "P1.2"], context.facts, context.now).reasons,
    ).toHaveLength(1);
    expect(
      guard({
        ...context,
        facts: { ...context.facts, hasDamageEvidence: false },
      }).kind,
    ).toBe("blocked");
  });
  it("uses strict business-day thresholds and cents rounding", () => {
    expect(businessDaysAfter("2026-09-04", "2026-09-07")).toBe(1);
    const base = { ...order, promisedAt: "2026-09-07" };
    expect(
      calculate(
        { ...base, deliveredAt: "2026-09-21" },
        ["P2.1"],
        {
          ...context.facts,
          deliveryDates: {
            promisedAt: base.promisedAt,
            deliveredAt: "2026-09-21",
          },
        },
        context.now,
      ).lines,
    ).toEqual([]);
    expect(
      calculate(
        { ...base, deliveredAt: "2026-09-22" },
        ["P2.1"],
        {
          ...context.facts,
          deliveryDates: {
            promisedAt: base.promisedAt,
            deliveredAt: "2026-09-22",
          },
        },
        context.now,
      ).lines,
    ).toEqual([{ item: "shipping", cents: 800 }]);
    expect(
      calculate(
        { ...base, deliveredAt: "2026-10-05" },
        ["P2.1", "P2.2"],
        {
          ...context.facts,
          deliveryDates: {
            promisedAt: base.promisedAt,
            deliveredAt: "2026-10-05",
          },
        },
        context.now,
      ).lines,
    ).toEqual([]);
    expect(
      calculate(
        { ...base, deliveredAt: "2026-10-06" },
        ["P2.1", "P2.2"],
        {
          ...context.facts,
          deliveryDates: {
            promisedAt: base.promisedAt,
            deliveredAt: "2026-10-06",
          },
        },
        context.now,
      ).lines,
    ).toEqual([
      { item: "shipping", cents: 800 },
      { item: "mug", cents: 720 },
    ]);
  });
  it("deducts $6 once and checks return receipt, sale exclusion and 30-day boundary", () => {
    expect(
      calculate(order, ["P3.1"], context.facts, "2026-11-01").lines,
    ).toEqual([{ item: "mug", cents: 4200 }]);
    expect(
      calculate(order, ["P3.1"], context.facts, "2026-11-02").lines,
    ).toEqual([]);
    for (const line of [{ ...order.lines[0], sale: true }]) {
      expect(
        calculate(
          { ...order, lines: [line] },
          ["P3.1"],
          context.facts,
          context.now,
        ).lines,
      ).toEqual([]);
    }
    expect(
      calculate(
        order,
        ["P3.1"],
        { ...context.facts, returnReceived: false },
        context.now,
      ).lines,
    ).toEqual([]);
    const two = {
      ...order,
      lines: [...order.lines, { ...order.lines[0], id: "bowl" }],
    };
    expect(
      calculate(
        two,
        ["P3.1"],
        {
          ...context.facts,
          returnedItems: two.lines.map((line) => ({
            item: line.id,
            quantity: line.quantity,
          })),
        },
        context.now,
      ).lines.reduce((sum, line) => sum + line.cents, 0),
    ).toBe(9000);
  });
  it("blocks unknown, mixed and dependent-only clauses", () => {
    for (const ids of [[], ["P9.1"], ["P1.1", "P2.1"], ["P1.2"], ["P2.2"]]) {
      expect(calculate(order, ids, context.facts, context.now).lines).toEqual(
        [],
      );
    }
  });
  it("adjusts wrong model amounts, blocks wrong currency, ambiguity, duplicates and non-refunds", () => {
    expect(
      guard({ ...context, proposal: { ...proposal, proposed_total: 999999 } })
        .kind,
    ).toBe("adjusted");
    for (const change of [
      { order: null },
      { ambiguous: true },
      { duplicate: true },
      { proposal: { ...proposal, currency: "EUR" } },
      { proposal: { ...proposal, intent: "question" as const } },
      { unallocatedRefund: true },
    ]) {
      expect(guard({ ...context, ...change }).kind).toBe("blocked");
    }
    expect(
      guard({ ...context, duplicate: true, overrideDuplicate: true }).kind,
    ).toBe("pass");
    expect(guard({ ...context, approvedCents: 5601 }).kind).toBe("blocked");
    expect(guard({ ...context, approvedCents: 100 }).kind).toBe("adjusted");
    expect(
      guard({
        ...context,
        refundedCents: 5600,
        refundedByLine: { mug: 4800, shipping: 800 },
      }).kind,
    ).toBe("blocked");
  });
});

describe("acceptance properties", () => {
  it("no approved amount exceeds the order or per-line refundable remainder", () =>
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100000 }),
        fc.integer({ min: 0, max: 100000 }),
        fc.integer({ min: 0, max: 200000 }),
        (captured, already, requested) => {
          const previous = Math.min(already, captured);
          const currentOrder = {
            ...order,
            capturedCents: captured,
            shippingCents: 0,
            lines: [{ ...order.lines[0], quantity: 1, unitCents: captured }],
          };
          const result = guard({
            ...context,
            order: currentOrder,
            facts: {
              ...context.facts,
              damagedItems: [{ item: "mug", quantity: 1 }],
            },
            refundedCents: previous,
            refundedByLine: { mug: previous },
            approvedCents: requested,
          });
          expect(result.computedCents).toBeLessThanOrEqual(captured - previous);
          expect(
            result.lines.every((line) => line.cents <= captured - previous),
          ).toBe(true);
          if (result.kind !== "blocked")
            expect(result.approvedCents).toBeLessThanOrEqual(
              captured - previous,
            );
        },
      ),
      { numRuns: 500 },
    ));
  it("computed amounts are independent of all model numbers", () =>
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000000 }),
        fc.array(fc.integer({ min: 0, max: 1000000 }), { maxLength: 10 }),
        (total, amounts) => {
          const changed = {
            ...proposal,
            proposed_total: total,
            proposed_lines: amounts.map((amount, index) => ({
              item: `invented-${index}`,
              amount,
              reason: "model",
            })),
          };
          expect(guard({ ...context, proposal: changed }).computedCents).toBe(
            guard(context).computedCents,
          );
        },
      ),
      { numRuns: 300 },
    ));
  it("duplicates always block without a human override", () =>
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000000 }), (amount) => {
        expect(
          guard({
            ...context,
            duplicate: true,
            proposal: { ...proposal, proposed_total: amount },
          }).kind,
        ).toBe("blocked");
      }),
      { numRuns: 300 },
    ));
  it("currency and ambiguous matches always fail closed", () =>
    fc.assert(
      fc.property(
        fc.constantFrom("EUR", "GBP", "JPY"),
        fc.boolean(),
        (currency, ambiguous) => {
          expect(
            guard({
              ...context,
              ambiguous,
              proposal: { ...proposal, currency },
            }).kind,
          ).toBe("blocked");
          expect(guard({ ...context, ambiguous: true }).kind).toBe("blocked");
        },
      ),
    ));
  it("damage caps every affected line and never refunds undamaged lines", () =>
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 1, max: 8 }),
        (price, qty) => {
          const two = {
            ...order,
            lines: [
              { ...order.lines[0], unitCents: price, quantity: qty },
              { ...order.lines[0], id: "other" },
            ],
            capturedCents: price * qty + 5600,
          };
          const result = guard({
            ...context,
            order: two,
            facts: {
              ...context.facts,
              damagedItems: [{ item: "mug", quantity: qty }],
            },
            proposal: { ...proposal, policy_clause_ids: ["P1.1"] },
          });
          expect(result.lines).toEqual([{ item: "mug", cents: price * qty }]);
        },
      ),
    ));
  it("late item percentage and return deduction follow the policy at any price", () =>
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100000 }), (price) => {
        const priced = {
          ...order,
          promisedAt: "2026-08-01",
          lines: [{ ...order.lines[0], quantity: 1, unitCents: price }],
        };
        expect(
          calculate(
            priced,
            ["P2.1", "P2.2"],
            {
              ...context.facts,
              deliveryDates: {
                promisedAt: priced.promisedAt,
                deliveredAt: priced.deliveredAt,
              },
            },
            context.now,
          ).lines.find((line) => line.item === "mug")?.cents,
        ).toBe(Math.round(price * 0.15));
        expect(
          calculate(
            priced,
            ["P3.1"],
            { ...context.facts, returnedItems: [{ item: "mug", quantity: 1 }] },
            context.now,
          ).lines[0].cents,
        ).toBe(Math.max(0, price - 600));
      }),
    ));
  it("money conversion round trips integer cents exactly", () =>
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10000000 }), (cents) => {
        expect(decimalToCents(centsToDecimal(cents))).toBe(cents);
      }),
    ));
});
