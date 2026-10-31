import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "../src/server/config.js";
import { Store } from "../src/server/db.js";
import { PayPalClient, type PayPalCapture, type PayPalRefund } from "../src/server/paypal.js";
import { DeskService } from "../src/server/service.js";
import { seededMessages } from "../src/server/fixtures.js";
import { seedTemplates, names, emailFor, EVAL_DATE, seedCatalog } from "../src/server/seed-book.js";
import { emptyFacts } from "../src/core/types.js";
import type { DemoSnapshot } from "../src/server/replay.js";
import { reconcile } from "../src/server/reconcile.js";
import { redactError } from "../src/server/errors.js";

const source = new Store(config.dbPath), clean = new Store(":memory:");
const paypal = new PayPalClient(config.paypalClientId, config.paypalClientSecret);
const service = new DeskService(clean, paypal, { aiMode: "offline" }, () => EVAL_DATE);
const money = (value: { currency_code: string; value: string }) => ({ currency_code: value.currency_code, value: value.value });
const capture = (value: PayPalCapture): PayPalCapture => ({ id: value.id, status: value.status, amount: money(value.amount) });
const receipt = (value: PayPalRefund): PayPalRefund => ({ id: value.id, status: value.status, amount: money(value.amount), ...(value.supplementary_data?.related_ids?.capture_id ? { supplementary_data: { related_ids: { capture_id: value.supplementary_data.related_ids.capture_id } } } : {}) });
try {
  seedCatalog(clean);
  const recorded: DemoSnapshot["recorded"] = { captures: [], orders: [], refunds: [] };
  for (const template of seedTemplates(EVAL_DATE)) {
    const local = source.getOrder(template.id);
    if (!local?.captureId || !local.paypalOrderId) throw new Error("Run npm run seed with live sandbox credentials first");
    const remoteCapture = await paypal.getCapture(local.captureId), remoteOrder = await paypal.getOrder(local.paypalOrderId);
    if (remoteCapture.id !== local.captureId || remoteOrder.id !== local.paypalOrderId || remoteCapture.amount.value !== (template.capturedCents / 100).toFixed(2)) throw new Error("Seed capture identity/amount mismatch");
    const order = { ...template, captureId: local.captureId, paypalOrderId: local.paypalOrderId };
    clean.saveOrder(order);
    const listed = remoteOrder.purchase_units?.filter((unit) => unit.payments?.captures?.some((c) => c.id === local.captureId)).flatMap((unit) => unit.payments?.refunds || []) || [];
    const refunds: PayPalRefund[] = [];
    for (const ref of listed) {
      const result = receipt(await paypal.getRefund(ref.id));
      refunds.push(result); recorded.refunds.push(result);
      const existing = source.listRefunds(local.id).find((item) => item.id === result.id);
      if (!existing) throw new Error("Unexpected sandbox refund: reconcile the seed before snapshotting");
      clean.saveRefund({ id: result.id, caseId: existing.caseId?.startsWith("case-seed-") ? existing.caseId : null,
        orderId: order.id, amountCents: existing.amountCents, currency: "USD", status: result.status,
        requestId: `recorded-${result.id}`, allocations: existing.allocations.map(({ item, cents }) => ({ item, cents })), createdAt: `${EVAL_DATE}T00:00:00Z` });
    }
    recorded.captures.push(capture(remoteCapture));
    recorded.orders.push({ id: remoteOrder.id, status: remoteOrder.status, purchase_units: [{ payments: { captures: [capture(remoteCapture)], refunds } }] });
    if (!(await reconcile(clean, paypal, order.id)).match) throw new Error("Seed did not reconcile exactly before snapshotting");
    console.log(`${template.id}: recorded sanitized sandbox responses`);
  }
  for (const [index, fixture] of seededMessages.entries()) {
    const input = service.createMessage({ sender: fixture.sender === null ? "Sam" : names[fixture.sender], email: fixture.sender === null ? "sam@unknown.example.test" : emailFor(fixture.sender), subject: fixture.subject, message: fixture.message });
    clean.db.prepare("DELETE FROM cases WHERE id=?").run(input.id);
    input.id = `case-seed-${String(index + 1).padStart(2, "0")}`;
    input.createdAt = new Date(Date.parse(EVAL_DATE) - (20 - index) * 3600000).toISOString();
    input.fixture = fixture.key;
    input.orderId = fixture.order ? `FC-${1000 + fixture.order}` : null;
    clean.saveCase(input);
    await service.triageCase(input.id);
    // These are explicit demo fixture confirmations, not model-promoted facts.
    if (["damage-all", "late-shipping", "received-return", "wrong-amount", "spanish", "very-late"].includes(fixture.key)) {
      const detail = service.detail(input.id);
      service.edit(input.id, { confirmedFacts: detail.proposedFacts });
    }
    const already = clean.listRefunds().filter((refund) => refund.caseId === input.id && refund.status === "COMPLETED");
    if (already.length) {
      const value = clean.getCase(input.id)!;
      value.status = "refunded"; value.approvedCents = already.reduce((sum, refund) => sum + refund.amountCents, 0);
      const approved = source.getCase(input.id)?.approvalCheck;
      if (approved) value.approvalCheck = { ...approved, reasons: ["Recorded owner-approved sandbox refund"] };
      clean.saveCase(value);
    }
  }
  const snapshot: DemoSnapshot = { version: 1, referenceDate: EVAL_DATE,
    provenance: "Allowlisted GET responses from a real PayPal sandbox seed. Names, emails, messages, dates and reviewed facts are synthetic demo fixtures. OAuth, headers, payer/card fields, addresses, credentials and API keys are excluded. New replay refunds are simulations.",
    orders: clean.listOrders(), cases: clean.listCases(), refunds: clean.listRefunds(),
    ledger: clean.listOrders().map((order) => clean.getLedger(order.id)!), recorded };
  mkdirSync("demo", { recursive: true });
  writeFileSync("demo/snapshot.json", JSON.stringify(snapshot, null, 2) + "\n");
  console.log("Snapshot written: 25 orders, demo cases, ledger and allowlisted sandbox receipts.");
} catch (error) { console.error(redactError(error)); process.exitCode = 1; }
finally { source.close(); clean.close(); }
