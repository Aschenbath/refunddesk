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

All money in the domain and API is **integer cents**. UI amounts are dollars. PayPal amounts are two-decimal strings. An approved amount may be lower than the computed allowance; a higher amount is rejected. The drawer displays the model amount, confirmed policy allowance and refundable balance separately. A case with an ineligible clause combination fails closed. Damage and returns use owner-confirmed quantities within each order line.

## Owner trust boundary and recovery

Previously the local API was unauthenticated, triage could promote item suggestions into trusted facts, and approval could execute an edit made during its PayPal lookup. Every customer-data read and mutation now requires an owner session. Sign-in uses `OWNER_PASSWORD`; an eight-hour HttpOnly, SameSite=Strict cookie is signed with `SESSION_SECRET`. If that secret is unset, startup generates one and a restart invalidates existing sessions. Passwordless access works only from a loopback socket outside production. Production startup requires a password and `PUBLIC_ORIGIN`; HTTPS origins work through an HTTP reverse proxy. Configure a stable secret to preserve sessions across restarts. Limits use the socket IP, not client-supplied forwarded headers; a shared proxy can therefore share a rate bucket.

Each case has a revision. Approve sends `{ revision, approvedCents }` from the drawer; an intervening change returns 409, displays “This case changed; review again”, and reloads. The transaction after reconciliation checks that revision again and freezes the amount, allocations, clauses, confirmed facts, order and revision. Facts are split into `proposedFacts` and `confirmedFacts`. Seeded, fixture and newly triaged cases have no confirmations. The owner checks each affected line, its quantity, damage evidence, return receipt and delivery dates before money is allowed. A changed order clears confirmations. P3 deducts $6 from this case’s confirmed returned items and records the case that incurred the fee; later return parcels incur their own fee.

Conflicting explicit references, customer identity disagreements and unresolved order matches require an owner to choose an order. A single explicit reference resolves several orders for the same customer when the name and email agree. The model’s order lookup is limited to records matching that case’s references, email or name. Online provider failures retain a keyword proposal and reply marked “AI unavailable”; provider errors are stored and logged as class/status only. Sign-in, import and triage have per-IP rate limits, triage concurrency is two, and request limits count streamed bytes rather than trusting Content-Length.

Refund attempts have `submitted`, `pending`, `completed`, `failed` and transport-uncertain states. Only a completed PayPal receipt closes a case as refunded; pending money is displayed separately and reserves the balance. Reconciliation changes the receipt, attempt, case and ledger in one transaction. “Check PayPal” enumerates refunds for the verified capture and finds the attempt’s `invoice_id`/`custom_id`, then validates the frozen amount and currency before importing its allocations. It sends no refund. If the receipt is absent after the conservative one-hour request-id window, an owner can explicitly confirm a warning and provide a reason to retry with a new request id. No automatic new-id retry exists; uncertainty and reporting lag can still require PayPal investigation.

Seed batches and operation intents persist before network requests. Resuming uses the same batch, dates and request ids. Known PayPal orders are read before capturing, uncertain captures are looked up by invoice through PayPal transaction reporting, and refunds are searched by invoice before resubmission. Reporting requires PayPal reporting access and may lag; missing access or a missing result beyond the request-id window fails closed. `--reset` starts a new batch and leaves old sandbox transactions intact.

## Run

Use Node 24.18 or newer. Dependencies are already installed in this workspace; a new checkout needs `npm ci`.

1. Copy `.env.example` to `.env` only if you do not already have `.env`. Fill the two sandbox credentials. Set `PAYPAL_ENV=sandbox`, `AI_MODE=offline`, and optionally `PORT=15480`. The application reads this file with `process.loadEnvFile`; credentials stay on the server.
   Set `OWNER_PASSWORD` in your shell for local runs (`$env:OWNER_PASSWORD = 'your-local-password'` in PowerShell). Set `SESSION_SECRET` and `PUBLIC_ORIGIN` through environment configuration for a deployed service; use its exact HTTPS origin without a path or trailing slash.
