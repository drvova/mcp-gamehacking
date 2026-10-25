import { define } from "rstack";

// Library build. Bundleless ESM mirrors the previous `tsc` output:
// src/index.ts -> dist/index.js, plus type declarations.
define.lib({
  lib: [
    {
      format: "esm",
      bundle: false,
      dts: true,
    },
  ],
});

define.test({
  include: ["test/**/*.test.ts"],
});

define.lint(({ js, ts }) => [
  js.configs.recommended,
  ts.configs.recommended,
  {
    // The empty catch in `safeRead` is deliberate: it is a best-effort probe
    // that reports "unreadable" as null. Guard against a bare `catch {}` in new
    // code while allowing the existing, intentional one.
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
]);

define.fmt({
  // The codebase is written to ~100 columns (p95 of existing lines is 108),
  // so the default 80 would reflow far more than necessary.
  printWidth: 100,
  // The knowledge base under these directories is archived data, not source.
  // They are tracked in git (so .gitignore does not cover them) but reformatting
  // them would rewrite thousands of upstream files. Scope formatting to the
  // server's own source and docs.
  ignorePatterns: [
    "skills/**",
    "agents/**",
    "subagents/**",
    "plugins/**",
    "prompts/**",
    // Local-only working artifacts: excluded from git, so they are not source.
    "GATES.md",
    ".unlazy/**",
  ],
});
