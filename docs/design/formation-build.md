# kiln formation and build: decision record

Date: 2026-09-04
Status: shared understanding reached after a three-round agent-versus-agent design grill (87
questions, 20 challenges, 19 consistency findings, a per-item over-concession audit) plus nine
controller rulings. No human took part; every open decision was made by the owner-agent or by the
controller, and each carries a rationale and a cost-if-wrong. This record is the input to the
Formation-and-Build implementation plan.

**Precedence.** Where this record differs from the design spec
`docs/superpowers/specs/2026-09-02-kiln-ideation-harness-design.md`, **this record wins**. The design
spec is not edited; it remains the historical document, exactly as it relates to the ideation loop
through `docs/superpowers/specs/2026-09-03-kiln-ideation-loop-decisions.md`. §18 below lists every
spec section this record overrides, with the old wording and the new binding wording. A spec section
not listed there stands unchanged.

**Inheritance.** The ideation-loop decision record is binding precedent, not a suggestion. Its
mechanisms are extended here rather than re-invented: failure classes; a derived sub-budget with a
floor, where whole units are skipped rather than truncated; protected harness-owned files; resume
idempotent-by-file with the cursor as a hint; stop kinds distinct from failures; the mechanical-floor
honest exit counted apart from the declared one; metrics as a fold over the record; the stateless
worker idiom (one decision tool, `terminalTools`, a turn cap of 1-2, one retry then a recorded
degenerate outcome); and the schema-task-first rule.

Sources: `.superpowers/sdd/grill-formation-build/round-1-questions.md`, `round-1-answers.md`,
`round-2-challenges.md`, `round-2-answers.md`, `round-3-consistency.md`, `cost-model.md`,
`design-status.md`.

---

## 0. Controller rulings

Nine decisions the controller made, either on a residual conflict the two agents could not settle or
to correct a remedy the round-3 over-concession audit found had overreached. Each is binding.

| # | Ruling |
|---|---|
| 1 | **Turn caps are runaway guards; paid-turn dispatch is gated by `usdCap`.** All turn caps return to the design spec's §8 placeholders; every seat in form and build instead carries a dollar threshold checked at turn boundaries. The crossing turn is allowed to finish, as ruling 3 now states explicitly. Spec override 8 (the turn-cap cut) is withdrawn. |
| 2 | **Formation gets a dollar ceiling, not a turn cut.** Its base allocation is `share.form x budgets.usd = $1.375`; its effective one-attempt ceiling also receives unused earlier-phase allocation through §12's forward ledger. Roll-forward is headroom inside that one attempt and never increases `formationAttempts`; `budgets.turns.form` stays 30. |
| 3 | **`budgets.usd` is a planning target, not a hard cap.** $23.22 is the expected projection and $26.88 is an **estimated high-water envelope under the cost model's assumed turn shape**, not a proven worst case. Turn-boundary `usdCap` checks can overshoot by the next turn, and v1 has no numeric bound on that turn without pre-dispatch cost reservation and maximum-output limits. `budgetOvershootUsd` is recorded. |
| 4 | **Arm B gets equal total budget and equal total turns**, not equal per-attempt caps, because §5.4 says "one long session with the same budget". |
| 5 | **`featuresPassed` splits into `{ executed, humanVerified }`**; `executed` is the headline everywhere. A human-verified `manual` feature passes, and never enters `executed`. |
| 6 | **`overBudgetPlan` is restored, re-scoped** to the run's observed mean attempt cost after three attempts. |
| 7 | **The wall-clock sizing assertion moves to `validateFeatures`**; the per-check 2T scope cap stands alone; the partial sweep is a recorded deadline-imminent degradation, not a sizing policy. |
| 8 | **Two audit cap sets, one pure truncator** — stored audits stay large, the pinned copy is produced by `pinAudit()`. |
| 9 | **"Additive-only" is scoped** to the shared closed unions and the files the ideation stream edits; **`init.sh` runs at build entry**, while the initial commit is made at freeze. |

The over-concession audit's verdict on round 2, recorded because a defender that concedes twenty for
twenty is itself a signal: **14 concessions sound, 6 sound with an overreaching remedy, 0 that should
have been rejections.** Eighteen of twenty challenges attacked the answer set with its own material —
twelve internal contradictions or arithmetic over caps the answer set itself chose, four decisive
one-line code facts independently re-verified. Four round-2 rulings refused the challenge's preferred
remedy on a spec or invariant argument, or corrected the challenge's premise, which is the evidence
against reflexive agreement. The over-concession was real and lived entirely in the remedies;
rulings 1, 6, 7, 8 and 9 above correct all six.

---

## 1. Scope and phases

- This record governs three phases: **form** (§4.4 of the spec), **build** (§4.5) and **reflect**
  (§4.6). Ideate and the checkpoint belong to the ideation-loop record; the evals and evolution
  pipeline belongs to its own later plan and this record only writes candidates into it.
- The idea shape frozen at frame exit is re-asserted at form and at build entry.
  `assertShapeFrozen(deps): PhaseResult | undefined` is extracted from `src/phases/discover.ts` and
  called by all three phases; today only discover implements it.
- Formation is one brain session plus two critic calls. Build is a loop of fresh builder sessions,
  each verified by the harness and audited by an independent read-only seat. Reflect is one
  reflector call over a harness-computed digest. Nothing in these phases runs concurrently: the
  shared `Limiter` is not used, and the loop is strictly sequential, one model call and one process
  at a time, including the regression sweep.

**ADR scope.** ADRs 0007–0013 govern the future production harness described by
`AGENTIC_HARNESS_PLAN.md`, not this standalone kiln prototype. Kiln borrows the compatible principles
that deterministic delivery, Git bookkeeping and budget arithmetic should not purchase model turns
(ADR 0009), that originals are retained before lossy projection (ADR 0012), and that a verifier does
not activate or integrate its own result (ADR 0013). This plan does **not** claim to implement the
AgentInstance materialization authority, ContextManifest, narrowing-only organization policy, or
progressive capability registry of ADRs 0007, 0008, 0010 and 0011.

## 2. The project directory, roots, and the protection boundary

- With no `--out`, the project directory **is** `<run.dir>/project/`, a real directory. With
  `--out DIR` the project is created at `DIR` and `<run.dir>/project` is a symlink to it, so
  `join(run.dir, "project")` is the one entry point in every downstream path. `insideRoots` already
  resolves symlinks through `realPath` on both sides. **Stated consequence: by default the project
  lives inside the run directory**, so `kiln run list`, a tarball of `runs/`, and
  `~/.kiln/.gitignore`'s `runs/` line all cover a user's product.
- `projectPaths(dir): ProjectPaths` is pure and synchronous, in `src/formation/paths.ts`. `RunPaths`
  gains exactly one field for this, `project`; `runPaths` stays pure and never reads `status.json`.
- At creation the harness writes `<project>/project.json` = `{ runId, ideaId, kilnVersion,
  createdAt }`. A directory is adopted when it is empty, when it holds only `project.json` plus empty
  `checks/` and `blocked/`, or when its `project.json` names this run **and** this idea; anything
  else — including a directory containing only `.git` — is refused with a message naming the marker,
  and `--force` is the only override. `--force` authorizes adoption; it does not delete unrelated
  contents. `git init` runs only when `.git` is absent. With `--out`, the harness first adopts or
  refuses the resolved external directory and then atomically creates `<run.dir>/project` as a
  symlink to it; without `--out`, it creates that path as a real directory. In both cases it writes
  the resolved directory to `status.projectDir`. An existing link with the wrong target is refused
  unless `--force`, and replacement is atomic. `project.json.ideaId` is load-bearing: a differing `ideaId`
  deletes `spec.md`, `<project>/features.json`, `init.sh` and any lock, and re-forms from scratch.
- **Roots.** Form gets `cwd` and `roots = [project.dir]`. Build gets `cwd = <project>/repo` and
  `roots = [project.repo]`. The form brain reads run artifacts by absolute path, which `read` permits
  because `read` has no root check. The builder's only writable place outside the repo is
  `repo/.kiln-scratch/`, which is inside the repo by construction and is gitignored.
- `ToolContext` gains `protectedPaths?: string[]` and `protectedDirs?: string[]`, consulted by
  `isProtectedRunFile` in addition to its own hard-wired list. **The function is not renamed** (that
  rename would touch files the ideation stream is editing). In form the caller supplies
  `protectedPaths = [<project>/project.json]` and `protectedDirs = [<project>/checks,
  <project>/blocked]`. `spec.md`, `<project>/features.json` and `init.sh` stay writable during
  formation because writing them is how formation produces them.

## 3. `spec.md` and `features.json`

- `SPEC_SECTIONS = ["What", "For whom", "Why now", "Scope", "Non-goals", "Risks", "First
  milestone"]`, all seven required as `##` headings, plus three content assertions: First milestone
  non-empty and at most 600 characters, Scope has at least one bullet, Non-goals has at least one
  bullet. One re-ask, then a `verify` failure.
- One form brain session performs three sequential validated writes on the same brain object:
  `spec.md`, then `features.json` validated against the parsed spec, then `init.sh` (validated only
  for existence, non-empty, and a leading `#!`).
- `features.json` is `{ version: 1, init: { needs: string[] }, features: [{ id, title, description,
  acceptance }] }`. **A feature record carries no mutable fields**: `passes`, `attempts`, `blocked`,
  `regressedBy` and `repairs` are folded from `state.jsonl`. There is no `dependsOn` and no
  `milestone` flag; the whole list *is* the first milestone by definition.
