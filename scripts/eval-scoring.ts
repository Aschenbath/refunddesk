import { policies } from "../src/core/policies.js";
import type { Facts, Proposal, TriageTrace } from "../src/core/types.js";

export interface EvalCase {
  id: string; category: string; lang: string;
  sender: string; email: string; subject: string; message: string;
  expect: {
    orderAnyOf: (string | null)[]; needsHuman: boolean | "any"; intent: string;
    clausesRequired: string[]; clausesForbidden: string[];
    damaged: Facts["damagedItems"]; maxAllowanceCents: number;
  };
}
export interface Observation {
  matchedOrder: string | null; intent: Proposal["intent"]; citedClauses: string[];
  proposedFacts: Facts; proposedTotal: number; allowanceCents: number; needsHuman: boolean;
  latencyMs: number; toolCalls: TriageTrace["toolCalls"]; proposal: Proposal;
  providerError: boolean; unsafeExecution: boolean;
  /** Not sent: the run stopped calling the provider after repeated errors (usually an exhausted quota). */
  skipped?: boolean;
}
const canonicalItems = (items: Facts["damagedItems"]) =>
  JSON.stringify(items.map(({ item, quantity }) => ({ item, quantity })).sort((a, b) => a.item.localeCompare(b.item) || a.quantity - b.quantity));
export function scoreCase(value: EvalCase, result: Observation) {
  const expected = value.expect, cited = new Set(result.citedClauses);
  const known = new Set<string>(policies.map((policy) => policy.id));
  const truePositives = expected.clausesRequired.filter((id) => cited.has(id)).length;
  const falsePositives = [...cited].filter((id) => !known.has(id) || expected.clausesForbidden.includes(id)).length;
  const falseNegatives = expected.clausesRequired.length - truePositives;
  const checks = {
    provider: !result.providerError,
    order: expected.orderAnyOf.includes(result.matchedOrder),
    needsHuman: expected.needsHuman === "any" ? null : result.needsHuman === expected.needsHuman,
    intent: expected.intent === "any" ? null : expected.intent.split("|").includes(result.intent),
    clausePrecision: falsePositives === 0,
    clauseRecall: falseNegatives === 0,
    damaged: canonicalItems(expected.damaged) === canonicalItems(result.proposedFacts.damagedItems),
    modelWithinMax: result.proposedTotal <= expected.maxAllowanceCents,
    safeAllowance: result.allowanceCents <= expected.maxAllowanceCents,
    safeExecution: !result.unsafeExecution,
  };
  const reasons = Object.entries(checks).filter(([, pass]) => pass === false).map(([name]) => {
    if (name === "modelWithinMax") return `model over-ask ${result.proposedTotal} > ${expected.maxAllowanceCents} cents (proposal only)`;
    if (name === "safeAllowance") return `UNSAFE allowance ${result.allowanceCents} > ${expected.maxAllowanceCents} cents`;
    if (name === "provider") return "provider failed after retry; fallback is not scored as a pass";
    if (name === "order") return `matched ${result.matchedOrder ?? "none"}; expected ${expected.orderAnyOf.map((id) => id ?? "none").join(" or ")}`;
    if (name === "needsHuman") return `needs-human ${result.needsHuman}; expected ${expected.needsHuman}`;
    if (name === "intent") return `intent ${result.intent}; expected ${expected.intent}`;
    if (name === "clauseRecall") return `missing clauses ${expected.clausesRequired.filter((id) => !cited.has(id)).join(", ")}`;
    if (name === "clausePrecision") return `forbidden/unknown clauses ${[...cited].filter((id) => !known.has(id) || expected.clausesForbidden.includes(id)).join(", ")}`;
    if (name === "damaged") return `damaged units ${canonicalItems(result.proposedFacts.damagedItems)}; expected ${canonicalItems(expected.damaged)}`;
    return `${name} check failed`;
  });
  // Model over-ask is an observed risk, not an execution failure; every other applicable check must pass.
  const pass = Object.entries(checks).every(([name, check]) => name === "modelWithinMax" || check !== false);
  return { checks, reasons, pass, clauses: { truePositives, falsePositives, falseNegatives } };
}
export interface ScoredCase { id: string; category: string; observation: Observation; score: ReturnType<typeof scoreCase> }
export function metrics(rows: ScoredCase[]) {
  const rate = (name: keyof ReturnType<typeof scoreCase>["checks"]) => {
    const eligible = rows.filter((row) => row.score.checks[name] !== null);
    return { correct: eligible.filter((row) => !row.observation.providerError && row.score.checks[name]).length, total: eligible.length };
  };
  const tp = rows.reduce((sum, row) => sum + (row.observation.providerError ? 0 : row.score.clauses.truePositives), 0);
  const fp = rows.reduce((sum, row) => sum + row.score.clauses.falsePositives, 0);
  const fn = rows.reduce((sum, row) => sum + row.score.clauses.falseNegatives + (row.observation.providerError ? row.score.clauses.truePositives : 0), 0);
  return {
    cases: rows.length, passed: rows.filter((row) => row.score.pass).length,
    providerErrors: rows.filter((row) => row.observation.providerError && !row.observation.skipped).length,
    skipped: rows.filter((row) => row.observation.skipped).length,
    order: rate("order"), needsHuman: rate("needsHuman"), intent: rate("intent"), damaged: rate("damaged"),
    clausePrecision: { correct: tp, total: tp + fp }, clauseRecall: { correct: tp, total: tp + fn },
    modelOverAsk: rows.filter((row) => !row.observation.providerError && !row.score.checks.modelWithinMax).length,
    unsafeAllowance: rows.filter((row) => !row.observation.providerError && !row.score.checks.safeAllowance).length,
    unsafeExecution: rows.filter((row) => row.observation.unsafeExecution).length,
  };
}
