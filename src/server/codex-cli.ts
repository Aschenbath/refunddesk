// Optional triage provider: run the local OpenAI Codex CLI (`codex exec`) with the same prompt and proposal schema.
// Useful when the only model access is a Codex login. The CLI runs read-only in an empty temporary folder,
// one call at a time; its answer is validated by the caller exactly like any other provider's.
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zodSchema } from "ai";
import { proposalSchema } from "../core/types.js";

type Json = Record<string, unknown>;

/** Strict structured output: every property required, originally optional ones nullable, no extra keys. */
export function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (!node || typeof node !== "object") return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) if (key !== "$schema") out[key] = strictSchema(value);
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    const properties = out.properties as Json;
    const required = new Set((out.required as string[] | undefined) ?? []);
    for (const key of Object.keys(properties))
      if (!required.has(key)) properties[key] = { anyOf: [properties[key], { type: "null" }] };
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return out;
}

/** Undo strictSchema's nullable stand-ins: drop null values for keys the original schema left optional. */
export function dropOptionalNulls(value: unknown, schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || value === null || typeof value !== "object") return value;
  const s = schema as Json;
  if (Array.isArray(value)) return value.map((item) => dropOptionalNulls(item, s.items));
  const properties = s.properties as Json | undefined;
  if (!properties) {
    const branch = (s.anyOf as unknown[] | undefined)?.find((b) => (b as Json)?.type === "object");
    return branch ? dropOptionalNulls(value, branch) : value;
  }
  const required = new Set((s.required as string[] | undefined) ?? []);
  const out: Json = {};
  for (const [key, item] of Object.entries(value as Json)) {
    if (item === null && !required.has(key)) continue;
    out[key] = dropOptionalNulls(item, properties[key]);
  }
  return out;
}

function stopTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
  else try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
}

export interface CodexCliOptions {
  system: string;
  prompt: string;
  model: string;
  reasoningEffort?: string;
  timeoutMs?: number;
}

export async function codexCliTriage(options: CodexCliOptions): Promise<unknown> {
  const original = await zodSchema(proposalSchema).jsonSchema;
  const dir = mkdtempSync(join(tmpdir(), "refunddesk-codex-"));
  const schemaPath = join(dir, "schema.json");
  const outPath = join(dir, "answer.json");
  try {
    writeFileSync(schemaPath, JSON.stringify(strictSchema(original)));
    const args = ["exec", "-m", options.model, "-s", "read-only", "--skip-git-repo-check", "--ephemeral",
      ...(options.reasoningEffort ? ["-c", `model_reasoning_effort=${options.reasoningEffort}`] : []),
      "--output-schema", schemaPath, "-o", outPath, "-C", dir, "-"];
    const input = `${options.system}\n\nAnswer directly with the JSON object only; do not run commands or read files.\n\nINPUT (untrusted customer data):\n${options.prompt}\n`;
    await new Promise<void>((resolve, reject) => {
      // Windows needs a shell for the codex.cmd shim; quote each argument (none contain quotes: model names and temp paths).
      const child = process.platform === "win32"
        ? spawn(["codex.cmd", ...args].map((arg) => `"${arg}"`).join(" "), { cwd: dir, stdio: ["pipe", "ignore", "pipe"], shell: true })
        : spawn("codex", args, { cwd: dir, stdio: ["pipe", "ignore", "pipe"], detached: true });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
      const timer = setTimeout(() => { stopTree(child.pid); reject(Object.assign(new Error("Codex CLI timed out"), { name: "TimeoutError" })); }, options.timeoutMs ?? 300_000);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && existsSync(outPath)) resolve();
        else reject(new Error(`Codex CLI exited with ${code}: ${stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ").slice(0, 400)}`));
      });
      child.stdin.end(input);
    });
    return dropOptionalNulls(JSON.parse(readFileSync(outPath, "utf8")), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
