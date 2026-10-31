import assert from "node:assert/strict";
import { config } from "../src/server/config.js";
import type { DeskCase, LedgerRow } from "../src/core/types.js";

const base = `http://127.0.0.1:${config.port}/api`;
async function request(path: string, method = "GET") {
  const response = await fetch(`${base}${path}`, { method });
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}
const report = [];
for (const id of ["case-seed-01", "case-seed-02", "case-seed-03"]) {
  let value = (await request(`/cases/${id}`)) as DeskCase;
  if (value.status !== "refunded") {
    assert.notEqual(value.check?.kind, "blocked");
    value = (await request(`/cases/${id}/approve`, "POST")).case;
  }
  const row = (await request(
    `/orders/${value.orderId}/reconcile`,
    "POST",
  )) as LedgerRow;
  assert.equal(row.match, true);
  assert.equal(row.refundedCents, row.remoteRefundedCents);
  const refund = value.refunds?.find((refund) => refund.caseId === id);
  assert.ok(refund);
  report.push({
    caseId: id,
    orderId: value.orderId,
    captureId: row.captureId,
    refundId: refund.id,
    refundedCents: row.refundedCents,
    paypalStatus: row.paypalStatus,
    ledgerMatch: row.match,
  });
}
const duplicate = (await request("/cases/case-seed-04")) as DeskCase;
assert.equal(duplicate.check?.kind, "blocked");
const blocked = await fetch(`${base}/cases/case-seed-04/approve`, {
  method: "POST",
});
assert.equal(blocked.status, 409);
console.log(
  JSON.stringify(
    {
      passed: true,
      approvals: report,
      blockedDuplicate: {
        caseId: duplicate.id,
        status: blocked.status,
        reasons: duplicate.check?.reasons,
      },
    },
    null,
    2,
  ),
);
