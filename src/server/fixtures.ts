import type { DeskCase, Order, Proposal } from "../core/types.js";

export const seededMessages = [
  {
    key: "damage-all",
    order: 1,
    sender: 0,
    subject: "Both mugs arrived broken :(",
    message:
      "Hi, Maya here. Order FC-1001 arrived this morning. Both moss mugs have cracked handles and sharp pieces in the box. The packaging was crushed. Can you refund the whole order please?",
  },
  {
    key: "late-shipping",
    order: 2,
    sender: 1,
    subject: "Delivery was weeks late",
    message:
      "Theo Bennett, order ending 1002. You promised delivery ages ago; it took another 12 business days! The bowl is lovely, but could you return my postage?",
  },
  {
    key: "received-return",
    order: 3,
    sender: 2,
    subject: "Return delivered back to you",
    message:
      "Hello, this is Amara Okafor. FC-1003 was not quite the right colour. I sent the planter back and your shop confirmed receipt. Please refund it. Thanks!",
  },
  {
    key: "duplicate",
    order: 1,
    sender: 0,
    subject: "Following up on my broken mugs",
    message:
      "Maya again, FC-1001. Both handles are cracked. I sent an email earlier but just checking you got it. Please refund those mugs.",
  },
  {
    key: "already-refunded",
    order: 4,
    sender: 3,
    subject: "Can I get that refund again?",
    message:
      "Luis Romero here, FC-1004. The bowl had a big crack down the middle. I already got a partial refund of $12, but can you send the refund again?",
  },
  {
    key: "wrong-amount",
    order: 5,
    sender: 4,
    subject: "I WANT $140 BACK",
    message:
      "FC-1005. Priya Shah. Both plates arrived shattered into tiny shards. This is ridiculous. I want $140 back including your delivery fee. Please sort this out today.",
  },
  {
    key: "spanish",
    order: 6,
    sender: 5,
    subject: "Mi taza llegó rota",
    message:
      "Hola, soy Sofía García. Mi pedido FC-1006 llegó con el asa rota y una grieta grande. Quisiera un reembolso de la taza y del envío, por favor. Gracias.",
  },
  {
    key: "very-late",
    order: 7,
    sender: 6,
    subject: "More than a month late",
    message:
      "Hi, Ben Walsh here. FC-1007 finally arrived, over 20 business days after your promised date. Both pieces are fine. I would like the shipping and the extra late-delivery refund in your policy.",
  },
  {
    key: "old-return",
    order: 8,
    sender: 7,
    subject: "Changed my mind after six weeks",
    message:
      "Iris Park — FC-1008. I bought this six weeks ago and have decided to redecorate. Can I return it for a refund?",
  },
  {
    key: "sale-return",
    order: 9,
    sender: 8,
    subject: "Return the clearance vase",
    message:
      "Noah Wilson, FC-1009. I know it was on sale but I have changed my mind. I returned it yesterday. Please refund me.",
  },
  {
    key: "return-pending",
    order: 10,
    sender: 9,
    subject: "Refund before I post it?",
    message:
      "June Taylor here, FC-1010. Changed my mind about the planter. I have not sent it back yet. Could you refund it now?",
  },
  {
    key: "ambiguous",
    order: 11,
    sender: 10,
    subject: "One of my mugs broke",
    message:
      "Hey it is Evan Brooks. I placed two orders recently and cannot find the number. One mug has a cracked base. Can you help with a refund?",
  },
  {
    key: "unknown",
    order: null,
    sender: null,
    subject: "Missing order number",
    message:
      "Bought a cup from you at some point. It was broken. I used a different email and cannot remember which. Can I get my money back? — Sam",
  },
  {
    key: "question",
    order: 13,
    sender: 12,
    subject: "Is it dishwasher safe?",
    message:
      "Ada Morgan, FC-1013. I love the new cup. Is the glaze dishwasher safe? Not asking for a refund, just checking.",
  },
  {
    key: "exchange",
    order: 14,
    sender: 13,
    subject: "Swap for a different colour?",
    message:
      "Oliver Reed here, FC-1014. Everything arrived safely. Would you exchange the mug for a blue one? I do not need a refund.",
  },
] as const;

