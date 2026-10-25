# Gates: mcp-gamehacking — the model builds its own tooling

Run every gate with `npm run test:gates`, or one with `npm run test:gate -- <name>`.
The checks live in `tools/checks/check.mjs` and spawn the BUILT server, so run
`npm run build` first.

One check reads the skill archive (19 GB) and skips with a loud notice when
`skills/` is absent, which is the normal case in CI. Set `GATES_REQUIRE_ARCHIVE=1`
to make an absent archive a failure instead of a skip.

OWNS: src/index.ts, src/profiles/**, profiles/**, model-profiles/**, test/**, tools/checks/**, README.md, GATES.md

Scope: A model builds its own tooling. The server ships no base of tools and no catalogue of surfaces to choose from — one seed tool, the whole tool catalogue, and the means to compose, keep and revise a surface from it. Nothing is pre-authored on the model's behalf.

- [x] G1: The built server boots, points a model at `surface`, and carries it in the seed
  CHECK: node tools/checks/check.mjs build-artifact
  EXPECT: gate-passed:build-artifact

- [x] G2: No pre-authored base ships: exactly one surface exists in the repository, and it is the seed
  CHECK: node tools/checks/check.mjs no-pre-authored-base
  EXPECT: gate-passed:no-pre-authored-base

- [x] G3: The seed is one tool, and its report shows the whole catalogue so there is something to choose from
  CHECK: node tools/checks/check.mjs seed-surface
  EXPECT: gate-passed:seed-surface

- [x] G4: A model composes its own surface with `pick`: order honoured, typos reported, an empty pick refused
  CHECK: node tools/checks/check.mjs compose-pick
  EXPECT: gate-passed:compose-pick

- [x] G5: The catalogue publishes every registered tool, agrees with what `tools/list` serves, and an omitted tool stays callable
  CHECK: node tools/checks/check.mjs catalog-complete
  EXPECT: gate-passed:catalog-complete

- [x] G6: A surface a model built is saved, survives the process, is recallable by name and by `_meta`, and can be revised
  CHECK: node tools/checks/check.mjs save-recall
  EXPECT: gate-passed:save-recall

- [x] G7: Hostile surface ids are refused and write nothing outside the profiles directory
  CHECK: node tools/checks/check.mjs id-safety
  EXPECT: gate-passed:id-safety

- [x] G8: Every surface carries the core, so none can trap a model, and composing or clearing keeps it
  CHECK: node tools/checks/check.mjs surface-escape
  EXPECT: gate-passed:surface-escape

- [x] G9: Every client lands on the seed, proving detection hands no client a base set
  CHECK: node tools/checks/check.mjs detect-client
  EXPECT: gate-passed:detect-client

- [x] G10: Omission is presentation only: a tool the seed does not carry still works when called by name
  CHECK: node tools/checks/check.mjs filter-advisory
  EXPECT: gate-passed:filter-advisory

- [x] G11: The declared runtime floor is honoured: no source or harness file uses an API newer than engines.node
  CHECK: node tools/checks/check.mjs engines-honoured
  EXPECT: gate-passed:engines-honoured

- [x] G12: The design is data, not code: no surface id is hardcoded, and a surface added as a file is live with no rebuild
  CHECK: node tools/checks/check.mjs data-driven
  EXPECT: gate-passed:data-driven

- [x] G13: Existing tool behaviour is unchanged end to end
  CHECK: node tools/checks/check.mjs tool-smoke
  EXPECT: gate-passed:tool-smoke

- [x] G14: This ledger passes its own lint
  CHECK: node tools/checks/check.mjs ledger
  EXPECT: gate-passed:ledger

- [x] G15: A model may define its own tools by binding arguments: the bound argument leaves the schema, the tool works when called with nothing, a caller cannot undo the binding, and it survives a save and a fresh process
  CHECK: node tools/checks/check.mjs derived-tools
  EXPECT: gate-passed:derived-tools

- [x] G16: A surface cannot lie: a duplicate alias, a stolen tool name and a bogus bound argument are all refused (and all reported at once), and a hand-edited file is held to the same rules with the listing and the call agreeing
  CHECK: node tools/checks/check.mjs derived-guards
  EXPECT: gate-passed:derived-guards

- [x] G17: An argument can be defaulted (stays, omittable, shown) or constrained (narrows and is enforced), the schema says what will actually happen, and a constraint the tool's own default would break is refused rather than shipped
  CHECK: node tools/checks/check.mjs derived-narrowing
  EXPECT: gate-passed:derived-narrowing