- Ids are `f01`..`f12`, assigned by the **harness** immediately after the first validated write and
  carried unchanged through the critique revision. A revision that renames, reorders or drops an id
  is a validation problem with one re-ask.
- **Feature count.** `minFeatures = 3`. `maxFeatures = min(12, floor(budgets.usd x
  budgets.share.build / (cfg.build.expectedAttempts x expectedAttemptUsd)))`, which is **8** at the
  defaults; 12 survives only as a schema ceiling and is reachable at `budgets.usd >= $36.42`. A list
  longer than `maxFeatures` is a validation problem with one re-ask, then a `verify` failure.
- **`validateFeatures` also carries the wall-clock sizing assertion** (controller ruling 7), in
  expected values rather than ceilings:
  `F(F-1)/2 x expectedCheckMs + F x expectedAttempts x expectedCheckMs + expectedInitMs <=
  buildWallShare x 0.35`, with `cfg.build.expectedCheckSeconds: 30` and `expectedInitSeconds: 120`
  before any observation. At F = 8 that is 1,272 s against 6,840 s and passes. It lives at formation
  time because at build entry the list is frozen and its ids are hashed into the lock, so reducing
  the count there is either inoperative or an `integrity` failure.
- List order is advisory. First-fit picks the first feature with `passes: false`, `attempts <
  maxAttempts` and not blocked, skipping blocked ones and continuing; every skip past a blocked
  feature increments `skippedAfterBlocked`.

## 4. Acceptance checks, their environment, and the regression sweep

- **Three types only: `shell`, `file`, `manual`.** No HTTP runner and no rendered-page runner
  (override 1).
  `{ type: "shell", command, expect?, timeoutSeconds?, needs?: string[] }`,
  `{ type: "file", path, contains?, needs?: string[] }`,
  `{ type: "manual", instructions }`.
- A shell check runs `sh -c <command>` with `cwd = <project>/repo` and
  `timeoutMs = min((acceptance.timeoutSeconds ?? 300) x 1000, cfg.build.checkTimeoutSeconds x 1000)`
  through `runProcess`, and **passes when the exit code is 0 and, when an `expect` predicate is
  present, the predicate matches the combined stdout+stderr**. A `file` check passes when the path
  exists relative to `repo/` and, with `contains`, the file's text contains it. `predicateMatches` is
  exported from `src/ideation/probe.ts` and a named `Predicate` type is added there; the check runner
  imports both rather than copying them.
- **Triviality screen at validate time.** A shell command is rejected when, after normalising
  whitespace and stripping a trailing `;`, its whole body is in `{ true, :, exit 0, test 1 = 1,
  [ 1 = 1 ], /bin/true }`, or when its first word is one of `echo`, `printf`, `true`, `:` and it
  carries neither an `expect` predicate nor a path-shaped token. One re-ask, then a `verify` failure.
  `bun test`, `make check` and any bare test-runner invocation are unaffected.
- **Environment: an allowlist, not a denylist** (override 10). Acceptance checks, regression checks
  and `init.sh` run with `envReplace: true` and exactly `PATH`, `HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`,
  `TMPDIR`, `TZ`, `SHELL`, `USER`, `TERM=dumb`, plus the names in `acceptance.needs` /
  `features.init.needs`. `redactEnv()` is **not** used on that path: `isSecretEnvName` matches only
  the suffixes `_API_KEY`, `_TOKEN`, `_SECRET` and two OAuth names, and returns **false** for
  `AWS_SECRET_ACCESS_KEY`, `AWS_ACCESS_KEY_ID`, `GITHUB_PAT`, `DATABASE_URL`, `STRIPE_SK` and
  `GOOGLE_APPLICATION_CREDENTIALS` (verified in `src/core/secrets.ts`). `checkNeeds` is called with
  `{ env: checkEnv(needs) }` rather than its `redactEnv()` default. A declared need that is absent
  makes the feature `blocked: missing_dependency:<name>` with **zero attempts spent**. `needs` is
  inside the object hashed into `acceptance.lock`, so widening it after freeze is `integrity` and
  terminal. The builder's own `bash` keeps the widened denylist, and §17 records that the builder
  shell's undeclared exposure is the larger and unobserved one.
- **Manual features.** In autonomous mode a `manual` feature is `blocked: not_verifiable` before any
  builder session, with zero attempts. In interactive mode the harness asks once through the injected
  `io.ask` and records the answer as a `feature.state` transition with `source: "human"`; a human
  "yes" sets `passes: true` and counts in `featuresPassed.humanVerified`, **never** in
  `featuresPassed.executed` (controller ruling 5). The first feature's acceptance must be executable,
  and at least one executable check is required overall.
- **Captured check output** goes to
  `<project>/checks/<phase>-<feature-or-init>-a<attempt>-<checkId>.txt`, where `checkId` is a
  harness-generated UUID recorded on the `check` event, so repeated regression sweeps never overwrite
  earlier evidence. `runProcess` is called with `maxOutputBytes = cfg.build.checkOutputBytes` (default
  8 MiB); the file contains every captured byte and `outputTruncated` says whether the process runner
  dropped a middle region. The `check` event and `CheckResult` also carry `outputPath` and
  `overrunMs`. `progress.md` gets `excerpt(output, 20, 20)` further capped at 1,000 characters
  (`excerpt` truncates by lines only, so the character cap is separate and explicit); the auditor gets
  the excerpt inline plus the path.
- **Regression sweep.** After every passing feature is committed, the harness re-runs every earlier
  passing check, **each with `timeoutMs = min(checkTimeoutSeconds x 1000, max(5000, 2 x that check's
  last passing durationMs))`** — the duration is already on the `check` event. A regression marks the
  earlier feature `passes: false` with `regressedBy`, **resets its `attempts` to zero**, and
  increments `repairs`; after `cfg.build.maxRegressionRepairs` (default 2) the feature is
  `blocked: regression_unrepairable`. Repairs are charged to the same `featureCeiling` as ordinary
  attempts, so they cannot silently triple a feature's cost. When the remaining build wall budget
  will not hold a full sweep, the sweep covers the most recent K passing features plus every feature
  that has ever regressed; the `sweep` event records `scope: "partial"` and the skipped ids, and an
  incomplete sweep is re-run at the next build entry. A partial sweep is a **recorded
  deadline-imminent degradation**, never a silent absence and never a sizing policy.

## 5. Critique, freeze, and `acceptance.lock`

- The critic seat resolves with `resolveRoleOn("critic", otherProvider(brainProvider, available),
  cfg, available)`; on failure it searches the critic role's configured refs on the brain's provider,
  excluding the brain's exact ref, and the `critique` event records `crossProvider: false`. If no
  admitted alternative exists, formation returns a typed no-model failure instead of silently reusing
  the producer model or widening policy. `PhaseDeps` therefore exposes the available-provider set and
  `modelsOn(role, provider, excludeRef?)`. Effort is `high` (§7). Everything else runs at `cfg.effort`.
- The critic is a stateless worker with one decision tool `critique({ scopeCreep, unverifiable,
  missing, verdict })`, each item `{ featureId?, text }`; `terminalTools: ["critique"]`, `turnCap: 2`,
  no write tool. Its pinned block quotes `spec.md`, `features.json`, the chosen idea's
  `forJudge: false` render, and the brief's Constraints and Non-goals. **It never sees the brain's
  transcript.**
- The critic's `unverifiable` list is **binding only where the harness can independently confirm the
  claim** — the named feature's `acceptance.type === "manual"`, or the triviality screen fires on its
  command. Everything else, and all of `scopeCreep` and `missing`, is advisory and passed to the
  revision prompt without force. Coverage of the Scope section has **no mechanical floor**, and the
  plan says so.
- **Exactly one revision, then a second critique; freeze happens only on a second verdict of `ok`**
  (override 2). Otherwise formation takes the honest exit `not_formable` quoting the critic's
  remaining items. Both critique calls are recorded. The second call costs $0.106.
- The lock is `{ version: 1, ids: hashInput(orderedIds), init: hashInput(features.init),
  features: { "<id>": hashInput(feature.acceptance) }, specHash }`.
  `verifyAcceptanceLock(file, lock, currentSpecHash)` compares `ids`, `init` and every per-feature
  hash, and returns `specDrift: currentSpecHash !== lock.specHash`. **Spec drift is observed but does
  not make `ok` false**: a prose drift appends a typed `spec.drift` event, sets `specDrift: true` and
  continues. `hashInput` is canonical JSON with
  recursively sorted keys, so reformatting does not trip the lock while one changed character inside a
  command does.
- The lock is verified at build entry, immediately after every builder session, and immediately
  before every harness check. There is never an automatic rewrite; the operator's path is
  `kiln project relock <run> --confirm`, which rewrites the lock, appends a `relock` event with the
  before/after hashes, and sets `relocked: true`.

## 6. Where the authoritative state lives, and what v1 does not prevent

This section is deliberately self-contained. Round 1 justified the relocation of the frozen plan by an
argument round 2 showed to be false, and **that justification is withdrawn**; what remains is stated
without dressing.

**(1) What moves.** Three files: `runs/<id>/features.json` (`RunPaths.features`),
`runs/<id>/acceptance.lock` (`RunPaths.acceptanceLock`), `runs/<id>/state.jsonl`
(`RunPaths.featureState`). Nothing else. `spec.md`, `init.sh`, `progress.md`, `audit.md`, `checks/`,
`blocked/` and `repo/` stay in the project directory.

