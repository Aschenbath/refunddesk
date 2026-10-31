import { useEffect, useRef, useState } from "react";
import type { DeskCase, Order } from "../core/types.js";
import { policies } from "../core/policies.js";
import { money, parseAmount } from "./api.js";
import { Chip } from "./Grid.js";

function Message({ text, spans }: { text: string; spans: string[] }) {
  const valid = [...new Set(spans)]
    .filter((span) => span && text.toLowerCase().includes(span.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  if (!valid.length) return <>{text}</>;
  const escaped = valid.map((span) =>
    span.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const parts = text.split(new RegExp(`(${escaped.join("|")})`, "gi"));
  return (
    <>
      {parts.map((part, index) =>
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
  onClose,
  onEdit,
  onAction,
}: {
  value: DeskCase;
  orders: Order[];
  busy: boolean;
  onClose: () => void;
  onEdit: (changes: Record<string, unknown>) => Promise<boolean>;
  onAction: (action: string) => void;
}) {
  const [amount, setAmount] = useState("");
  const [reply, setReply] = useState("");
  const [copied, setCopied] = useState(false);
  const [override, setOverride] = useState("");
  const [showFacts, setShowFacts] = useState(false);
  const [orderQuery, setOrderQuery] = useState("");
  const [formError, setFormError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    setAmount(value.check ? (value.check.approvedCents / 100).toFixed(2) : "");
    setReply(value.replyDraft);
    setOverride(value.duplicateOverride || "");
    setCopied(false);
    setFormError("");
  }, [value]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
        );
        const first = focusable?.[0];
        const last = focusable?.[focusable.length - 1];
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
  const locked = ["refunded", "rejected", "processing", "failed"].includes(
    value.status,
  );
  const amountCents = parseAmount(amount);
  const changed = amountCents !== value.check?.approvedCents;
  const matchingOrders = orders.filter((order) =>
    `${order.id} ${order.customerName} ${order.email}`
      .toLowerCase()
      .includes(orderQuery.toLowerCase()),
  );
  const saveAmount = async () => {
    if (amountCents === null) {
      setFormError("Enter a positive amount with at most two decimal places.");
      return false;
    }
    return onEdit({ approvedCents: amountCents });
  };
  const approve = async () => {
    if (changed && !(await saveAmount())) return;
    onAction("approve");
  };
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
            <span className="eyebrow">Case review</span>
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
            <span>
              {value.orderId || "Order not matched"} ·{" "}
              {new Date(value.createdAt).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          </div>
          {value.error && <div className="notice blocked">{value.error}</div>}
          {value.status === "refunded" && (
            <div className="success-receipt">
              <span className="success-icon">✓</span>
              <div>
                <strong>Refund recorded with PayPal</strong>
                {value.refunds
                  ?.filter((refund) => refund.caseId === value.id)
                  .map((refund) => (
                    <p key={refund.id}>
                      {money(refund.amountCents)} ·{" "}
                      {refund.status.toLowerCase()}
                      <code>{refund.id}</code>
                    </p>
                  ))}
                <small>The ledger shows the latest reconciliation.</small>
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
                spans={value.proposal?.match_evidence || []}
              />
            </div>
          </section>
          {!value.proposal ? (
            <div className="notice pending">
              <strong>Ready for a first look.</strong>
              <p>
                Triage this message to match an order, choose a policy, and
                draft a reply.
              </p>
              <button
                className="button primary"
                disabled={busy || locked}
                onClick={() => onAction("triage")}
              >
                Triage this case
              </button>
            </div>
          ) : (
            <>
              <section>
                <div className="section-label">
                  Matched order{" "}
                  <button
                    className="text-button"
                    disabled={locked}
                    onClick={() => setShowFacts(!showFacts)}
                  >
                    {showFacts ? "Close review" : "Review match & facts"}
                  </button>
                </div>
                {value.order ? (
                  <>
                    <div className="order-summary">
                      <strong>{value.order.id}</strong>
                      <span>
                        {money(value.order.capturedCents, value.order.currency)}{" "}
                        captured
                      </span>
                    </div>
                    <div className="order-lines">
                      {value.order.lines.map((line) => (
                        <div key={line.id}>
                          <div>
                            <strong>{line.title}</strong>
                            <small>
                              Qty {line.quantity}
                              {line.sale ? " · Sale item" : ""}
                              {line.returnReceived ? " · Return received" : ""}
                            </small>
                          </div>
                          <span>{money(line.unitCents * line.quantity)}</span>
                        </div>
                      ))}
                      <div>
                        <span>Shipping</span>
                        <span>{money(value.order.shippingCents)}</span>
                      </div>
                    </div>
                    <p className="date-line">
                      Promised {value.order.promisedAt} · Delivered{" "}
                      {value.order.deliveredAt}
                    </p>
                    <code className="capture-line">
                      Capture {value.order.captureId}
                    </code>
                  </>
                ) : (
                  <div className="notice blocked">
                    No verified order. Pick the right order to continue.
                  </div>
                )}
                {(showFacts ||
                  !value.order ||
                  value.proposal.needs_human_reason) && (
                  <div className="fact-editor">
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
                        value={value.orderId || ""}
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
                            {money(order.capturedCents)}
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
                        onChange={(event) => {
                          const family = event.target.value;
                          void onEdit({
                            clauseIds:
                              family === "P1"
                                ? ["P1.1"]
                                : family === "P2"
                                  ? ["P2.1"]
                                  : ["P3.1"],
                          });
                        }}
                      >
                        <option value="">Choose policy…</option>
                        <option value="P1">Damaged in transit</option>
                        <option value="P2">Late delivery</option>
                        <option value="P3">Change of mind</option>
                      </select>
                    </label>
                    {value.proposal.policy_clause_ids.some((id) =>
                      id.startsWith("P1"),
                    ) && (
                      <>
                        <label className="check-label">
                          <input
                            type="checkbox"
                            disabled={busy || locked}
                            checked={value.facts.hasDamageEvidence}
                            onChange={(event) =>
                              void onEdit({
                                hasDamageEvidence: event.target.checked,
                              })
                            }
                          />{" "}
                          Photo or clear damage description verified
                        </label>
                        {value.order?.lines.map((line) => (
                          <label key={line.id} className="check-label">
                            <input
                              type="checkbox"
                              disabled={busy || locked}
                              checked={value.facts.damagedLineIds.includes(
                                line.id,
                              )}
                              onChange={(event) =>
                                void onEdit({
                                  damagedLineIds: event.target.checked
                                    ? [...value.facts.damagedLineIds, line.id]
                                    : value.facts.damagedLineIds.filter(
                                        (id) => id !== line.id,
                                      ),
                                })
                              }
                            />
                            {line.title} arrived damaged (all units)
                          </label>
                        ))}
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
                          Include shipping when every item is damaged
                        </label>
                      </>
                    )}
                    {value.proposal.policy_clause_ids.some((id) =>
                      id.startsWith("P2"),
                    ) && (
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
                        Include 15% item refund for more than 20 business days
                        late
                      </label>
                    )}
                    {value.proposal.policy_clause_ids.some((id) =>
                      id.startsWith("P3"),
                    ) &&
                      value.order?.lines.map((line) => (
                        <label key={line.id} className="check-label">
                          <input
                            type="checkbox"
                            disabled={busy || locked}
                            checked={line.returnReceived}
                            onChange={(event) =>
                              void onEdit({
                                returnReceivedLineIds: value
                                  .order!.lines.filter((item) =>
                                    item.id === line.id
                                      ? event.target.checked
                                      : item.returnReceived,
                                  )
                                  .map((item) => item.id),
                              })
                            }
                          />
                          {line.title} return received
                        </label>
                      ))}
                  </div>
                )}
              </section>
              <section>
                <div className="section-label">
                  Policy check <Chip kind={value.check?.kind || "pending"} />
                </div>
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
                <div className="clauses">
                  {value.proposal.policy_clause_ids.map((id) => (
                    <p key={id}>
                      <strong>{id}</strong>
                      {policies.find((policy) => policy.id === id)?.text ||
                        "Unknown policy clause"}
                    </p>
                  ))}
                </div>
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
                          placeholder="Explain why this is a separate eligible refund"
                        />
                      </label>
                      <button
                        className="button secondary"
                        disabled={busy || override.trim().length < 8}
                        onClick={() =>
                          void onEdit({ duplicateOverride: override })
                        }
                      >
                        Record human override
                      </button>
                    </div>
                  )}
              </section>
              <section>
                <div className="section-label">
                  Amount review <span>{value.order?.currency || "USD"}</span>
                </div>
                <div className="amount-compare">
                  <div>
                    <span>AI proposed</span>
                    <strong>{money(value.check?.modelCents)}</strong>
                  </div>
                  <div>
                    <span>Policy allowance</span>
                    <strong>{money(value.check?.computedCents)}</strong>
                  </div>
                  <div>
                    <span>Refundable balance</span>
                    <strong>{money(value.check?.remainderCents)}</strong>
                  </div>
                </div>
                <label className="amount-input">
                  Amount to approve
                  <div>
                    <span>$</span>
                    <input
                      aria-label="Amount to approve"
                      inputMode="decimal"
                      value={amount}
                      disabled={locked || busy}
                      onChange={(event) => {
                        setAmount(event.target.value);
                        setFormError("");
                      }}
                    />
                    <span>USD</span>
                  </div>
                </label>
                {formError && <p className="field-error">{formError}</p>}
                <small className="helper">
                  You can reduce the amount within the policy allowance. Every
                  edit is checked.
                </small>
              </section>
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
                  onChange={(event) => setReply(event.target.value)}
                  rows={5}
                />
                <div className="reply-actions">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(reply);
                        setCopied(true);
                        if (reply !== value.replyDraft)
                          await onEdit({ replyDraft: reply });
                      } catch {
                        setFormError(
                          "Clipboard unavailable. Select and copy the reply text.",
                        );
                      }
                    }}
                  >
                    {" "}
                    {copied ? "✓ Copied" : "Copy reply"}
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
          ) : value.status === "rejected" ? (
            <p>This case was rejected. No payment was made.</p>
          ) : (
            <>
              <button
                className="button secondary"
                disabled={
                  busy ||
                  value.status === "processing" ||
                  value.status === "failed"
                }
                onClick={() => onAction("reject")}
              >
                Reject
              </button>
              <button
                className="button primary"
                disabled={
                  busy ||
                  value.status === "processing" ||
                  (value.status !== "failed" &&
                    (!value.check ||
                      value.check.kind === "blocked" ||
                      amountCents === null ||
                      amountCents > value.check.computedCents))
                }
                onClick={() =>
                  value.status === "failed"
                    ? onAction("approve")
                    : void approve()
                }
              >
                {busy ? (
                  <>
                    <span className="spinner" />
                    Working…
                  </>
                ) : value.status === "failed" ? (
                  "Retry locked refund"
                ) : (
                  `Approve ${money(amountCents)}`
                )}
              </button>
            </>
          )}
          <small>Human approval · PayPal sandbox</small>
        </footer>
      </aside>
    </>
  );
}
