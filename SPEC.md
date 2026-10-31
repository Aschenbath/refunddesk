# RefundDesk: spec

An AI refund desk for small online merchants. A customer complaint arrives. RefundDesk finds the order, reads the merchant's
refund policy, proposes a refund with the policy clause it relied on, and waits for a human to approve. On approval it
executes a real PayPal refund (sandbox) and reconciles it against PayPal. Every money movement is checked by deterministic
code, never by the model alone.

Contest: PayPal AI Hackathon (Devpost). Targets "Best Use of PayPal + AI" and the AG Grid sponsor prize. The deadline is
2026-11-12 12:00 PT.

## Who it is for
A one-to-five person shop that sells on its own site with PayPal checkout. Its owner spends evenings on refund emails: working
out which order it is, what the policy allows, how much to refund, and whether they already refunded it. Mistakes cost money
(double refunds, over-refunds) or customers (slow, inconsistent answers).

## Demo merchant (fictional)
"Fernleaf Ceramics", which sells handmade mugs, bowls and planters ($18–$140). Seed about 12 products, about 25 orders across 15
customers, and 3 policies:
1. **Damaged in transit.** Full refund of the item, with a photo or a clear description required. Shipping is refunded if every
   item arrived damaged.
2. **Late delivery.** If delivery took more than 10 business days past the promised date, refund the shipping cost; if more
   than 20, also refund 15% of the item total.
3. **Change of mind.** Within 30 days of delivery, refund the item price minus a $6 return-shipping deduction once the return is
   marked received. Not eligible after 30 days, and not for sale items.

Policies live in `data/policies.md` as numbered clauses (P1.1, P1.2, …). The AI must cite clause ids.

## Core flow
1. **Orders are real sandbox payments.** A seeding script creates PayPal sandbox orders and captures them, so every order has a
   real `capture_id`. Prefer direct capture with a sandbox test card (`payment_source.card`). If the sandbox app does not allow
   it, fall back to a tiny storefront page (`/shop`) with the PayPal JS SDK button, so a human can buy with the sandbox Personal
   account. Store the order, the items and the capture in a local SQLite file (`node:sqlite`, which is built in, with no native
   build).
2. **Inbox.** Complaints come in through a form or a JSON import. About 15 seeded messages are written like real email: messy,
   partial order numbers, some by name only, one angry, one in Spanish, one asking for a refund that was already given, one
   trying to get more than allowed, one that is not a refund request at all.
3. **AI triage.** For each message, the model returns strict JSON (schema-validated with zod):
   - `matched_order_id` and `match_evidence`;
   - `intent`, one of refund, exchange, question or other;
   - `policy_clause_ids`;
   - `proposed_lines`, each with an item, a reason and an amount;
   - `proposed_total`;
   - `customer_reply_draft`;
   - `confidence` (0–1);
   - `needs_human_reason`.

   The model gets tools to look up orders by email, name, partial id and date. These are read-only.
4. **Guardrails (deterministic, tested).** Before a proposal reaches the queue, the code applies these rules:
   - The refund amount is never more than the captured amount minus refunds already made, per order and per line.
   - The amount must match what the cited clauses allow. Recompute the amount from the clause rules in code. If the model's
     number differs, flag it, and the human sees both.
   - Duplicate protection: the same order with an open or recent refund is blocked unless a human overrides it.
   - Unknown or ambiguous order: the proposal cannot be approved until a human picks the order.
   - The currency must match the capture.
5. **Approval queue (AG Grid).** This is the main screen. It has one row per case, with these columns:
   - customer;
   - order;
   - intent;
   - proposed amount;
   - policy check (pass, adjusted or blocked);
   - confidence;
   - age;
   - status.

   It needs row selection, inline editing of the approved amount (re-validated by the guardrails), grouping by status, quick
   filters, and a detail drawer. The drawer shows the message with the matched spans highlighted, the cited clause text, the
   order lines, the computed versus proposed amount, and the reply draft.
6. **Execute.** On approval, call PayPal `POST /v2/payments/captures/{capture_id}/refund` with an amount and a `PayPal-Request-Id`
   idempotency key derived from the case id. Show the result inline.
7. **Reconcile.** After each refund, and on demand, fetch the capture (`GET /v2/payments/captures/{id}`) and its refunds. Compare
   them with the local ledger. A second AG Grid, "Ledger", shows one row per order with captured, refunded and net amounts, the
   PayPal status and a match flag. Mismatches are highlighted. Webhooks (`PAYMENT.CAPTURE.REFUNDED`), with signature
   verification via `/v1/notifications/verify-webhook-signature`, are used when deployed publicly; polling is the local
   fallback.
8. **Customer reply.** Copy the edited draft, or mark it sent. Do not send real email.

## PayPal + AI depth (what judges should see)
- Real sandbox captures and refunds, partial refunds, idempotency, and reconciliation against PayPal's own records.
- Use the official `@paypal/agent-toolkit` for at least the read and refund tools, if it works with the chosen AI SDK version.
  Otherwise call the REST API directly, and say so honestly in the README. Never let the model call the refund tool itself:
  refunds run only through the approve endpoint after the guardrails pass.
- The README says which parts the AI decides (matching, intent, clause choice, reply draft) and which parts code decides
  (amounts, limits, duplicates, execution).

## Tech
- TypeScript everywhere. Server: Node 24, Hono (or Express), zod, `node:sqlite`. Client: Vite, React and AG Grid Community.
  Keep dependencies few.
- AI provider: OpenAI-compatible chat completions configured by env (`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`). A deterministic
  `AI_MODE=offline` stub returns fixture triage results for tests and for running without a key.
- Config in `.env`:
  - `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV=sandbox`, `PAYPAL_WEBHOOK_ID` (optional);
  - the AI variables;
  - never commit `.env`. Provide `.env.example`.
- Tests: vitest. The guardrail and clause-amount math gets example tests plus property tests (fast-check). The PayPal client
  is tested against recorded fixtures. One opt-in live sandbox test (`npm run test:live`) captures and partially refunds a
  $1 order.
- Scripts:
  - `npm run seed` (sandbox orders plus the inbox);
  - `npm run dev`;
  - `npm test`;
  - `npm run test:live`;
  - `npm run build`.
- Deployable to Render (one web service). Write `render.yaml`.

## Design
Calm, trustworthy back-office look: warm off-white, ink text, one accent colour (deep teal), and generous spacing. Money
uses tabular numerals. Status chips:
- pass: green;
- adjusted: amber;
- blocked: red.

Do not use PayPal's logo except where PayPal's brand rules allow (the checkout button). The empty, loading and error states are
designed. It must look complete at 1440×900 and still be usable at a laptop width of 1280.

## Out of scope
Real email or inbox integration, live payments, payouts, disputes, subscriptions, multi-merchant support, auth beyond one local
owner, and autonomous refunds with no human approval.

## Acceptance
- `npm test` passes, including property tests:
  - no approved amount ever exceeds the refundable remainder;
  - the recomputed clause amount is independent of the model's answer;
  - duplicates are blocked.
- With real sandbox keys, `npm run seed` creates captured orders. Approving 3 seeded cases produces 3 PayPal refunds, and the
  Ledger matches PayPal exactly, including one partial refund and one blocked duplicate.
- `AI_MODE=offline npm run dev` runs the whole UI without any AI key.
