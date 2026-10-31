import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitVendor } from "../scripts/ag-grid-chunks.js";
describe("AG Grid vendor chunking", () => {
  it("keeps dependency declarations and attached initializers intact", () => {
    const source = 'import { external } from "ag-stack";\nvar state = {}; state.value = "ready";\nfunction read() { return external(state.value); }\nexport { read };';
    const result = splitVendor(source);
    expect(result.parts.join("\n")).toContain('var state = {};\nstate.value = "ready";');
    expect(result.parts.join("\n")).toContain('function read() { return external(state.value); }');
    expect(result.facade).toContain('export { read };');
  });
  it("supports the installed AG Grid package and emits bounded source groups", () => {
    const result = splitVendor(readFileSync("node_modules/ag-grid-community/dist/package/main.esm.mjs", "utf8"));
    expect(result.parts.length).toBeGreaterThan(1);
    expect(result.parts.every((part) => part.length < 500_000)).toBe(true);
  });
});