// Deliberately hand-written model answers, separate from the deterministic calculator.
const fixtureAmounts: Record<
  string,
  {
    clauses: string[];
    amounts: number[];
    total: number;
    intent?: Proposal["intent"];
    reason?: string;
    confidence?: number;
  }
> = {
  "damage-all": {
    clauses: ["P1.1", "P1.2"],
    amounts: [4800, 800],
    total: 5600,
  },
  "late-shipping": { clauses: ["P2.1"], amounts: [800], total: 800 },
  "received-return": { clauses: ["P3.1"], amounts: [3200], total: 3200 },
  duplicate: { clauses: ["P1.1"], amounts: [4800], total: 4800 },
  "already-refunded": { clauses: ["P1.1"], amounts: [4800], total: 4800 },
  "wrong-amount": {
    clauses: ["P1.1", "P1.2"],
    amounts: [13200, 800],
    total: 14000,
  },
  spanish: { clauses: ["P1.1", "P1.2"], amounts: [2400, 800], total: 3200 },
  "very-late": {
    clauses: ["P2.1", "P2.2"],
    amounts: [800, 360, 570],
    total: 1730,
  },
  "old-return": { clauses: ["P3.2"], amounts: [], total: 0 },
  "sale-return": { clauses: ["P3.1", "P3.3"], amounts: [2200], total: 2200 },
  "return-pending": { clauses: ["P3.1"], amounts: [3200], total: 3200 },
  ambiguous: {
    clauses: ["P1.1"],
    amounts: [2400],
    total: 2400,
    confidence: 0.45,
    reason: "Two orders match Evan Brooks. Pick the affected order.",
  },
  unknown: {
    clauses: ["P1.1"],
    amounts: [],
    total: 0,
    confidence: 0.2,
    reason: "No order could be identified. Ask for an order number or email.",
  },
  question: { clauses: [], amounts: [], total: 0, intent: "question" },
  exchange: { clauses: [], amounts: [], total: 0, intent: "exchange" },
};
export function fixtureProposal(
  value: DeskCase,
  order: Order | null,
): Proposal | null {
  const fixture = value.fixture && fixtureAmounts[value.fixture];
  if (!fixture) return null;
  const ids = fixture.clauses[0]?.startsWith("P2")
    ? ["shipping", ...(order?.lines.map((line) => line.id) || [])]
    : [...(order?.lines.map((line) => line.id) || []), "shipping"];
  const evidence = order ? [order.id, value.sender] : [];
  return {
    matched_order_id: order?.id || null,
    match_evidence: evidence.filter((span) =>
      value.message.toLowerCase().includes(span.toLowerCase()),
    ),
    intent: fixture.intent || "refund",
    policy_clause_ids: fixture.clauses,
    proposed_lines: fixture.amounts.map((amount, index) => ({
      item: ids[index] || "unknown",
      reason: "Customer request under cited policy",
      amount,
    })),
    proposed_total: fixture.total,
    currency: "USD",
    confidence: fixture.confidence ?? 0.96,
    needs_human_reason: fixture.reason ?? null,
    customer_reply_draft:
      value.fixture === "spanish"
        ? "Hola Sofía, sentimos que tu taza haya llegado rota. Podemos revisar un reembolso de la taza y del envío según nuestra política. Te confirmaremos el importe tras la aprobación."
        : fixture.intent === "question"
          ? "Hi Ada, thank you for checking. We recommend hand washing handmade ceramics to protect the glaze."
          : fixture.intent === "exchange"
            ? "Hi Oliver, we can help check availability for an exchange. We will confirm the colour with you."
            : `Hi ${value.sender.split(" ")[0]}, thank you for letting us know. We have reviewed your request against our policy. ${fixture.reason || "We will confirm the eligible amount once the shop owner has reviewed it."}`,
  };
}
