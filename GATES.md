# Gates: mcp-gamehacking per-model tool profiles

Run every gate with `npm run test:gates`, or one with `npm run test:gate -- <name>`.
The checks live in `tools/checks/check.mjs` and spawn the BUILT server, so run
`npm run build` first.

Three checks read the skill archive (19 GB): they skip with a loud notice when
`skills/` is absent, which is the normal case in CI. Set `GATES_REQUIRE_ARCHIVE=1`
to make an absent archive a failure instead of a skip.

OWNS: src/index.ts, src/profiles/**, profiles/**, test/**, tools/checks/**, model-profiles/**, README.md, GATES.md

Scope: Give the mcp-gamehacking MCP server a per-model tooling layer. A profile owns a surface: which tools it carries, their order, and the wording of each. There is no generic base — an unrecognised caller gets ONE tool that reports the catalogue and composes a surface from it, because no base set suits every model. All 29 registered tools stay reachable regardless of profile, so a profile is presentation and never permission. The whole surface-management layer is one tool. Existing tool behaviour is unchanged.

- [x] G1: The built server boots and exposes the profile entry point
      CHECK: node tools/checks/check.mjs build-artifact
      EXPECT: gate-passed:build-artifact
  EVIDENCE: automatic-evidence=v1; definition-sha256=c46dc739a0d2cb990221a55f80c0930ff62ae74b208cef57cfaa155ededd5dc5; exit=0; EXPECT=matched; output-sha256=f755a3b6bf30f337017d1ad24df50a896119133e019823588a40b5933e7f6dae; output-bytes=27; shell=C:\WINDOWS\system32\cmd.exe; cwd=G:\mcp-gamehacking; path=ccd114205878/47 entries

- [x] G2: An unrecognised caller gets a ONE-tool seed, and that tool shows the whole catalogue to choose from
      CHECK: node tools/checks/check.mjs seed-surface
      EXPECT: gate-passed:seed-surface
  EVIDENCE: automatic-evidence=v1; definition-sha256=7322e18242ef81e5c629dfdbbb185ffef03b6a01041ab8aaf32e65d0d1902481; exit=0; EXPECT=matched; output-sha256=985ee1d93472dce6d11854aa70e0b3edc1072f8eb2858209bec7a21a071efd5a; output-bytes=25; shell=C:\WINDOWS\system32\cmd.exe; cwd=G:\mcp-gamehacking; path=ccd114205878/47 entries

- [x] G3: The catalogue publishes every registered tool and agrees with what tools/list serves
      CHECK: node tools/checks/check.mjs catalog-complete
      EXPECT: gate-passed:catalog-complete
  EVIDENCE: automatic-evidence=v1; definition-sha256=79b7ab112b0824228b28e7b752d1a21df8776a3d0bf2e3119ac090856dd5d434; exit=0; EXPECT=matched; output-sha256=02b647c5fe8629415cd10660e61ab0957cfdbff26433b75847dd63362004f9dd; output-bytes=29; shell=C:\WINDOWS\system32\cmd.exe; cwd=G:\mcp-gamehacking; path=ccd114205878/47 entries

- [x] G4: A profile owns how its tools are worded, and no override leaks into a profile that did not ask for it
      CHECK: node tools/checks/check.mjs descriptions-apply
      EXPECT: gate-passed:descriptions-apply
  EVIDENCE: automatic-evidence=v1; definition-sha256=6a6480f3fad544d1887fe5190b59450838b8f0e6c10f2ced494f9084ba60c5f9; exit=0; EXPECT=matched; output-sha256=99efa66228b0de710da0815b72cdf97c5309ac92636baaeb7c714c80b2ef4b3d; output-bytes=31; shell=C:\WINDOWS\system32\cmd.exe; cwd=G:\mcp-gamehacking; path=ccd114205878/47 entries

- [x] G5: Client identity resolves to the expected profile, with unknown as control
      CHECK: node tools/checks/check.mjs detect-client
      EXPECT: gate-passed:detect-client
  EVIDENCE: automatic-evidence=v1; definition-sha256=180ae89183c4ccbde9482ea6a448e64361d95f1ca56d3afc9bdaf534e1bafeb8; exit=0; EXPECT=matched; output-sha256=1513813a80f10964d25cbaefb3781b529152cb5cef2af5b2dc7227742ed6c1f1; output-bytes=26; shell=C:\WINDOWS\system32\cmd.exe; cwd=G:\mcp-gamehacking; path=ccd114205878/47 entries

- [x] G6: A per-request `_meta` override wins and reshapes the tool list
      CHECK: node tools/checks/check.mjs meta-override
      EXPECT: gate-passed:meta-override
  EVIDENCE: automatic-evidence=v1; definition-sha256=adf6f575f7eab3b71d6f27a62be7fe94ff4e659cd6a4928bd1443a9c799a5bdc; exit=0; EXPECT=matched; output-sha256=f2db3ff4acd699b548eccd455b55039d6471ed7ba4805880d79890285bd6325d; output-bytes=26; shell=C:\WINDOWS\system32\cmd.exe; cwd=G:\mcp-gamehacking; path=ccd114205878/47 entries

- [x] G7: Profile filtering is presentation-only; a tool the profile omits is still callable
      CHECK: node tools/checks/check.mjs filter-advisory
      EXPECT: gate-passed:filter-advisory
  EVIDENCE: automatic-evidence=v1; definition-sha256=8a9d4f1575e0b165863d83e27651a37af26670cfed41ae4150f3d6a85211c302; exit=0; EXPECT=matched; output-sha256=acc864be0602770ca1fadca9495679754e3ef0dc0c30fafa7c4232c1f2c1ec11; output-bytes=28; shell=C:\WINDOWS\system32\cmd.exe; cwd=G:\mcp-gamehacking; path=ccd114205878/47 entries

- [x] G8: A model-authored profile persists, including its own tool wording, and a new process can select it
      CHECK: node tools/checks/check.mjs author-profile
      EXPECT: gate-passed:author-profile
  EVIDENCE: automatic-evidence=v1; definition-sha256=e3244f136e3b6945e6df457e5c39f88ed5c0d7f9cc933a2b96687f6137cdf4be; exit=0; EXPECT=matched; output-sha256=5f349eec6fe503efb360e8ac87cc5e31474998df5d8e89d19fc7944791be24d4; output-bytes=27; shell=C:\WINDOWS\system32\cmd.exe; cwd=G:\mcp-gamehacking; path=ccd114205878/47 entries

- [x] G9: Hostile profile ids are rejected and write nothing outside the profile directory
      CHECK: node tools/checks/check.mjs id-safety
      EXPECT: gate-passed:id-safety
  EVIDENCE: automatic-evidence=v1; definition-sha256=104401acd1c56043b906d0a6e7b5e9731b977397ad93cb6a1ae0a51f3f0f6c86; exit=0; EXPECT=matched; output-sha256=cc3e44348774b98b994af084d31612e4edb94a72a33c3789611552214e1d36d8; output-bytes=22; shell=C:\WINDOWS\system32\cmd.exe; cwd=G:\mcp-gamehacking; path=ccd114205878/47 entries

- [x] G10: Built-in profiles carry distinct, substantive guidance rather than placeholders
      CHECK: node tools/checks/check.mjs profile-content
      EXPECT: gate-passed:profile-content
  EVIDENCE: automatic-evidence=v1; definition-sha256=705c9c35783c1c04c50d0ba414dd265804e98b714bfbba64b9dc4a324c04a4f9; exit=0; EXPECT=matched; output-sha256=a448f65839a3b15e3ca90b5f162b83d9947fb73e6784ce896397a9b614ea1706; output-bytes=28; shell=C:\WINDOWS\system32\cmd.exe; cwd=G:\mcp-gamehacking; path=ccd114205878/47 entries

- [x] G11: Existing tool behaviour is unchanged end to end
      CHECK: node tools/checks/check.mjs tool-smoke
      EXPECT: gate-passed:tool-smoke
  EVIDENCE: automatic-evidence=v1; definition-sha256=0d859b715aed3f4f7dd8ff14783955c20c3ebb5bba5dcc80e8ec0b7dd788d8de; exit=0; EXPECT=matched; output-sha256=eec44d2db4c5ae9dbb93b457212f99d7d0bc5433af2b368f6807711eed97834b; output-bytes=23; shell=C:\WINDOWS\system32\cmd.exe; cwd=G:\mcp-gamehacking; path=ccd114205878/47 entries

- [x] G12: Type checking, linting and formatting all pass
      CHECK: npm run check
      EXPECT: success Format check passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=69843f2e108c05ef3664c30709ae841ebb69edc3c03cc1646c92e031456e34af; exit=0; EXPECT=matched; output-sha256=24b5b4abec3618d2d8a04ca860c0395866f896e757131e0ba91e4cbd99fa5257; output-bytes=248; shell=C:\WINDOWS\system32\cmd.exe; cwd=G:\mcp-gamehacking; path=ccd114205878/47 entries

- [x] G13: The repository test suite passes, including the profile tests
      CHECK: npm test
      EXPECT: "status": "pass"
  EVIDENCE: automatic-evidence=v1; definition-sha256=f4aa0e37d41c40987e91d8bd40f9f61da99c028a7488fa56682db36ec763fdd3; exit=0; EXPECT=matched; output-sha256=d12020498bc2ad2e9b0bdaed4d7a4e706007541a9db149779c77766c8adfb9d6; output-bytes=720; shell=C:\WINDOWS\system32\cmd.exe; cwd=G:\mcp-gamehacking; path=ccd114205878/47 entries

- [x] G14: This ledger passes its own lint
      CHECK: node tools/checks/check.mjs ledger
      EXPECT: gate-passed:ledger
  EVIDENCE: automatic-evidence=v1; definition-sha256=deb8d681c3810acbde3764d6427dd0a29db0fa7aec64937914838ce63ac84494; exit=0; EXPECT=matched; output-sha256=86c225e401c74db6641bc8f9145f71f3824af9cd3be3a64834f3ad6fdafa6894; output-bytes=19; shell=C:\WINDOWS\system32\cmd.exe; cwd=G:\mcp-gamehacking; path=ccd114205878/47 entries

- [x] G15: Every profile carries the surface core, so no surface can trap a model, and switching out actually widens it
      CHECK: node tools/checks/check.mjs surface-escape
      EXPECT: gate-passed:surface-escape
  EVIDENCE: automatic-evidence=v1; definition-sha256=4f4d918d58073bed8eaf01471629080bec742da64987dbf9dc1557595bc797b7; exit=0; EXPECT=matched; output-sha256=b4178229e4c4ae8a50cfaf857817c6c0067a51a90b0c19b4fa597703eb54de4c; output-bytes=27; shell=C:\WINDOWS\system32\cmd.exe; cwd=G:\mcp-gamehacking; path=ccd114205878/47 entries

- [x] G16: A model composes its own surface with `pick`, and the seed is a single tool
      CHECK: node tools/checks/check.mjs compose-pick
      EXPECT: gate-passed:compose-pick
  EVIDENCE: automatic-evidence=v1; definition-sha256=335f840bf197c0241914c21d667189afed595873511d33f476486e70721bf33f; exit=0; EXPECT=matched; output-sha256=edcfda94ac0cb8ee24bf04398cb3a23d9e505016e47bd1a4ee77c7bfbe99b4b3; output-bytes=25; shell=C:\WINDOWS\system32\cmd.exe; cwd=G:\mcp-gamehacking; path=ccd114205878/47 entries

- [x] G17: The design is data, not code: no shipped surface id is hardcoded, and a surface added as a file is live with no rebuild
      CHECK: node tools/checks/check.mjs data-driven
      EXPECT: gate-passed:data-driven
  EVIDENCE: automatic-evidence=v1; definition-sha256=cba6efebffd7176068af8bd57d4a5ccc7a2bcbdb9baa630ff1575333508b5d9a; exit=0; EXPECT=matched; output-sha256=955a62fec9cad9724bd43ddc1ffb8e88fc3468fe35769a0d2c963c4831ea353c; output-bytes=24; shell=C:\WINDOWS\system32\cmd.exe; cwd=G:\mcp-gamehacking; path=ccd114205878/47 entries