**(2) The complete data flow.** Before freeze, the form brain's root is `project.dir`, so it writes
`<project>/features.json`; it cannot write `RunPaths.features`, which is outside its roots. At freeze
the harness reads `<project>/features.json`, assigns ids, canonicalises it, `writeAtomic`s it to
`RunPaths.features`, computes the lock **over that copy**, writes `RunPaths.acceptanceLock`, creates
an empty `RunPaths.featureState`, and then regenerates `<project>/features.json` and
`<project>/acceptance.lock` as mirrors. After freeze **every reader reads the run copy** — the feature
pick, `verifyAcceptanceLock`, the builder's pinned block, the auditor's acceptance text,
`computeMetrics`, `kiln project status` and `kiln project relock`. **No harness code path uses a
mirror as authority.** Mirrors are regenerated after freeze and after every `state.jsonl` transition;
a poison-mirror test proves that picking, lock verification, status and relock still use the run copy.

**(3) What the mirror is for.** Operator inspection, and nothing else: someone reading the project
directory — which is what the user thinks of as "the project", and what `--out` points at — can see
what was promised and what is frozen without knowing where the run directory is.

**(4) How a tampered mirror is detected.** It is not, and it does not need to be. Nothing reads it and
it is overwritten at the next regeneration. Tampering it has no effect on the run.

**(5) How a tampered run copy is detected, and what that does.** `verifyAcceptanceLock` at the three
points in §5 is the **only** mechanism. A mismatch appends a `failure` event of class `integrity`,
writes `status.json` with `state: "failed"` and `outcome: { kind: "failure", failureClass:
"integrity" }`, writes `metrics.json`, and stops the run with no further commit. `kiln run resume`
refuses; the operator must start a new run or `relock --confirm`.

**(6) What a confused or adversarial model can still do that v1 will not stop.** `read` and `search`
do not enforce `roots`; `bashTool` calls `insideRoots` nowhere; and `isProtectedRunFile` is consulted
only by `write` and `edit` (all verified in the tree). The harness does not supply `record.jsonl`, a
full transcript, previous auditor verdicts, `progress.md` to the auditor, `evals/`, or prompt files in
the prompt/context it constructs, but a model can traverse to them with an absolute or relative path.
That access is unprevented and unobservable in v1 except when the chosen tool call itself is recorded.
A builder's shell can also write **any absolute path**, including
`runs/<id>/features.json`, `runs/<id>/acceptance.lock`, `runs/<id>/state.jsonl` and
`runs/<id>/record.jsonl`. Specifically unstopped: a builder that rewrites an acceptance object **and**
the lock consistently passes every verification; a builder that truncates or appends to
`record.jsonl` corrupts the journal `metrics.json` folds; a builder that edits `state.jsonl` can mark
a feature passed. Under the default project location the run copy sits at `../../features.json` from
the builder's cwd — a two-segment relative path — so **the relocation removes no convenience at all in
the default case**, and matters only when `--out` points outside the run.

**(7) Why the relocation is kept anyway.** Two reasons, neither a security control: the run copy is
outside the tree the loop discards with `git checkout -- . && git clean -fd`, so a discard can never
destroy the frozen plan; and it keeps the frozen plan next to the rest of the run's own account of
itself. **The run copies are not currently in `isProtectedRunFile`'s hard-wired list, and the schema
task adds them there** — round 1 claimed they already were, which was false.

**(8) Idempotence, split by phase.** The pre-freeze resume key is `<project>/features.json` existing
and validating. The post-freeze completion marker is `RunPaths.acceptanceLock` existing. Two rules on
two different files.

**v1 detects some writes rather than preventing traversal.** That sentence is the whole security
posture of this phase. It follows the spec's already-accepted "v1 has no sandbox" position for probes;
the prompt-construction guarantee is precise, and the larger read/write residual is named in §17 and
override 11.

## 7. Formation phase mechanics

- `runForm(deps, ideaId?)` defaults to `RunStatus.chosenIdeaId` and the CLI may override with an
  explicit id.
- The form brain's pinned block is the form contract, the brief's Constraints, Non-goals and Search
  success sections quoted verbatim, and the chosen idea rendered by
  `renderDossier(d, e, { forJudge: false })`. The contract names `ideas/<id>.md` and
  `ideas/<id>.evidence.json` by absolute path so an uncapped re-read costs one `read` turn.
- **Honest exit `not_formable`.** The mechanical floor fires when, after the single revision, either
  zero features have an executable acceptance check, or the second critique's verdict is still
  `revise`. A validation failure after its one re-ask stays a `verify` failure and is **not** an
  honest exit. The brain may additionally declare `not_formable` through the `exit` tool.
  `metrics.json` carries `honestExits.not_formable: { mechanical, declared }`.
- `formationAttempts = max(1, floor(budgets.usd x share.form / projectedFormationUsd))` = **1** at the
  defaults, so a `not_formable` ends the run immediately; the next-idea machinery exists but is
  unreachable below `budgets.usd >= $41.70`. When it is reachable, the harness advances down the
  value ladder read defensively from `frontier.json`; an absent or unreadable frontier means "no
  second idea" and ends the run honestly rather than throwing.
- **Freeze ordering**, one function: write `RunPaths.features` and the lock; create `repo/`,
  `git init -b main`, the local git identity, a `.gitignore` containing `.kiln-scratch/`, and
  `checks/` and `blocked/`; make the **initial commit** so the auditor's git tools have a HEAD;
  regenerate the mirrors. `init.sh` is **not** run here (controller ruling 9).
- Formation is resumable and its unit of idempotence is the file: a resumed formation skips any of
  `spec.md`, `<project>/features.json` and `init.sh` that exists and validates, and re-runs the
  critique only when the lock is absent. A repo is never created on a `not_formable` path.
- **Formation's base allocation is `share.form x budgets.usd = $1.375`.** At form entry the effective
  `formationCeilingUsd` is `phaseAvailableUsd("form", spentByPhaseBeforeForm)`, so unused frame,
  discover or ideate allocation rolls forward as headroom while earlier overspend reduces it.
  `formationAttempts` remains derived from the base form share and stays one at the defaults; roll-forward
  never buys another formation attempt. One phase-local ledger covers the form brain and both critic
  calls (controller ruling 2). `runValidatedFile` invokes an `onResult` hook after **every** model
  call, including a corrective re-ask, and the critic does the same after a malformed-call retry.
  Each hook adds that call's `BrainResult.costUsd`; before the next call, `createBrain` compares the
  accumulated completed-call spend plus its own live `runCost` with the common ceiling. No final-result
  overwrite and no shared-journal sequence window can lose a call's cost. `budgets.turns.form` stays 30.

## 8. The build loop

Per-iteration order, ratified:

0. At build entry only: assert the tree is clean, run `init.sh` (§4's environment, 600 s deadline,
   recorded as a `check` event with `phase: "init"`, non-terminal on a non-zero exit), and commit any
   resulting tree change as `chore(init)` with a `Kiln-Init` trailer. At every later iteration start,
   a **resume-point fold** over the record decides whether the dirty tree is abandoned work to
   discard; a discard is `git checkout -- . && git clean -fd` with the discarded diff's `--stat`
   recorded. `.kiln-scratch/` survives because it is gitignored.
1. Verify `acceptance.lock`.
2. Budget and deadline precheck against `attemptCeiling` and the remaining build wall share.
3. Pick the feature (first-fit).
4. Builder session.
5. Verify the lock again.
6. The harness runs the acceptance check. **Never the builder.**
7. Create the exact detached snapshot; run the auditor there; clean up the snapshot.
8. Decide.
9. On pass and agree: commit, write the `passed` transition, run the regression sweep, write any
   `regressed` transitions.
10. Generate the `progress.md` entry from `state.jsonl` plus the iteration's events and append it.
11. Write `status.json`'s cursor and `metrics.json`.

- **`state.jsonl` is the truth**; `status.cursor` is a hint. Build entry additionally scans `git log`
  for `Kiln-Feature:` trailers and marks any feature named by a commit as passed even when no
  transition line was written, so a crash between the commit and the journal costs nothing.
  `RunStatus.cursor` is widened to `{ round?: number; featureId?: string; attempt?: number; step:
  string }`.
- The commit is written **before** the transition; a crash between them is repaired by the trailer
  scan.
- `attempts` is durable and cumulative across resumes. At most **3 consecutive** transient retries and
  **3 consecutive pauses** per feature, after which the run is `stopped` with `stopKind: "transient"`
  and a resumable status. A stall counts as a spent `verify` attempt.
- Build entry calls `assertShapeFrozen` before `phase.start`. A genuine auditor disagreement on a
  passing check spends the attempt, preserves its stored audit for the next session, and leaves the
  producer tree to the normal resume-point discard. If the builder moved HEAD, the typed `attempt`
  event records `builderCommitted: true`; a passing check plus effective audit agreement still gets
  the harness's `--allow-empty` trailer commit. A failed harness commit is `verify`, spends the
  attempt, records stderr and is discarded at the next resume point.
- Whenever a feature becomes blocked at its attempt or repair cap, `archiveBlocked` atomically writes
  its last captured check file and its last **stored-cap** audit beneath
  `<project>/blocked/<featureId>/`, plus `manifest.json` naming the source event sequences and hashes.
  A missing check or audit is represented explicitly in the manifest rather than silently omitted.

## 9. The builder session

