# Gates: mcp-gamehacking per-model tool profiles

Run every gate with `npm run test:gates`, or one with `npm run test:gate -- <name>`.
The checks live in `tools/checks/check.mjs` and spawn the BUILT server, so run
`npm run build` first.

Three checks read the skill archive (19 GB): they skip with a loud notice when
`skills/` is absent, which is the normal case in CI. Set `GATES_REQUIRE_ARCHIVE=1`
to make an absent archive a failure instead of a skip.

OWNS: src/index.ts, src/profiles/**, test/**, tools/checks/**, model-profiles/**, README.md, GATES.md

Scope: Give the mcp-gamehacking MCP server a per-model tooling layer. A profile owns a surface: which tools it carries, their order, and the wording of each. There is no generic base — an unrecognised caller gets ONE tool that reports the catalogue and composes a surface from it, because no base set suits every model. All 29 registered tools stay reachable regardless of profile, so a profile is presentation and never permission. The whole surface-management layer is one tool. Existing tool behaviour is unchanged.

- [x] G1:  The built server boots and exposes the profile entry point
  CHECK: node tools/checks/check.mjs build-artifact
  EXPECT: gate-passed:build-artifact

- [x] G2:  An unrecognised caller gets a ONE-tool seed, and that tool shows the whole catalogue to choose from
  CHECK: node tools/checks/check.mjs seed-surface
  EXPECT: gate-passed:seed-surface

- [x] G3:  The catalogue publishes every registered tool and agrees with what tools/list serves
  CHECK: node tools/checks/check.mjs catalog-complete
  EXPECT: gate-passed:catalog-complete

- [x] G4:  A profile owns how its tools are worded, and no override leaks into a profile that did not ask for it
  CHECK: node tools/checks/check.mjs descriptions-apply
  EXPECT: gate-passed:descriptions-apply

- [x] G5:  Client identity resolves to the expected profile, with unknown as control
  CHECK: node tools/checks/check.mjs detect-client
  EXPECT: gate-passed:detect-client

- [x] G6:  A per-request `_meta` override wins and reshapes the tool list
  CHECK: node tools/checks/check.mjs meta-override
  EXPECT: gate-passed:meta-override

- [x] G7:  Profile filtering is presentation-only; a tool the profile omits is still callable
  CHECK: node tools/checks/check.mjs filter-advisory
  EXPECT: gate-passed:filter-advisory

- [x] G8:  A model-authored profile persists, including its own tool wording, and a new process can select it
  CHECK: node tools/checks/check.mjs author-profile
  EXPECT: gate-passed:author-profile

- [x] G9:  Hostile profile ids are rejected and write nothing outside the profile directory
  CHECK: node tools/checks/check.mjs id-safety
  EXPECT: gate-passed:id-safety

- [x] G10: Built-in profiles carry distinct, substantive guidance rather than placeholders
  CHECK: node tools/checks/check.mjs profile-content
  EXPECT: gate-passed:profile-content

- [x] G11: Existing tool behaviour is unchanged end to end
  CHECK: node tools/checks/check.mjs tool-smoke
  EXPECT: gate-passed:tool-smoke

- [x] G12: Type checking, linting and formatting all pass
  CHECK: npm run check
  EXPECT: success Format check passed

- [x] G13: The repository test suite passes, including the profile tests
  CHECK: npm test
  EXPECT: "status": "pass"

- [x] G14: This ledger passes its own lint
  CHECK: node tools/checks/check.mjs ledger
  EXPECT: gate-passed:ledger

- [x] G15: Every profile carries the surface core, so no surface can trap a model, and switching out actually widens it
  CHECK: node tools/checks/check.mjs surface-escape
  EXPECT: gate-passed:surface-escape

- [x] G16: A model composes its own surface with `pick`, and the seed is a single tool
  CHECK: node tools/checks/check.mjs compose-pick
  EXPECT: gate-passed:compose-pick
