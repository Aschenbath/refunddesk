# RefundDesk

RefundDesk is a refund desk for a small shop, demonstrated with fictional Fernleaf Ceramics customers and real PayPal sandbox payments. It turns customer complaints into policy-backed proposals, waits for the owner to approve, issues the refund, and checks the local ledger against PayPal. This reduces the work and mistakes involved in matching orders, calculating refunds and checking earlier payments.

The starting folder contained the specification and installed dependencies. The implementation adds a pure policy core, SQLite storage, a PayPal REST client, offline and online AI triage, a Hono API, and a React / AG Grid owner workspace. No dependencies were added. Keeping calculation separate from triage makes incorrect model amounts visible and prevents them from deciding money movements.

```text
Message form / JSON import
          |
          v
AI triage <--- read-only order & policy lookups
          |
          v
Zod schema --> pure policy calculator --> remainder / duplicate / match checks
                                              |
                                    owner reviews and approves
                                              |
                                  persisted amount + request key
                                              |
                                        PayPal refund
                                              |
                               capture + order + refund lookups
                                              |
                                     SQLite ledger / AG Grid
```

The AI suggests an order match, intent, clause ids, item reasons and amounts, and a reply draft. Code verifies the match against lookup candidates, recomputes the policy allowance from merchant facts, checks currency and previous item allocations, blocks duplicates, persists the approved request, executes it, and reconciles it. The AI has no refund tool or endpoint access. The owner can select an order, verify damage evidence, mark returned items received, choose clauses, lower the approved amount, and record a reasoned duplicate override. Overrides never bypass the refundable balance, policy allowance, currency check or unresolved request lock.

All money in the domain and API is **integer cents**. UI amounts are dollars. PayPal amounts are two-decimal strings. An approved amount may be lower than the computed allowance; a higher amount is rejected. The drawer displays the model amount, policy allowance and refundable balance separately. A case with an ineligible clause combination fails closed. Full quantities of damaged lines are supported; partial-unit damage needs a separate line in the order.

## Run

Use Node 24.18 or newer. Dependencies are already installed in this workspace; a new checkout needs `npm ci`.

1. Copy `.env.example` to `.env` only if you do not already have `.env`. Fill the two sandbox credentials. Set `PAYPAL_ENV=sandbox`, `AI_MODE=offline`, and optionally `PORT=15480`. The application reads this file with `process.loadEnvFile`; credentials stay on the server.
2. `npm run seed -- --reset` creates 12 products, 15 customers, 25 captured sandbox orders and 15 messy customer messages. It back-dates local delivery records, issues a real $12 partial refund, triages the messages, and reconciles the ledger. `--reset` removes local data only; old sandbox transactions remain. Stop the server before reset. Without `--reset`, existing local captures and cases are preserved, and incomplete seeding resumes.
3. `npm run dev` starts the API on **15480** and Vite on **15481**. Open `http://localhost:15481`. The server is imported in the same process; restart dev after server source changes, or use `npm run dev:server` for a separately watched API.
4. For production, `npm run build` then `npm start`. Open `http://localhost:15480`; Hono serves the built client and API.