- **Six tools: read, write, edit, bash, search, exit** (override 3). `BUILDER_TOOL_NAMES` and
  `PHASE_TOOLS.build` are set to the same constant so the two lists cannot disagree — they disagree
  today (7 versus 5), and the five-tool list has no `exit`, which would make §4.5's own honest exit
  structurally unreachable. `note` is out: `progress.md` is harness-owned and `note` would be a
  second, unprotected cross-session memory channel competing with the audit.
- `cwd = <project>/repo`; scratch work goes in `repo/.kiln-scratch/`.
- **Turn cap 40 per attempt** (the spec's §8 placeholder, restored by controller ruling 1), effort
  `cfg.effort`. The money threshold is `builderUsdCap = $1.081`, checked at turn boundaries by
  `BrainOptions.usdCap` with `BrainResult.stopped` gaining `"usd_cap"`, which maps to failure class
  `budget`. `createBrain` compares its own live internal `runCost` plus optional caller-owned prior
  `spentUsd`; a builder passes zero prior spend, while formation uses the callback to aggregate its
  sequential sessions. No cap is derived by diffing the shared journal.
- The pinned block is the feature, its acceptance rendered as read-only text with the sentence "the
  harness runs this check after your session and the harness's run is the only one that counts", the
  latest audit truncated by `pinAudit()`, the last 2 `progress.md` entries for this feature plus the
  last 3 overall, the remaining budget in dollars and turns, the honest-exit clause naming
  `cannot_be_satisfied`, the scratch path, and the rule that the frozen plan is not the builder's to
  write. The block is capped at **8,000 characters**, allocated audit 3,000, progress tail 2,500,
  contract and the rest 2,500, asserted at construction; when the cap binds, the oldest progress
  entries drop first and `pinnedTruncated` is recorded.
- **The builder is shown the acceptance command.** The harness records whether it ran it, by
  normalising whitespace and testing whether the command appears in any journalled `bash` argument
  during the attempt (`builderSelfVerified`). Running it is not a violation; the harness's own run
  decides. A prompt-level prohibition is not a mechanism; the journal is.
- `StallDetector` observes **every** tool end event (the `onTool` end callback already carries the
  400-character redacted excerpt the detector wants). On a trip the attempt aborts with a recorded
  `stall` event carrying the feature, attempt, tool and fingerprint; the attempt counts as `verify`;
  the run does not end. `StallDetector` is called from nowhere today.
- **`cannot_be_satisfied`** (override 9). A declaration ends the session and the harness **runs the
  check anyway** — it is free and the code is on disk. If it passes, the declaration is recorded
  `overruled: true` and the feature proceeds through the audit. If it fails, the first declaration
  costs an attempt and the feature stays pickable; the **second** declaration for the same feature,
  from a different fresh session, blocks it as `declared_unsatisfiable` with the union of both
  reasons. `ToolContext` gains `allowedExitKinds?: ExitKind[]` and `exitTool` refuses a kind outside
  it with `fail(...)` recorded as a `policy` failure — `form: ["not_formable"]`,
  `build: ["cannot_be_satisfied"]`; the field is optional so frame, discover and ideate are unchanged.

## 10. The auditor, `audit.md` and `progress.md`

- The auditor resolves off the builder's provider where possible through the same admitted
  provider-restricted resolver, then uses a configured different ref on that provider or fails typed;
  it records `crossProvider` and runs
  at `cfg.effort`. **Turn cap 15 on a passing check, 8 on a failing one** (the spec's placeholders,
  restored by controller ruling 1), with `auditorUsdCap = $0.6948` as the dispatch threshold —
  it bites at roughly turn 9 against a 6-turn typical audit, so truncation is exceptional rather than
  median. A truncated or malformed-after-one-retry audit is recorded and treated as `agree`, never as
  a veto. `auditorTruncated` and `auditEvidenceUsable` are metrics lines, and a run whose truncation
  rate exceeds 20 percent is excluded from any claim about the audit's effect.
- **The auditor gets no `bash` at all.** Its tools are `read`, `search`, two fixed-argument tools
  implemented with `runProcess` — `git_log({ n? })` and `git_diff({ ref?, path? })`, arguments always
  an array and never a shell string — and the terminal `audit` tool. `git_diff` returns `--stat`
  first, then the full diff when it fits `shapeResult`'s 80-line / 16 kB thresholds, and a per-file
  head-and-tail plus an "abridged" note when it would spill. A first-word shell allowlist was
  considered and rejected: it is about sixty lines of parser bypassed by `;`, `&&`, `$()`, backticks
  and here-docs, and would read as a control while being none.
- Immediately after the producer-tree check, the harness snapshots the exact pre-audit tree through a
  temporary Git index: `read-tree HEAD`, then forced `add -A` of the worktree with pathspec exclusions
  for `.git` and `.kiln-scratch`, `write-tree`, and `commit-tree` with the current HEAD as parent. Git's
  tree preserves file bytes, executable/symlink modes, tracked deletions, and every untracked or
  otherwise ignored file except those two exclusions. The real index and producer worktree are not
  changed. The harness checks that tree out into a temporary detached worktree and points `read`,
  `search`, `git_log` and `git_diff` at that snapshot. The auditor never receives a producer-tree tool.
  If snapshot porcelain changes, the harness discards and recreates the detached worktree from the
  same temporary commit, records a `policy` failure and an `audit.disposition` with `checkVoided: true`,
  re-runs the check once in the rebuilt snapshot, and on a pass runs **one fresh audit**. It never calls
  `checkoutAndClean` on the producer tree. Snapshot cleanup is idempotent and happens after every path.
- Prompt/context construction supplies the snapshot through its tools, the acceptance criteria
  verbatim, the check output (excerpt inline plus path), `spec.md`'s **First milestone** section only,
  and the previous audit's `nextSessionNotes` **only**. It does not supply previous verdicts,
  `progress.md`, the builder's transcript or `record.jsonl`. Because v1 has no sandbox and `read` and
  `search` accept traversing paths, this is a construction guarantee rather than an access-control
  guarantee; §6 and §17 record the residual.
- It returns `audit({ verified, claimedUnverified, regressions, nextSessionNotes, checkQuality:
  { adequate, reason }, verdict: "agree" | "disagree" })` with `terminalTools: ["audit"]`. **The
  auditor writes no file** (override 5): the harness renders `<project>/audit.md` from the latest
  audit and appends every audit to `runs/<id>/audits.jsonl`.
- **Two cap sets** (controller ruling 8): stored audits and the `blocked/` archive keep 8 items x 200
  characters for the three lists, `nextSessionNotes` 1,200, `checkQuality.reason` 200; the pinned copy
  is produced by a pure `pinAudit(audit)` at 4 x 120 / 900 / 150. The archive is the only cheap
  instrument §17 names for recovering three of its own cannot-observe items, so it is not truncated to
  fit a prompt. Both `audit.md` and `audits.jsonl` store the large form; only the copy inserted into a
  later builder prefix uses the pinned caps.
- **The auditor keeps a full veto**, disciplined by one rule: a `disagree` must carry at least one
  non-empty item in `claimedUnverified` or `regressions`; an empty disagreement is recorded and
  downgraded to `agree`. `auditorDisagreeRate` and `auditorEmptyDisagreeRate` are recorded. A harness
  override on repeated disagreement is explicitly **not** in v1 — it would be a second oracle with no
  evidence behind it.
- `progress.md` is **harness-generated and strictly factual**, one block per attempt, generated from
  `state.jsonl` plus the iteration's events and then appended: `## <featureId> attempt <n> — <iso>`,
  then `check:`, `audit:`, `commit:` and a `discard:` line when a tree was discarded, then the check
  excerpt in a fenced block. Stored entries are capped at 1,200 characters; the pinned render is 500.
  **No model prose ever enters it** — Recovery-Bench says environment-only beats
  environment-plus-summary, and a builder narrating its own failure into the next session's prefix is
  the middle arm wearing the best arm's name.

## 11. Git

- At freeze: `git init -b main` (falling back to `git symbolic-ref HEAD refs/heads/main`),
  `user.name = "kiln"` and `user.email = "kiln@localhost"` via `git config --local` (a repo with no
  identity **cannot commit at all**, verified), a `.gitignore` containing `.kiln-scratch/`, and the
  initial commit.
- Per passing feature: `feat(<id>): <title>`, body naming the acceptance command, its exit code and
  duration, trailers `Kiln-Feature: <id>`, `Kiln-Run: <runId>`, `Kiln-Attempt: <n>`. All git
  invocations go through `runProcess` with an argument array and a 60 s deadline.
- `git rev-parse HEAD` is captured before and after every builder session. A moved HEAD is recorded as
  a `policy` failure with `builderCommitted: true`, and the harness still makes its own commit with
  `--allow-empty` so the trailer exists — but **the attempt is not re-counted as `verify` when the
  check passed and the audit agreed**: a bookkeeping violation does not overrule the one signal §5
  says cannot be argued with.
- Only `<project>/repo` is a git repository. The frozen plan and the journals are unversioned under
  the run directory, and `relock` is their audit trail.

## 12. Budgets, wall clock, failure classes, stops, and honest exits

**Shares and ledger.** `budgets.share = { frame: 0.015, discover: 0.025, ideate: 0.42, form: 0.055,
build: 0.475, reflect: 0.01 }`, summing to 1.000, used for **both** dollars and wall clock. Config load
rejects a partial or complete override whose merged shares do not sum to 1.000 within `1e-9`; it never
silently normalizes. `phaseBudgetUsd(phase)` and `phaseBudgetWallSeconds(phase)` return the base
allocations. The runtime helpers `phaseAvailableUsd(phase, spentByPhase)` and
`phaseAvailableWallSeconds(phase, elapsedByPhase)` return, in their respective units,
`max(0, sum(base allocations through phase) - sum(actual spend through phase))`. That is the
forward-roll ledger for frame through build: an earlier underspend increases a later phase, an earlier
overshoot reduces it, and no later share rolls backward. `reflectReserveUsd` defaults to $0.25 and the
effective reserve is `min(reflectReserveUsd, phaseBudgetUsd("reflect"))`, so a smaller configured run
remains valid. Pre-reflect availability excludes the reflect share. At reflect, availability is
`max(effectiveReflectReserveUsd, budgets.usd - totalUsdSpentBeforeReflect)`; the wall analogue is
`max(phaseBudgetWallSeconds("reflect"), budgets.wallSeconds - elapsedBeforeReflect)`. Those protected
minimums are the explicit exception to cumulative depletion: an unbounded crossing turn may already
have pushed total spend or elapsed time past the planning target, but reflection still runs and records
the additional overshoot. At `budgets.usd: 25` and `wallSeconds: 14400`: base form $1.375 / 792 s,
base build $11.875 / 6,840 s, reflect minimum $0.25 / 144 s.

**The money table**, every figure from `pi-catalog@18.1.3` list prices through the cost model's
session formula (`input = T x start + grow x T(T-1)/2`, a fraction billed at `cacheRead`;
`output = T x outPerTurn`):

| quantity | value | what it is for |
|---|---|---|
| `projectedFormationUsd` | $1.146 | sizes `share.form` and `formationAttempts` |
| `expectedAttemptUsd` (builder 15 turns + auditor 6) | $1.109 | sizes `maxFeatures` |
| `builderUsdCap` (builder at 20 turns) | $1.081 | the builder session's `usdCap` |
| `auditorUsdCap` (auditor at 8 turns x 1.2) | $0.6948 | the auditor session's `usdCap` |
| `attemptCeiling` | $1.7758 | refuse-to-start planning floor; sum of seat cap thresholds, not a bound on turn overshoot |
| `featureCeiling` = `max(3 x expectedAttemptUsd, attemptCeiling, remainingBuildUsd / featuresRemaining)` | $3.327 | per-feature ceiling, repairs included |
| `maxFeatures` | 8 | `floor(11.875 / (1.3 x 1.109))` |
| projected run total | $23.22 | frame+discover 0.82, ideate 9.57, form 1.146, build 11.53, reflect 0.153 |
| estimated high-water run envelope | $26.88 | cost-model estimate under its assumed turn shape; 7.5 percent over the target, not a proven maximum |

Every one of these is **estimated, not measured**; no paid call was made anywhere in this design.
`metrics.json` carries the observations that will replace them: `costByRole`, `costByPhase`,
`builderSessions`, `auditorTokenShare`, `floorUnderestimated`, `usdCapHits`. The auditor's projected
24 percent token share sits inside the spec's own measured 19-38 percent band, which is the only
external check these numbers have.

**Enforcement.** The loop refuses to *start* a feature when `remainingBuildUsd < attemptCeiling`,
with `stopKind: "budget"` — never truncating a provider turn mid-flight. `attemptCeiling` covers the
configured cap thresholds, not the cost of the turn that crosses either threshold. A feature's spend is measured from
its `feature.pick` mark against `featureCeiling`; reaching it blocks the feature with
`blocked: feature_budget`. Mid-session paid-turn dispatch is gated by `usdCap` at turn boundaries, so the
overshoot is at most one additional turn **per independently capped seat**, but its dollars have no
numeric bound in v1 because there is no pre-dispatch reservation or maximum-output cost limit. The
$26.88 line above is therefore an estimate, not an enforcement claim. Wall clock is checked at
loop boundaries and each check's timeout is additionally clamped to the remaining wall time;
`overrunMs` is recorded, never absorbed.

**Failure classes**, retry policy a pure function of class, every call site passing structured
`FailureInput` fields rather than a stringified message:

| event | class | counted | effect |
|---|---|---|---|
| provider 429/5xx | `transient` | no | clean retry, max 3 consecutive, then `stopped: transient` |
| builder turn cap | `budget` | yes | attempt spent, fresh session next |
| builder `usd_cap` at a turn boundary | `budget` | yes | attempt spent |
| stall | `verify` | yes | attempt spent |
| check non-zero exit | `verify` | yes | attempt spent |
| check timeout | `deadline` | yes | attempt spent, run continues |
| declared `needs` missing | — | no | `blocked: missing_dependency:<n>`, 0 attempts |
| auditor malformed after one retry, or truncated | `verify` | no | recorded as `agree` with a note |
| auditor-snapshot porcelain difference | `policy` | no | audit discarded, detached snapshot rebuilt from its temporary commit, check re-run there, one fresh audit; producer untouched |
| `git commit` fails | `verify` | yes | attempt spent, stderr recorded |
| builder moved HEAD but the check passed | `policy` | no | recorded; harness commits `--allow-empty`; feature passes |
| lock mismatch | `integrity` | — | terminal |
| `exit cannot_be_satisfied` | — | — | check runs anyway; first costs an attempt, second blocks the feature |

A probe's non-zero exit is evidence and never a failure class (ideation record §6); an acceptance
check's non-zero exit **is** the `verify` signal the whole loop turns on. These are deliberately not
unified.

**Stop precedence**, evaluated top to bottom:

| condition | outcome |
|---|---|
| acceptance-lock mismatch | `failure`, `failureClass: integrity` |
| all features pass | `success` |
| no pickable feature remains, `featuresPassed.executed === 0`, and at least one feature blocked by declaration | `honest_exit`, `cannot_be_satisfied` |
| no pickable feature remains (any other case) | `stopped`, `stopKind: "blocked"` |
| run or phase wall-clock deadline | `stopped`, `stopKind: "deadline"` |
| 3 consecutive transient retries, or 3 consecutive pauses, on one feature | `stopped`, `stopKind: "transient"` |
| remaining build share below `attemptCeiling` | `stopped`, `stopKind: "budget"` |

`StopKind` gains `blocked`, `deadline`, `transient`. **There is no mechanical floor for
`cannot_be_satisfied`**: mechanical exhaustion is `stopped: blocked`, and the honest exit is reserved
for a builder's own declaration — the ideation record's rule that the mechanical trigger and the
declared exit are different kinds, counted apart, so §5.3's honest-exit counts mean something.
`RunOutcome.kind: "partial"` is explicitly not added; the `featuresPassed.executed === 0` gate does
the same work with no schema change.

Every stopped outcome writes `RunStatus.state: "stopped"`; ideation Task 8 now supplies that shared
state. `kiln run resume` accepts it and branches on the durable stop kind. Existing ideation stops stay
owned by ideation Task 9: `rounds` and `stagnant` enter the checkpoint over the last complete frontier;
`stalled` re-enters ideate from its cursor with fresh model seats; `budget` enters the checkpoint when a
complete frontier exists, and otherwise re-enters ideate only after the configured target increased.
Build `transient` gets a new consecutive-retry window; build `deadline` and `budget` proceed only when
their configured target increased, otherwise they stop again before a paid call; and `blocked` rechecks
only reversible `missing_dependency` and interactive-manual cases, appending an unblocked transition
when the condition changed. Attempt exhaustion, declarations, regression caps and feature-budget blocks
remain durable. `done` is terminal success or honest exit and is not silently resumed; `paused` remains
reserved for usage-window waits.

**Usage-window pause** is reused verbatim: reactive on 429 or a usage-limit error plus a boundary poll
at 95 percent, writing `state: "paused"`, `pausedReason` and `wakeAt`. A mid-session pause abandons
the builder session and discards the tree; the abandoned work never passed a check, and its cost is
charged to `featureCeiling` rather than being free.

## 13. Reflect

- The harness computes a fixed digest — event counts by type, cost and tokens by role, failures by
  class, honest exits by kind, per-feature attempt histories with 300-character check excerpts, the
  tool-use histogram, stall fingerprints, and the stop kind — writes it to `runs/<id>/reflect/digest.md`,
  hashes it, and records the hash. The digest is capped at 16 kB with `digestTruncated` recorded,
  dropping per-feature sections first. **The reflector's constructed context contains only that
  digest, a 24 kB size-selected bundle of the run's markdown files, the playbook, and `metrics.json`;
  its only tool is `playbook_delta`, so it has no read path to `record.jsonl`** (override 6).
- The tool is `playbook_delta({ op: "add" | "edit" | "retire", section, id?, text, evidence:
  { kind: "digest" | "file" | "metric", ref }[] })`, in `terminalTools` so exactly one delta is
  possible. **The harness validates that every ref resolves** — a digest heading, a path under the
  run, or a key present in `metrics.json`. A delta with no evidence, or an unresolvable ref, is
  rejected and recorded and is not written to `evolution/candidates/`.
- The candidate is `evolution/candidates/<runId>.json`, carrying the run id, the digest hash, the
  champion playbook's hash and the reflector's model ref. **It is never applied here**; applying it is
  the evals-and-evolution plan's job, gated on held-out seeds.
- The reflector may propose **playbook deltas only** in v1. Context construction does not supply
  `evals/` or any prompt file, and its tool set cannot retrieve them; it never proposes a prompt
  candidate — that would let the seat that will be evaluated edit the thing that evaluates it.
- `budgets.reflectReserveUsd` (default **$0.25**) is reserved in every pre-reflect planning check; no
  pre-reflect phase is allocated that share. A crossing provider turn is not physically pre-reserved
  and may consume more than the run target, so v1 does not claim the dollars remain untouched. Reflect
  nevertheless receives at least the protected dollar and wall minima defined in §12, accepts the
  resulting overshoot, and runs on **every** terminal path including `budget`, `deadline` and
  `integrity` — the runs that ran out are the most informative ones. `metrics.json` is written, then
  reflect runs, then rewritten, so the reflector can cite a metric and its own cost lands in totals.

## 14. Schema, record events, metrics

**One schema task first**, as the ideation record established, and it is **sequenced after ideation
Tasks 8 and 9 land** because it touches seven files that stream owns. "Additive-only" binds the
shared closed unions and those files — `core/events.ts`, `core/run.ts`, `core/config.ts`,
`brain/agent.ts`, `brain/tools/index.ts`, `cli/commands/run.ts`, `ideation/metrics.ts` — except the
named exhaustive stop-key initializer and list/cursor/stop widenings. Refactors touching no exported name
are permitted and named: extracting `assertShapeFrozen` from `discover.ts`, exporting
`predicateMatches` and a `Predicate` type from `probe.ts`. One deliberate removal is called out
separately: `PHASE_TOOLS.build` narrows to `BUILDER_TOOL_NAMES`, which moves no existing test.

The task adds: `PromptName`/`PROMPT_FILES` and `initHome`'s bundled list gain `critic`, `builder`,
`auditor`, `reflector`; `StopKind` gains `blocked`, `deadline`, `transient`; `RunStatus` gains
`chosenIdeaId?`, `specHash?`, `relocked?` and the widened `cursor`; it consumes the already-landed
`RunStatus.state: "stopped"` as a resumable state distinct from `"done"`, and `RunPaths` gains `project`,
`features`, `acceptanceLock`, `featureState`, `audits`, `reflectDir`, `digest`, and `createRun`
creates `reflect/`; `isProtectedRunFile`'s hard-wired list gains the three new run files;
`ToolContext` gains `protectedPaths?`, `protectedDirs?` and `allowedExitKinds?`; `BrainOptions` gains
`usdCap?` and `spentUsd?` and `BrainResult.stopped` gains `"usd_cap"`; `BUILDER_TOOL_NAMES` gains
`exit`; `KilnConfig` gains a `build` section and `budgets` gains `share`, `reflectReserveUsd` and
the dollar/wall base-allocation and forward-roll helpers; `PhaseDeps` gains the available-provider set and a
provider-restricted model resolver.

`cfg.build` defaults: `maxAttempts: 3`, `sessionTurnCap: 40`, `auditorTurnCap: 15`,
`auditorFailTurnCap: 8`, `builderUsdCap: 1.081`, `auditorUsdCap: 0.6948`, `checkTimeoutSeconds: 300`,
`checkOutputBytes: 8388608`,
`maxRegressionRepairs: 2`, `expectedAttempts: 1.3`, `expectedAttemptUsd: 1.109`,
`expectedCheckSeconds: 30`, `expectedInitSeconds: 120`, `minFeatures: 3`, `maxFeatures: 12`
(the schema ceiling; the effective cap is derived).

**New `RecordEvent` variants**: `critique`, `freeze`, `relock`, `spec.drift`, `feature.pick`,
`feature.state`, `attempt`, `check`, `audit`, `audit.disposition`, `commit`, `stall`, `sweep`, `digest`,
`delta`. `freeze` has no future-dependent `overBudgetPlan` field. `feature.pick` carries the feature,
attempt and phase-budget mark. `attempt` carries `featureId`, `attempt`, `builderStopped`,
`builderSelfVerified`, `builderCommitted`, `contextPressure`, `declaredUnsatisfiable`,
`declarationReasons`, `declarationOverruled`, `builderCostUsd`, `auditorCostUsd`, total `costUsd` and
`counted`, plus `disposition: "passed" |
"verify_failed" | "audit_disagreed" | "stalled" | "transient" | "budget" | "declared_failed" |
"commit_failed" | "paused"`. A builder's immediate `honest_exit` tool event is a declaration; the
`attempt` also carries `arm: "fresh" | "single_session"`; its disposition and final `RunOutcome` decide whether the declaration was overruled, feature-blocking or a
terminal honest exit, so `honestExits` never counts raw declarations as completed run exits. `check`
carries `checkId`, optional `featureId` (absent for init), `phase: "acceptance" | "regression" |
"init"`, `ok`, `exitCode?`, `durationMs`, `overrunMs`, `timedOut`, `predicateMatched?`, `outputPath`,
`outputTruncated` and `notRunReason?`. `audit.disposition` links `featureId`, `attempt` and `checkId`,
and carries the raw and effective verdicts plus `emptyDisagree`, `malformed`, `truncated`, `retried`,
`evidenceUsable` and `checkVoided`. `sweep` carries `scope` and `skipped: string[]`; `digest` carries its hash, byte count
and truncation flag. The existing `stop` variant requires a `round`, which
build does not have; the schema task makes `round` optional. Both `feature.pick` and `feature.state`
exist because a pick that produced no transition — a stalled or transient-aborted attempt — would
otherwise be invisible to the fold. After at least three `attempt` events with `counted: true`, the
metrics fold computes `observedMeanAttemptUsd = sum(costUsd) / count`, `projectedBuildUsd =
derivedMaxFeatures x expectedAttempts x observedMeanAttemptUsd`, and `overBudgetPlan =
projectedBuildUsd > phaseBudgetUsd("build")`; no historical event is rewritten.

**`metrics.json`** adds, as a fold over those variants: `featuresTotal`, `featuresPassed:
{ executed, humanVerified }`, `featuresBlocked` by reason (`attempts_exhausted`, `not_verifiable`,
`missing_dependency`, `declared_unsatisfiable`, `regression_unrepairable`, `feature_budget`),
`attemptsByFeature`, `builderSessions`, `checkPassRate: { acceptance, regression }`, `initExitCode`,
`regressionsCaught`, `regressionRepairs`, `regressionSweepSeconds`, `regressionChecksRun`,
`regressionChecksSkipped`, `sweepsIncomplete`, `auditorAgreeRate`, `auditorDisagreeRate`,
`auditorEmptyDisagreeRate`, `auditorTruncated`, `auditEvidenceUsable`, `auditRetried`,
`auditorTokenShare`, `auditorCostUsd`, `checkQualityInadequate`, `costByRole`, `costByPhase`,
`wallByPhase`, `stopKind`, `stops`, `honestExits`, `declarationOverruled`, `formationRevisions`,
`formationAttempts`, `criticVerdicts`, `crossProviderCritic`, `crossProviderAuditor`,
`manualFeatureShare`, `builderSelfVerified`, `builderCommitted`, `relocked`, `specDrift`,
`overBudgetPlan`, `skippedAfterBlocked`, `floorUnderestimated`, `usdCapHits`, `budgetOvershootUsd`,
`checksVoided`, `censored`, `contextPressureByArm`, `digestTruncated`, `deltaProposed`. Task 1 extends
the ideation metrics stop-key initializer as soon as `StopKind` widens; Task 6 owns the corresponding
`Metrics` interface/build fields and derives `contextPressureByArm` from `attempt.arm`, never inference
from session length or CLI flags.

## 15. CLI

`kiln project form <run> [--out DIR] [--force]`, `kiln project build <run> [--autonomous] [--reinit]
[--single-session]`, `kiln project status <run> [--json]`, `kiln project audit <run> [--json]`,
`kiln project relock <run> --confirm`; `--through` extended to
`frame|discover|ideate|checkpoint|form|build|reflect` **and given real validation** — today it is an
unvalidated string defaulting to `"discover"` whose only use is `through !== "frame"`, so an unknown
value silently misroutes. The run id is the only handle; the project directory is derived from
`status.projectDir`. The `--json` build summary carries `{ id, dir, projectDir, status, costUsd,
outcome, features: [...] }` so a caller never parses `features.json` itself. A projected build-cost
table is printed before the first feature, skipped under `--json` or `--yes`, mirroring the ideation
loop's projected per-round prompt.

`--single-session` is arm B of M2 and ships now, as the ideation loop shipped `--bare`: one builder
session for the whole feature list, same checks, same auditor, same sweep, same commits, same
metrics, with **equal total budget and equal total turns** (controller ruling 4) —
`usdCap = maxFeatures x expectedAttempts x builderUsdCap` and
`turnCap = maxFeatures x expectedAttempts x sessionTurnCap`. Arms are compared at equal dollar **and**
wall budgets; either arm ending `stopKind: "deadline"` marks the comparison `censored`.

## 16. Testing

- Tests never call a real provider: `createMockModel` + `streamMock` as `streamFn`, `mkdtempSync`
  temp homes, injected `fetchImpl`, an explicit `Limiter`. `createMockModel` supports `responses`
  (array, iterable or async generator), a `handler`, `{ throw }`, and `responseStatus` /
  `responseHeaders`, which is how the 429 pause path is tested.
- A `GitRunner` interface (`init`, `commit`, `log`, `statusPorcelain`, `diff`, `revParseHead`,
  `checkoutAndClean`, and the create/rebuild/remove audit-snapshot operations) is injected and faked
  in unit tests; **one** real-git integration test runs on a temp repo with `HOME` pointed at an empty
  directory, asserts fake/real log agreement, and proves the detached snapshot preserves bytes, Git
  modes/symlinks, deletions and untracked/ignored files except `.git` and `.kiln-scratch` without
  changing the producer tree or index.
- An injected step hook that throws between each numbered pair of loop steps gives the deterministic
  crash matrix; it asserts the same final `state.jsonl` fold at every kill point, no repeated builder
  session for a `(featureId, attempt)` whose check had passed, and no `check ok: true` without either
  a commit or a subsequent failed transition.
- **One** genuinely spawned e2e test runs `bin/kiln.ts` and kills the process group for real, marked
  slow and platform-sensitive — this is the only thing that actually tests §12's fault-injection
  requirement.
- A deadline test with a check that ignores SIGTERM asserts the graduated kill fires and `overrunMs`
  is recorded.
- Project-path tests cover the default real directory, external symlink, wrong-target refusal,
  marker mismatch, a directory containing only `.git`, and explicit `--force`; force never deletes
  unrelated contents. A poison-mirror test proves every authoritative reader ignores both mirrors.
- One formation-budget test spends below the ceiling in the form brain and crosses it in the first or
  second critic, proving the three sessions share one ledger. Provider-routing tests cover a genuine
  other-provider critic/auditor, the admitted same-provider alternative, and typed failure when no
  alternative exists.
- Loop tests cover genuine audit disagreement, builder-moved-HEAD, commit failure, shape mismatch at
  build entry, each stopped state's exact status and resume behavior, collision-free repeated
  regression outputs, and blocked-artifact manifests preserving the stored-cap audit.
- Schema/metrics tests construct every new typed event and prove every §14 metric — especially
  `declarationOverruled`, `builderSelfVerified`, `builderCommitted`, `checksVoided`,
  `contextPressureByArm`, `digestTruncated` and runtime `overBudgetPlan` — is recoverable without
  matching note or failure prose. Config tests reject a merged share map whose sum is not 1.000 and
  exercise forward roll-over and the reflect reserve.

## 17. What this design makes impossible to observe

Named before any measurement is trusted, as §1 requires.

1. Whether the auditor's `disagree` was right — nothing re-verifies a vetoed pass, so
   `auditorDisagreeRate` cannot be split into correct and incorrect vetoes.
2. Whether a passing check was a *good* check — the lock freezes it, so `checkQuality` is the
   auditor's opinion, not a measurement.
3. Whether an implementation satisfies the check while behaving wrongly at runtime — the check is the
   only oracle and the auditor cannot execute anything.
4. Whether `attempts < 3` is the right cap — a feature blocked at 3 is never retried.
5. Whether a `manual` feature would have passed in autonomous mode.
6. Whether the builder's self-verification helped or hurt — the harness records that it happened, not
   what it changed.
7. Projects longer than the budget (the spec's own M2 statement).
8. Whether a declared credential was misused. The record proves which variables were exposed to which
   command **on the harness-run check path only**; the builder's own shell keeps the widened denylist
   and its undeclared exposure is the larger and unobserved one. v1 has no sandbox.
9. Whether a builder rewrote an acceptance object **and** its lock consistently — §6 detects an
   inconsistent tamper, not a consistent one.
10. Whether a dirty tree discarded at an iteration boundary contained work that would have passed.
11. Whether the derived feature cap foreclosed a project that would have been completable.
12. Whether arm B's single long session lost on the session boundary or on context compaction — a
    session that long will compact, so the arm tests both. `contextPressure` is recorded per arm so
    the confound is at least visible.
13. Whether a builder or auditor used unrestricted `read`, `search`, or builder `bash` path traversal
    to pull `record.jsonl`, prior verdicts, prompts, eval material, or any other non-supplied file into
    model context. The harness records the chosen tool call but cannot prove which bytes a shell
    command or traversing read exposed; v1 has no sandbox.
14. Whether an unrestricted tool mutated a path outside the auditor's detached snapshot. Snapshot
    porcelain detects changes inside that snapshot only; the producer tree is protected from the
    auditor's supplied tools, not from arbitrary host-path effects outside the tool contract.

**The cheap instrument that recovers part of this:** when a feature is blocked at max attempts, the
harness persists the last check output *and* the last audit under `<project>/blocked/<featureId>/`, at
the stored (large) audit caps, so a human can adjudicate offline and produce labels the design cannot
produce for itself.

## 18. Overrides of the design spec

The design spec is not edited. It remains the historical document; these sections are overridden.
Round-1 override 8 (the turn-cap cut) was **withdrawn** by controller ruling 1 and does not appear.

1. **§4.4, acceptance-check types.** *Spec:* "a shell command, an HTTP check, a rendered-page check,
   or a manual description". *Now binding:* **a shell command, a file check, or a manual
   description**; HTTP and rendered-page checks are expressed as shell commands in v1. *Why:* the
   under-6,000-line target and the no-new-runtime-dependencies constraint; one execution path means
   one timeout, environment, failure-mapping and test surface. *Foreclosure:* the harness cannot
   report why a web check failed, only that it did.
2. **§4.4, the freeze sequence.** *Spec:* "the brain revises once. Then **freeze**". *Now binding:*
   the brain revises once, **the critic re-reads, and freeze happens only on a second verdict of
   `ok`**; otherwise formation takes `not_formable`. *Why:* freezing a list the critic has just called
   unverifiable makes the lock permanent for a known-bad artifact and spends the whole build share on
   it; the second critique costs $0.106.
3. **§4.5, the builder's tool set.** *Spec:* "read, write, edit, bash, and search. Five tools."
   *Now binding:* **read, write, edit, bash, search, exit — six**, with `BUILDER_TOOL_NAMES` and
   `PHASE_TOOLS.build` the same constant. *Why:* `exitTool` is the only structural path to
   `honest_exit`; a five-tool builder cannot file `cannot_be_satisfied`, leaving a loop whose only
   exits are success and retry.
4. **§8, the tool-set sentence.** Unchanged for the brain, **plus**: in build the set is the builder's
   six, and `note` is not among them because `progress.md` is harness-owned and `note` would be a
   second unprotected cross-session channel.
5. **§4.5, who writes `audit.md`.** *Spec:* "auditor writes `project/audit.md`". *Now binding:* the
   auditor is read-only and **returns an `audit` tool call**; the harness renders `audit.md` from the
   latest audit and appends every audit to `audits.jsonl`. *Why:* the spec sentence contradicts its
   own read-only role; the auditor now receives only snapshot tools and the harness owns persistence.
6. **§4.6, what the reflector reads.** *Spec:* "a reflector reads `record.jsonl` and the run files".
   *Now binding:* a **harness-computed digest** of the record at `reflect/digest.md`, capped at 16 kB,
   plus a 24 kB bundle of the run's markdown and `metrics.json`. *Why:* §3's rule that the record is
   never read back into model context.
7. **§10, the file layout.** *Spec:* `<project dir>/ spec.md features.json acceptance.lock init.sh
   progress.md audit.md repo/`. *Now binding:* `<project dir>/ project.json spec.md init.sh
   progress.md audit.md checks/ blocked/ repo/`, with `features.json` and `acceptance.lock` present
   only as regenerated read-only mirrors no harness path reads; the authoritative copies are
   `runs/<id>/features.json`, `runs/<id>/acceptance.lock` and `runs/<id>/state.jsonl`, and the run
   directory additionally holds `audits.jsonl` and `reflect/`. *Why, stated plainly:* a blast-radius
   and tidiness measure, **not a control** — see §6.
8. **§4.5, the regression sweep's scope.** *Spec:* "the harness re-runs all earlier acceptance
   checks". *Now binding:* it re-runs all earlier passing checks, **each with `timeoutMs =
   min(checkTimeoutSeconds, max(5 s, 2 x its last passing duration))`**; when the remaining build wall
   budget will not hold a full sweep, the sweep degrades to the most recent K plus every
   ever-regressed feature, the `sweep` event records `scope: "partial"` and the skipped ids, and the
   incomplete sweep is re-run at the next build entry. *Why:* the untrimmed ceilings exceed
   `budgets.wallSeconds` before a single model call.
9. **§4.5, the "cannot be satisfied" exit.** *Spec:* a scored terminal outcome of the run.
   *Now binding:* the declaration ends the session; **the harness runs the check anyway** and an
   overruled declaration is recorded; otherwise the first declaration costs an attempt and the second
   blocks the feature; the run ends `honest_exit: cannot_be_satisfied` **only when
   `featuresPassed.executed === 0`** and at least one feature was blocked by declaration, otherwise
   `stopped: blocked`. `exitTool` gains per-phase `allowedExitKinds`. *Why:* execution is the top of
   the trust ordering, and a declaration made before any oracle ran is an opinion; and one impossible
   feature should not discard eleven good ones.
10. **§4.5, the check environment.** *Now binding:* an **allowlist** environment, not
    `redactEnv()`'s denylist, plus exactly the declared `needs`, with `envReplace: true`. *Why:*
    `isSecretEnvName` returns false for `AWS_SECRET_ACCESS_KEY` and most real credential names, so
    "credential-stripped" was a claim the denylist did not support.
11. **§3 and §4.5, model-context isolation.** *Spec:* "The record is never read back into model
    context" and the auditor has "no access to the builder's transcript." *Now binding:* **the
    harness never supplies `record.jsonl`, the builder transcript, previous verdicts, or other excluded
    artifacts through prompt/context construction; the reflector additionally has no retrieval tool.**
    Builder `bash` and the existing `read`/`search` tools are not sandboxed and can traverse host paths,
    so v1 does not claim that a builder or auditor is technically unable to retrieve excluded bytes.
    The auditor's supplied repo and Git tools point only at an exact detached snapshot, which protects
    the producer tree but does not create a host sandbox. *Why:* the previous absolute wording was
    stronger than the existing tool boundary and contradicted §6's accepted no-sandbox posture.
    *Foreclosure:* v1 cannot observe or rule out out-of-scope path reads; §17 names that limitation.
12. **§4.4, mutable feature progress.** *Spec:* each `features.json` item carries `passes: false` and
    `attempts: 0`, and the loop mutates those fields. *Now binding:* frozen feature objects contain
    only identity, description and acceptance; every pass, attempt, block, regression and repair
    transition lives in append-only `state.jsonl`, from which mirrors are regenerated. *Why:* one
    mutable artifact cannot be both the frozen contract and resume truth. *Foreclosure:* tools that
    edited `features.json` directly must consume the state fold instead.
13. **§4.4, post-freeze edit prevention.** *Spec:* "The brain and the builder cannot edit acceptance
    checks after this point; the human can." *Now binding:* harness write/edit tools refuse protected
    paths and the lock detects inconsistent edits, but unsandboxed builder bash can technically change
    both an acceptance object and its lock consistently. Human relock is the only authorized path,
    not the only technically possible one. *Why:* the live bash tool has no filesystem mediation.
    *Foreclosure:* §17 explicitly names consistent tamper as unobservable.
14. **§4.5, stall and budget/deadline termination.** *Spec:* three identical fingerprints, budget or
    deadline are terminal outcomes of the build loop. *Now binding:* a stall ends and counts the
    current attempt, then a fresh session may continue; budget and deadline write resumable
    `state: "stopped"`, re-entering only under §12's exact changed-condition rules. *Why:* a stuck
    transcript is not evidence the task is impossible, while an increased target can make a prior
    stop actionable. *Foreclosure:* operators use `done`, not `stopped`, for irreversible terminality.
15. **§10, the project link.** *Spec:* `runs/<run-id>/project` is always a symlink to the user-selected
    project directory. *Now binding:* without `--out` it is a real directory at that path; only an
    external `--out` uses a symlink. *Why:* the default needs no second location and stays complete in
    a run-directory archive. *Foreclosure:* callers accept either a directory or symlink at the one
    stable entry path.
16. **§14, exact formation metric provenance.** *Spec:* the listed record variants were treated as a
    complete event set, but none identifies a formation attempt or the single revision independently
    of critic calls. *Now binding:* add typed `formation.attempt { ideaId, attempt }` and
    `formation.revision { ideaId, attempt }` events at their durable orchestration boundaries. *Why:*
    validation and budget exits can occur before critique, so `formationAttempts` and
    `formationRevisions` cannot be reconstructed exactly from `phase.start` or paired critic events.
    *Foreclosure:* consumers must tolerate these two additive variants instead of assuming the §14
    list is exhaustively closed.
17. **§14, crash-safe builder-session provenance.** *Spec:* the final `attempt` event was the only
    typed carrier for raw builder-session facts. *Now binding:* add a keyed
    `builder.session { featureId, attempt, ...rawSessionFacts }` event immediately after the builder
    returns; the loop later folds it into exactly one final `attempt` after check, audit and commit
    disposition are known. *Why:* a crash after the builder or a passing check but before the final
    attempt event must resume without rerunning the builder, while writing a partial `attempt` early
    would double-count sessions and corrupt disposition metrics. *Foreclosure:* resume reducers must
    treat `builder.session` as raw boundary evidence, never as a completed attempt or pass decision.

**Not overridden:** `budgets.usd: 25`, `budgets.wallSeconds: 14400`, `rounds: 3`, and §8's turn-cap
placeholders. `maxFeatures`, `formationAttempts` and the sweep's scope are **derived from** them,
which extends the ideation record's derived-sub-budget-with-a-floor mechanism one level down rather
than re-tuning a ratified number. `budgets.usd >= $36.42` is what a 12-feature build costs and
`>= $41.70` is what a second formation attempt costs; both are budget consequences, not new defaults.

## 19. Assumed interfaces from the ideation loop (verify before execution)

Ideation Tasks 8 (`src/phases/ideate.ts`, `src/ideation/metrics.ts`, `src/ideation/bare.ts`) and 9
(`src/phases/checkpoint.ts`, `src/cli/commands/ideas.ts`) are being implemented concurrently. At the
original decision they were not on disk. Task 8 has now landed `computeMetrics`, the shared
`PhaseResult` stopped arm, `RunStatus.state: "stopped"`, and base `budgets.share`/`phaseBudgetUsd`;
they are dependencies to consume, not interfaces this plan may duplicate. **Verify each item
against the merged tree before executing the plan.**

1. **`RunStatus.chosenIdeaId`**, written by `runCheckpoint` and by `kiln ideas pick`. Needed by
   formation to learn which idea was chosen, and by `project.json.ideaId`.
   *Fallback:* `lastChosenIdea(record)` returning the `id` of the last `checkpoint.decision` whose
   `kind` is `"pick"` or `"autonomous_pick"`, **ignoring `"reject"` and `"another_round"`**.
   **Works** — both kinds and the optional `id` are already in `core/events.ts`. *An unfiltered scan
   does not work: `checkpoint.decision.id` is set on rejections too.*
2. **`runCheckpoint(deps, io, opts?: { exclude?: string[] })`.** Needed only for interactive re-entry
   after a `not_formable`. The original ideation Task 9 brief named only `(deps, io)`; the controller
   has carried this additive option and its exclusion test into the live Task 9 dispatch. *Fallback:*
   none exercised — `formationAttempts` derives to 1 at the default budget. **Verify the option before
   executing this plan; it is inert below `budgets.usd >= $41.70`.**
3. **`io.ask(prompt): Promise<string>`** on the injected io object. Needed to ask a human once to
   verify a `manual` feature. *Fallback:* the build plan declares its own `AskFn` in
   `src/build/loop.ts` and the CLI wires stdin. **Works unconditionally.**
4. **A value-ordered frontier in `frontier.json`.** Needed to advance down the value ladder after a
   `not_formable`. *Fallback:* read it defensively — accept `{ ideas: [{ id, ... }] }` in value order
   or an explicit `ladders.value`; treat absent, unreadable or unrecognised as "no second idea" and
   end honestly. **Works by degrading.** *Reading `checkpoint.shown`'s ladders does not work:
   autonomous mode picks without showing anything.*
5. **`computeMetrics(paths): Metrics`** in `src/ideation/metrics.ts`. Needed by the metrics fold, the
   reflect digest and write-reflect-rewrite ordering. Task 1 extends the widened stop initializer;
   Task 6 extends the exported interface and merges `BuildMetrics`. *Fallback:* if no callable export
   exists, the build plan owns the whole fold. **Works unconditionally.**
6. **`RunStatus.cursor` widened** to `{ round?; featureId?; attempt?; step }`. *Fallback:* the schema
   task widens it and every added field is optional. **Works only if the schema task lands after
   Tasks 8 and 9** — landing it concurrently is a merge conflict in `src/core/run.ts`, not a type
   reconciliation. Note this is a widening (`round` becomes optional), not a pure addition.
7. **A `PhaseResult` arm expressing a stop** — `{ outcome: "stopped"; stopKind: StopKind }` — and
   `RunStatus.state: "stopped"` landed in Task 8. **This was the single non-additive coordination
   point between the plans.** This plan extends the shared types; declaring a local `BuildResult` or
   reverting stopped runs to `done` does not work.
8. **`--through` accepting `ideate|checkpoint`.** *Fallback:* append `form|build|reflect` to whatever
   list lands. **Works, but note the premise is currently false**: `--through` is an unvalidated
   string defaulting to `"discover"`, so a mismatch today is a **silent misroute, not a compile
   error**. This plan adds the validation.
9. **`runBare(deps)` in `src/ideation/bare.ts`** as the structural precedent for shipping an ablation
   arm beside the mechanism it tests. *Fallback:* none needed — a precedent, not a call.

**Cross-workstream corrections**, recorded here because ideation owns their code: consumers of
`checkpoint.decision.id` filter to pick kinds; Task 9 adds the optional checkpoint exclusion above;
ideate reads its 0.42 share through `phaseBudgetUsd`; config rejects an effective share total other
than 1.000; and every stopped ideation outcome uses the shared `state: "stopped"`. Task 8 has landed
the budget/state corrections and also measures `BrainResult.costUsd`/`ScoutResult.costUsd` inside
the brain. This plan consumes those values rather than diffing the shared journal; `costSince` is
stale and does not exist.

## 20. What must be measured before any of this is trusted

Every dollar and second in §12 is an estimate from list prices and an assumed session shape. Nothing
here was measured, and no paid call was made. The first end-to-end run replaces them:

- `costByRole.builder / builderSessions` against $0.716, and `costByRole.auditor / audits` against
  $0.393 — these two size everything else.
- the fraction of builder sessions ending `stopped: "turn_cap"` versus `"usd_cap"` — the first says
  the restored 40-turn cap binds, the second says the dollar cap does, and only the second is
  intended.
- `auditorTokenShare` against the spec's measured 19-38 percent band.
- `regressionSweepSeconds` and `regressionChecksSkipped` against the 2T scope cap's projected 4x
  headroom.
- `costByPhase` against the cumulative share ledger, and `usdSpent` against both the $25 target and
  the $26.88 estimated high-water envelope. Any observation above the envelope disproves its turn-shape
  assumptions; it does not violate a hard bound, because v1 has none.
- M2 itself: five formed projects, arm A against `--single-session`, at equal dollar and wall
  budgets, with `censored` runs excluded.