2. `npm run seed -- --reset` creates 12 products, 15 customers, 25 captured sandbox orders and 15 messy customer messages. It back-dates local delivery records, issues a real $12 partial refund, triages the messages, and reconciles the ledger. `--reset` removes local data only; old sandbox transactions remain. Stop the server before reset. Without `--reset`, existing local captures and cases are preserved, and incomplete seeding resumes.
3. `npm run dev` starts the API on **15480** and Vite on **15481**. Open `http://localhost:15481`. The server is imported in the same process; restart dev after server source changes, or use `npm run dev:server` for a separately watched API.
4. For production, `npm run build` then `npm start`. Open `http://localhost:15480`; Hono serves the built client and API.

On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`. The scripts use Node 24's native TypeScript stripping and a small source-resolution hook: the installed `tsx` CLI fails here because `os.userInfo()` is unavailable in the managed Windows session. Production runs emitted JavaScript without the hook.

The Queue supports selection, sorting, quick search, inline amount editing, status filters and collapsible status groups. Double-click an amount to edit it; the server validates the edit. AG Grid Community does not include enterprise row grouping, so the status groups are implemented with Community full-width rows. Select a case to inspect the message, highlighted match evidence, clauses, order lines, refund balance and editable reply. Confirm facts, save any amount edit, review the updated amount and click Approve. The drawer shows the PayPal refund id; completed Ledger rows turn green when every receipt matches PayPal. Pending refunds stay visible, and unexpected remote refunds use violet. Copy the reply or mark it sent; no real email is sent.

Inbox accepts a message form or a JSON array with `sender`, `email`, `subject` and `message`. Offline fixtures cover partial ids, repeated complaints, Spanish, an angry over-refund request, missing/ambiguous orders, received and unreceived returns, sale exclusions, expired returns, exchanges and questions. The angry case intentionally proposes $140 on a $72 capture; deterministic code adjusts it to $72. New messages use a modest keyword fallback and require human order selection when matching is uncertain.

For online AI, set `AI_MODE=online`, `AI_BASE_URL` to your OpenAI-compatible chat API base (usually ending `/v1`), `AI_API_KEY` and `AI_MODEL`. AI SDK structured output is validated by strict Zod; the provider is created with `supportsStructuredOutputs: true` so the JSON schema reaches the model. There is one retry for invalid output or a failed provider call, then deterministic keyword triage supplies a proposal and reply marked “AI unavailable”. The only tools are case-scoped local order lookups and policy reads. Model facts remain proposals regardless of provider or confidence.

`@paypal/agent-toolkit` 1.11's AI SDK tools use `parameters` rather than AI v7's required `inputSchema`; the compatibility check fails, so RefundDesk uses direct PayPal REST for reads and refunds. Run `npm run check:toolkit` to reproduce the tool-shape check without credentials or network calls.

## Test

```sh
npm test
npm run build
npm run seed -- --reset
npm run test:live
# With npm start running and the same OWNER_PASSWORD in this shell, confirm/approve/check two seeded cases:
npm run verify:seeded
```

Unit and fast-check tests cover order and line remainders, model-independent calculation, duplicate protection, currency and ambiguous matches, damage evidence, clause families, business-day thresholds, percentage rounding, return receipt and deductions. Fixture tests cover PayPal token caching, direct and separate capture, request headers, typed errors, and webhook verification. API tests cover concurrent approval claims, frozen retries, invalid-edit rollback, order selection and schema retry limits. Synthetic fixtures cover error and creation paths; an additional reduced fixture records real sandbox capture, order and refund GET responses, with credentials, tokens and personal fields excluded.

The opt-in live test signs in, creates a $1 capture, approves a $0.40 refund, checks 401 without a session and 409 for stale/second approval, and repeats the exact PayPal request key to prove idempotency. A separate ten-cent refund has its response deliberately lost after real creation; owner-controlled recovery finds that same receipt without a second call. Total refunded is $0.50. Each run leaves one labelled order in the ledger. Seeded verification explicitly confirms facts for cases 01–02, checks stale approval, approves them, proves the duplicate case is blocked and reconciles every row. Re-running it verifies completed receipts instead of issuing new refunds.

## API and reconciliation

`GET /api/cases`, `/api/cases/:id`, `/api/orders?q=...`, `/api/policies`, `/api/ledger`, `/api/health`.

`POST /api/sign-in` accepts `{ password }`; `/api/sign-out` clears the session. `GET /api/session` reports authentication. `POST /api/cases` adds a message; `/api/inbox/import` adds an array atomically. `POST /api/triage` triages new messages; `/api/cases/:id/triage` triages one editable case. `PATCH /api/cases/:id` updates `approvedCents`, `orderId`, `clauseIds`, `confirmedFacts`, `duplicateOverride`, `replyDraft` or `replySent`. Confirmed facts contain `damagedItems` and `returnedItems` arrays of `{ item, quantity }`, `hasDamageEvidence`, `returnReceived`, and nullable `deliveryDates` (`promisedAt`, `deliveredAt`). `POST /api/cases/:id/approve` requires `{ revision, approvedCents }`; `/reject` rejects. `/check-paypal` checks or recovers an attempt, and `/retry-new-id` requires `{ revision, confirmed: true, reason }`. `POST /api/orders/:id/reconcile` and `/api/reconcile` check one or all orders. Health, policies, session and sign-in are public; webhook verification is independent of owner sessions.

Every PayPal POST carries `Prefer: return=representation` and `PayPal-Request-Id`. Refund keys are hashes derived from case ids and their capture ids, so reset seeds cannot reuse a previous capture's key. Before execution, code reconciles the order and atomically claims its approval. The request amount and allocations are frozen in SQLite. Unknown outcomes keep the order locked and retry the same request for up to one hour; older uncertain requests require manual PayPal review. Process startup marks interrupted attempts recoverable. A recorded refund blocks a second approval. Other cases with an unresolved request on the same order cannot approve, even with a duplicate override. The approval check is preserved with the case so the completed row retains the approved amount and policy result.

Reconciliation verifies capture membership through order payments or capture related-order metadata, enumerates that capture’s refund ids, and fetches each refund independently. It compares each local/remote refund one to one by id, amount, currency, valid status transition and capture association; matching totals alone cannot pass. Net subtracts completed refunds, while `pendingCents` reserves pending money separately. Unrecognised remote refunds or failed reads flag a mismatch and block further approval for investigation.

`POST /api/webhooks/paypal` verifies the untouched parsed event through PayPal’s signature endpoint before Zod extraction and hashes the raw request string for its verification request key. Verified `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.REFUND.PENDING` and `PAYMENT.REFUND.FAILED` events reconcile the associated order and deduplicate event ids. Without `PAYPAL_WEBHOOK_ID`, development acknowledges events as unverified and never acts on them; production returns 503. On-demand reconciliation is the local polling fallback.

## Sandbox and deployment limits

Only the sandbox host is supported; `PAYPAL_ENV=live` is rejected. Seeding uses the app's verified direct sandbox test-card capture path. Test card details are public test data. Capture, refund and debug ids are safe to show; client secrets, tokens and `.env` values are never logged. All people and products here are fictional.

`render.yaml` defines a single Node web service with a persistent SQLite disk and server-side environment variables. Use a paid disk-capable plan, supply the sandbox credentials, owner password, public HTTPS origin and webhook id, and run `npm run seed` once from the service shell. Render generates the session secret. This demo authenticates one owner; it is not a multi-merchant system. No deployment was performed.

Public holidays, taxes, discounts beyond sale eligibility, disputes, payouts, live payments, email integration and automatic refunding are outside this implementation. External refunds are detected but need manual ledger/allocation investigation; there is no automatic import of unidentified refunds. Fonts load from Google Fonts when available and have local fallbacks. The AG Grid bundle is substantial. Hosted webhook delivery, reporting permissions and a broader online AI evaluation require separately configured integration checks.

Validation includes the original 32 tests plus focused review regressions for authentication, streaming/rate/concurrency limits, revision races, human-confirmed fact properties, reference conflicts, per-return fees, pending/failed transitions, response-loss recovery, exact reconciliation, untouched webhook verification, seed recovery and provider redaction/fallback. Live checks and screenshots are retained under ignored `output/`; the final verification report lists the sandbox ids and actual results.
