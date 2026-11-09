import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { DeskCase, LedgerRow, Order } from "../core/types.js";
import { api, ApiError } from "./api.js";
import { formatMoneyTotals, sumMoney } from "./money-state.js";
import { triageBatchCase, type BatchAction, type BatchReport } from "./review-batch.js";
const QueueGrid = lazy(() => import("./Grid.js").then((module) => ({ default: module.QueueGrid })));
const LedgerGrid = lazy(() => import("./Grid.js").then((module) => ({ default: module.LedgerGrid })));
import { Drawer } from "./Drawer.js";

function Leaf() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M7 24C4 11 14 5 26 5c0 12-6 22-18 19"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M5 28 22 10M12 21l-1-7m6 2 6 1"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}
export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [view, setView] = useState<"queue" | "ledger" | "inbox">("queue");
  const [cases, setCases] = useState<DeskCase[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const initializing = useRef(false);
  const [batchReport, setBatchReport] = useState<BatchReport | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [demoMode, setDemoMode] = useState("");
  const [form, setForm] = useState({
    sender: "",
    email: "",
    subject: "",
    message: "",
  });
  const [importText, setImportText] = useState("");
  const [importMode, setImportMode] = useState(false);
  const [aiMode, setAiMode] = useState("offline");
  const refresh = useCallback(async () => {
    const [nextCases, nextLedger, nextOrders] = await Promise.all([
      api<DeskCase[]>("/cases"),
      api<LedgerRow[]>("/ledger"),
      api<Order[]>("/orders"),
    ]);
    setCases(nextCases);
    setLedger(nextLedger);
    setOrders(nextOrders);
  }, []);
  const initialize = useCallback(async () => {
    if (initializing.current) return;
    initializing.current = true;
    setLoading(true);
    setError("");
    try {
      const session = await api<{ authenticated: boolean }>("/session");
      if (!session.authenticated) {
        setAuthenticated(false);
        return;
      }
      await Promise.all([
        refresh(),
        api<{ aiMode: string; demoMode: string }>("/health").then((result) => {
          setAiMode(result.aiMode); setDemoMode(result.demoMode);
        }),
      ]);
      setAuthenticated(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Connection failed");
    } finally {
      initializing.current = false;
      setLoading(false);
    }
  }, [refresh]);
  useEffect(() => { void initialize(); }, [initialize]);
  const run = useCallback(
    async (
      operation: () => Promise<unknown>,
      message = "",
    ): Promise<boolean> => {
      if (running.current) return false;
      running.current = true;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        await operation();
        await refresh();
        setNotice(message);
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          setAuthenticated(false);
          setCases([]);
          setOrders([]);
          setLedger([]);
          setSelected(null);
        }
        setError(
          error instanceof Error ? error.message : "Something went wrong",
        );
        try {
          await refresh();
        } catch {
          /* Keep the visible data so the owner can retry. */
        }
        return false;
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [refresh],
  );
  const edit = useCallback(
    async (changes: Record<string, unknown>) =>
      selected ? run(() => api(`/cases/${selected}`, "PATCH", changes)) : false,
    [selected, run],
  );
  const close = useCallback(() => setSelected(null), []);
  const onReconcile = useCallback(
    (id: string) => {
      void run(
        () => api(`/orders/${id}/reconcile`, "POST"),
        "Order checked against PayPal.",
      );
    },
    [run],
  );
  const onBatch = (action: BatchAction, ids: string[]) => {
    void run(async () => {
      const selected = cases.filter((value) => ids.includes(value.id));
      const skipped: string[] = [], failed: string[] = [];
      const targets = action === "triage" ? selected.map((value) => value.id) : [...new Set(selected.flatMap((value) => value.orderId ? [value.orderId] : []))];
      if (action === "reconcile") for (const value of selected) if (!value.orderId) skipped.push(`${value.id}: no matched order`);
      let completed = 0;
      const report = (summary: string) => setBatchReport({ summary, details: [...skipped.map((text) => `Skipped ${text}`), ...failed] });
      for (const [index, id] of targets.entries()) {
        report(`${action === "triage" ? "Triaging" : "Reconciling"} ${index + 1}/${targets.length}…`);
        try {
          if (action === "triage") {
            const skippedStatus = await triageBatchCase(id, {
              readCase: (caseId) => {
                report(`Triaging ${index + 1}/${targets.length}…`);
                return api<DeskCase>(`/cases/${encodeURIComponent(caseId)}`);
              },
              triageCase: (caseId) => api(`/cases/${encodeURIComponent(caseId)}/triage`, "POST"),
              onWait: (milliseconds, retry) => report(`Triaging ${index + 1}/${targets.length} · rate limited; waiting ${Math.ceil(milliseconds / 1000)}s before retry ${retry}/2…`),
            });
            if (skippedStatus) { skipped.push(`${id}: ${skippedStatus.replaceAll("_", " ")}`); continue; }
          } else {
            const result = await api<LedgerRow>(`/orders/${encodeURIComponent(id)}/reconcile`, "POST");
            if (result.error || result.match === false) throw new Error(result.error || "Ledger mismatch; review this order.");
          }
          completed++;
        } catch (error) {
          failed.push(`${id}: ${error instanceof Error ? error.message : "Request failed"}`);
          if (error instanceof ApiError && error.status === 401) { report("Batch stopped: sign in again."); throw error; }
        }
      }
      report(`${action === "triage" ? "Triage" : "Reconciliation"}: ${completed} ${action === "triage" ? "triaged" : `order${completed === 1 ? "" : "s"} matched`} · ${skipped.length} skipped · ${failed.length} failed${failed.length ? " — expand for details" : ""}`);
    });
  };
  const current = cases.find((value) => value.id === selected);
  const ready = cases.filter(
    (value) =>
      !["refunded", "rejected", "processing", "pending"].includes(
        value.status,
      ) &&
      !value.attempt &&
      value.check?.kind !== "blocked" &&
      value.proposal,
  ).length;
  const review = cases.filter(
    (value) =>
      !["refunded", "rejected"].includes(value.status) &&
      (value.check?.kind === "blocked" || value.status === "new"),
  ).length;
  const completed = cases.filter((value) => value.status === "refunded").length;
  const refunded = sumMoney(ledger.map((row) => ({ cents: row.refundedCents, currency: row.currency })));
  const go = (next: typeof view) => {
    setView(next);
    setSearch("");
    setSelected(null);
    setNotice("");
    setBatchReport(null);
  };
  const action = (action: string, body?: unknown) => {
    if (!selected) return;
    void run(
      async () => {
        const result = await api<{ reconciliationError?: string }>(
          `/cases/${selected}/${action}`,
          "POST",
          body,
        );
        if (result.reconciliationError)
          throw new Error(
            `Refund recorded. Reconciliation needs a retry: ${result.reconciliationError}`,
          );
      },
      action === "approve" || action === "retry-new-id"
        ? "PayPal response recorded. Check the case and ledger for its status."
        : action === "check-paypal"
          ? "PayPal checked. Review the recovery result."
          : action === "reject"
            ? "Case rejected. No payment was made."
            : "Triage complete. Review the proposal.",
    );
  };
  if (authenticated === null)
    return (
      <div className="signin-page">
        {loading ? <div className="loading-state">Loading owner workspace…</div> : (
          <div className="signin-card">
            <span className="eyebrow">Owner workspace</span>
            <h2>We couldn’t reach your desk.</h2>
            <p className="field-error" role="alert">{error || "Connection failed. Check that the server is running."}</p>
            <button className="button primary" onClick={() => void initialize()}>Retry connection</button>
          </div>
        )}
      </div>
    );
  if (!authenticated)
    return (
      <div className="signin-page">
        <div className="signin-intro">
          <span className="brand-symbol">
            <Leaf />
          </span>
          <span className="eyebrow">Fernleaf Ceramics · Customer care</span>
          <h1>
            A considered way
            <br />
            to make it right.
          </h1>
          <p>
            Review the facts. Make a fair decision.
            <br />
            Keep every refund accounted for.
          </p>
        </div>
        <form
          className="signin-card"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            void api("/sign-in", "POST", { password })
              .then(async () => {
                setPassword("");
                setAuthenticated(true);
                await refresh();
                const health = await api<{ aiMode: string; demoMode: string }>("/health");
                setAiMode(health.aiMode);
                setDemoMode(health.demoMode);
              })
              .catch((error) => setError(error.message))
              .finally(() => setBusy(false));
          }}
        >
          <span className="eyebrow">Owner workspace</span>
          <h2>Welcome to RefundDesk.</h2>
          <p>Sign in to review requests and manage refunds.</p>
          <label>
            Owner password
            <input
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <button className="button primary full" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <small>
            <span className="sandbox">● PayPal sandbox</span> · Fernleaf
            Ceramics
          </small>
        </form>
      </div>
    );
  return (
    <div className="app-shell">
      {demoMode === "replay" && <div className="replay-badge" role="status">Replay demo — no money moves, no keys needed</div>}
      <header className="topbar">
        <a className="brand" href="/" aria-label="RefundDesk home">
          <span className="brand-symbol">
            <Leaf />
          </span>
          <strong>
            RefundDesk<span>A considered way to make it right.</span>
          </strong>
        </a>
        <nav aria-label="Main navigation">
          {(["queue", "inbox", "ledger"] as const).map((tab) => (
            <button
              key={tab}
              className={view === tab ? "active" : ""}
              onClick={() => go(tab)}
            >
              {tab === "queue"
                ? "Approval queue"
                : tab === "inbox"
                  ? "Inbox"
                  : "Ledger"}
              {tab === "queue" && (
                <span>
                  {
                    cases.filter(
                      (value) =>
                        !["refunded", "rejected"].includes(value.status),
                    ).length
                  }
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="merchant">
          <span className="sandbox">
            <i />
            Sandbox
          </span>
          <span className="merchant-name">
            Fernleaf Ceramics<small>Owner workspace</small>
          </span>
          <span className="merchant-avatar">FC</span>
          <button
            className="text-button"
            onClick={() => {
              void api("/sign-out", "POST").then(() => {
                setAuthenticated(false);
                setCases([]);
                setOrders([]);
                setLedger([]);
                setSelected(null);
                setError("");
              });
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main>
        <div className="page-heading">
          <div>
            <div className="eyebrow">
              Fernleaf Ceramics /{" "}
              {view === "queue"
                ? "Customer care"
                : view === "ledger"
                  ? "Payments"
                  : "Incoming messages"}
            </div>
            <h1>
              {view === "queue"
                ? "Make it right. Keep it fair."
                : view === "ledger"
                  ? "Every refund, accounted for."
                  : "Good care starts with listening."}
            </h1>
            <p>
              {view === "queue"
                ? "Policy-backed proposals. A human decision. Every cent checked."
                : view === "ledger"
                  ? "Your local ledger, reconciled against PayPal’s own records."
                  : "Bring in a customer message. We’ll find the order and prepare it for review."}
            </p>
          </div>
          {view === "ledger" ? (
            <button
              className="button primary"
              disabled={busy || loading || !orders.length}
              onClick={() =>
                void run(
                  () => api("/reconcile", "POST"),
                  "Reconciliation finished. Review any mismatches in the ledger.",
                )
              }
            >
              <span>↻</span>
              {busy ? "Checking PayPal…" : "Reconcile all orders"}
            </button>
          ) : view === "inbox" ? (
            <span className="mode-label">
              {aiMode === "offline"
                ? "Offline triage available"
                : "AI provider connected"}
            </span>
          ) : null}
        </div>
        {error && (
          <div className="banner error" role="alert">
            <span>⚠ {error}</span>
            <button onClick={() => setError("")} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="banner success" role="status">
            <span>✓ {notice}</span>
            <button
              onClick={() => setNotice("")}
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        )}
        <div className="metrics">
          <div>
            <span>Ready to approve</span>
            <strong>
              {ready.toString().padStart(2, "0")}
              <i className="metric-dot green" />
            </strong>
            <small>Checked against your policies</small>
          </div>
          <div>
            <span>Needs your attention</span>
            <strong>
              {review.toString().padStart(2, "0")}
              <i className="metric-dot amber" />
            </strong>
            <small>Missing details or a policy exception</small>
          </div>
          <div>
            <span>Resolved with a refund</span>
            <strong>
              {completed.toString().padStart(2, "0")}
              <i className="metric-dot teal" />
            </strong>
            <small>Human-approved, recorded with PayPal</small>
          </div>
          <div className="money-metric">
            <span>Total returned to customers</span>
            <strong>{formatMoneyTotals(refunded)}</strong>
            <small>
              {ledger.filter((row) => row.match === true).length} of{" "}
              {ledger.length} orders reconciled
            </small>
          </div>
        </div>
        {loading ? (
          <div className="loading-state">
            <span className="spinner dark" />
            <h2>Opening your desk…</h2>
            <p>Loading customer cases and payment records.</p>
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        ) : error && !cases.length && !orders.length ? (
          <div className="empty-state">
            <h2>We couldn’t reach your desk.</h2>
            <p>Check that the server is running, then try again.</p>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void run(refresh)}
            >
              Retry connection
            </button>
          </div>
        ) : view === "inbox" ? (
          <div className="inbox-layout">
            <section className="inbox-form">
              <div className="section-label">
                New customer message{" "}
                <button
                  className="text-button"
                  onClick={() => setImportMode(!importMode)}
                >
                  {importMode ? "Use message form" : "Import JSON"}
                </button>
              </div>
              <h2>
                {importMode
                  ? "Bring your inbox with you."
                  : "One message. A clear next step."}
              </h2>
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (busy) return;
                  await run(async () => {
                    const saved = importMode
                      ? await api<DeskCase[]>("/inbox/import", "POST", JSON.parse(importText))
                      : [await api<DeskCase>("/cases", "POST", form)];
                    // Creation has committed even if triage or the next refresh fails.
                    setCases((previous) => [...saved, ...previous]);
                    setForm({
                      sender: "",
                      email: "",
                      subject: "",
                      message: "",
                    });
                    setImportText("");
                    go("queue");
                    if (importMode) return;
                    const value = saved[0];
                    try {
                      await api(`/cases/${value.id}/triage`, "POST");
                    } catch (error) {
                      const detail = error instanceof Error ? error.message : "Request failed";
                      const message = `Message saved. Triage did not finish: ${detail}. Find the saved message under All in the queue, open it, and use Triage this case.`;
                      throw error instanceof ApiError
                        ? new ApiError(message, error.status, error.retryAfterMs)
                        : new Error(message);
                    }
                    setSelected(value.id);
                  }, importMode ? "Messages imported. Select them in the queue to triage." : "Message added and ready for review.");
                }}
              >
                {importMode ? (
                  <label>
                    Messages as a JSON array
                    <textarea
                      required
                      rows={12}
                      value={importText}
                      onChange={(event) => setImportText(event.target.value)}
                      placeholder={
                        '[{"sender":"Maya Chen","email":"maya@example.test","subject":"Broken handle","message":"FC-1001 arrived with a cracked handle."}]'
                      }
                    />
                    <small>
                      Each message needs sender, email, subject, and message. Up
                      to 100 at a time.
                    </small>
                  </label>
                ) : (
                  <>
                    <div className="form-pair">
                      <label>
                        Customer name
                        <input
                          required
                          maxLength={100}
                          value={form.sender}
                          onChange={(event) =>
                            setForm({ ...form, sender: event.target.value })
                          }
                          placeholder="Maya Chen"
                          autoComplete="name"
                        />
                      </label>
                      <label>
                        Email address
                        <input
                          required
                          type="email"
                          maxLength={200}
                          value={form.email}
                          onChange={(event) =>
                            setForm({ ...form, email: event.target.value })
                          }
                          placeholder="maya@example.test"
                          autoComplete="email"
                        />
                      </label>
                    </div>
                    <label>
                      Subject
                      <input
                        required
                        maxLength={200}
                        value={form.subject}
                        onChange={(event) =>
                          setForm({ ...form, subject: event.target.value })
                        }
                        placeholder="A few words about the issue"
                      />
                    </label>
                    <label>
                      Customer message
                      <textarea
                        required
                        minLength={5}
                        maxLength={15000}
                        rows={8}
                        value={form.message}
                        onChange={(event) =>
                          setForm({ ...form, message: event.target.value })
                        }
                        placeholder="Paste the customer’s original message, including an order number if available…"
                      />
                    </label>
                  </>
                )}
                <div className="form-footer">
                  <span>No email is sent from this desk.</span>
                  <button className="button primary" disabled={busy}>
                    {busy
                      ? "Preparing case…"
                      : importMode
                        ? "Import messages"
                        : "Add & triage message →"}
                  </button>
                </div>
              </form>
            </section>
            <aside className="inbox-note">
              <Leaf />
              <span className="eyebrow">A little context helps</span>
              <h2>
                Behind every order
                <br />
                is a person.
              </h2>
              <p>
                Keep their original words. Order numbers, names, and a clear
                description of the problem help the desk find the right policy.
              </p>
              <div>
                <strong>01</strong>
                <p>
                  Match the order
                  <br />
                  <small>Look up real customer and payment records.</small>
                </p>
              </div>
              <div>
                <strong>02</strong>
                <p>
                  Check the policy
                  <br />
                  <small>Amounts are computed from your clauses.</small>
                </p>
              </div>
              <div>
                <strong>03</strong>
                <p>
                  You make the call
                  <br />
                  <small>Review, approve, and reconcile with PayPal.</small>
                </p>
              </div>
            </aside>
          </div>
        ) : (
          <>
            <Suspense fallback={<div className="loading-state">Opening grid?</div>}>
            {view === "queue" ? (
              <QueueGrid
                cases={cases}
                search={search}
                onSearch={setSearch}
                onSelect={setSelected}
                busy={busy}
                batchReport={batchReport}
                onBatch={onBatch}
                onAmount={(id, cents) =>
                  void run(() =>
                    api(`/cases/${id}`, "PATCH", { approvedCents: cents }),
                  )
                }
                onInvalidAmount={() =>
                  setError(
                    "Enter a positive amount with at most two decimal places.",
                  )
                }
              />
            ) : (
              <LedgerGrid
                rows={ledger}
                search={search}
                onSearch={setSearch}
                busy={busy}
                onReconcile={onReconcile}
              />
            )}
            </Suspense>
            <div className="desk-note">
              <span>
                <i />
                {aiMode === "offline"
                  ? "Offline demo triage"
                  : "AI-assisted triage"}{" "}
                · All payments use PayPal sandbox
              </span>
              <span>
                {view === "queue"
                  ? "The AI proposes. Your policy sets the limits. You approve."
                  : "Reconcile on demand, or receive verified PayPal webhooks when deployed."}
              </span>
            </div>
          </>
        )}
      </main>
      <footer className="app-footer">
        <span>
          Fernleaf Ceramics <i>·</i> Thoughtfully made. Thoughtfully resolved.
        </span>
        <span>RefundDesk / Sandbox workspace</span>
      </footer>
      {current && (
        <Drawer
          value={current}
          orders={orders}
          busy={busy}
          demoMode={demoMode}
          onClose={close}
          onEdit={edit}
          onAction={action}
        />
      )}
    </div>
  );
}
