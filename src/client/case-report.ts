import type { CaseReport, ReportOrder } from "../core/case-report.js";
import type { Allocation, Check, Facts, Proposal } from "../core/types.js";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);
const text = (value: unknown, fallback = "Not recorded"): string =>
  typeof value === "string" && value.trim() ? value : fallback;
const count = (value: unknown): string => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "Unknown";
const currency = (value: unknown): string => typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : "Currency unavailable";
const money = (value: unknown, unit: unknown): string => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "Amount unavailable";
  return `${currency(unit)} ${Math.floor(value / 100).toLocaleString("en-US")}.${String(value % 100).padStart(2, "0")}`;
};
const historicalAmount = (value: unknown): string => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  ? `${value} minor units · currency not recorded` : "Amount unavailable";
const date = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) return "Not recorded";
  if (!/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return "Unrecognized date";
  const day = value.slice(0, 10);
  const calendar = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 10) !== day) return "Unrecognized date";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Unrecognized date";
  if (value.length === 10) return value;
  return new Date(parsed).toISOString().replace("T", " ").replace("Z", " UTC");
};
const confirmed = (value: unknown): string => value === true ? "Confirmed by owner" : value === false ? "Not confirmed" : "Unknown";
const list = (values: string[], fallback = "None recorded"): string => values.length
  ? `<ul>${values.map((value) => `<li>${escape(value)}</li>`).join("")}</ul>` : `<p class="muted">${escape(fallback)}</p>`;
