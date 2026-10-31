import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Node 24 strips TypeScript natively. Resolve emitted .js specifiers to source .ts during development.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".") &&
      specifier.endsWith(".js") &&
      context.parentURL?.startsWith("file:")
    ) {
      const candidate = new URL(
        specifier.slice(0, -3) + ".ts",
        context.parentURL,
      );
      if (
        !candidate.pathname.includes("/node_modules/") &&
        existsSync(fileURLToPath(candidate))
      )
        return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});
