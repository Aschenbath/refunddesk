import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "../src/server/config.js";
import {
  emptyFacts,
  type DeskCase,
  type LedgerRow,
} from "../src/core/types.js";

const base = `http://127.0.0.1:${config.port}/api`;
if (!config.ownerPassword)
  throw new Error(
    "Set OWNER_PASSWORD in the shell for the authenticated API session.",
  );
const signedIn = await fetch(`${base}/sign-in`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: config.ownerPassword }),
});
assert.equal(signedIn.status, 200);
const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
async function request(path: string, method = "GET", input?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}
const unauthenticated = await fetch(`${base}/cases/case-seed-01/approve`, {
  method: "POST",
  body: JSON.stringify({ revision: 1, approvedCents: 1 }),
});
assert.equal(unauthenticated.status, 401);
const report = [];
let staleStatus = 409;
for (const id of ["case-seed-01", "case-seed-02"]) {
  let value = (await request(`/cases/${id}`)) as DeskCase;
  if (value.status !== "refunded") {
    const old = {
      revision: value.revision,
      approvedCents: value.check!.approvedCents || 1,
    };
    // The seed starts with proposals only; this explicit owner action confirms the fixture facts.
    const facts =
      id === "case-seed-01"
        ? {
            ...emptyFacts(),
            damagedItems: value.order!.lines.map((line) => ({
              item: line.id,
              quantity: line.quantity,
            })),
            hasDamageEvidence: true,
          }
        : {
            ...emptyFacts(),
            deliveryDates: {
              promisedAt: value.order!.promisedAt,
              deliveredAt: value.order!.deliveredAt,
            },
          };
    value = await request(`/cases/${id}`, "PATCH", { confirmedFacts: facts });
    const stale = await fetch(`${base}/cases/${id}/approve`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(old),
    });
    staleStatus = stale.status;
    assert.equal(staleStatus, 409);
    assert.notEqual(value.check!.kind, "blocked");
    value = (
      await request(`/cases/${id}/approve`, "POST", {
        revision: value.revision,
        approvedCents: value.check!.approvedCents,
      })
    ).case;
  }
  const row = (await request(
    `/orders/${value.orderId}/reconcile`,
    "POST",
  )) as LedgerRow;
  assert.equal(row.match, true);
  const refund = value.refunds!.find((refund) => refund.caseId === id)!;
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
const rows = (await request("/reconcile", "POST")) as LedgerRow[];
assert.equal(
  rows.every((row) => row.match === true),
  true,
  JSON.stringify(rows.filter((row) => !row.match)),
);
const duplicate = (await request("/cases/case-seed-04")) as DeskCase;
assert.equal(duplicate.check!.kind, "blocked");
const blocked = await fetch(`${base}/cases/case-seed-04/approve`, {
  method: "POST",
  headers: { Cookie: cookie },
  body: JSON.stringify({ revision: duplicate.revision, approvedCents: 1 }),
});
assert.equal(blocked.status, 409);
const result = {
  passed: true,
  signInStatus: signedIn.status,
  unauthenticatedApprovalStatus: unauthenticated.status,
  staleRevisionStatus: staleStatus,
  approvals: report,
  reconciledOrders: rows.length,
  allRowsMatch: true,
  blockedDuplicateStatus: blocked.status,
};
mkdirSync("output", { recursive: true });
writeFileSync("output/api-session.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
