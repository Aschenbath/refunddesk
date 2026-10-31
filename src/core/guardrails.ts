import { calculate } from "./calculator.js";
import type { Allocation, Check, GuardContext } from "./types.js";

export function distribute(lines: Allocation[], amount: number): Allocation[] {
  let remaining = amount;
  return lines
    .map((line) => {
      const cents = Math.min(remaining, line.cents);
      remaining -= cents;
      return { item: line.item, cents };
    })
    .filter((line) => line.cents > 0);
}
export function guard(context: GuardContext): Check {
  const { order, proposal, facts } = context;
  const reasons: string[] = [];
  let lines: Allocation[] = [];
  const remainderCents = order
    ? Math.max(0, order.capturedCents - context.refundedCents)
    : 0;
  if (!order) reasons.push("Pick a verified order before approval.");
  if (context.ambiguous)
    reasons.push("Order match is ambiguous; a human must pick the order.");
  if (context.duplicate && !context.overrideDuplicate)
    reasons.push(
      "An open or recent refund exists for this order. A reasoned human override is required.",
    );
  if (context.unallocatedRefund)
    reasons.push(
      "PayPal has an unallocated refund; review its item allocation before approval.",
    );
  if (proposal.intent !== "refund")
    reasons.push("This message is not a refund request.");
  if (proposal.needs_human_reason) reasons.push(proposal.needs_human_reason);
  if (order && proposal.currency !== order.currency)
    reasons.push("Proposal currency differs from the capture currency.");
  if (order) {
    const calculation = calculate(
      order,
      proposal.policy_clause_ids,
      facts,
      context.now,
    );
    reasons.push(...calculation.reasons);
    lines = calculation.lines.map((line) => ({
      ...line,
      cents: Math.max(0, line.cents - (context.refundedByLine[line.item] ?? 0)),
    }));
    lines = distribute(
      lines,
      Math.min(
        remainderCents,
        lines.reduce((sum, line) => sum + line.cents, 0),
      ),
    );
  }
  const computedCents = lines.reduce((sum, line) => sum + line.cents, 0);
  const approvedCents = context.approvedCents ?? computedCents;
  if (
    !Number.isSafeInteger(approvedCents) ||
    approvedCents <= 0 ||
    approvedCents > computedCents ||
    approvedCents > remainderCents
  )
    reasons.push(
      "Approved amount must be positive integer cents within both the policy allowance and refundable remainder.",
    );
  const modelItems = new Map(
    proposal.proposed_lines.map((line) => [line.item, line.amount]),
  );
  const mismatch =
    proposal.proposed_total !== computedCents ||
    proposal.proposed_lines.reduce((sum, line) => sum + line.amount, 0) !==
      proposal.proposed_total ||
    proposal.proposed_lines.length !== lines.length ||
    lines.some((line) => modelItems.get(line.item) !== line.cents);
  return {
    kind: reasons.length
      ? "blocked"
      : mismatch || approvedCents !== computedCents
        ? "adjusted"
        : "pass",
    computedCents,
    approvedCents,
    modelCents: proposal.proposed_total,
    remainderCents,
    reasons: reasons.length
      ? [...new Set(reasons)]
      : mismatch
        ? ["Model amount differs from the deterministic policy calculation."]
        : approvedCents !== computedCents
          ? ["Human chose a lower amount within policy."]
          : [],
    lines,
  };
}
