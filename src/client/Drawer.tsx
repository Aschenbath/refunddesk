import { useEffect, useRef, useState } from "react";
import type { DeskCase, Order } from "../core/types.js";
import type { CaseReport } from "../core/case-report.js";
import { policies } from "../core/policies.js";
import { api, money, parseAmount } from "./api.js";
import { Chip } from "./Chip.js";
import { FactConfirmation } from "./FactConfirmation.js";
import { caseApprovedCurrency, caseCheckCurrency, caseModelCurrency } from "./money-state.js";

function Message({ text, spans }: { text: string; spans: string[] }) {
  const valid = [...new Set(spans)]
    .filter((span) => span && text.toLowerCase().includes(span.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  if (!valid.length) return <>{text}</>;
  const escaped = valid.map((span) =>
    span.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return (
    <>
      {text
        .split(new RegExp(`(${escaped.join("|")})`, "gi"))
        .map((part, index) =>
          valid.some((span) => span.toLowerCase() === part.toLowerCase()) ? (
            <mark key={index}>{part}</mark>
          ) : (
            part
          ),
        )}
    </>
  );
}
export function Drawer({
  value,
  orders,
  busy,
  demoMode,
  onClose,
  onEdit,
  onAction,
}: {
  value: DeskCase;
  orders: Order[];
  busy: boolean;
  demoMode: string;
  onClose: () => void;
  onEdit: (changes: Record<string, unknown>) => Promise<boolean>;
  onAction: (action: string, body?: unknown) => void;
}) {
  const [amount, setAmount] = useState("");
  const [replyDraft, setReplyDraft] = useState<{ caseId: string; text: string } | null>(null);
  const reply = replyDraft?.caseId === value.id ? replyDraft.text : value.replyDraft;
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [factsPending, setFactsPending] = useState(false);
  const [override, setOverride] = useState("");
  const [showMatch, setShowMatch] = useState(false);
  const [orderQuery, setOrderQuery] = useState("");
  const [formError, setFormError] = useState("");
  const [retryReason, setRetryReason] = useState("");
  const [retryConfirmed, setRetryConfirmed] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [reportError, setReportError] = useState("");
  const exportingRef = useRef(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    setAmount(value.check ? (value.check.approvedCents / 100).toFixed(2) : "");
    setOverride(value.duplicateOverride || "");
    setFormError("");
    setReportError("");
    setRetryConfirmed(false);
  }, [value]);
  useEffect(() => {
    // A successful save only consumes the exact draft that reached the server.
    // Typing during that request and unrelated case refreshes keep the newer text.
    if (!busy) setReplyDraft((draft) => draft?.caseId === value.id && draft.text === value.replyDraft ? null : draft);
  }, [value.id, value.replyDraft, busy]);
  useEffect(() => { setFactsPending(false); setCopiedText(null); }, [value.id, value.orderId]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
        );
        const first = focusable?.[0],
          last = focusable?.[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handle);
    return () => {
      document.removeEventListener("keydown", handle);
      previous?.focus();
    };
  }, [onClose]);
  const locked =
    !!value.attempt ||
    ["refunded", "rejected", "processing", "pending"].includes(value.status);
  const amountCents = parseAmount(amount);
  const checkCurrency = caseCheckCurrency(value);
  const approvedCurrency = caseApprovedCurrency(value);
  const replay = demoMode === "replay";
  const exportReport = async () => {
    if (busy || exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    setReportError("");
    try {
      const report = await api<CaseReport>(`/cases/${encodeURIComponent(value.id)}/report`);
      const { renderCaseReport, caseReportFilename } = await import("./case-report.js");
      const url = URL.createObjectURL(new Blob([renderCaseReport(report)], { type: "text/html;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = caseReportFilename(report.case.id);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setReportError(error instanceof Error ? error.message : "Could not export this case. Please try again.");
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  };
  const changed = amountCents !== value.check?.approvedCents;
  const matchingOrders = (value.candidates || []).filter((order) =>
    `${order.id} ${order.customerName} ${order.email}`
      .toLowerCase()
      .includes(orderQuery.toLowerCase()),
  );
  return (
    <>
      <div className="drawer-shade" onClick={onClose} />
      <aside
        ref={drawerRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="case-title"
      >
        <header className="drawer-header">
          <div>
            <span className="eyebrow">
              Case review · revision {value.revision}
            </span>
            <h2 id="case-title">{value.sender}</h2>
            <small>{value.email}</small>
          </div>
          <button
            ref={closeRef}
            className="icon-button"
            aria-label="Close case"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="drawer-body">
          <div className="drawer-status">
            <Chip kind={value.status}>
              {value.status === "needs_human" ? "Needs review" : value.status}
            </Chip>
            <span>{value.orderId || "Order not matched"}</span>
          </div>
          <div className="case-report-action">
            <button className="button secondary" disabled={busy || exporting} onClick={() => void exportReport()}>
              {exporting ? "Preparing report…" : "Export case report"}
            </button>
            <small>Downloads saved data, including customer details. Unsaved edits are excluded.</small>
          </div>
          {reportError && <p className="field-error" role="alert">{reportError}</p>}
          {value.error && <div className="notice blocked">{value.error}</div>}
          {["refunded", "pending"].includes(value.status) && (
            <div className="success-receipt">
              <span className="success-icon">
                {value.status === "pending" ? "◷" : "✓"}
              </span>
              <div>
                <strong>
                  {replay
                    ? value.status === "pending" ? "Replay refund pending" : "Refund recorded in replay"
                    : value.status === "pending" ? "PayPal refund pending" : "Refund completed with PayPal"}
                </strong>
                {value.refunds
                  ?.filter((refund) => refund.caseId === value.id && refund.orderId === value.orderId)
                  .map((refund) => (
                    <p key={refund.id}>
                      {money(refund.amountCents, refund.currency)} ·{" "}
                      {refund.status.toLowerCase()}
                      <code>{refund.id}</code>
                      {replay && <small>{refund.id.startsWith("REPLAY-") ? "Simulated replay receipt" : "Recorded sandbox receipt"}</small>}
                    </p>
                  ))}
                <small>{replay ? "Replay records only. New refunds are simulated." : "The ledger shows the latest reconciliation."}</small>
              </div>
            </div>
          )}
          <section>
            <div className="section-label">
              Customer message <span>Match evidence highlighted</span>
            </div>
            <h3 className="subject">{value.subject}</h3>
            <div className="message">
              <Message
                text={value.message}
                spans={value.triageTrace?.evidenceSpans || value.proposal?.match_evidence || []}
              />
            </div>
          </section>
          {value.triageTrace && <details className="ai-trace">
            <summary>How the AI got here</summary>
            <p className="trace-model">{value.triageTrace.source === "live" ? `${value.triageTrace.provider} · ${value.triageTrace.model}` : value.triageTrace.source === "manual" ? "Owner manual review" : value.triageTrace.source === "unavailable" ? "Provider unavailable — keyword fallback" : "Demo fixture, not a live model call"}</p>
            <p className="helper">{value.triageTrace.model} · {value.triageTrace.latencyMs} ms · {value.triageTrace.attempts} attempts</p>
            {value.triageTrace.toolCalls.length ? <ol className="trace-tools">{value.triageTrace.toolCalls.map((call, index) => <li key={index}><strong>{call.name}</strong><span>Attempt {call.attempt}</span><code>{JSON.stringify(call.arguments)}</code><p>{call.summary}</p></li>)}</ol> : <p className="helper">No model tool calls were made.</p>}
            <div className="amount-compare"><div><span>Model proposal</span><strong>{money(value.triageTrace.proposal.proposed_total, value.triageTrace.proposal.currency)}</strong></div><div><span>Proposed-facts allowance</span><strong>{value.triageTrace.calculatorAllowanceCents != null ? money(value.triageTrace.calculatorAllowanceCents, null) : money(value.proposedCheck?.computedCents, value.order?.currency ?? null)}</strong></div></div>
            <p className="helper">{value.triageTrace.evidenceSpans.length ? `Cited message spans: ${value.triageTrace.evidenceSpans.map((span) => `“${span}”`).join(", ")}` : "No verbatim message spans cited."} Owner-confirmed facts set the final allowance.</p>
          </details>}
          {!value.proposal ? (
            <div className="notice pending">
              <strong>Ready for a first look.</strong>
              <p>Match an order, choose a policy, and prepare a reply.</p>
              <button
                className="button primary"
                disabled={busy || locked}
                onClick={() => onAction("triage")}
              >
                Triage this case
              </button>
              <button className="button secondary" disabled={busy || locked} onClick={() => { setShowMatch(true); void onEdit({ intent: "refund" }); }}>Review manually</button>
            </div>
          ) : (
            <>
              <section>
                <div className="section-label">
                  Matched order{" "}
                  <button
                    className="text-button"
                    disabled={locked}
                    onClick={() => setShowMatch(!showMatch)}
                  >
                    {showMatch ? "Close review" : "Review match & policy"}
                  </button>
                </div>
                {value.order ? (
                  <>
                    <div className="order-summary">
                      <strong>{value.order.id}</strong>
                      <span>{money(value.order.capturedCents, value.order.currency)} captured</span>
                    </div>
                    <div className="order-lines">
                      {value.order.lines.map((line) => (
                        <div key={line.id}>
                          <div>
                            <strong>{line.title}</strong>
                            <small>
                              Qty {line.quantity}
                              {line.sale ? " · Sale item" : ""}
                            </small>
                          </div>
                          <span>{money(line.unitCents * line.quantity, value.order!.currency)}</span>
                        </div>
                      ))}
                      <div>
                        <span>Shipping</span>
                        <span>{money(value.order.shippingCents, value.order.currency)}</span>
                      </div>
                    </div>
                    <code className="capture-line">
                      Capture {value.order.captureId}
                    </code>
                  </>
                ) : (
                  <div className="notice blocked">
                    Pick the right order to continue.
                  </div>
                )}
                {(showMatch || !value.order || value.ambiguous || value.error) && (
                  <div className="fact-editor">
                    <label>Intent<select aria-label="Case intent" disabled={busy || locked} value={value.proposal.intent} onChange={(event) => void onEdit({ intent: event.target.value })}>
                      <option value="refund">Refund</option><option value="exchange">Exchange</option><option value="question">Question</option><option value="other">Other</option>
                    </select></label>
                    {value.ambiguous && (
                      <div className="notice blocked">
                        Conflicting references or customer identity. A human
                        must choose the order.
                      </div>
                    )}
                    <label>
                      Find an order
                      <input
                        value={orderQuery}
                        onChange={(event) => setOrderQuery(event.target.value)}
                        placeholder="Order number, name or email"
                      />
                    </label>
                    <label>
                      Choose verified order
                      <select
                        value={value.manualOrder ? value.orderId || "" : ""}
                        disabled={busy || locked}
                        onChange={(event) =>
                          event.target.value &&
                          void onEdit({ orderId: event.target.value })
                        }
                      >
                        <option value="">Select an order…</option>
                        {matchingOrders.map((order) => (
                          <option key={order.id} value={order.id}>
                            {order.id} · {order.customerName} ·{" "}
                            {money(order.capturedCents, order.currency)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Apply policy
                      <select
                        value={
                          value.proposal.policy_clause_ids[0]?.slice(0, 2) || ""
                        }
                        disabled={busy || locked}
                        onChange={(event) =>
                          void onEdit({
                            clauseIds: [
                              event.target.value === "P1"
                                ? "P1.1"
                                : event.target.value === "P2"
                                  ? "P2.1"
                                  : "P3.1",
                            ],
                          })
                        }
                      >
                        <option value="">Choose policy…</option>
                        <option value="P1">Damaged in transit</option>
                        <option value="P2">Late delivery</option>
                        <option value="P3">Change of mind</option>
                      </select>
                    </label>
                    {value.proposal.policy_clause_ids.includes("P1.1") && (
                      <label className="check-label">
                        <input
                          type="checkbox"
                          disabled={busy || locked}
                          checked={value.proposal.policy_clause_ids.includes(
                            "P1.2",
                          )}
                          onChange={(event) =>
                            void onEdit({
                              clauseIds: event.target.checked
                                ? ["P1.1", "P1.2"]
                                : ["P1.1"],
                            })
                          }
                        />
                        Include shipping when every unit is damaged
                      </label>
                    )}
                    {value.proposal.policy_clause_ids.includes("P2.1") && (
                      <label className="check-label">
                        <input
                          type="checkbox"
                          disabled={busy || locked}
                          checked={value.proposal.policy_clause_ids.includes(
                            "P2.2",
                          )}
                          onChange={(event) =>
                            void onEdit({
                              clauseIds: event.target.checked
                                ? ["P2.1", "P2.2"]
                                : ["P2.1"],
                            })
                          }
                        />
                        Include 15% item refund after 20 business days
                      </label>
                    )}
                    <details className="manual-clauses"><summary>Review individual clauses</summary>{policies.map((policy) => <label key={policy.id} className="check-label"><input type="checkbox" disabled={busy || locked} checked={value.proposal!.policy_clause_ids.includes(policy.id)} onChange={(event) => void onEdit({ clauseIds: event.target.checked ? [...value.proposal!.policy_clause_ids, policy.id] : value.proposal!.policy_clause_ids.filter((id) => id !== policy.id) })} />{policy.id} · {policy.text}</label>)}</details>
                  </div>
                )}
              </section>
              {value.order && (
                <FactConfirmation
                  value={value}
                  disabled={busy || locked}
                  onEdit={onEdit}
                  onPendingChange={setFactsPending}
                />
              )}
              <section>
                <div className="section-label">
                  Policy check {factsPending ? <Chip kind="pending">Unsaved dates</Chip> : <Chip kind={value.check?.kind || "pending"} />}
                </div>
                {factsPending && <p className="helper">Amounts below use the last saved facts. Confirm the edited dates to update them before approving.</p>}
                {value.check?.reasons.length ? (
                  <div className={`notice ${value.check.kind}`}>
                    <ul>
                      {value.check.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="policy-pass">
                    ✓ Within the policy and refundable balance.
                  </p>
                )}
                <div className="clauses">
                  {value.proposal.policy_clause_ids.map((id) => (
                    <p key={id}>
                      <strong>{id}</strong>
                      {policies.find((policy) => policy.id === id)?.text ||
                        "Unknown policy clause"}
                    </p>
                  ))}
                </div>
                {value.duplicateOverride && (
                  <div className="notice adjusted">
                    <strong>Human duplicate override</strong>
                    <p>{value.duplicateOverride}</p>
                    {!locked && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => void onEdit({ duplicateOverride: null })}
                      >
                        Remove override
                      </button>
                    )}
                  </div>
                )}
                {value.check?.reasons.some((reason) =>
                  reason.includes("override"),
                ) &&
                  !locked && (
                    <div className="override-box">
                      <label>
                        Reason for duplicate override
                        <input
                          value={override}
                          onChange={(event) => setOverride(event.target.value)}
                        />
                      </label>
                      <button
                        className="button secondary"
                        disabled={busy || override.trim().length < 8}
                        onClick={() =>
                          void onEdit({ duplicateOverride: override.trim() })
                        }
                      >
                        Record human override
                      </button>
                    </div>
                  )}
              </section>
              <section>
                <div className="section-label">
                  Refund amount <span>Integer cents · {checkCurrency || "Currency unknown"}</span>
                </div>
                <div className="amount-compare">
                  <div>
                    <span>AI proposal</span>
                    <strong>{money(value.check?.modelCents, caseModelCurrency(value))}</strong>
                  </div>
                  <div>
                    <span>{factsPending ? "Last saved allowance" : "Confirmed allowance"}</span>
                    <strong>{money(value.check?.computedCents, checkCurrency)}</strong>
                  </div>
                  <div>
                    <span>Refundable balance</span>
                    <strong>{money(value.check?.remainderCents, checkCurrency)}</strong>
                  </div>
                </div>
                <label className="amount-input">
                  Approved amount
                  <div>
                    {approvedCurrency === "USD" && <span>$</span>}
                    <input
                      aria-label="Approved amount"
                      value={amount}
                      disabled={busy || locked}
                      onChange={(event) => setAmount(event.target.value)}
                    />
                    <span>{approvedCurrency || "Unknown"}</span>
                  </div>
                </label>
                {changed && !locked && (
                  <>
                    <small className="helper">
                      Save the amount, then review the updated case before
                      approving.
                    </small>
                    <button
                      className="button secondary"
                      disabled={busy || amountCents === null}
                      onClick={() =>
                        amountCents !== null &&
                        void onEdit({ approvedCents: amountCents })
                      }
                    >
                      Save amount
                    </button>
                  </>
                )}
                {formError && <p className="field-error">{formError}</p>}
              </section>
              {value.attempt && value.status !== "refunded" && (
                <section className="override-box">
                  <div className="section-label">
                    PayPal recovery <span>{value.attempt.state}</span>
                  </div>
                  <p className="helper">
                    Check the existing attempt’s receipt before retrying. The
                    amount and facts remain frozen.
                  </p>
                  <button
                    className="button secondary"
                    disabled={busy || value.status === "processing"}
                    onClick={() => onAction("check-paypal")}
                  >
                    Check PayPal
                  </button>
                  {value.attempt.retryOriginalAllowed && (
                    <>
                      <p className="helper">Within the retry window, reuse the original request ID and frozen amount. This does not create a new refund request ID.</p>
                      <button
                        className="button secondary"
                        disabled={busy || value.status === "processing"}
                        onClick={() => onAction("approve", { revision: value.revision, approvedCents: value.attempt!.amountCents })}
                      >
                        Retry original request
                      </button>
                    </>
                  )}
                  {value.attempt.retryAllowed && (
                    <>
                      <div className="notice blocked">
                        A new request id can create a duplicate refund if
                        PayPal’s earlier result arrives late. Only retry after
                        investigating the missing receipt.
                      </div>
                      <label>
                        Reason for retry
                        <input
                          value={retryReason}
                          onChange={(event) =>
                            setRetryReason(event.target.value)
                          }
                        />
                      </label>
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={retryConfirmed}
                          onChange={(event) =>
                            setRetryConfirmed(event.target.checked)
                          }
                        />
                        I confirm the duplicate-refund risk and checked PayPal
                      </label>
                      <button
                        className="button secondary"
                        disabled={
                          busy ||
                          !retryConfirmed ||
                          retryReason.trim().length < 8
                        }
                        onClick={() =>
                          onAction("retry-new-id", {
                            confirmed: true,
                            reason: retryReason.trim(),
                            revision: value.revision,
                          })
                        }
                      >
                        Retry with a new request id
                      </button>
                    </>
                  )}
                </section>
              )}
              <section>
                <div className="section-label">
                  Customer reply{" "}
                  <span>
                    {value.replySent ? "Marked sent" : "Draft · not sent"}
                  </span>
                </div>
                <textarea
                  aria-label="Customer reply draft"
                  value={reply}
                  onChange={(event) => {
                    const text = event.target.value;
                    setReplyDraft({ caseId: value.id, text });
                    setCopiedText(null);
                  }}
                  rows={5}
                />
                <div className="reply-actions">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(reply);
                        setCopiedText(reply);
                        if (reply !== value.replyDraft)
                          await onEdit({ replyDraft: reply });
                      } catch {
                        setFormError(
                          "Clipboard unavailable. Select and copy the reply text.",
                        );
                      }
                    }}
                  >
                    {copiedText === reply ? "✓ Copied" : "Copy reply"}
                  </button>
                  {reply !== value.replyDraft && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => void onEdit({ replyDraft: reply })}
                    >
                      Save draft
                    </button>
                  )}
                  <button
                    className="text-button"
                    disabled={busy || value.replySent}
                    onClick={() =>
                      void onEdit({ replyDraft: reply, replySent: true })
                    }
                  >
                    {value.replySent ? "✓ Marked sent" : "Mark as sent"}
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
        <footer className="drawer-footer">
          {value.status === "refunded" ? (
            <button className="button primary full" onClick={onClose}>
              Done · back to queue
            </button>
          ) : locked ? (
            <p>
              {value.status === "pending"
                ? replay ? "Replay records show this refund as pending." : "Waiting for PayPal to complete this refund."
                : value.status === "rejected"
                  ? "This case was rejected. No payment was made."
                  : "Refund locked. Use Check PayPal to resolve its outcome."}
            </p>
          ) : (
            <>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => onAction("reject")}
              >
                Reject
              </button>
              <button
                className="button primary"
                disabled={
                  busy ||
                  factsPending ||
                  changed ||
                  !value.check ||
                  value.check.kind === "blocked" ||
                  amountCents === null
                }
                onClick={() =>
                  onAction("approve", {
                    revision: value.revision,
                    approvedCents: value.check!.approvedCents,
                  })
                }
              >
                {busy ? "Working…" : `Approve ${money(amountCents, approvedCurrency)}`}
              </button>
            </>
          )}
          <small>{replay ? "Human approval · Replay simulation · No money moves" : "Human approval · PayPal sandbox"}</small>
        </footer>
      </aside>
    </>
  );
}
