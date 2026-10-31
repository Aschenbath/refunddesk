import { parseSync } from "rolldown/utils";
import type { Plugin } from "vite";

// AG Grid publishes one flattened ESM file. Ordinary manualChunks cannot divide
// that file. Reconstruct dependency groups as virtual ESM modules, keeping the
// vendor's statements intact. SCCs stay together; groups are packed in dependency
// order so eager initializers cannot acquire a cross-chunk cycle.
type Node = { type: string; start: number; end: number; [key: string]: any };
const prefix = "\0refunddesk-ag-part-";
export function splitVendor(code: string) {
  const parsed = parseSync("ag-grid.mjs", code);
  if (parsed.errors.length) throw new Error("Cannot parse AG Grid ESM");
  const body = parsed.program.body as Node[];
  const imports = body.filter((node) => node.type === "ImportDeclaration").map((node) => code.slice(node.start, node.end)).join("\n");
  const exports = body.filter((node) => node.type === "ExportNamedDeclaration");
  const nodes = body.filter((node) => ["VariableDeclaration", "FunctionDeclaration"].includes(node.type));
  const owner = new Map<string, number>();
  const names = nodes.map((node, index): string[] => {
    const result = node.type === "FunctionDeclaration" ? [node.id.name] : node.declarations.map((value: Node) => value.id.name);
    for (const name of result) {
      if (!name || owner.has(name)) throw new Error("Unsupported AG Grid declaration; update the chunk adapter");
      owner.set(name, index);
    }
    return result;
  });
  const refs = (node: unknown, result = new Set<string>()): Set<string> => {
    if (!node || typeof node !== "object") return result;
    const value = node as Node;
    if (value.type === "Identifier") result.add(value.name);
    for (const [key, child] of Object.entries(value)) {
      if (["start", "end", "loc", "raw", "name"].includes(key)) continue;
      if (key === "property" && value.type === "MemberExpression" && !value.computed) continue;
      if (key === "key" && ["Property", "MethodDefinition"].includes(value.type) && !value.computed && !value.shorthand) continue;
      if (Array.isArray(child)) child.forEach((item) => refs(item, result));
      else if (child && typeof child === "object") refs(child, result);
    }
    return result;
  };
  const statements = nodes.map((node) => [node]);
  for (const node of body.filter((node) => !["ImportDeclaration", "ExportNamedDeclaration", "VariableDeclaration", "FunctionDeclaration"].includes(node.type))) {
    if (node.type !== "ExpressionStatement") throw new Error("Unsupported AG Grid statement");
    const targets = [...refs(node)].filter((name) => owner.has(name));
    if (targets.length !== 1) throw new Error("Unsupported AG Grid initializer");
    statements[owner.get(targets[0])!].push(node);
  }
  const graph = statements.map((list, index) => [...new Set(list.flatMap((node) => [...refs(node)]))].map((name) => owner.get(name)).filter((value): value is number => value !== undefined && value !== index));
  let sequence = 0;
  const indices: number[] = [], low: number[] = [], stack: number[] = [], active = new Set<number>(), components: number[][] = [];
  const visit = (value: number) => {
    indices[value] = low[value] = sequence++; stack.push(value); active.add(value);
    for (const target of graph[value]) {
      if (indices[target] === undefined) { visit(target); low[value] = Math.min(low[value], low[target]); }
      else if (active.has(target)) low[value] = Math.min(low[value], indices[target]);
    }
    if (low[value] === indices[value]) {
      const component: number[] = []; let target: number;
      do { target = stack.pop()!; active.delete(target); component.push(target); } while (target !== value);
      components.push(component);
    }
  };
  nodes.forEach((_, index) => { if (indices[index] === undefined) visit(index); });
  const groups: number[][] = []; let current: number[] = [], size = 0;
  for (const component of components) {
    const bytes = component.reduce((sum, index) => sum + statements[index].reduce((sum, node) => sum + node.end - node.start, 0), 0);
    if (size + bytes > 350_000 && current.length) { groups.push(current); current = []; size = 0; }
    current.push(...component); size += bytes;
  }
  if (current.length) groups.push(current);
  const groupFor = new Map<number, number>();
  groups.forEach((group, index) => group.forEach((node) => groupFor.set(node, index)));
  const parts = groups.map((group, index) => {
    const dependencies = new Map<number, Set<string>>();
    for (const node of group) for (const target of graph[node]) {
      const remote = groupFor.get(target)!;
      if (remote !== index) { const set = dependencies.get(remote) || new Set<string>(); names[target].forEach((name) => set.add(name)); dependencies.set(remote, set); }
    }
    return imports + "\n" + [...dependencies].map(([remote, values]) => `import { ${[...values].join(", ")} } from ${JSON.stringify(prefix + remote)};`).join("\n") + "\n" +
      group.flatMap((index) => statements[index]).sort((a, b) => a.start - b.start).map((node) => code.slice(node.start, node.end)).join("\n") +
      `\nexport { ${group.flatMap((index) => names[index]).join(", ")} };`;
  });
  const facade = imports + "\n" + groups.map((group, index) => `import { ${group.flatMap((index) => names[index]).join(", ")} } from ${JSON.stringify(prefix + index)};`).join("\n") + "\n" + exports.map((node) => code.slice(node.start, node.end)).join("\n");
  return { facade, parts };
}
export function agGridChunks(): Plugin {
  let parts: string[] = [];
  return { name: "refunddesk-ag-grid-chunks", apply: "build", enforce: "pre",
    resolveId(id) { if (id.startsWith(prefix)) return id; },
    load(id) { if (id.startsWith(prefix)) return parts[Number(id.slice(prefix.length))]; },
    transform(code, id) {
      if (!/ag-grid-community[\\/]dist[\\/]package[\\/]main\.esm\.mjs$/.test(id)) return;
      const result = splitVendor(code); parts = result.parts; return { code: result.facade, map: null };
    },
  };
}
