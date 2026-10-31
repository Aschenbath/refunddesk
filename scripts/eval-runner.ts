import { readFileSync } from "node:fs";
import { Store } from "../src/server/db.js";
import { seedEvalBook, EVAL_DATE } from "../src/server/seed-book.js";
import { DeskService } from "../src/server/service.js";
import { PayPalClient } from "../src/server/paypal.js";
import { guard } from "../src/core/guardrails.js";
import { emptyFacts } from "../src/core/types.js";
import type { TriageSettings } from "../src/server/triage.js";
import { scoreCase, type EvalCase, type Observation, type ScoredCase } from "./eval-scoring.js";

export function loadCases(): EvalCase[] {
  return readFileSync(new URL("../eval/cases.jsonl", import.meta.url), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
}
export function evalContext(store: Store, result: Observation) {
  const order = result.matchedOrder ? store.getOrder(result.matchedOrder) : null;
  const refunds = order ? store.listRefunds(order.id) : [];
  const byLine: Record<string, number> = {};
  for (const refund of refunds) for (const line of refund.allocations)
    byLine[line.item] = (byLine[line.item] || 0) + line.cents;
  return { order, proposal: result.proposal, facts: result.proposedFacts, now: EVAL_DATE,
    refundedCents: refunds.reduce((sum, refund) => sum + refund.amountCents, 0), refundedByLine: byLine,
    duplicate: false, ambiguous: false };
}
export async function runCase(value: EvalCase, settings: TriageSettings): Promise<ScoredCase> {
  const store = new Store(":memory:");
  seedEvalBook(store);
  // No payment client method is invoked by triage or scoring.
  const service = new DeskService(store, new PayPalClient("", ""), { ...settings, useFixtures: false }, () => EVAL_DATE);
  try {
    const input = service.createMessage({ sender: value.sender, email: value.email, subject: value.subject, message: value.message });
    const detail = await service.triageCase(input.id);
    const proposal = detail.proposal!, trace = detail.triageTrace!;
    const result: Observation = {
      matchedOrder: detail.orderId, intent: proposal.intent, citedClauses: proposal.policy_clause_ids,
      proposedFacts: detail.proposedFacts, proposedTotal: proposal.proposed_total,
      allowanceCents: detail.proposedCheck!.computedCents,
      // Human escalation using proposed facts; all real approvals still require separate confirmations.
      needsHuman: trace.source === "unavailable" || !!detail.ambiguous || !!proposal.needs_human_reason || detail.proposedCheck!.kind === "blocked",
      latencyMs: trace.latencyMs, toolCalls: trace.toolCalls, proposal,
      providerError: trace.source === "unavailable", unsafeExecution: false,
    };
    const context = evalContext(store, result);
    const allowance = guard(context).computedCents;
    const candidates = new Set([0, proposal.proposed_total, allowance, allowance + 1, 1_000_000]);
    result.unsafeExecution = [...candidates].some((approvedCents) => {
      const check = guard({ ...context, approvedCents });
      return check.kind !== "blocked" && (check.approvedCents > check.computedCents || check.approvedCents > check.remainderCents);
    });
    // Ensure scoring never changes the app's confirmation state.
    if (JSON.stringify(detail.confirmedFacts) !== JSON.stringify(emptyFacts())) throw new Error("Triage promoted facts");
    return { id: value.id, category: value.category, observation: result, score: scoreCase(value, result) };
  } finally { store.close(); }
}
