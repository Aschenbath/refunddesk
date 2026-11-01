import { describe, expect, it } from "vitest";
import { zodSchema } from "ai";
import { proposalSchema } from "../src/core/types.js";
import { dropOptionalNulls, strictSchema } from "../src/server/codex-cli.js";

describe("codex-cli schema helpers", () => {
  it("makes every object strict with optional keys nullable", async () => {
    const strict = strictSchema(await zodSchema(proposalSchema).jsonSchema) as any;
    expect(strict.additionalProperties).toBe(false);
    expect(strict.required).toEqual(Object.keys(strict.properties));
    expect(strict.properties.proposed_facts.anyOf.at(-1)).toEqual({ type: "null" });
    expect(JSON.stringify(strict)).not.toContain("$schema");
  });
  it("drops null stand-ins for optional keys so the answer parses", async () => {
    const original = await zodSchema(proposalSchema).jsonSchema;
    const answer = { matched_order_id: null, match_evidence: [], intent: "question", policy_clause_ids: [], proposed_lines: [],
      proposed_total: 0, currency: "USD", customer_reply_draft: "Hi", confidence: 0.5, needs_human_reason: null, proposed_facts: null };
    const cleaned = dropOptionalNulls(answer, original) as Record<string, unknown>;
    expect("proposed_facts" in cleaned).toBe(false);
    expect(cleaned.matched_order_id).toBeNull(); // required nullable stays
    expect(proposalSchema.safeParse(cleaned).success).toBe(true);
  });
});