const fields = (values: [string, unknown][]): string => `<dl class="facts">${values.map(([label, value]) =>
  `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl>`;
const table = (labels: string[], rows: string[][], empty: string): string => rows.length
  ? `<table><thead><tr>${labels.map((label) => `<th scope="col">${escape(label)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) =>
    `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
  : `<p class="muted">${escape(empty)}</p>`;
const note = (value: string): string => `<p class="note">${escape(value)}</p>`;
const section = (number: string, title: string, content: string): string =>
  `<section><div class="chapter"><span>${escape(number)}</span><h2>${escape(title)}</h2></div>${content}</section>`;
const itemName = (id: string, order: ReportOrder | null): string => {
  const item = order?.lines.find((line) => line.id === id);
  return item ? `${item.title} (${id})` : id;
};
const allocations = (values: Allocation[], unit: string, order: ReportOrder | null): string => table(
  ["Allocation", "Amount"], values.map((line) => [itemName(line.item, order), money(line.cents, unit)]), "No allocation lines recorded.",
);

function facts(value: Facts, order: ReportOrder | null, proposed = false): string {
  const evidence = (flag: unknown): string => proposed ? flag === true ? "Proposed true" : flag === false ? "Proposed false" : "Unknown" : confirmed(flag);
  return fields([
    ["Damage evidence", evidence(value.hasDamageEvidence)], ["Return received", evidence(value.returnReceived)],
    ["Promised delivery", date(value.deliveryDates?.promisedAt)], ["Reported delivery", date(value.deliveryDates?.deliveredAt)],
  ]) + table([proposed ? "Proposed fact" : "Confirmed fact", "Item", "Quantity"], [
    ...value.damagedItems.map((line) => ["Damaged", itemName(line.item, order), count(line.quantity)]),
    ...value.returnedItems.map((line) => ["Returned", itemName(line.item, order), count(line.quantity)]),
  ], proposed ? "No item quantities proposed." : "No item quantities confirmed.");
}

function proposal(value: Proposal | null, order: ReportOrder | null): string {
  if (!value) return note("No proposal is saved for this case.");
  const matchedOrder = value.matched_order_id === order?.id ? order : null;
  const confidence = Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1
    ? `${Math.round(value.confidence * 100)}%` : "Unknown";
  return fields([
    ["Matched order", text(value.matched_order_id, "No match")], ["Intent", text(value.intent)],
    ["Proposed total", money(value.proposed_total, value.currency)], ["Recorded confidence", confidence],
    ["Selected clause IDs", value.policy_clause_ids.join(", ") || "None"], ["Escalation reason", text(value.needs_human_reason, "None recorded")],
  ]) + table(["Proposed item", "Recorded reason", "Amount"], value.proposed_lines.map((line) => [
    itemName(line.item, matchedOrder), text(line.reason), money(line.amount, value.currency),
  ]), "No proposal lines recorded.") + `<h4>Order-match evidence</h4>${list(value.match_evidence)}` +
    (value.proposed_facts ? `<h4>Facts stored with this proposal</h4>${note("These are proposal facts, not owner-confirmed facts.")}${facts(value.proposed_facts, matchedOrder, true)}` : "");
}

function check(value: Check | null, unit: string, modelUnit: string, order: ReportOrder | null): string {
  if (!value) return note("No saved policy check is available; approval eligibility is unknown.");
  return fields([
    ["Check result", text(value.kind)], ["Model amount in this check", money(value.modelCents, modelUnit)],
    ["Calculated allowance", money(value.computedCents, unit)], ["Selected amount in this check", money(value.approvedCents, unit)],
    ["Refundable balance at this check", money(value.remainderCents, unit)],
  ]) + `<h4>Check reasons</h4>${list(value.reasons, "No blocking or adjustment reasons recorded for this check.")}` +
    `<h4>Calculated allocations</h4>${allocations(value.lines, unit, order)}`;
}

function receipts(report: CaseReport): string {
  const totals = new Map<string, number>();
  let incomplete = false;
  for (const receipt of report.receipts.filter((value) => value.status === "COMPLETED")) {
    if (!Number.isSafeInteger(receipt.amountCents) || receipt.amountCents < 0 || !/^[A-Z]{3}$/.test(receipt.currency)) { incomplete = true; continue; }
    const total = (totals.get(receipt.currency) ?? 0) + receipt.amountCents;
    if (!Number.isSafeInteger(total)) { incomplete = true; continue; }
    totals.set(receipt.currency, total);
  }
  const source = (value: CaseReport["receipts"][number]["source"]): string => ({
    "sandbox-record": "Saved sandbox receipt", "recorded-sandbox-sample": "Recorded sandbox sample — retained sandbox ID",
    "simulated-replay": "Simulated replay receipt — no PayPal payment",
  })[value] ?? "Receipt source unknown";
  const summary = totals.size ? [...totals].map(([unit, amount]) => money(amount, unit)).join(" · ") : "No completed amount recorded";
  return note("Only receipts associated with this case are listed. Pending and failed receipts are not completed refunds. The recorded time is a local record timestamp, not a PayPal completion timestamp.") +
    fields([["Completed receipt totals, by currency", summary]]) +
    (incomplete ? note("Completed totals are incomplete: an amount or currency is unavailable or exceeds the supported integer range.") : "") +
    (report.receipts.length ? report.receipts.map((value) => `<article class="receipt"><div class="receipt-title"><h3>${escape(text(value.status, "Unknown status"))}</h3><strong>${escape(money(value.amountCents, value.currency))}</strong></div><p class="source">${escape(source(value.source))}</p>${fields([
      ["Receipt ID", value.id], ["Request ID", text(value.requestId)], ["Locally recorded at", date(value.recordedAt)],
    ])}</article>`).join("") : note("No refund receipts are saved for this case. A proposal or approval alone does not prove payment completion."));
}

const styles = `
:root{font-family:"Segoe UI",Aptos,sans-serif;color:#293c38;background:#f6f6ef;font-size:15px;line-height:1.55}
*{box-sizing:border-box}body{margin:0}main{width:100%;max-width:1060px;margin:36px auto;padding:48px 54px;background:#fffefa;border:1px solid #dce2d6}
h1,h2,h3,h4,p,dl{margin:0}h1,h2{font-family:Georgia,"Times New Roman",serif;font-weight:400}h1{font-size:clamp(32px,5vw,52px);letter-spacing:-1.6px;line-height:1.1;margin:20px 0 12px}h2{font-size:26px;line-height:1.2}h3{font-size:17px;margin:24px 0 8px}h4{font-size:13px;margin:20px 0 8px;color:#19594f}
p,dd,td,th,li,code,h1,h2,h3,h4,strong{overflow-wrap:anywhere;word-break:normal;min-width:0}p{margin:8px 0}code{font:inherit;font-variant-numeric:tabular-nums}ul{padding-left:21px;margin:8px 0}li{padding:3px 0}header{border-top:4px solid #19594f;padding-top:18px}.brandline{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;font-size:12px;color:#61736a}.brand{font-size:18px;font-weight:700;letter-spacing:-.5px;color:#19594f}.subhead{color:#61736a;max-width:720px}.origin{margin:24px 0 18px;padding:18px 20px;background:#edf2e5;border-left:4px solid #19594f}.origin strong{display:block;font-size:13px;letter-spacing:.08em}.origin p{font-size:13px;margin:7px 0 0}.origin.replay{background:#f7efda;border-color:#8a6b30;color:#584820}.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 28px;margin:16px 0}.facts>div{min-width:0}dt{font-size:11px;text-transform:uppercase;letter-spacing:.065em;color:#65736c;margin-bottom:3px}dd{margin:0;font-size:14px;white-space:pre-wrap}.amounts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:24px 0 8px;border-top:1px solid #dce2d6;border-bottom:1px solid #dce2d6}.amount{padding:19px 15px 19px 0;min-width:0}.amount+.amount{border-left:1px solid #dce2d6;padding-left:18px}.amount span{display:block;color:#65736c;font-size:11px;text-transform:uppercase;letter-spacing:.06em}.amount strong{display:block;font-size:23px;font-weight:600;line-height:1.3;margin-top:7px;font-variant-numeric:tabular-nums}.amount small{display:block;font-size:11px;color:#65736c;margin-top:7px}.chapter{display:flex;align-items:baseline;gap:15px;margin:0 0 18px}.chapter>span{font-size:12px;font-variant-numeric:tabular-nums;color:#849181}section{margin-top:36px;padding-top:27px;border-top:1px solid #dce2d6}.note{padding:10px 13px;border-left:2px solid #cad4c3;color:#5c6c63;font-size:12px;margin:13px 0}.message{padding:20px 22px;border:1px solid #e0e5d9;background:#f8f8f1;white-space:pre-wrap}.message h3{margin:0 0 10px;font-family:Georgia,"Times New Roman",serif;font-size:20px;font-weight:400}.message p{margin:0}.muted,.source{color:#66786c;font-size:13px}.source{margin:0 0 8px}.receipt{border:1px solid #dce2d6;padding:17px 20px;margin:14px 0;break-inside:avoid}.receipt-title{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap}.receipt-title h3{margin:0}.receipt-title strong{font-size:20px;font-variant-numeric:tabular-nums}.receipt .facts{margin-bottom:0}table{width:100%;table-layout:fixed;border-collapse:collapse;margin:12px 0 18px;font-size:13px}th{text-align:left;font-size:11px;font-weight:600;letter-spacing:.025em;color:#627367;padding:10px 9px;border-bottom:1px solid #cbd5c4;vertical-align:bottom}td{padding:10px 9px;border-bottom:1px solid #e5e9df;vertical-align:top;white-space:pre-wrap}thead{display:table-header-group}tr{break-inside:avoid}footer{margin-top:35px;padding-top:18px;border-top:2px solid #19594f;font-size:11px;color:#627367}.error{color:#8b3f2e}.policy-id{font-weight:700;color:#19594f}.policy{padding:12px 0;border-bottom:1px solid #e5e9df}.policy p{font-size:13px;white-space:pre-wrap}
@media(max-width:640px){main{margin:0;padding:25px 18px;border:0}.facts{grid-template-columns:minmax(0,1fr);gap:12px}.amounts{grid-template-columns:minmax(0,1fr)}.amount,.amount+.amount{padding:14px 0;border-left:0}.amount+.amount{border-top:1px solid #e5e9df}.amount strong{font-size:25px}.amount small{margin-top:3px}.chapter{gap:10px}h2{font-size:24px}.origin{padding:15px}.message,.receipt{padding:15px}th,td{padding:9px 5px;font-size:12px}.receipt .facts{gap:10px}}
@page{margin:16mm}@media print{:root,body{background:white;color:#172b25;font-size:10pt}main{max-width:none;margin:0;padding:0;border:0;background:white}header{padding-top:10px}h1{font-size:28pt}h2{font-size:17pt}h3{font-size:12pt}.brandline,.source,.muted,dt,.note,footer{color:#35483e}.origin,.origin.replay,.message{background:white;color:inherit}.origin{border:1px solid #8c9b8e;border-left:4px solid #19594f;margin:16px 0;padding:10px 12px}.amounts{grid-template-columns:repeat(3,minmax(0,1fr));margin-top:16px}.amount,.amount+.amount{padding:12px 10px;border-top:0}.amount+.amount{border-left:1px solid #cbd5c4}.amount strong{font-size:15pt}.amount small{font-size:8pt}.facts{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 20px}dd{font-size:9pt}dt{font-size:7.5pt}section{margin-top:20px;padding-top:16px}.chapter,h3,h4{break-after:avoid}.chapter{margin-bottom:10px}.message{padding:12px}.receipt{padding:12px}.note{font-size:8pt}.receipt-title strong{font-size:13pt}table,th,td{font-size:8.5pt}th,td{padding:7px 5px}footer{font-size:8pt}}
`;

export function caseReportFilename(id: string): string {
  const safe = String(id ?? "").normalize("NFKC").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return `refunddesk-${safe || "unknown"}.html`;
}

/** Render only the allowlisted saved report. No network, executable content or raw JSON. */
export function renderCaseReport(report: CaseReport): string {
  const { case: value, order, triage, review, approval, attempt, ledger } = report;
  const unit = review.checkBasis === "approval" ? approval?.currency ?? "" : order?.currency ?? "";
  // Successful approval requires matching model/order currencies; without its snapshot the historical unit is unknown.
  const frozenModelUnit = approval?.check && approval.check.kind !== "blocked" ? approval.currency : "";
  const modelUnit = review.checkBasis === "approval" ? frozenModelUnit : review.proposal?.currency ?? "";
  const checkOrder = review.checkBasis === "approval" ? approval?.order ?? null : order;
  const ledgerUnit = order?.id === ledger?.orderId ? order?.currency ?? "" : "";
  const modeTitle = report.mode === "replay" ? "Replay demo — no money moves" : report.mode === "sandbox" ? "PAYPAL SANDBOX — NO PRODUCTION MONEY" : "ENVIRONMENT UNKNOWN";
  const modeText = report.mode === "replay"
    ? "Recorded sandbox IDs are retained; new replay refunds are simulations. Demo dates are shifted to keep the scenarios current."
    : "This file contains saved sandbox records. Exporting it does not query PayPal, reconcile an order, or submit a refund.";
  const basis = review.checkBasis === "approval" ? "Frozen approval check" : review.checkBasis === "current" ? "Current saved case check" : "Check unavailable";
  const amountTile = (label: string, amount: string, caption: string): string => `<div class="amount"><span>${escape(label)}</span><strong>${escape(amount)}</strong><small>${escape(caption)}</small></div>`;
  const overview = fields([
    ["Customer", text(value.sender)], ["Email", text(value.email)], ["Saved case status", text(value.status).replaceAll("_", " ")],
    ["Case created", date(value.createdAt)],
  ]) + (value.error ? `<p class="error">${escape(value.error)}</p>` : "") +
    `<article class="message"><h3>${escape(text(value.subject, "Customer message"))}</h3><p>${escape(value.message)}</p></article>` +
    (order ? `<h3>Matched order in this snapshot</h3>${fields([
      ["Order", order.id], ["PayPal order ID", order.paypalOrderId], ["Capture ID", order.captureId], ["Captured amount", money(order.capturedCents, order.currency)],
      ["Shipping", money(order.shippingCents, order.currency)], ["Ordered", date(order.orderedAt)], ["Promised delivery", date(order.promisedAt)], ["Recorded delivery", date(order.deliveredAt)],
    ])}${table(["Order item", "Quantity", "Unit price"], order.lines.map((line) => [
      `${line.title} (${line.id})${line.sale ? " · Sale item" : ""}`, count(line.quantity), money(line.unitCents, order.currency),
    ]), "No order lines recorded.")}` : note("No order is matched. Order balance and payment attribution are unavailable."));
  const triageSource = triage ? ({ live: "Live model response", fixture: "Recorded demo fixture — not a live model call", offline: "Offline keyword baseline — not a live model call", unavailable: "Provider unavailable — keyword fallback", manual: "Owner manual review — no model call" }[triage.source] ?? "Triage source unknown") : "No triage record saved";
  const original = `<p class="source">${escape(triageSource)}</p>` + (triage ? fields([
    ["Provider / model", `${text(triage.provider)} / ${text(triage.model)}`], ["Latency / attempts", `${count(triage.latencyMs)} ms / ${count(triage.attempts)}`],
    ["Allowance recorded at triage", historicalAmount(triage.calculatorAllowanceCents)],
  ]) + proposal(triage.proposal, order) + `<h4>Stored cited message spans</h4>${list(triage.evidenceSpans.map((span) =>
    value.message.includes(span) ? span : `${span} — not found verbatim in the saved message`))}` +
    `<h4>Recorded tool calls</h4>${table(["Tool", "Attempt", "Recorded summary"], triage.tools.map((tool) => [tool.name, count(tool.attempt), text(tool.summary)]), "No model tool calls recorded.")}`
    : note("No original model proposal or recorded tool evidence is available. A manual review can still be saved separately."));
  const reviewed = note("This is the saved review proposal, including any owner edits. It may differ from the original triage record above.") +
    proposal(review.proposal, order) + fields([["Order selection", review.manualOrder ? "Manually selected by owner" : "No manual selection recorded"], ["Duplicate override reason", text(review.duplicateOverride, "None recorded")]]) +
    `<h3>Owner-confirmed facts</h3>${facts(review.confirmedFacts, order)}${note("Owner confirmations are entered facts, not independent verification of damage, delivery or a warehouse return.")}` +
    `<h3>${escape(basis)}</h3>${review.checkBasis === "approval" ? note("These amounts and reasons were frozen for the approval. They are not a newly calculated remaining balance.") : note("The check describes this saved review state. Exporting does not approve it or refresh payment data.")}${check(review.check, unit, modelUnit, checkOrder)}`;
  const frozen = approval ? fields([
    ["Reviewed revision", count(approval.reviewedRevision)], ["Frozen approved amount", money(approval.amountCents, approval.currency)],
    ["Frozen order", approval.order.id], ["Frozen capture ID", approval.order.captureId], ["Captured amount in approval snapshot", money(approval.order.capturedCents, approval.order.currency)],
    ["Frozen clause IDs", approval.clauseIds.join(", ") || "None"], ["Frozen duplicate override", text(approval.duplicateOverride, "None recorded")],
  ]) + `<h4>Frozen allocations</h4>${allocations(approval.allocations, approval.currency, approval.order)}<h4>Facts frozen at approval</h4>${facts(approval.facts, approval.order)}<h4>Frozen policy check</h4>${check(approval.check, approval.currency, frozenModelUnit, approval.order)}`
    : note("No frozen approval record is available. A selected amount, a model proposal or a completed case status alone does not establish the approval details.");
  const request = attempt ? `<h3>Current refund request</h3>${fields([
    ["Attempt ID", attempt.id], ["Request ID", attempt.requestId], ["Request state", attempt.state], ["Current request started", date(attempt.createdAt)],
    ["Last saved attempt check", date(attempt.checkedAt)], ["Associated refund ID", text(attempt.refundId)],
  ])}${note("The request start is not an approval timestamp. A submitted, pending or uncertain request is not a completed refund.")}<h4>Recorded earlier requests</h4>${table(["Request ID", "Request started", "Retry reason"], attempt.priorRequests.map((prior) => [prior.requestId, date(prior.createdAt), text(prior.reason)]), "No earlier request IDs recorded.")}` : note("No current refund request is recorded.");
  const reconciliation = `<h3>Last saved order reconciliation</h3>${note("This is an order-wide saved reconciliation, which may include other cases. Exporting makes no PayPal query; these totals are not this case’s refund totals.")}` +
    (ledger ? fields([
      ["Order / capture", `${ledger.orderId} / ${ledger.captureId}`], ["Match at last saved check", ledger.match === true ? "Matched" : ledger.match === false ? "Mismatch" : "Unknown / unchecked"],
      ["Last saved check", date(ledger.checkedAt)], ["Remote captured amount recorded", money(ledger.remoteCapturedCents, ledgerUnit)],
      ["Remote refunded amount recorded", money(ledger.remoteRefundedCents, ledgerUnit)], ["Pending amount recorded", money(ledger.pendingCents, ledgerUnit)],
      ["Reconciliation error", text(ledger.error, "None recorded")], ["Unexpected receipt IDs", ledger.unexpectedRefundIds.join(", ") || "None recorded"],
    ]) : note("No reconciliation is saved for this order. Payment match, remote balance and last check time are unknown."));
  const policies = note("The text below is the application’s current policy text. Historical policy wording was not stored with the approval; matching clause IDs do not prove the wording was unchanged.") +
    (report.policies.length ? report.policies.map((policy) => `<article class="policy"><span class="policy-id">${escape(policy.id)}</span><p>${escape(text(policy.currentText, "Current policy text is unavailable for this clause."))}</p></article>`).join("") : note("No policy clauses are referenced in this report."));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(value.id)} — RefundDesk case review</title><style>${styles}</style></head>
<body><main><header><div class="brandline"><span class="brand">RefundDesk</span><span>Private owner review · contains customer information</span></div><h1>Case review record</h1><p class="subhead">A saved snapshot of the message, review and recorded payment evidence. This is not a complete case history.</p>${fields([["Case ID / current revision", `${value.id} / ${count(value.revision)}`], ["Snapshot exported", date(report.generatedAt)]])}</header>
<div class="origin${report.mode === "replay" ? " replay" : ""}"><strong>${escape(modeTitle)}</strong><p>${escape(modeText)}</p></div>
<div class="amounts">${amountTile("Original triage proposal", money(triage?.proposal.proposed_total, triage?.proposal.currency), triageSource)}${amountTile("Calculated allowance", money(review.check?.computedCents, unit), basis)}${amountTile(approval ? "Frozen approved amount" : "Selected review amount", !approval && review.selectedCents === null ? "Not selected" : money(approval?.amountCents ?? review.selectedCents, approval?.currency ?? unit), approval ? `Reviewed revision ${count(approval.reviewedRevision)} · payment status below` : "Selection alone does not mean approved or paid")}</div>
${section("01", "Message & matched order", overview)}${section("02", "Original triage record", original)}${section("03", "Saved owner review", reviewed)}${section("04", "Frozen approval & request", frozen + request)}${section("05", "Receipts & reconciliation", receipts(report) + reconciliation)}${section("06", "Policy reference", policies)}
<footer><p>Generated from saved RefundDesk data. No model call, refund submission or PayPal verification was made by this export.</p><p>This is not an append-only audit log or a signed certificate. No approver identity or approval timestamp is asserted. Customer facts are not independently verified. Receipt record times are not PayPal completion times. Keep this file private when it contains customer information.</p></footer></main></body></html>`;
}