On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`. The scripts use Node 24's native TypeScript stripping and a small source-resolution hook: the installed `tsx` CLI fails here because `os.userInfo()` is unavailable in the managed Windows session. Production runs emitted JavaScript without the hook.

The Queue supports selection, sorting, quick search, inline amount editing, status filters and collapsible status groups. Double-click an amount to edit it; the server validates the edit. AG Grid Community does not include enterprise row grouping, so the status groups are implemented with Community full-width rows. Select a case to inspect the message, highlighted match evidence, clauses, order lines, refund balance and editable reply. Edit the amount and click Approve. The drawer shows the PayPal refund id; Ledger rows turn green when a refund matches PayPal. Copy the reply or mark it sent; no real email is sent.

Inbox accepts a message form or a JSON array with `sender`, `email`, `subject` and `message`. Offline fixtures cover partial ids, repeated complaints, Spanish, an angry over-refund request, missing/ambiguous orders, received and unreceived returns, sale exclusions, expired returns, exchanges and questions. The angry case intentionally proposes $140 on a $72 capture; deterministic code adjusts it to $72. New messages use a modest keyword fallback and require human order selection when matching is uncertain.

For online AI, set `AI_MODE=online`, `AI_BASE_URL` to your OpenAI-compatible chat API base (usually ending `/v1`), `AI_API_KEY` and `AI_MODEL`. AI SDK structured output is validated by strict Zod; the provider is created with `supportsStructuredOutputs: true` so the JSON schema reaches the model. Checked with Gemini (`gemini-3.5-flash` via its OpenAI-compatible endpoint): 11 of 12 open seeded cases triaged, with the 12th rate-limited and handed to a human. There is one retry for invalid output or a failed provider call, then the case is marked `needs_human`. The only tools are local order lookups by email, name, partial id or date, and policy reads.

`@paypal/agent-toolkit` 1.11's AI SDK tools use `parameters` rather than AI v7's required `inputSchema`; the compatibility check fails, so RefundDesk uses direct PayPal REST for reads and refunds. Run `npm run check:toolkit` to reproduce the tool-shape check without credentials or network calls.

## Test

```sh
npm test
npm run build
npm run seed -- --reset
npm run test:live
# With npm start running, approve/check three seeded cases:
npm run verify:seeded
```

Unit and fast-check tests cover order and line remainders, model-independent calculation, duplicate protection, currency and ambiguous matches, damage evidence, clause families, business-day thresholds, percentage rounding, return receipt and deductions. Fixture tests cover PayPal token caching, direct and separate capture, request headers, typed errors, and webhook verification. API tests cover concurrent approval claims, frozen retries, invalid-edit rollback, order selection and schema retry limits. Synthetic fixtures cover error and creation paths; an additional reduced fixture records real sandbox capture, order and refund GET responses, with credentials, tokens and personal fields excluded.

The opt-in live test creates a $1 capture, approves a $0.40 refund through the actual Hono approval route, reconciles it, expects HTTP 409 for a second approval, and repeats the exact PayPal request key to prove it returns the same refund id without another payment. Each live test leaves one clearly labelled order in the ledger. The seeded verification approves cases 01–03 (damage, late shipping, received return), checks exact PayPal gross amounts/statuses, and proves the duplicate case is blocked. Re-running it verifies existing receipts instead of issuing new refunds.

## API and reconciliation

`GET /api/cases`, `/api/cases/:id`, `/api/orders?q=...`, `/api/policies`, `/api/ledger`, `/api/health`.

`POST /api/cases` adds a message; `/api/inbox/import` adds an array atomically. `POST /api/triage` triages new messages; `/api/cases/:id/triage` triages one editable case. `PATCH /api/cases/:id` updates amount (`approvedCents`), verified order (`orderId`), `clauseIds`, `damagedLineIds`, `hasDamageEvidence`, `returnReceivedLineIds`, `duplicateOverride` (reason), `replyDraft`, or `replySent`. `POST /api/cases/:id/approve` executes; `/reject` rejects. `POST /api/orders/:id/reconcile` and `/api/reconcile` check one or all orders.

Every PayPal POST carries `Prefer: return=representation` and `PayPal-Request-Id`. Refund keys are hashes derived from case ids and their capture ids, so reset seeds cannot reuse a previous capture's key. Before execution, code reconciles the order and atomically claims its approval. The request amount and allocations are frozen in SQLite. Unknown outcomes keep the order locked and retry the same request for up to one hour; older uncertain requests require manual PayPal review. Process startup marks interrupted attempts recoverable. A recorded refund blocks a second approval. Other cases with an unresolved request on the same order cannot approve, even with a duplicate override. The approval check is preserved with the case so the completed row retains the approved amount and policy result.

Reconciliation fetches the capture, enumerates refund ids from the PayPal order, then fetches each refund independently. It compares capture amount, currency, refund amounts, known ids and the capture's status with the local ledger. Net is the gross capture minus refunds, before PayPal fees. Pending refunds reserve the amount. Unrecognised remote refunds or failed reads flag a mismatch and block further approval for manual investigation. No totals are inferred from capture status alone.

`POST /api/webhooks/paypal` handles `PAYMENT.CAPTURE.REFUNDED` and deduplicates event ids. Set `PAYPAL_WEBHOOK_ID` to verify the event via PayPal's signature endpoint. With an empty id, verification is deliberately skipped for local sandbox use. Configure it for public deployment. On-demand reconciliation is the local polling fallback.

## Sandbox and deployment limits

Only the sandbox host is supported; `PAYPAL_ENV=live` is rejected. Seeding uses the app's verified direct sandbox test-card capture path. Test card details are public test data. Capture, refund and debug ids are safe to show; client secrets, tokens and `.env` values are never logged. All people and products here are fictional.

`render.yaml` defines a single Node web service with a persistent SQLite disk and server-side environment variables. Use a paid disk-capable plan, supply the sandbox credentials, and run `npm run seed` once from the service shell. A deployment was not requested or performed. This demo has one owner and no authentication; restrict access externally before exposing a money-operation UI. It is not a multi-merchant system.

Public holidays, partial quantities within one order line, taxes, discounts beyond sale eligibility, disputes, payouts, live payments, email integration and automatic refunding are outside this implementation. External refunds are detected but need manual ledger/allocation investigation; there is no automatic import of unidentified refunds. PayPal retains idempotency keys for a limited period, so an old uncertain request needs manual review instead of assuming indefinite remote deduplication. Fonts load from Google Fonts when available and have local fallbacks. The AG Grid bundle is substantial. Online provider output and publicly delivered webhook signatures require their own configured integration checks.

Required local validation passed: 32 tests, production build, real reset seed, live approval/idempotency test, and three seeded approvals with matching PayPal ledger rows. A seed rerun preserved all existing captures. Browser checks passed at 1440×900 and 1280×900, including inline edits, rejected over-limit edits, status grouping, search, drawer, ledger, message creation and rejection. The local handoff report lists sandbox ids; screenshots remain under ignored `output/playwright/`.
