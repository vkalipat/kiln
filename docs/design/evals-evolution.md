# kiln evals and evolution: decision record

Date: 2026-09-05
Status: shared understanding reached after a three-round agent-versus-agent design grill (101
questions, 26 challenges, 13 consistency findings, a per-item over-concession audit, two code-contact
audits) plus eight controller rulings. No human took part; every open decision was made by the
owner-agent or by the controller, and each carries a rationale and a cost-if-wrong. Three supervisor
addenda are binding on this record and are cited by item id throughout. This record is the input to
the evals-and-evolution implementation plan.

**Precedence.** Where this record differs from the design spec
`docs/superpowers/specs/2026-09-02-kiln-ideation-harness-design.md`, **this record wins**. The design
spec is not edited; it remains the historical document, exactly as it relates to the ideation loop and
to formation/build through their own records. §15 below lists every spec section this record
overrides, with the old wording and the new binding wording; a spec section not listed there stands
unchanged. Where this record and the ideation-loop record
(`docs/superpowers/specs/2026-09-03-kiln-ideation-loop-decisions.md`) or the formation/build record
(`docs/superpowers/specs/2026-09-04-kiln-formation-build-decisions.md`) differ on a matter those records
own — the money table in formation/build §12, the judge's effort in ideation §2, the candidate contract
in formation/build §13 — **they win**, and this record flags a cross-workstream correction rather than
overriding them. The three supervisor addenda are binding: `docs/research/2026-09-04-frontier-model-practices.md`
items A3, A12, A15, §C and §E (E1–E7), and `.superpowers/sdd/model-practices/rulings.md` rulings 1, 7,
8, 9, 10 and 12. Where a round-1 answer and a binding text differed, the binding text won and the
ruling says so.

**Inheritance.** Both earlier decision records are binding precedent, not suggestions. Their mechanisms
are extended here rather than re-invented: failure classes; a derived sub-budget with a floor, where
whole units are skipped rather than truncated (here the unit is one seed pair, and the floor is its
ceiling); protected harness-owned files (here fingerprinted by a manifest and by commit-on-write);
resume idempotent-by-file with the cursor as a hint (here the eval directory and its judged lines);
stop kinds distinct from failures; the mechanical-floor honest exit counted apart from the declared one
(here an honest exit loses a seed and never censors); metrics as a fold over durable artifacts (here
the cost block is another plan's fold, consumed); the stateless worker idiom — one decision tool,
`terminalTools`, a turn cap of 1–2, one retry then a recorded degenerate outcome — for the labeller and
the arbiter conflict seat; the projected-cost table printed before money is spent; and the
schema-task-first rule, now ordered across three plans.

Sources: `.superpowers/sdd/grill-evals-evolution/round-1-questions.md`, `round-1-answers.md`,
`round-2-challenges.md`, `round-2-answers.md`, `round-3-consistency.md`, `code-contact-round-1.md`,
`code-contact-round-2.md`, `cost-model.md`, `design-status.md`, `design-brief.md`.

---

## 0. Controller rulings

Eight decisions the controller made on the residual conflicts the two agents could not settle, or to
correct a remedy the round-3 over-concession audit found had overreached. Each is binding; each was
recorded as `Ruling: what — why — cost if wrong`.

| # | Ruling |
|---|---|
| 1 | **Build-class candidates promote on paired feature outcomes.** For a `## build` candidate (and a `builder`/`auditor` prompt candidate) the freeze is cloned at `freeze` and each feature id is one collapsed pair — the candidate arm wins when its feature reaches `passes: true` from execution and the champion's does not, loses in the reverse case, ties otherwise (half a win) — `n` = paired features over uncensored seed pairs, `minPairs: 32` unchanged (reachable at 8 seeds x 4 features), the same 95 percent Wilson gate; honest exits and blocks leave a feature unpassed on their side. `## form` and `critic` candidates (clone at checkpoint, unpaired features) are seed-level and **`not_evidence` at 12 seeds in v1** — reported, never promoted — and the record's item-8 sentence says so. — **Why:** one gate shape, and the paired unit is the execution signal §5 ranks first; without it round 2's "only build-class candidates can promote" promoted nothing. — **Cost if wrong:** feature outcomes inside one project are correlated (the same caveat E5 carries for pairs within a seed), so the interval is optimistic — named in §14; a `## form` delta cannot promote in v1. |
| 2 | **The candidate hash is counter-stripped, and the field is `playbookHash`.** A cross-workstream correction to formation/build Task 10, uncommitted this morning: `playbookHash = hashInput(stripCounters(playbook))`, with `stripCounters` (one regex over `[helpful:n harmful:n]`) exported from `src/build/delta.ts` and reused by this plan's `playbookHash()`; this record uses the name `playbookHash` everywhere; a candidate carrying a byte hash is archived `stale_champion` on first sight. — **Why:** F4's promote/archive counter bumps and ruling 7's operator resets must not stale every pending candidate; one hash function in one file. — **Cost if wrong:** one line in a file the dev lead is committing; candidates written before it are archived and re-reflected at $0.153 each. |
| 3 | **The sweep's baseline set is twelve incumbent loop runs, and its incumbent cell is the one pre-registered A/A.** The generator + brain row's baseline is the champion at ruling 1's table run once on the 12 dev seeds at one round (+$28.08 over the bare baseline; minimal grid ≈ $574 on the round-3 repriced basis, estimated); every cell is loop-versus-loop against that set, which is what item 2(b)'s "lower bound against the incumbent" pairs against; the incumbent cell — the same configuration run again — is champion-versus-champion at n = 96 and is the **only** pre-registered A/A: its 95 percent interval must contain 0.5 or no sweep or M3 result is trusted. L7's separate 6-seed A/A is dropped; the bare arm stays in M1 as B0, not in the sweep. Round-2 item 12 is thereby corrected on the premise the over-concession audit found wrong. — **Why:** an A/A must compare identical loops; a rule that pairs against an incumbent needs incumbent runs. — **Cost if wrong:** $28 and one more row; if the A/A interval excludes 0.5 the judging scheme is biased and the grid is halted — which is the point. |
| 4 | **Rung 11 is a flag, never a refusal.** `promote` prints both `usdPerSuccess` figures and their ratio, records `Kiln-Cost-Ratio` in the promote commit's trailers, marks the row in `evolve list` when the ratio exceeds `cfg.evals.costRatioCap` (1.5, a warning threshold), and refuses nothing on cost; the ladder has ten refusal rungs and one flag. — **Why:** E1 read literally — quality first, cost second — and refusing a quality win on cost is the ordering E1 forbids; the supervisor sees the columns. — **Cost if wrong:** an expensive quality win is promoted by inattention; the ratio is in the commit and the list, and rollback is one command. |
| 5 | **One validator, in Task 10's file; the arbiter runs only where there is an async seam.** This plan extends `validateDelta` in `src/build/delta.ts` **additively** with the A12 and A15 structural rules and never creates a second validator; `PlaybookDelta` gains optional `why` and `kind` (a cross-workstream correction to the uncommitted Task 10 tool schema), and the bullet line's serialised form is `<lesson>. Why: <clause>.` — when a delta arrives without `why`, `validateDelta` parses the `Why:` clause out of `text` and refuses an `add`/`edit` that has none; `kind` defaults to `correction`. The recorded arbiter `conflict` verdict runs at `evolve eval` preflight and at `evolve apply` only; reflect-time validation is structural. `prompts/reflector.md` already carries A12's rubric in the working tree and this plan does not edit it. — **Why:** `runReflect` has no async seam and the answers' own rule forbids a duplicate validator. — **Cost if wrong:** a formation/build file gains eval rules (additive, tested there); a reflector candidate is semantically checked only at eval — six arbiter calls later, before any money. |
| 6 | **The three-plan order is a cross-workstream correction the supervisor relays.** Formation/build Tasks 10-11 → model-practices Task 1 → evals Task 1 → model-practices Tasks 2-5 → evals Tasks 2+; the model-practices plan's Task 3 waits for evals Task 1, which ships `applyDelta` and `kiln evolve apply`, and applies the B1-B3 / FM1-FM2 rewording as one operator-delta series with counters **reset** (ruling 7 over that plan's "preserved"). Stated in this record §1 and flagged for that plan's Global Constraints. — **Why:** two plans adding one field to `core/config.ts` with no order is a merge conflict. — **Cost if wrong:** that Task 3 hand-edits and hand-writes `evolution/deltas.jsonl` lines — the named degrading fallback. |
| 7 | **The porcelain refusal covers `evals/` and, in `config.json`, only `evals.judgeGate`.** `evolve` and `evals` commands compare `config.json`'s `evals.judgeGate` against HEAD and refuse on a difference; other config keys are not fingerprinted because `eval.json` freezes the roles, budgets, profile and effort table every eval ran under (round-2 item 18). — **Why:** item 9's remedy overreached its finding; a whole-file refusal blocks every command after a budget edit. — **Cost if wrong:** a hand edit to model roles between evals is invisible to the fingerprint but visible in the frozen block of every report. |
| 8 | **Round-3 fixes adopted as written, in one sentence each.** `cfg.evals.sweepPairsPerSeed: 8` names the sweep's `k` and is frozen in `eval.json` beside `pairsPerSeed` (conflict 6); the builder and auditor sweep rows are priced at ruling 1's 7 features (≈ $220 / $209, estimated; conflict 8); `kiln evolve rollback` runs `git revert --no-commit`, appends the `deltas.jsonl` line, and commits once with the trailer, so the journal and the revert share a commit (conflict 9); the survivor denominator is the fold "inserted ideas not later rejected as `restatement` or `collided`", keyed by id (conflict 13); the reflector's `deps.effort` read is the eleventh site the model-practices plan's `effortFor` switch covers (code-contact); the M1 grid, the ceilings, the clone figures and the $1,597 sequencing sum stand as recomputed. |

The over-concession audit's verdict on round 2, recorded because a defender that concedes twenty-six
for twenty-six is itself a signal: **24 concessions sound, 1 sound with an overreaching remedy (item
9, the porcelain scope — corrected by ruling 7), 1 that should have been rejected on its premise (item
12, the A/A cell — corrected by ruling 3), 0 rejections to audit.** Twenty-four of the twenty-six
challenges attacked the answer set with its own material — twelve internal contradictions or
arithmetic over caps and floors round 1 itself chose, six decisive code facts independently
re-verified, six binding texts the answers had narrowed or predated. The positive evidence against
reflexive agreement is concrete: the owner refused the deferral of the generator + brain sweep row
(item 8), refused `frontier.raw` as the headline denominator (item 4), refused "cheapest admissible"
without a quality-win clause (item 2), refused the challenger's own repricing in favour of the cost
model's (items 21, 23), refused "accepted" for three git spawns per invocation (item 20), and narrowed
item 5's ceiling to the run's allocation. Where the concession failed, it failed in the one way the
previous grill's audit predicted: a premise taken from the answer set instead of from the file it was
about.

**The fifteen rulings owed, as they stand after the controller rulings:**

| item | final ruling |
|---|---|
| 1 seeds | Authored by a seed-author seat and vetted by an independent seed-auditor seat in Task 1 under a rubric `seeds.test.ts` enforces; every seed source resolves by hash before a run exists and a held-out seed refuses without `--eval`; `kiln evals leakcheck` (Jaccard, 8-word shingles, run-split cross-check, manifest) runs standalone and as a promote preflight; the brain/builder `bash` and unrooted `read` residual is named (§3). |
| 2 M0 without a human | Agent-labelled by default with `labelSource: "agent"`, which never gates promotion and never trips the kill, refusals counted; with no `calibration.json` every artifact reports `judgeCalibration.status: "absent"`, evals run, judge-based verdicts are `provisional`, promote refuses — and **in v1, with no human labeller, only execution-scored (build-class) candidates can promote** (§4). |
| 3 gates and money | Unit = collapsed pair (`k = 4`) for judged classes, paired feature outcome for build-class (ruling 1); `minPairs: 32`, `minUncensoredSeeds: 8`; gate = 95 percent Wilson lower bound over the pairs actually judged > 0.5 (31 of 48 when all seeds count, 22 of 32 at the floor); one `evolve eval` is $495 expected / $558 at the ceilings (ideate-class, 3 rounds; $196 at 1 round) and $818–$849 build-class with the clone, never inside $25 / 4 h, started only with an explicit `--budget` at or above one seed pair's ceiling (§9). |
| 4 evaluator outside the tree | `evals/seeds/{dev,heldout}/` plus the harness files, fingerprinted by `manifest.json` that every `evals`/`evolve` command verifies; the three gating files it cannot cover are committed by the commands that write them and guarded by the porcelain refusal (scoped by ruling 7); write-side `protectedDirs` from every phase plus an `--out`-inside-home refusal; `initHome` sets identity and makes the initial commit; rollback = `git revert --no-commit` of a promote or operator-delta HEAD plus the journal line in one commit, `--confirm`; `evolve.lock` serialises every writer (§2). |
| 5 prompt variants | In v1, operator-authored via `kiln evolve propose`; `judge`, `kernel` and `reflector` refused; never reflector-proposed; evaluated by the role's phases with the clone rule (§8). |
| 6 runners | `pairCensoredBy` = `budget`, `deadline`, `transient`, `stalled`; failures excluded and counted; honest exits lose the seed, leave `n`, never censor; quality columns then `cost.*`; M2 in scope via `cloneFormedRun` (three rewrites, symlink refusal, `init.sh` once per arm); M1 is four arms in three paired tables (§7). |
| 7 archive and the 120 cap | Every candidate leaves `candidates/` to `promoted/` or `archive/<id>/` with a closed 16-value reason enum, committed; the 120-active-bullet refusal runs at eval preflight and at promote; retired bullets excluded (§8, §10). |
| A3 | Effort is measured once per (role, model ref, seating profile) by the grid — judge on the M0 replay (five pairs per group); generator + brain on twelve incumbent loop runs at one round, `k = 8`, with the incumbent A/A cell (ruling 3); builder then auditor on M2's five formed projects at 7 features; critic and cheap seats `not_swept` — under the non-inferiority rule, recorded in `evals/effort.json` and committed; every comparison consumes and records it and none whose grid-row seats are unswept may promote; minimal grid ≈ $574, estimated (§6). |
| A15/§C | The mechanical gate is `validateDelta`'s structural rules in `src/build/delta.ts` (extended in place, ruling 5) plus a recorded arbiter `conflict` verdict per (bullet, role prompt) and (bullet, sibling) at `evolve eval` and `evolve apply`, applied to candidates and operator deltas alike; the precedence sentence in `kernel.md` is the model-practices plan's; this plan adds no prompt text (§8). |
| A12 | Five validation rules — `<lesson>. Why: <clause>.` on every new add/edit, `kind` on add/edit (defaulting to `correction`), duplicate-forces-edit at Jaccard 0.6, retire-with-metric-evidence, fact-not-lesson refusal — with pre-rubric bullets grandfathered and no plan-time migration; the reflector prompt's rubric sentences are Task 10's (§8). |
| E1/E7 | `usdPerSuccess` and its three companions come from `metrics.json.cost` (model-practices Task 5); ideation denominator = inserted ideas not later rejected as `restatement`/`collided`, keyed by id, `frontier.raw` beside; `null` on zero; `model.call.usage`'s four buckets satisfy E1 and the mapping is stated; quality is decided by the Wilson gate alone, cost never refuses (ruling 4), and the sweep's non-inferiority margin is the one named quality risk (§5, §6). |
| ruling 1 | Adopted verbatim as the initial `effortByRole`, owned by the model-practices plan's Task 1 and consumed here; `generator` is flagged as unlisted; the repricing (`maxFeatures` 7, `expectedAttemptUsd` $1.240, `builderUsdCap` $1.256, formation $1.315) is a priced consequence flagged to the supervisor for the formation/build record's §12 table; runners read `derivedCaps(cfg)` (§6). |
| ruling 7 | Operator deltas are a category — `kiln evolve apply`, validated, ungated, counters reset, committed with `Kiln-Operator-Delta`, journalled in `evolution/deltas.jsonl` — shipped in this plan's Task 1 before the model-practices plan's Task 3 uses it (ruling 6) (§8). |
| ruling 10 | `cfg.seating.frontier` is an opt-in profile carrying the cost model's re-derived caps (`maxFeatures` 4, a $26.72 full run — over target, flagged as ruling 10's own money call), and M1's A2 arm runs it (§7). |
| ruling 12 | M1 runs A0 vs B0, then A1 (Fable-at-low) vs A0, then A2 (frontier profile) vs A0, paired on the same 12 held-out seeds with `usdPerSuccess` beside the quality columns; the grid is $429 at 3 rounds and $190 at 1 round, estimated (§7). |

---

## 1. Scope, ownership and sequencing

- This record governs the evaluation harness and the self-evolution pipeline: `evals/` and its
  seeds, split, manifest and calibration; the pre-registered runners M0, M1, M2 and M3; the per-role
  effort sweep; the playbook delta model, candidates, operator deltas and prompt variants; and
  `kiln evolve eval | promote | rollback | archive | list | propose | apply`. Ideate and the
  checkpoint belong to the ideation-loop record; form, build and reflect to the formation/build
  record. Reflect writes candidates into `evolution/candidates/`; this record is what reads them.
- **What this record consumes from formation/build Tasks 10 and 11** (in flight; §16): the candidate
  file at `candidatePath(home, runId)` = `evolution/candidates/<runId>.json` (`src/core/paths.ts`,
  working tree), `validateDelta`, `parseDelta`, `playbookSections`, `playbookBulletIds` and
  `writeCandidate` in `src/build/delta.ts`, the digest (`src/build/digest.ts`, 16 kB cap) and
  `runReflect` (`src/phases/reflect.ts`, one tool, `roots: []`); and Task 11's `kiln project build
  --single-session`, `--through form|build|reflect` and `run resume` routing, each with a fallback.
- **What it consumes from the model-practices plan** (`docs/superpowers/plans/2026-09-04-kiln-model-practices.md`,
  nothing landed): Task 1's `KilnConfig.effortByRole` and `effortFor(cfg, role, model)` (ruling 1),
  the `model.call` fields `effortSent`, `addendaHash`, `fallbackServed`, `reasoningTokens`, and the
  `refusal` failure class; Task 3's kernel precedence sentence; Task 5's `src/core/cost.ts`
  (`foldCost(events, phase, successes): CostBlock`) and `metrics.json.cost: Record<Phase, CostBlock>`.
  This plan adds none of these and consumes all of them.
- **Sequencing (controller ruling 6):** formation/build Tasks 10–11 → model-practices Task 1 →
  **this plan's Task 1** (schema, home git, the delta model and `kiln evolve apply`) → model-practices
  Tasks 2–5 → this plan's Tasks 2+. The model-practices plan's Task 3 waits for this plan's Task 1
  and applies its B1–B3 / FM1–FM2 rewording as one operator-delta series with counters reset. This
  order is a cross-workstream correction the supervisor relays to that plan's Global Constraints;
  a sequencing rule that lives in only one of the two plans it orders is not a rule (round 3, item 12).
- Nothing in this record runs inside a run. `kiln evolve` is manual, never scheduled, never invoked
  by a phase (spec §6); every multi-run measurement is a separately budgeted, supervisor-gated
  operation that starts only with an explicit dollar figure on the command line.
- **ADR scope.** ADRs 0007–0013 govern the future production harness described by
  `AGENTIC_HARNESS_PLAN.md`, not this standalone kiln prototype. This record borrows only the
  compatible principles the formation/build record §1 named — deterministic delivery and budget
  arithmetic never purchase model turns; originals are retained before lossy projection; a verifier
  does not activate its own result — and claims none of the ADRs' mechanisms.

## 2. The evaluator's home

- **Layout.** `~/.kiln/evals/{seeds/dev/<id>.md, seeds/heldout/<id>.md, split.json, judge-rubric.md,
  README.md, manifest.json, calibration.json, calibration/<id>.jsonl, effort.json}`;
  `~/.kiln/evolution/{candidates/, archive/<id>/, reports/<evalId>/, work/<evalId>/<arm>/, promoted/,
  deltas.jsonl, evolve.lock}`. The directory a runner reads *is* the split; `split.json` is the
  cross-check. `initHome` bundles and copy-if-absents the 24 seeds, `split.json`, `judge-rubric.md`,
  `README.md` and `manifest.json` (29 files; `src/core/home.ts:18` is the idiom). Exactly two commands
  write under `evals/`: `kiln evals calibrate` (`calibration.json`, `calibration/`) and `kiln evals
  effort` (`effort.json`); no run ever does. Eval runs live **only** under
  `evolution/work/<evalId>/<arm>/runs/`; `evolution/reports/<evalId>/` holds exactly `eval.json`,
  `judged.jsonl`, `record.jsonl` and `criteria/`.
- **The manifest.** `evals/manifest.json` = `{ version: 1, kilnVersion, generatedAt, files: { "<path>":
  "<sha256 of bytes>" } }` over every file under `evals/` except `manifest.json`, `calibration.json`,
  `calibration/` and `effort.json`; generated by a build-time script and bundled.
  `verifyEvalsManifest(home): { ok, changed, missing, extra }` is called by every `kiln evals *` and
  `kiln evolve *` entry and refuses on mismatch with failure class `integrity`, naming the files;
  `kiln run new` / `run resume` append a `note` and continue — an ordinary run does not consume
  `evals/`. This is spec §3's "fingerprinting it is the stronger form" applied to the evaluator's
  material.
- **The three gating files the manifest cannot cover are fingerprinted by commit-on-write.** The
  command that writes one commits it through `GitRunner` in the same invocation: `evals(calibrate):
  <labelSource> <groups> groups` for `calibration.json` and `calibration/<id>.jsonl`; `evals(effort):
  <role> <winner>` for `effort.json`; `evals(gate): judge removed` for the §4 kill's `config.json`
  write — each with a `Kiln-Evals-Write: <path>` trailer. `evolve eval` and `promote` refuse on a
  dirty tree under `playbook/`, `prompts/` or `evals/`, and, in `config.json`, on a difference in
  `evals.judgeGate` against HEAD only (**controller ruling 7**); other config edits are recorded in
  every report's frozen block (§9) and never block. The `--effort-sweep <role>` one-off on a runner
  reports and never writes.
- **The home repo.** `initHome` sets `user.name = kiln`, `user.email = kiln@localhost` with
  `git config --local` and, when HEAD is absent, makes an initial commit of `playbook/`, `prompts/`,
  `evals/`, `config.json` and `.gitignore` (a repo with no identity cannot commit — the formation/build
  record's verified fact; a rollback needs a parent). On later startups the check is an fs check —
  `.git/HEAD` exists and `.git/refs/heads/` is non-empty — so no `git` is spawned on an initialised
  home (`initHome` runs at four CLI entry points: `run.ts:89`, `ideas.ts:35,88`, `auth.ts:31`); a
  packed-refs repo falls through to one harmless `git init -q`. Tracked: `playbook/`, `prompts/`,
  `evals/`, `evolution/{archive,reports,promoted}/`, `evolution/deltas.jsonl`, `config.json`.
  Ignored: `runs/`, `auth.json`, `evolution/{candidates,work}/`, `evolution/evolve.lock` — the two
  new lines added by an idempotent `ensureIgnored(home, lines)`, because `.gitignore` is written only
  when absent (`home.ts:20`). The committers are `initHome`, `calibrate`, `effort`, the gate write,
  `promote`, `archive`, `apply` and `rollback`, each with a trailer: `Kiln-Evals-Write`,
  `Kiln-Candidate`, `Kiln-Eval`, `Kiln-Champion-Before`, `Kiln-Champion-After`, `Kiln-Confirmed`,
  `Kiln-Cost-Ratio`, `Kiln-Operator-Delta`, `Kiln-Rollback-Of`. `GitRunner` gains `revert(dir, sha,
  { noCommit })`; `GitRunner.hasTrailer(dir, key, value)` (`src/build/git.ts:42`) is the trailer
  check; `FakeGitRunner` gains `revert`.
- **`evolve.lock`** in the `run.lock` shape (`src/core/lock.ts`: `O_EXCL`, `{ pid, host, startedAt }`,
  stale by `kill(pid, 0)`, `--force`) is held by `evolve eval` for its whole invocation and by
  `promote`, `rollback`, `archive` and `apply` for theirs.
- **Rollback.** `kiln evolve rollback --confirm` reverts **HEAD only**, only when HEAD carries a
  `Kiln-Candidate` or `Kiln-Operator-Delta` trailer, refuses on a dirty tree, runs `git revert
  --no-commit`, appends the `deltas.jsonl` line (`op: "revert"`), and commits once with the revert's
  message plus `Kiln-Rollback-Of: <sha>` (controller ruling 8); a reverted candidate is re-archived
  `rolled_back`. The sha form is refused: "only the most recent promotion can be rolled back in v1"
  — older reverts can conflict and kiln has no merge tool.
- **Write-side defence in depth.** Every phase's `ToolContext` supplies `protectedDirs:
  homeProtectedDirs(home)` = `[evals, evolution, playbook, prompts]` under the home
  (`ctx.protectedDirs`, `src/brain/tools/write.ts:55-62`), and `materializeProjectPath` gains one
  additive check refusing an `--out` that resolves inside `<home>` anywhere except under
  `<home>/runs/` — today it refuses only a target inside the run directory
  (`src/formation/paths.ts:159-160`), so `--out ~/.kiln/evals/x` would make `evals/` the form brain's
  writable root. Roots are the mechanism (`insideRoots`, `write.ts:33`); a `read`-side refusal is
  rejected because it would be the first root check on `read` and would break the form brain's
  absolute-path reads (formation/build record §2).
- **The residual, stated plainly.** `read` and `search` have no root check (`read.ts:22-24`,
  `search.ts:29-36`); `bashTool` calls `insideRoots` nowhere (`bash.ts:9,36`); the brain in frame,
  discover and form and the builder have `bash`. A seat that chooses to read or write
  `~/.kiln/evals/` can. v1 detects (the manifest, commit-on-write, §3's leak check); it does not
  prevent — the same posture the formation/build record §6 adopted.

## 3. Seeds, the split, seed identity, secrecy and leak detection

- **Authorship (supervisor item 1).** The plan's Task 1 dispatches a **seed-author** subagent that
  writes the 24 seeds under the rubric in `evals/README.md`, and an independent **seed-auditor**
  subagent that checks every seed against the rubric's judgement half (non-trivial, no named artifact
  to copy, one shape) and writes its report to the ledger before the implementer commits;
  `seeds.test.ts` enforces the mechanical half. No kiln code path ever writes a seed. This overrides
  spec §5.2's "added by humans" (§15, override 1); the author/auditor pair is the critic precedent.
- **The rubric.** Seed text is 2–6 sentences and 200–900 characters, names a domain or problem and at
  least one constraint, contains no URL, backticked identifier, product, paper or repository name to
  copy, and declares one of `research | product | creative`. The non-triviality sentence lives in
  `split.json` as `rationale` and never reaches the brain — frame's prompt is `Seed:\n${seed}`
  verbatim (`src/phases/frame.ts:126`) and a seed that argues for its own difficulty steers the run.
  Seed files are plain text.
- **`split.json`** = `{ version: 1, seeds: [{ id, shape, split, file, sha256, rationale }] }`, 24
  entries, 12 dev / 12 held-out, exactly 4 per shape per split, ids matching
  `^(dev|heldout)-(research|product|creative)-\d{2}$`, `file` under the matching directory;
  `verifySplit(home)` is called by every runner. Pairwise `trigramJaccard` (`src/ideation/novelty.ts:37`)
  < 0.30 across all 24 and < 0.25 for every dev/held-out pair — **estimated**; the test prints the
  observed maximum and the Task 1 report records it.
- **Seed identity.** `RunStatus.seed?: { id, split: "dev" | "heldout", sha256 }` is written by `kiln
  run new --seed-id <id> | --seed-file <path>` and by every runner; `seedIdentity(run, split)`
  re-derives it by hashing `seed.md` against `split.json`, so a hand-started run with pasted held-out
  text is still recognised. `run new` computes `seedIdentity` for **every** seed source — `--seed-id`,
  `--seed-file`, argv text — **before** `createRun`, and refuses a seed that resolves to `heldout`
  unless `--eval <evalId>` names an eval directory in progress; the refusal names the seed id. The
  rule is keyed on the seed's hash, not on a flag (round 2, item 17). The seed's declared shape is the
  eval's expectation and frame's `Shape` is the observation — `shapeMismatch: true` on the report
  row, never enforced.
- **What "the reflector and the brain never see the held-out seeds" means** (override 3). The literal
  sentence is unsatisfiable for the arm that runs a held-out seed (`frame.ts:120`). What is protected
  is the **mutable tree**: playbook, prompts and candidates are never trained on held-out text —
  (i) `runReflect` records a `delta` with `accepted: false, reason: "heldout_seed"` and writes no file
  for a run whose `status.seed.split === "heldout"` (assumed interface 1; Task 10 does not read
  `status.seed` today, and the fallback holds without it); (ii) the runners never invoke reflect on
  any eval run; (iii) `kiln evolve eval` refuses a candidate whose `runId` resolves to a held-out
  run; (iv) the `--eval` refusal above. The reflector's bundle excludes `repo/` and symlinks
  (`src/build/bundle.ts:25,76`, working tree) and its context excludes `evals/`
  (`test/phases/reflect.test.ts:57`).
- **Leak detection after the fact.** `kiln evals leakcheck [--json]` runs four unpaid checks:
  (i) `trigramJaccard` ≥ 0.35 (estimated) between any held-out seed and any playbook bullet, any
  paragraph of any `prompts/*.md`, or any candidate's `delta.text`; (ii) any shared 8-word shingle,
  exact; (iii) every candidate's, archived candidate's and promoted candidate's `runId` resolved to its
  run's `status.seed` and flagged if `heldout` (falling back to `seedIdentity`); (iv) the manifest.
  Output rows `{ kind, source, seedId, score }`. `evolve promote` runs it as a mandatory preflight
  and refuses on any flag. A paraphrase below 0.35 passes — named in §14.
- **The enforcement table** (ratified as the record's statement for supervisor item 1). Seats with
  **no shell**, verified in the tree: the judge (`tools: []` / `[verdictTool]`, `src/ideation/judge.ts`),
  islands (`islands.ts:246`), the bare generator (`bare.ts:47`), the critic (`critique.ts:109,120`),
  the arbiter (`archive.ts:247`, `priorart.ts:91`, `axes.ts:67`), the prober (`probe.ts:208`), scouts
  (`SCOUT_TOOL_NAMES`, no `bash`), the auditor (`build/auditor.ts:238`), the reflector (one tool,
  `roots: []`, `reflect.ts:120-142`), and this record's labeller and arbiter conflict seats (one
  decision tool each). Seats **with** a shell: the brain in frame, discover and form (`PHASE_TOOLS`)
  and the builder (`BUILDER_TOOL_NAMES`). `read`/`search` are unrooted everywhere. A test per seat
  pins its exact tool names so a later tool addition cannot hand a shell to a seat the record says
  has none.
- **The bundled-held-out residual.** Held-out seeds are bundled in the package and copied into every
  home; any seat with `read` can open them by absolute path and the text sits in git history. The
  record names it: the secrecy that matters is against the mutable tree, not against a curious seat,
  and v1 has no sandbox. Hashes-only or encryption at rest would need a human to hold the key.

## 4. Judge calibration and M0 without a human

- **`kiln evals calibrate --labels human|agent [--groups N]`** (supervisor item 2). One file,
  `labelSource` recorded. The **agent labeller** is a strong model resolved with `resolveRoleOn` on
  the **other** provider from the judge's (degrading to a different tier on the same provider with
  `crossProvider: false`, as ideation record §2 does for the judge), effort `high`, one call per group
  with a single `bws({ best, worst })` decision tool in `terminalTools`, pinned with
  `evals/judge-rubric.md` and the shape's `## Value` block, no prompt file of its own (a labeller with
  its own prompt is a second judge, not an anchor). Fallbacks are **off** on this isolation seat
  (ruling 8); a refusal drops the group and is counted in `refusedGroups`. An agent-labelled file
  **never gates promotion** and never trips the kill; the human anchor is deferred, not replaced
  (override 2). Cost model 6: 20 groups ≈ $6.50 (labeller $1.35 + replay $5.15 [$2.57]), estimated.
- **Groups and pairs.** Groups of four are drawn only **within one run and one round**, from both
  loop and bare runs (`frontier.mode` recorded per group), using that run's own renders
  (`ideas/rendered/<id>-r<round>.md`) and criteria (`criteria/r<n>-*.md`); `bwsGroups` throws below
  four (`src/phases/checkpoint.ts:36-38`); a home with fewer than 20 such groups reports "insufficient
  material: run M1 first". A group of four yields exactly **five** implied pairs — best over each
  middle and the worst, each middle over the worst, best-over-worst counted once; the middle-versus-
  middle pair is unlabelled and never judged (round 2, item 13). Twenty groups imply 100 pairs.
- **The replay** calls `judgePair` per implied pair and ordering (`src/ideation/judge.ts:144`) and
  stores `TournamentRecord`-shaped lines in `evals/calibration/<id>.jsonl` with the `(a, b, order)`
  skip-by-key rule on resume — never in any run's `tournament.jsonl`, which is that run's truth
  (ideation record §10). `writeCriteria`/`judgePair` bind to `deps.run.criteriaDir` and `deps.record`
  (`judge.ts:103,126,192`), so the calibration hands them a hand-built `RunPaths`-shaped object
  `{ ...runPaths(home, evalId), criteriaDir: join(reportDir, "criteria"), record: join(reportDir,
  "record.jsonl") }` and a full `JudgeDeps` (`home`, `cfg`, `models`, `apiKeyFor`, `streamFn`, `effort`
  — `judge.ts:66-80`). The swap rule is `collapsePairs` (`src/ideation/bt.ts:244`) over the stored
  lines; order-agreement is the fraction of replayed pairs whose two orderings agree on **value**,
  feasibility order-agreement reported alongside. Judged lines carry the **served** model and
  `fallbackServed` per side (ruling 8; `fallbackUnknown: true` until model-practices Task 1 lands).
- **`evals/calibration.json`** = `{ version: 1, labelSource, computedAt, hash: { judgePrompt,
  kernelPrompt, judgeModel, renderVersion, effort }, groups, impliedPairs, refusedGroups, agreement,
  orderAgreement, calibrated, provisional, byShape: { research, product, creative: { groups, pairs,
  agreement, orderAgreement } }, strata: { none, a, b, both: { pairs, agreement } }, costUsd }`. The
  hash covers the **whole** `prompts/judge.md` **and** `prompts/kernel.md` (the judge's system prompt
  is `[kernel, judgePromptFor(...)]`, `judge.ts:72`), the judge model ref, `RENDER_VERSION`
  (`src/ideation/dossier.ts:17`) and the judge's `effortFor` level (`medium` today) — ideation record
  §11's three components plus the two the code actually sends. Below 20 groups the file is written
  with `provisional: true, calibrated: false`; agreement is over implied pairs where the labeller
  expressed a preference. `calibrated` requires human labels, agreement ≥ 0.70 and order-agreement
  ≥ 0.80 (spec §5.1). Every reader recomputes the hash and treats a mismatch as `status: "stale"`;
  nothing deletes under `evals/`. The strata by `selfPreferenceRisk` (`src/ideation/tournament.ts:54`)
  exclude fallback-served calls.
- **`judgeCalibration: { status: "absent" | "stale" | "provisional" | "agent" | "calibrated" |
  "removed", agreement?, orderAgreement?, labelSource?, hash?, effort? }`** is stamped on every eval
  report, on `evals metrics` and on `evolve list`; nothing is added to per-run `metrics.json`, which is
  a fold over the run's own artifacts. With no `calibration.json` the harness reports `status:
  "absent"`, runs every eval anyway, labels every judge-based verdict `provisional`, and refuses to
  promote on it.
- **The kill (spec §5.4 M0).** Only a **human-labelled** calibration below 0.60 writes
  `evals.judgeGate: "removed"` into `config.json` and commits it (`evals(gate)`); thereafter `evolve
  promote` refuses every judge-based win regardless of numbers and `cfg.autonomous` is forced false
  for ideation runs; an agent-labelled result below 0.60 is reported and trips nothing — §1 forbids
  removing a mechanism on a measurement the design itself calls not the anchor.
- **The consequence, in one sentence: in v1, with no human labeller, `kiln evolve promote` can
  promote only execution-scored (build-class) candidates; ideate-class evals and the generator +
  brain sweep are measurements that inform the supervisor and `effortByRole`, and cannot change the
  playbook until a human labels twenty groups.** The measurement that precedes the first promotable
  verdict is priced in §9.

## 5. Cost-efficiency metrics and cross-run aggregation

- **The cost block is consumed, not folded here** (round 2, item 26; addendum E1). `metrics.json.cost:
  Record<Phase, CostBlock>` with `CostBlock = { usd, tokens, turns, successes, usdPerSuccess,
  tokensPerSuccess, turnsPerSuccess, cacheReadRatio, cacheWrite, reasoningTokens }` and
  `foldCost(events, phase, successes)` are the model-practices plan's Task 5 (`src/core/cost.ts`);
  this plan adds no `efficiency` key and no `tokensByPhase`. Until Task 5 lands, the eval report
  computes the same block evals-side over each eval run's `record.jsonl` with the definitions below
  — works, duplicated, temporary (§16).
- **Denominators, one definition in both plans.** Ideation = **inserted ideas not later rejected**:
  the ids with an `idea.insert` event and no later `idea.reject` event for the same id with reason
  `restatement` or `collided` — keyed by id, because a rejected restatement never receives an
  `idea.insert` line (`src/ideation/archive.ts:122-123,178`) and a count difference double-subtracts
  (controller ruling 8); `lost_cell` is a seeding filter, not a rejection (ideation record §4).
  `frontier.raw` is reported beside it as the quality-bearing secondary and the report adds
  `backfilled` per arm from `frontier.json.ideas[].backfill`; `frontier.shown` is **not** a success
  count — `trimForCheckpoint` clamps it to `[checkpointMin: 5, checkpointMax: 8]` and backfills
  (`src/phases/ideate.ts:361-363`; `frontierSizes` counts `shown.length`, `src/ideation/metrics.ts:97-98`).
  Form = freeze events (formed projects); build = `featuresPassed.executed` (never `humanVerified`);
  reflect = accepted deltas; frame/discover = 1 on `ok`. A zero-success phase reports `null`, never
  `Infinity`, with its dollars beside it. Projections (cost model, estimated): ideation $1.276 per
  raw-front idea at 3 rounds, formation $1.315, build $1.612 per executed feature at ruling 1's table
  ($11.284 / 7), bare $0.101 per uncollided idea.
- **The E1 field mapping.** `model.call.usage: { input, output, cacheRead, cacheWrite }`
  (`src/core/events.ts:57`) plus `costUsd` carry everything E1 needs: `cacheRead ↔
  cache_read_input_tokens`, `cacheWrite ↔ cache_creation_input_tokens`, `input ↔ uncached input
  tokens`, `output ↔ output tokens including thinking where the provider bills it as output`
  (`calculateUsageCost` prices exactly those four buckets, `src/providers/models.ts:102`).
  `cacheReadRatio = cacheRead / (input + cacheRead + cacheWrite)` per phase, `null` on a zero
  denominator; thinking tokens are unsplittable in v1 and `tokensPerSuccess` counts them as output
  until model-practices Task 1's `reasoningTokens` lands. Projected `cacheReadRatio`: ideate 0.387,
  form 0.706, build 0.727, bare 0.320 (cost model, weighting shown there).
- **`cacheHealthy`** — every `model.call` whose paired `turn` has `n > 1` has `cacheRead > 0` (E2) —
  is computed evals-side over each eval run's `record.jsonl`, **only over the phases whose calls are
  sequential by construction** (frame, form, build, reflect), and reports `null` for discover and
  ideate, where `d.limiter.run` at concurrency 4 interleaves `turn` and `model.call` events
  (`src/brain/agent.ts:219,280`; ideation record §3) until `model.call` carries a session id (the
  harness owner's field). Every eval report prints it per run with `unhealthyCallsByRole`.
- **Column order and the decision rule.** A shared `REPORT_COLUMNS` constant fixes every comparison
  table (M1, M2, M3, the effort sweep, `evolve list`): quality first — pair win rate with its
  interval, seed wins, honest exits, `featuresPassed.executed`, collision rate, probe pass rate —
  then cost — `usdPerSuccess`, `costUsd`, `tokensPerSuccess`, `turnsPerSuccess`, `cacheReadRatio`;
  `--json` carries the same object. **Quality is decided by the Wilson gate alone; cost never
  refuses** (controller ruling 4): `promote` prints both `usdPerSuccess` figures and their ratio,
  records `Kiln-Cost-Ratio`, and flags the row when the ratio exceeds `cfg.evals.costRatioCap` (1.5,
  a warning threshold). A candidate never promotes on cost. The sweep's non-inferiority margin (§6)
  is the one named quality risk E7 permits, because it is stated with its admission probabilities.
  Honest-exit accuracy has no ground truth (formation/build record §17) and is reported, not gated.
- **`kiln evals metrics [--since <iso|runId>] [--evals] [--json]`** aggregates over every
  `runs/<id>/metrics.json` with a readable `status.json` through a **fixed allowlist** in
  `src/evals/metrics.ts` (a compile-time test asserts it is a subset of `keyof Metrics`): from
  `IdeationMetrics` — `costUsd`, `costByPhase`, `frontier.raw`, `frontier.shown`, `collisionRate`,
  `noveltyEnforced`, `searchHealth.rate`, `probes.passRate`, `tournament.tieRate.value`,
  `tournament.haloCorrelation`, `stops`, `honestExits`; from `BuildMetrics` — `featuresPassed.executed`,
  `featuresPassed.humanVerified`, `featuresBlocked`, `regressionsCaught`, `auditorDisagreeRate`,
  `wallByPhase`, `stopKind`, `censored`, `budgetOvershootUsd`, `usdCapHits`; from `cost` —
  `cost.<phase>.usdPerSuccess` and `cacheReadRatio`. Numeric keys report `n`, mean, median with nulls
  dropped; counters sum; `crossProvider*` aggregates exclude fallback-served calls (ruling 8). Rows
  are bucketed by `status.shape ?? "unknown"`, all four always printed (spec §14: M1 reports per
  shape). A `runs: { total, done, stopped: Record<StopKind, n>, failed: Record<FailureClass, n>,
  paused, honestExits: Record<kind, n> }` header precedes means computed over `done` runs with a
  second column over all runs, so an honest exit is visible and never silently pulls a mean (§1).
  `schemaVersion` unknown is treated as 1; missing keys are null. `--evals` adds every staged home's
  runs from `evolution/work/` with `evalId`/`arm` columns; eval runs are never symlinked into
  `<home>/runs/` because `build/metrics.ts:151` would `loadConfig` the real home.
- **`pairCensored` is not `censored`.** The eval's per-seed-pair field is `pairCensored: boolean` with
  `pairCensoredBy: StopKind[]`; `BuildMetrics.censored` (deadline only, `src/build/metrics.ts:225`) is
  untouched and keeps its per-run column; the bare word is never printed for both meanings.

## 6. Effort: the table, the sweep grid and `effort.json`

- **Ruling 1's table, verbatim, is the initial `effortByRole`** — brain `high`, builder `high`, form
  (the form brain) `high`, critic `high`, judge `medium`, auditor `medium`, reflector `medium`,
  scout / arbiter / prober `low`; `cfg.effort` stays `medium` as the fallback for unlisted roles;
  every entry clamped by `clampEffort` (`src/providers/models.ts:87`). `generator` is unlisted and
  falls to `medium` — **flagged to the supervisor as a gap in ruling 1's list**. The table starts from
  what the tree does: `judgeBrain` passes `deps.effort` (`src/ideation/judge.ts:78`) and ideation
  record §2 says "medium for both judge orderings; no escalation in v1", which had already superseded
  spec §7's "judge finals at high"; scouts are `low` by literal (`priorart.ts:98,147`,
  `discover.ts:66,106`, `scout.ts:66`); the critic is a literal `"high"` (`critique.ts:118`). The
  field, `effortFor(cfg, role, model)`, and the switch of the **eleven** `effort:` sites (`frame.ts:105`,
  `discover.ts:129`, `ideate.ts:157`, `form.ts:238` → `:227` under Task 10, `judge.ts:78`, `bare.ts:54`,
  `islands.ts:254`, `auditor.ts:237,276`, `builder.ts:222` — which reads `deps.cfg.effort` —
  `reflect.ts:139`) plus the scout default and the critic literal are the model-practices plan's
  Task 1; this plan adds none of them. Only this plan's sweep may change an entry, and it records the
  winner as data.
- **The priced consequence for the formation/build record §12 table, flagged, not overridden.** On the
  cost model's session rows with output scaled x1.5 at `high`: `projectedFormationUsd` $1.146 →
  **$1.315** (4.4 percent under the $1.375 form share, was 20); builder @ 15 turns $0.716 → **$0.847**;
  `builderUsdCap` $1.081 → **$1.256**; `auditorUsdCap` $0.6948 unchanged; `expectedAttemptUsd`
  $1.109 → **$1.240**; `attemptCeiling` $1.776 → **$1.951**; `featureCeiling` $3.327 → **$3.720**;
  **`maxFeatures` 8 → 7** at $25 (8 features need $12.90 > the $11.875 share); one ideate round
  $3.19 → $3.11, three rounds $9.34; frame + discover $0.853; ideate-only run $10.19 / $3.97 at
  3 / 1 rounds; full run $22.95 at 7 features ($24.56 at 8); bare $1.60 — every figure estimated.
  `cfg.build.expectedAttemptUsd` and `builderUsdCap` are config values that record owns; whoever
  updates them makes `derivedCaps(cfg)` produce 7. **This plan's runners assume nothing**: they read
  `derivedCaps(cfg)` and `cfg.build` at run time and print what they find in every projection table,
  so a stale config is visible, not silent. Ruling 1's own cost-if-wrong names the symptom — more
  `usd_cap` stops, visible in the first real run's `usdCapHits`.
- **The sweep grid** (A3, §C; controller ruling 3), one seat at a time, cheapest first, everything
  else at ruling 1's level, each cell at `cfg.evals.sweepPairsPerSeed: 8` (n = 96, half-width ±0.098):

  | seat | vehicle | winner metric | levels | per-level (precedent judge basis) | row total |
  |---|---|---|---|---|---|
  | judge | M0 replay, 20 groups x 5 pairs x 2 orderings | agreement with the labels, then cost | 4 | $3.95 / $5.15 / $6.35 / $8.75 | **$24.20** [$12.10] |
  | generator + brain (joint) | M1 arm A0, 1 round, 12 dev seeds per level, judged at k = 8 against **twelve incumbent loop runs** (the champion at ruling 1's table, 1 round; $47.64) | the non-inferiority rule on the pair win rate, then `cost.ideate.usdPerSuccess` | 4 + the incumbent A/A cell | $46.33 / $50.95 / $55.57 / $64.81 + $50.95 (`medium`-basis rows) + 5 x $2.47 judging | **≈ $328.60** |
  | builder (auditor fixed) | M2 builds-only, 5 formed projects at 7 features | `featuresPassed.executed`, then `cost.build.usdPerSuccess` | 4 | $44.5 / $50.5 / $56.4 / $68.4 | **≈ $220** |
  | auditor (builder at its winner) | same | `featuresPassed.executed` and `auditorDisagreeRate`, then cost | 4 | ≈ | **≈ $209** |
  | critic; scout, prober, arbiter | not swept — critic keeps record §5's `high`, cheap seats ruling 1's `low`; recorded `not_swept` | — | — | — | — |

  Minimal grid (judge + generator/brain + builder) **≈ $574**; full (+ auditor) **≈ $782**; +$57.53
  of ideation and formation (5 x ($10.19 + $1.315)) when M2 has not formed the five projects first —
  the grid orders M2's formation before the builder row. Round 2's $577.67 / $816.69 were on the
  8-feature, `medium`-incumbent basis and are superseded. Wall ≈ 79 h serial, ≈ 20 h at concurrency 4
  (cost model). A 4-level factorial over k seats is 4^k passes and unaffordable at k ≥ 3. Every figure
  is an estimate; the grid prints `derivedCaps(cfg)` and the live projection at run time.
- **The incumbent cell is the one pre-registered A/A** (controller ruling 3): the champion at ruling
  1's table run a second time on the 12 dev seeds at one round and judged against the incumbent
  baseline set at k = 8 — champion versus champion at n = 96. Its 95 percent interval must contain
  0.5, or the judging scheme is biased and no sweep or M3 result is trusted until it is understood.
  The bare arm is M1's B0, not a sweep baseline; the earlier 6-seed 3-round A/A is optional.
- **The non-inferiority rule, in full** (round 2, item 2; E7): (a) sweep cells run at `k = 8`;
  (b) a level is **admissible** only when its 95 percent Wilson lower bound against the incumbent is
  at least `0.5 − cfg.evals.noninferiorityMargin` (default **0.10**, estimated); (c) a level whose
  lower bound **exceeds 0.5** is a quality win and is adopted regardless of cost (E1: quality first);
  (d) among admissible levels with no quality win, the cheapest by `usdPerSuccess` wins; (e) on any
  tie, and whenever no level is admissible, the incumbent stays. **The named E7 risk:** exact
  binomial, one level against the incumbent at n = 96, the rule admits a level five points worse
  19 percent of the time and ten points worse 3 percent of the time (an equal-quality level is
  admitted 54 percent of the time); the margin is the quality the sweep is willing to risk, chosen by
  the supervisor, not hidden inside "overlaps". The round-1 rule ("point estimate not below and
  interval overlaps") would have moved a seat to a five-point-worse `low` 29 percent of the time at
  n = 48.
- **`evals/effort.json`** = `{ version: 1, entries: { "<role>|<modelRef>|<profile>": { winner,
  sweptLevels, metric, quality, usdPerSuccess, n, rounds?, at, evalId } } }`, written only by
  `kiln evals effort <role> --budget $` and committed by it (`evals(effort)`), excluded from the
  manifest, **expired per entry** when the seated model ref differs from the key — a changed ref
  invalidates a measured level the way a changed judge prompt invalidates calibration (spec §5.1).
  Sweep rows are per seating profile (§7); only the default profile is priced and swept now.
- **Consumption.** Every M0, M1 and M3 comparison resolves each seat's effort in the order
  `arm profile → effort.json → cfg.effortByRole → cfg.effort`, records `effort[role] = { level,
  source: "profile" | "swept" | "config" | "fallback" }` per arm in the report, and sets
  `effortSwept: false` when any **scored seat with a grid row** (M0: judge; ideate-class: generator,
  brain, judge; build-class: builder, auditor) has no entry for its current ref and profile; critic
  and the cheap seats are `not_swept` and ignored. An `effortSwept: false` comparison runs, is
  reported, and **cannot promote** (rung 8, §10). `--effort-sweep <role>` on a runner is a one-off
  that reports one row per supported level and never writes `effort.json`. `model.call.effort`
  already records the level used (`events.ts:53`).

## 7. The M1 and M2 runners

- **M1 has four arms on the same 12 held-out seeds** (rulings 10 and 12), run and paired in ruling
  12's order: **A0** the baseline loop at the record's default seating (`claude-opus-4-8` /
  `gpt-5.5` — `gpt-5.4` is today's resolved judge — / `claude-haiku-4-5`) at ruling 1's efforts;
  **B0** `--bare` (`src/ideation/bare.ts`: one generator call plus the loop's evidence path,
  `mode: "bare"`); **A1** Fable-at-low — every `STRONG`-list seat on `anthropic/claude-fable-5-1` at
  effort `low`, isolation and cheap seats as A0; **A2** the frontier seating profile — `STRONG`
  seats on `claude-fable-5-1` at ruling 1's table, `STRONG_OTHER`-class seats on `claude-opus-5` at
  `medium` (the cost model's stated assumption). Three paired tables: A0 vs B0 (spec §5.4's M1),
  A1 vs A0 (ruling 12), A2 vs A0 (ruling 10), each with `usdPerSuccess` beside the quality columns
  and judged by the baseline judge at `k = 4`; A1 and A2 are skippable with `--no-fable-low` /
  `--no-frontier`. Both loop arms stop at the checkpoint boundary with `frontier.json` written and no
  pick (`--through ideate`); the pick is not an M1 observation.
- **Seating profiles.** `cfg.seating: { default, frontier }` carry role refs and, for `frontier`, the
  four re-derived caps the cost model wrote beside it — `builderUsdCap` **$2.512**, `auditorUsdCap`
  **$0.6654**, `expectedAttemptUsd` **$2.069**, **`maxFeatures` 4** — and a full frontier run
  projecting **$26.72, over the $25 target**, which this record flags to the owner as ruling 10's own
  money call (Fable input is twice Opus 4.8's). The runner writes the arm's profile into its staged
  `config.json` and builds one `CliRuntime` per arm (`createCliRuntime(realHome, armCfg, deps)`); the
  frontier arms have no `effort.json` entries for their refs, so their comparisons are `effortSwept:
  false` — correct, and moot, since M1 never promotes. All figures estimated.
- **What each arm reads.** From `metrics.json`: `frontier.raw`, `frontier.shown`, `collisionRate`,
  `noveltyEnforced`, `searchHealth.rate`, `probes.passRate`, `costUsd`, `costByPhase.ideate`,
  `wallByPhase.ideate`, `stops`, `honestExits`, `tournament.tieRate.value` (loop only), and
  `cost.ideate.*`; the ids to judge from `frontier.json.shown` in value-ladder order (arm A — what a
  human would have seen; the trim is part of the mechanism under test) and `frontier.json.ideas`
  (arm B, all ten). `frontier.raw` and `backfilled` are printed beside `shown` (§5).
- **Cross-arm judging.** One criteria text per seed, written by `writeCriteria` from a **neutral**
  brief — the seed text itself, not either arm's `brief.md` — against the eval's own `criteria/`
  (spec §14's judge-gaming row: the judge commits before seeing candidates; arm A's own criteria were
  written from its meta-review). Pairs are **rank-matched**: arm A's `shown` in value-ladder order
  against arm B's ideas in generation order (loop-vs-loop pairs for A1/A2: both have ladders),
  `k = min(cfg.evals.pairsPerSeed, |A|, |B|)`, default 4; both orderings always; ties from swap
  disagreement through `collapsePairs`. Lines are `TournamentRecord`s plus `seedId` in
  `evolution/reports/<evalId>/judged.jsonl`, with `aGenModel` / `bGenModel` / `judgeModel` set to the
  **served** model (`model.call.model` after the provider's overwrite) plus `aFallbackServed` /
  `bFallbackServed` / `judgeFallbackServed`, so `selfPreferenceRisk` strata apply and exclude
  fallback-served calls (ruling 8).
- **The unit and the interval** (override 5). A sample is a collapsed judged pair; win rate =
  (wins + ties/2) / n; 95 percent Wilson via `normalQuantile(0.975)` (`src/ideation/bt.ts:99`);
  `n = seeds x k`, counted from stored lines; the seed-level majority is reported beside it and
  labelled "not evidence" at 12 seeds. Rows the reports print: n = 24 → 17 wins (0.7083), 32 → 22
  (0.6875), 48 → 31 (0.6458), 96 → 58 (0.6042) for the lower bound to clear 0.5; half-widths at
  p = 0.5 ±0.186 / ±0.164 / ±0.136 / ±0.098. Spec §5.4's own prediction — arm A wins ≥ 65 percent —
  sits exactly on the n = 48 bar and fails it at every smaller n.
- **Censoring and honest exits** (supervisor item 6). `pairCensoredBy` = the stop kinds `budget`,
  `deadline`, `transient`, `stalled` of either arm's run (a stall is a loop failure whose cause is
  not the playbook under test — formation/build record §12 treats it as a spent attempt); `rounds` /
  `stagnant` are complete, `blocked` complete-with-blocks; `failed` runs (`verify`, `integrity`,
  `policy`) are excluded and counted in a `failed` column by class; a `paused` run is resumed at
  `wakeAt` within the eval's wall bound and is censored only if still paused when it ends. A seed
  with either arm censored contributes no pairs and appears in the `pairCensored` column. An honest
  exit (`no_idea_clears_bar`; for M2 `cannot_be_satisfied`, `not_formable`) is a legitimate outcome
  (spec §1): at seed level the exiting arm **loses that seed**; at pair level the seed contributes no
  pairs and leaves the Wilson `n`; it is never censored and never forfeits invented pairs; the
  report carries `honestExits` per arm and evaluates the kill line twice — pair level (excluding)
  and seed level (including).
- **The table and the footer.** Rows per seed — `seed | shape | A frontier (raw/shown/backfilled) |
  B ideas | A wins | B wins | ties | collision A/B | probe pass A/B | usdPerSuccess A/B | cost A/B |
  note` (`pairCensored` / honest exit / failed / shape mismatch), in `REPORT_COLUMNS` order; footer —
  pair-level rate with the interval, `n`, the wins required at that `n` and observed, seed-level
  rate, per-shape rates, §5.4's prediction and kill each printed verbatim as `met | not met | not
  evidence`, `judgeCalibration.status`, `effortSwept`, `cacheHealthy` per run, total cost. `--json`
  emits the report object of §9. M1's human re-ranking is deferred (override 12).
- **Fixed run seeds.** Run ids are `<evalId>-<seedId>-<arm>`, so `seedFor(runId, round)`
  (`src/ideation/tournament.ts:137`), `schedulePairs`, `selectEntrants` and island assignment
  reproduce, and `createRun(home, seed, { id })` (`src/core/run.ts:130`) accepts the id; `effort` is
  fixed by the measured level and recorded. Model outputs are **not** reproducible — no
  `temperature`/`top_p` is passed anywhere in `kiln/src` and none is exposed to pass; the record says
  so plainly.
- **Resume, projection, concurrency, pauses.** The report is rewritten after every run and every
  judged pair; a rerun with the same `evalId` resumes unfinished runs, skips finished ones and skips
  judged lines by `(seedId, a, b, order)`; `eval.json` freezes at creation `k`, `level`, `rounds`,
  `minPairs`, `minUncensoredSeeds`, `noninferiorityMargin`, `sweepPairsPerSeed`, the seating profile
  and effort table per arm and `playbookHash`, and a rerun whose live config differs refuses, naming
  the differing keys (round 2, item 18). Every runner prints a per-arm, per-seed projection —
  expectation from `projectedRoundCost` (`src/ideation/budget.ts:38`) and the pair figure, **and** the
  ceiling — and asks once unless `--yes` or `--json`; runs are sequential in v1 (provider usage
  windows are per account and concurrent runs would pause each other); the eval's own judge,
  criteria, labeller and arbiter calls share one eval-level `Limiter(cfg.ideation.concurrency)`. A
  pause sleeps until `wakeAt` within `--wall-seconds`.
- **M2** is in scope as a thin runner, `kiln evals m2 --projects N --budget $`: for each of N dev
  seeds it runs through checkpoint with autonomous pick and through formation once, then
  **`cloneFormedRun(home, fromId, toId)`** copies `runs/<fromId>` including the default real
  `project/`, rewrites **three** fields — `status.id`, `status.projectDir` (`src/phases/form.ts:200`
  → `:189` under Task 10 writes the source's absolute path) and `project.json.runId` — **refuses** a
  source whose `project` entry is a symlink (an external `--out`, formation/build record §2) with
  "clone needs a run-local project", leaves `record.jsonl` byte-identical up to the clone point
  (including `builder.session.builderModelRef`), and the record states that `init.sh` runs **once per
  arm** at build entry because `git.hasTrailer(project.repo, "Kiln-Init", deps.run.id)`
  (`src/build/loop-entry.ts:72`) is keyed by run id. Arm A (`runBuild`) and arm B
  (`runBuildSingleSession`, both exported from `src/phases/build.ts:1`) build the same freeze at equal
  dollar, turn and wall budgets (formation/build record §15) and report `featuresPassed.executed`,
  cost, `censored`, `contextPressureByArm`, `honestExits` and `cost.build.*` per arm. Five projects
  ≈ $170 (5 x ($10.19 + $1.315 + 2 x $11.284)), estimated. The clone is shared infrastructure: the
  build-class `evolve eval` uses it at `cloneAfter` (§9).
- **Costs, estimated** (cost model, precedent judge basis; `[gpt-5.4]` in brackets): per ideate-only
  run at 3 / 1 rounds A0 $10.19 / $3.97, B0 $1.60, A1 $10.00 / $4.09, A2 $13.26 / $5.46; pairings at
  3 rounds A0vB0 $144.34, A1vA0 $245.14, A2vA0 $284.26; **grid total $429.09 at 3 rounds, $189.88 at
  1 round** [$378.06 / $170.05]; wall ≈ 41 h serial, ≈ 10.5 h at concurrency 4 (3 rounds). A Fable
  arm drains the subscription usage windows roughly twice as fast — unmodelled, lengthens wall, not
  dollars.

## 8. The playbook delta model, operator deltas, candidates and prompt variants

- **Grammar.** `## <section>` headings over bullet lines `- <ID> [helpful:<n> harmful:<n>] <lesson,
  one sentence>. Why: <clause>.` (Task 10's `BULLET` regex `^- (\S+) \[helpful:\d+ harmful:\d+\] `,
  `src/build/delta.ts:40-44`, is the line shape); the text after the counters is opaque to the
  parser and the `Why:` clause is part of it. Pre-rubric bullets (the 19 on disk) are
  **grandfathered**: the parser accepts a bullet without `Why:`, and no plan-time migration rewrites
  them (round 2, item 10 — a rewrite of every seat's prompt text without E7's before/after columns).
  Sections are the closed set `lenses | frame | discover | ideate | form | build | retired`; ids are
  `<prefix><n>` with the prefix fixed per section (`L, F, D, M, FM, B`) and `add` assigns `max(n) + 1`
  over every id ever used in that section, including retired ones — never reused. `parsePlaybook` /
  `serializePlaybook` round-trip the bundled file byte-for-byte and build on Task 10's
  `playbookSections` / `playbookBulletIds` (`delta.ts:44-55`) rather than re-parsing; `playbookSection`
  (`src/brain/prompts.ts:26`, six call sites) keeps reading the markdown, which stays the source of
  truth.
- **Operations.** `applyDelta(md, delta)` is this plan's, one function for the candidate and operator
  paths (Task 10 never applies a delta, formation/build record §13). `retire` moves the line to
  `## retired` with counters intact and a ` (retired <iso> by <candidateId | operator>)` suffix;
  `playbookSection` never serves `retired` to a phase; retired bullets do not count toward 120.
  `edit` never changes the count; `add` at 120 active bullets is refused.
- **Counters** change only through `kiln evolve` outcomes: `promote` sets a promoted `add` to
  `helpful:1` and increments an `edit`'s target; `archive` with `lost_dev | lost_heldout` increments
  `helpful` on the champion bullet an `edit`/`retire` targeted (the champion beat the change);
  `harmful` increments when a promoted bullet is later retired by a winning candidate; an operator
  delta **resets** its target's counters to `[helpful:0 harmful:0]` (ruling 7 wins over the
  model-practices plan's "preserved"); counters gate nothing and are what A12's "confirmed
  approaches" count.
- **`playbookHash`** (controller ruling 2) = `hashInput(stripCounters(playbook))` — sha256 of the
  canonical text with `[helpful:n harmful:n]` replaced by `[]` — so counter bumps never stale a
  candidate; `stripCounters` is exported from `src/build/delta.ts` and reused by this plan. Task 10
  as written computes `hashInput(loadPlaybook(home))` (`src/phases/reflect.ts:124`, bytes with
  counters): a **cross-workstream correction**, and the field is named `playbookHash` everywhere in
  this record. A candidate carrying a byte hash is archived `stale_champion` on first sight.
- **`validateDelta`, one validator** (controller ruling 5; A12; A15/§C). This plan extends Task 10's
  `validateDelta(delta, ctx): DeltaValidation` (`delta.ts:120`, synchronous, pure) **additively**,
  never creating a second one. Task 10's rules stand: section exists, `edit`/`retire` need an existing
  id, `add` may not collide, non-empty text, ≥ 1 evidence ref, digest refs resolve to headings, file
  refs are relative, under the run and never under `repo/`, metric refs resolve to keys of
  `metrics.json` (`delta.ts:58-84`). Added, structural and synchronous: **A12's five rules** — one
  lesson per bullet with the `Why:` clause (parsed out of `text` when the optional `why` field is
  absent; an `add`/`edit` with neither is refused `missing_why`); `kind: "correction" | "confirmed"`
  on `add`/`edit`, defaulting to `correction`; duplicate-forces-edit — an `add` above trigram Jaccard
  0.6 against an active bullet in the section is refused `duplicate_bullet` (the reflector must
  `edit`); `retire` requires at least one `metric` evidence ref; the fact-not-lesson proxy refuses a
  bullet whose lesson has Jaccard ≥ 0.5 against any digest heading or `metrics.json` key name or
  contains no verb — and **A15's structural rules** — one sentence of ≤ 240 characters plus the
  clause; names no tool the section's seat lacks (`PHASE_TOOLS[section]` / `BUILDER_TOOL_NAMES`); no
  8-word shingle negating a sentence of `kernel.md` or the section's role prompt. **The recorded
  arbiter `conflict({ conflicts, against, reason })` verdict** — the cheap `arbiter` role on a model
  other than the reflector's, one call per (bullet, section role prompt) and per (bullet, sibling
  active bullet; at most the five nearest by Jaccard), ≈ $0.024 per candidate, `strict`-compatible
  (`additionalProperties: false`, `against: string | null`, ruling 9) — runs only where a command can
  await it: `evolve eval` preflight and `evolve apply`. A reflector candidate is therefore
  structurally validated at write time and semantically at eval. The precedence sentence in
  `kernel.md` ("the pinned contract and the user turn take precedence over playbook guidance; if two
  instructions conflict, name the one you cannot follow") is the model-practices plan's Task 3;
  **this plan adds no prompt text** — `prompts/reflector.md` already carries A12's rubric sentences in
  the working tree. Rejections are recorded on the `delta` event's `reason` and archived.
- **The candidate file** is `evolution/candidates/<runId>.json` (`candidatePath`) with Task 10's
  fields `{ runId, digestHash, playbookHash, reflectorModelRef, delta, createdAt }` (record §13's five
  plus `createdAt`; `delta.ts:29-36`) and this plan's additive `kind: "playbook" | "prompt"`,
  `seed?: { id, split, sha256 }` (copied from `status.seed` so leakcheck need not open the run),
  `author: "reflector" | "operator"`, `prompt?: { name, text }`. `validateCandidate` tolerates the
  absence of every field Task 10 does not write and defaults it; record §13's five are required when
  `author === "reflector"`. A candidate whose `playbookHash` differs from the current champion's is
  refused `stale_champion` and archived — no rebase in v1; the run directory still exists for
  re-reflecting (one reflect call, $0.153).
- **Operator deltas are a category** (ruling 7; override 4). `kiln evolve apply --op edit|retire
  --id <id> [--text <lesson>] --why <clause> --reason <text> [--yes]` applies one delta **directly**
  to `playbook/playbook.md` through `applyDelta`, validated by the extended `validateDelta` and the
  arbiter verdict exactly as a candidate is (ruling 7 lifts the *eval*, not the *validity* gate;
  A15/§C is the reason the correction exists), **not evaluated**, counters reset; `add` is not an
  operator op in v1 (a new lesson is a candidate, gated). It is committed as `evolve(operator): <op>
  <id> — <first 60 chars>` with trailers `Kiln-Operator-Delta: <id>`, `Kiln-Champion-Before`,
  `Kiln-Champion-After`, and journalled in the home-level append-only **`evolution/deltas.jsonl`**
  (`appendLine`, `src/core/paths.ts`): `{ seq, ts, source: "operator" | "reflector", op, section,
  id, text?, why?, kind?, author, commit, evidence?, runId?, candidateId?, evalId? }` — reflector
  deltas that become promotions are mirrored into it at promote time, so `evolve list` has one
  history; rejected candidates are not journalled here (their archive is their record). The
  run-record `delta` variant (`src/core/events.ts:196`) gains an additive `source?: "reflector"` and is
  otherwise untouched. An operator delta moves the champion hash, so pending candidates are archived
  `stale_champion` and an `incomplete` eval refuses at its next invocation; `apply` holds
  `evolve.lock`. The model-practices plan's Task 3 applies its B1–B3 / FM1–FM2 rewording through this
  path (ruling 6); if it runs first anyway, the fallback is a hand edit plus hand-written
  `deltas.jsonl` lines in the shape above.
- **Prompt variants** (supervisor item 5; override 4). In v1, `kind: "prompt"` candidates are
  operator-authored only: `kiln evolve propose --prompt <name> --file <path>` validates, hashes the
  champion and writes `evolution/candidates/prompt-<name>-<sha8>.json` with `{ kind: "prompt",
  prompt: PromptName, text, author: "operator" }`; `judge` and `kernel` are refused (they are the
  evaluator's prefix and hashed into calibration) and `reflector` is refused (reflect never runs on
  an eval run, so nothing could measure it); the reflector never proposes one (formation/build record
  §13). A prompt candidate is applied by whole-file replacement in the candidate's staged home and
  evaluated through the role's phases. A15's de-prescription of the eleven prompts is the
  model-practices plan's work; this pipeline is where its result gets measured.
- **Which phases an eval runs per candidate** — `cfg.evals.sectionPhases` = `{ lenses: ideate,
  frame: ideate, discover: ideate, ideate: ideate, form: build, build: build }` with `cloneAfter`
  per section (`form → checkpoint`, `build → freeze`, ideate-class `none`), and `cfg.evals.rolePhases`
  for prompt candidates (`brain, scout, generator, prober, arbiter → ideate`; `critic → build`, clone
  at checkpoint; `builder, auditor → build`, clone at freeze; `reflector` refused). A `## frame`
  delta whose effect appears only in build is scored on ideation — named in §14.
- **`evolve list`'s status is derived, never stored** (spec §10): `pending` (file in `candidates/`,
  no report), `evaluated: win | lose | not_evidence | censored | incomplete` (a report exists),
  `promoted` (a `Kiln-Candidate` trailer in `git log`), `archived: <reason>` (a directory under
  `archive/`), `stale` (hash differs from the working tree).

## 9. `kiln evolve eval <candidate>`

- **Staged homes** (supervisor item 4). A candidate is applied only inside a staged home per arm at
  `evolution/work/<evalId>/<arm>/`, holding a copied `config.json` (with the arm's seating profile
  written in), the arm's `playbook/` and `prompts/`, and its own `runs/`; no `auth.json` (`apiKeyFor`,
  `models`, `modelsOn`, `fetchUsage` come from `createCliRuntime(realHome, armCfg, deps)`), no
  `evals/` (the seed text is the run's seed), no `evolution/`; `PhaseDeps.home` is the staged home and
  the runner never calls `initHome` on it. This works with zero edits to phase code because every
  `PhaseDeps.home` use is a prompt or playbook read (seventeen sites) and `build/metrics.ts:151`
  derives the home from the run path. The real home is byte-identical after an eval.
- **The arms.** Champion = the real home's **committed** `playbook/` and `prompts/` (a dirty tree
  refuses), copied verbatim; candidate = champion plus `applyDelta`, or the replaced prompt file;
  everything else identical. Reflect **never** runs on an eval run — a candidate must not breed
  candidates, and held-out runs must never reach the reflector. Phases per class are §8's
  `sectionPhases`/`rolePhases`: `--through ideate` for ideate-class (the frontier is the observation;
  no pick), `--through build --autonomous` for build-class (assumed Task 11 interface; the fallback
  drives the phase functions directly). At the class's `cloneAfter` point the runner runs the champion
  arm to the clone point, clones it with `cloneFormedRun` for the candidate arm (§7's rules), and both
  arms continue; the source run's `record.jsonl` is shared up to the clone point and the report says
  so.
- **Passes and pairing.** Dev pass on all 12 dev seeds; if the dev-pass Wilson **upper** bound is
  below 0.5 the candidate is archived `lost_dev` and held-out is skipped (the only early stop that
  cannot bias the held-out verdict); otherwise held-out runs on all 12 and alone decides; the
  dev/held-out gap is reported (spec §5.4 M3: "the gap is the number to watch"). Seeds are run in
  `split.json` order, champion then candidate per seed, run ids `<evalId>-<seedId>-champion|candidate`,
  so an outage censors both arms of one seed rather than the tail of one arm. Judging is §7's
  cross-arm scheme at `k = 4`.
- **The gate, as a rule** (supervisor item 3; override 5; controller ruling 1): a candidate promotes
  on held-out when the 95 percent Wilson lower bound over the collapsed pairs actually judged exceeds
  0.5, with `cfg.evals.minPairs: 32` (the seed floor's own value at `k = 4`, so honest exits
  stacking on censoring yield `not_evidence` rather than an un-pre-registered 71 percent bar) and
  `cfg.evals.minUncensoredSeeds: 8`; below `minPairs` the verdict is `not_evidence`. Every report
  prints `n`, the wins required at that `n`, and the wins observed — 31 of 48 when all 12 seeds count,
  22 of 32 at the floor. **For build-class candidates the unit is the paired feature outcome:** on a
  freeze cloned at `freeze` the feature ids are identical across arms; per feature id the candidate
  wins when its feature reaches `passes: true` from execution (`featuresPassed.executed`'s source)
  and the champion's does not, loses in the reverse case, ties otherwise (half a win); `n` = paired
  features over uncensored seed pairs (≤ 7 x 12 = 84 at the repriced cap, ≥ 4 x 8 = 32 at the floor);
  honest exits and blocks leave a feature unpassed on their side; the same gate. **`## form` and
  `critic` candidates** (clone at checkpoint, unpaired features) are seed-level, `not_evidence` at 12
  seeds in v1, reported and never promoted. Spec §1's "twenty samples" is a floor the seed floor makes
  non-binding.
- **Money** (supervisor item 3). `--budget <usd>` is mandatory and must be at or above one seed
  pair's **ceiling** — `2 x (sum of budgets.share through the class's last phase) x budgets.usd +
  judging` = **$23.24** ideate-class, **$49.50** build-class (the run's own enforced allocation
  through `phaseAvailableUsd`, ideation record §3's floor shape) — and the runner refuses to start a
  seed pair when the remaining budget is below it; a run in flight is never cut by the eval (it has
  its own `budgets.usd`); the eval stops `verdict: "incomplete", stoppedReason: "budget"` with every
  completed pair intact. `--rounds N` exists for the supervisor and is recorded; a one-round eval is
  labelled as such in every table (a candidate is meant to change the loop users run, spec §1). The
  projection table prints expectation **and** ceiling per pair and for the whole eval. One
  `kiln evolve eval`, estimated on the precedent judge basis: ideate-class both passes **$494.78
  expected / $557.66 at the ceilings** at 3 rounds ($196.22 / $557.66 at 1 round; dev-only about
  half); build-class **$817.56** with the clone at freeze (`## form` at checkpoint $849.12;
  independent arms $1,093.68), ceiling $1,188.00 — **never inside a run's $25 / 4 h, never charged to
  any run's `budgets.usd`**; a separately budgeted, supervisor-gated operation. Wall: 24–48 h serial
  per eval, resumable.
- **The eval directory.** `evolution/reports/<evalId>/` (`evalId` = the candidate id, so there is one
  eval per candidate and the archive stays terminal) holds `eval.json` (rewritten after every run and
  every judged pair), `judged.jsonl`, `record.jsonl` (an eval-level `RunRecord` for judge, criteria,
  labeller and arbiter calls, summed the house way) and `criteria/`; runs live only under
  `evolution/work/`. `eval.json` = `{ version: 1, evalId, candidateId, candidate, playbookHash,
  frozen: { k, sweepPairsPerSeed, level, rounds, minPairs, minUncensoredSeeds, noninferiorityMargin,
  seating: Record<arm, profile>, effort: Record<arm, Record<Role, { level, source }>>, roles, budgets },
  effortSwept, judgeCalibration, startedAt, updatedAt, budgetUsd, costUsd, runs: [{ runId, seedId,
  split, shape, arm, state, outcome, stopKind?, pairCensored, pairCensoredBy, honestExit?, failedClass?,
  shapeMismatch, cacheHealthy, metrics: {...}, cost: {...} }], passes: { dev, heldout: { seeds,
  uncensoredSeeds, pairs, wins, ties, rate, wilson: { lower, upper }, requiredWins, evidence, seedWins } },
  verdict: "win" | "lose" | "not_evidence" | "censored" | "incomplete", stoppedEarly?: "lost_dev",
  stoppedReason?, costFlag?, gap? }`.
- **Resume, staleness, the lock.** A rerun with the same `evalId` finds the directory, resumes
  unfinished runs (`running | paused`) through the same resume semantics `kiln run resume` uses,
  skips `done`/`stopped` ones and judged lines by key, and **refuses with `stale_champion` before
  running another seed** when the frozen `playbookHash` differs from the working tree; a rerun whose
  live config differs from the frozen block refuses, naming the keys. `evolve eval` holds
  `evolve.lock` for its whole invocation. `promote` refuses while any report is `incomplete` unless
  `--abandon <evalId>` archives that candidate as `superseded`.
- **Preflight refusals** before any executor call: manifest mismatch (`integrity`); dirty
  `playbook/`/`prompts/`/`evals/` or a changed `evals.judgeGate`; candidate invalid, stale, archived
  ("archive is terminal in v1; reflect again from run <id>") or from a held-out run; the leak check;
  more than 120 active bullets after the delta (`playbook_overflow` — refuse before spending); the
  arbiter conflict verdict; no `--budget`.
- **The sequence before the first promotable verdict**, estimated from the repriced rows: M1's
  baseline pairing $144.34 (material for M0), the judge sweep $24.20, the generator + brain sweep with
  its incumbent baseline ≈ $328.60, five formed projects $57.53, the builder sweep ≈ $220, one
  build-class eval $817.56 — **about $1,597** — and none of it lifts rung 9 (§4's sentence).

## 10. `kiln evolve promote | rollback | archive | list | propose | apply`

- **The ladder** (override 6): ten refusal rungs and one flag, top to bottom, each a typed refusal
  with a reason string — (1) `evals/` manifest mismatch, `integrity`; (2) dirty `playbook/`,
  `prompts/` or `evals/`, or `evals.judgeGate` differing from HEAD; (3) `evolve.lock` held, or any
  report under `evolution/reports/` `incomplete` (unless `--abandon <evalId>`); (4) candidate invalid
  or `stale_champion`; (5) no finished report (`verdict` absent); (6) the leak check; (7) more than 120
  active bullets; (8) `effortSwept: false` over the seats with a grid row — not overridable; (9)
  judge-based class and `judgeCalibration.status !== "calibrated"` — **not overridable**; (10)
  `verdict !== "win"` — `--confirm` only when the verdict is `not_evidence` with a held-out point
  estimate above 0.5, never `lose` or `censored`; **(11) the cost flag** — `usdPerSuccess` more than
  `cfg.evals.costRatioCap` (1.5) x the champion's is printed, recorded as `Kiln-Cost-Ratio`, marked
  in `evolve list`, and **refuses nothing** (controller ruling 4). `--confirm` is the supervisor at
  the CLI standing in for spec §6's human; the promote commit records `Kiln-Confirmed: true`. Every
  refusal that names a candidate archives it with its rung's reason.
- **The promote commit** stages exactly `playbook/playbook.md` (or the replaced prompt file),
  `evolution/promoted/<candidateId>.json` (a copy of the candidate), `evolution/reports/<evalId>/eval.json`,
  the `deltas.jsonl` mirror line and the counter changes; message `evolve(<section>): <op> <id> — <first
  60 chars>` (prompt: `evolve(prompt): replace <name>`); trailers `Kiln-Candidate`, `Kiln-Eval` (sha256
  of `eval.json` bytes), `Kiln-Champion-Before`, `Kiln-Champion-After`, `Kiln-Confirmed`,
  `Kiln-Cost-Ratio`; through `GitRunner.commit` with the kiln identity — "with the eval attached"
  (spec §6) is the report in the commit and its hash in a trailer. In the same commit every other
  pending candidate is archived `stale_champion` (the run directory still exists for re-reflecting).
- **The archive** (supervisor item 7; spec §6 "losers stay in `evolution/archive/`").
  `evolution/archive/<candidateId>/{candidate.json, eval.json?, reason.json}` with `reason` in the
  closed set `lost_dev | lost_heldout | not_evidence | censored | stale_champion | invalid |
  playbook_overflow | heldout_seed | leak | conflicting_bullet | conflicting_prompt | duplicate_bullet
  | unswept_effort | rolled_back | operator | superseded` — sixteen values (round 2's seventeen less
  `cost_floor`, which ruling 4 removed) — and `detail` carrying the rule or rung. Every candidate
  leaves `candidates/` in exactly one of two directions, and `archive` commits (`evolve(archive): <id>
  <reason>`) so DGM's "recover from dips" history is in the repo. `kiln evolve eval` refuses an
  archived candidate; `kiln evolve archive <id> --reason operator --detail <text>` retires a pending
  one without an eval (§1's "not evidence" rule closes the multiple-comparisons hole re-evaluating a
  loser until it wins would open). Counters are applied by `promote` and `archive` inside their own
  commits (§8).
- **`kiln evolve list [--json]`** — one row per candidate across `candidates/`, `archive/` and the
  promote history: `id | run | seed(split) | kind | section/op/id | status | verdict | held-out rate
  [LB, UB] n/required | usdPerSuccess cand/champ | costFlag | cost | effortSwept | at`, with
  `judgeCalibration.status` in the footer.
- **`propose`** (§8, prompt variants and operator-authored playbook deltas that must be evaluated),
  **`apply`** (§8, operator deltas, ungated), **`rollback`** (§2). All hold `evolve.lock`.

## 11. Budgets, failure classes, stops and honest exits for eval runs

- Each eval run is an ordinary run under its staged home and inherits `budgets.usd: 25`,
  `wallSeconds: 14400` and the share table from the copied `config.json` — an eval measures the loop
  users run at the budget users run it at; `evals.runBudgetUsd` / `evals.runWallSeconds`, when set,
  are written into the staged config and recorded on every report row.
- **The eval-level floor** is one seed pair's ceiling (§9), checked before each seed; whole pairs are
  skipped, never truncated; `--wall-seconds` (default 172,800) bounds one invocation, a usage-window
  pause sleeps within it, and reaching it stops the eval `incomplete` with `stoppedReason: "deadline"`
  after the in-flight run finishes or pauses — a later invocation resumes. The eval is a directory
  and resumable, so a bound is a checkpoint, not a loss.
- **Failure classes at the eval level** use the closed `FailureClass` (`src/core/failure.ts:3`): a
  manifest mismatch is `integrity`, refused before any call; `stale_champion` is `integrity` with a
  **per-candidate** consequence — archive plus exit code 1 — not a run that `kiln run resume`
  refuses; an arm run that ends `failed` keeps its own class on the seed row and the eval continues;
  eval budget or wall exhaustion is `incomplete` with a reason, not a failure class; a judge with no
  verdict after one retry is a tie line, never a failure (`judgePair`'s existing behaviour). Retry
  policy stays a function of class only.
- Runs are sequential in v1; the eval's own model calls share one eval-level
  `Limiter(cfg.ideation.concurrency)` so cross-arm judging of a seed is parallel inside the seed.
- Honest exits, censoring and the per-arm columns are §7's; nothing at the eval level converts a stop
  kind into a failure.

## 12. Schema, record events, config and CLI

**One schema task first**, sequenced as §1 says. It adds:

- `KilnConfig.evals` with defaults: `wallSeconds: 172800`, `pairsPerSeed: 4`, `sweepPairsPerSeed: 8`,
  `minPairs: 32`, `level: 0.95`, `minUncensoredSeeds: 8`, `noninferiorityMargin: 0.10`,
  `costRatioCap: 1.5`, `sectionPhases` (with `cloneAfter`), `rolePhases`, `judgeGate: "calibrated" |
  "removed"`, `labeller?: string[]`, `runBudgetUsd?`, `runWallSeconds?`, `rounds?`; **no `budgetUsd`
  default** — every multi-run runner refuses without `--budget`. Every number is estimated and
  printed at run time.
- `KilnConfig.seating: { default, frontier }` — role refs per profile and, for `frontier`, the four
  re-derived caps (§7). The default profile is what `src/core/config.ts:130-141` resolves today.
- `RunStatus.seed?: { id, split, sha256 }` (optional; ideation and formation tests unchanged).
- The `delta` record variant gains `source?: "reflector"` (`src/core/events.ts:196`); **no new
  run-record variants** — an eval keeps its own `RunRecord` under `evolution/reports/<evalId>/`;
  no new `PromptName` — the labeller pins `judge.md`'s value block plus `evals/judge-rubric.md`.
- `PlaybookDelta` gains optional `why` and `kind` (a cross-workstream correction to Task 10's
  `src/build/delta.ts:10-16` and `playbookDeltaTool`'s schema in `src/phases/reflect.ts:45-59`);
  `validateDelta` is extended in place (§8); `stripCounters` and `playbookHash` exported from
  `src/build/delta.ts`.
- The two new decision tools — the labeller's `bws({ best, worst })` and the arbiter's
  `conflict({ conflicts, against, reason })` — declare `additionalProperties: false` and list every
  property in `required` (`against: string | null`), with execute-side validation in the `verdict`
  idiom (`src/ideation/judge.ts:155`: no enum, the tool validates), so ruling 9's `strict: true`
  rewrite cannot 400 them.
- `GitRunner.revert(dir, sha, { noCommit })`; `ensureIgnored(home, lines)`; `homeProtectedDirs(home)`;
  the `--out`-inside-home refusal in `materializeProjectPath`.
- **CLI.** `kiln evals calibrate [--labels human|agent] [--groups N]`, `kiln evals metrics [--since]
  [--evals]`, `kiln evals m1 [--rounds N] [--no-fable-low] [--no-frontier] --budget $ [--yes]`,
  `kiln evals m2 [--projects N] --budget $`, `kiln evals effort <role> --budget $`, `kiln evals
  leakcheck`, `kiln evals verify`; `kiln evolve list`, `kiln evolve propose (--prompt <name> --file
  <path> | --op … )`, `kiln evolve eval <id> --budget $ [--rounds N] [--yes]`, `kiln evolve promote
  <id> [--confirm] [--abandon <evalId>]`, `kiln evolve rollback --confirm`, `kiln evolve archive <id>
  --reason operator --detail <text>`, `kiln evolve apply --op edit|retire --id <id> …`; every one
  with `--json` and `--home`; `main.ts` dispatches `evals` and `evolve` — `evals` measures, `evolve`
  changes the tree. `kiln run new` gains `--seed-id <id>`, `--seed-file <path>` and `--eval <evalId>`
  and computes `seedIdentity` before `createRun` (`src/core/run.ts:130` accepts `{ id }`).
- **Files this plan edits in other streams' territory, all additive and each named in the plan:**
  `core/config.ts` (`evals`, `seating`), `core/run.ts` (`seed?`), `core/events.ts` (`delta.source?`),
  `core/home.ts` (identity, initial commit, `ensureIgnored`, the bundled `evals/` files),
  `cli/main.ts`, `cli/commands/run.ts` (the three flags), `brain/tools/index.ts` (`homeProtectedDirs`
  supplied by every phase), `formation/paths.ts` (the `--out` guard), `build/git.ts` (`revert`),
  `build/delta.ts` (`validateDelta` rules, `stripCounters`, `playbookHash`, `why`/`kind`),
  `phases/reflect.ts` (the tool schema's two optional fields, `source: "reflector"`). It edits
  **none** of the eleven `effort:` sites, no prompt file, and neither metrics fold.
- **Module split**, each under 400 lines with a test file: `src/evals/{seeds,manifest,calibrate,
  labeller,metrics,wilson,judging,report,m1,m2,effort,leakcheck,stage}.ts`,
  `src/evolution/{playbook,candidate,operator,evolve,promote,archive,list}.ts`,
  `src/cli/commands/{evals,evolve}.ts`. `src/` is 12,798 lines at `10af486` before this plan plus an
  estimated 2,500 (override 10).

## 13. Testing

- Tests never call a real provider: `createMockModel` + `streamMock` as `streamFn` (the mock records
  `calls: { context, options }`), `mkdtempSync` temp homes, an injected `fetchImpl`, an explicit
  `Limiter`. The **fixture judge** is a `createMockModel` handler returning a `verdict` tool call
  keyed on the render hashes, order-aware so the swap rule is exercised (spec §12: "the eval harness
  itself is tested with a fixture judge"); the fixture labeller and fixture arbiter are the same idiom.
- An injected `RunExecutor = (spec: { home, seed, arm, through, rounds, runId, profile }) =>
  Promise<RunSummary>` so no eval test constructs a phase; `FakeGitRunner` (`test/build/fake-git.ts`)
  gains `revert` and serves the home repo; **one** real-git integration test on a temp home with
  `HOME` pointed at an empty directory asserts identity, the initial commit, the promote trailers
  recovered through `hasTrailer`, and a rollback.
- Wilson against known values (31/48 → LB 0.5044; 22/32 → 0.5143); the **exact-binomial sweep-rule
  test** reproducing the admission probabilities of §6 (19 / 3 percent at n = 96; 29 percent under
  the round-1 rule at n = 48); a group of four yields exactly five implied pairs.
- Seeds: rubric per rule with a `[.!?]` sentence split, 4/4/4 per split, ids, `split.json` agreeing
  byte-for-byte with both directories, the pairwise Jaccard assertions printing the observed maximum;
  `initHome` copies 29 files byte-identical; the manifest ignores exactly `manifest.json`,
  `calibration.json`, `calibration/`, `effort.json`; one edited byte of a held-out seed makes
  `evolve eval` refuse with `integrity` naming the file while `run new` proceeds with a `note`.
- Leakcheck with planted texts: a bullet quoting a held-out seed, an 8-word shingle, a candidate whose
  run is held-out — each refusing promote; `--seed-file evals/seeds/heldout/…` and pasted held-out
  argv text both refuse without `--eval`; a run started with held-out text and no `--seed-id` reports
  `heldout` through `seedIdentity`.
- Calibration: an agent-labelled file leaves `promote` refusing a judge-based win; 12 groups →
  `provisional: true, calibrated: false`; a one-byte edit to `judge.md` or `kernel.md` → `stale`;
  groups never cross a run/round boundary; no implied pair judged twice on resume; a labeller refusal
  drops the group and increments `refusedGroups`; `judgeGate: "removed"` refuses every judge-based
  win; a hand edit to `calibration.json` after `calibrate` wrote it makes `promote` refuse naming the
  path; a hand edit to `budgets.usd` does **not** block (ruling 7).
- Metrics: the allowlist is a subset of `keyof Metrics` at compile time; a zero-frontier run folds to
  `null` with non-zero dollars; a `frontier.json` with `rawFront` of 1 and `shown` of 5 (4 backfill)
  asserts the headline denominator is neither; a scripted record with two interleaved scouts gives
  `cacheHealthy: null` for ideate and an exact value for build; a snapshot of `evals metrics --evals`
  over a fixture with one budget-stopped eval run prints `pairCensored`, never the bare word twice.
- Delta model: byte-exact round trip on the bundled playbook (pre-rubric bullets accepted); a fuzz over
  add/edit/retire sequences; `playbookSection(md, "ideate")` excludes a retired `M`-bullet and the
  count excludes it; 119/120/121 for each op at both checkpoints; a counter bump leaves `playbookHash`
  unchanged and an `edit` changes it; `validateDelta` table — a bullet naming `bash` under `## ideate`,
  one negating a kernel sentence, a near-duplicate of `M1`, an `add` without `Why:`, a `retire` without
  a `metric` ref, a fact-not-lesson — and a fixture-arbiter conflict asserting the `delta` reason and
  the call count; apply-then-rollback asserting the journal line, the trailer, the counter reset, the
  single commit and the archived pending candidate; `validateCandidate` per field, a Task 10-shaped
  fixture, and a byte-hash candidate archived `stale_champion`.
- Runners: the executor's recorded flags per candidate class and the call sequence around
  `cloneAfter`; the clone fixture asserting `status.projectDir`, the symlink refusal and an `init.sh`
  call count of two; the four-arm M1 fixture asserting per-arm `config.json`, per-arm `models` and the
  three paired tables in `REPORT_COLUMNS` order with §5.4's lines printed; one honest-exit seed →
  `n = 44` at pair level and 12 at seed level; one run per stop kind asserting the `pairCensoredBy`
  columns; a fixture at 8 uncensored seeds with 2 honest exits asserting `n = 24`, `not_evidence` and
  the printed bar; a build-class fixture asserting paired feature outcomes and `n`; a clear-loss dev
  pass executing no held-out run and a marginal one executing all; report fixtures at 30/48 (refused)
  and 31/48 (promotable); `--budget` = 5.5 expected pairs with runs spending their allocation
  asserting the sixth pair does not start; `evolve eval` without `--budget` refusing before any
  executor call; the eval lock/race fixture — start an eval, promote another candidate, rerun —
  asserting the refusal before any executor call; a rerun with `pairsPerSeed` changed from 4 to 8
  refusing with the key named and an unchanged `n`; a runner fixture where one grid-row seat lacks an
  `effort.json` entry asserting `effortSwept: false` and a promote refusal, and with entries that
  `model.call.effort` equals the recorded winner; `--effort-sweep judge` producing four rows and
  writing nothing.
- Promote: one fixture per rung asserting the reason string; `--confirm` flips exactly rung 10 in the
  `not_evidence` case; rung 11 flags and never refuses; a promote with two pending candidates archives
  both `stale_champion`; `--abandon` archives `superseded`; `git status --porcelain` is empty after a
  fixture eval in a temp home.
- The strict-compatibility assertion over every tool schema under `src/evals/**` and
  `src/evolution/**`; a test per seat pinning its exact tool names; `main.test.ts` dispatch tests;
  one e2e `evolve eval` on a two-seed fixture through `bin/kiln.ts`.

## 14. What this design makes impossible to observe

Named before any measurement is trusted, as §1 requires.

1. Whether the judge is right about pairs the agent labeller also misjudges — an agent label is a
   machine comparison, not the human anchor; the human-labelled M0 is deferred.
2. Whether a held-out seed was read through a seat's `bash` or unrooted `read` and paraphrased below
   the leak thresholds (Jaccard 0.35, an 8-word shingle); v1 detects quoted text, not paraphrase.
3. Whether a one-round eval or sweep row predicts three-round behaviour.
4. Whether `k = 4` pairs from one seed under- or over-weight that seed — pairs within a seed are
   correlated and the interval is optimistic.
5. Whether paired feature outcomes within one project are correlated (controller ruling 1) — the
   build-class interval carries the same optimism.
6. Whether model-sampling variance exceeds the playbook's effect — no seed is run twice per arm
   except the incumbent A/A cell, and no `temperature` can be fixed.
7. Whether the arbiter's conflict verdict is right; the structural floor catches only literal
   negation.
8. Thinking tokens inside `output` until `reasoningTokens` lands; `tokensPerSuccess` counts them.
9. A `## frame` delta whose effect appears only in build — it is scored on ideation.
10. A real five-point quality loss at n = 96 — the sweep admits it 19 percent of the time; the margin
    is the named E7 risk.
11. A `## form` or `critic` candidate's effect on promotion — `not_evidence` at 12 seeds, never
    promotable in v1.
12. `cacheHealthy` in discover and ideate, where the shared `Limiter` interleaves four seats' events
    until `model.call` carries a session id.
13. Whether a non-idempotent `init.sh` diverged the two arms of a cloned freeze — it runs once per arm.
14. Whether an expensive quality win should have been refused — rung 11 flags; the supervisor decides.
15. Whether the judge's effort winner on the M0 replay transfers to cross-arm judging on different
    material.

**The cheap instruments that recover part of this:** the incumbent A/A cell (judging bias), the
`backfilled` and `frontier.raw` columns beside `shown`, `honestExits` per arm, the archived losers'
`eval.json` under `evolution/archive/`, and the frozen block in every report.

## 15. Overrides of the design spec

The design spec is not edited. Each item names the spec's wording, the binding wording, why, and what
it forecloses. The formation/build record's money table (§12 there) is **flagged, not overridden**
(§6 here).

1. **§5.2, who adds seeds.** *Spec:* "Seeds are added by humans, never by the harness." *Now binding:*
   seeds are authored by a seed-author seat and vetted by an independent seed-auditor seat under the
   rubric in `evals/README.md`, both outside the harness, in this plan's Task 1; no run ever writes a
   seed. *Why:* there is no human; the author/auditor pair is the critic precedent. *Forecloses:* a
   human-curated set until one exists.
2. **§5.1, who labels calibration.** *Spec:* "shows the human at least twenty groups of four".
   *Now binding:* the labeller is a human at a terminal or the agent labeller; `labelSource` is
   recorded; only human labels make `calibrated: true` or trip M0's kill; agent labels are reported and
   never gate; labeller refusals are counted in `refusedGroups` and excluded. *Why:* §5's trust
   ordering — a machine label is not the anchor. *Forecloses:* judge-based promotion until a human
   labels twenty groups — stated in one sentence in §4.
3. **§5.2, held-out secrecy.** *Spec:* "The reflector and the brain never see the held-out seeds."
   *Now binding:* the mutable tree is never trained on held-out text — reflect never writes a
   candidate from a held-out run; held-out seeds are run only inside M1 and `evolve eval`; `kiln run
   new` resolves every seed source by hash before `createRun` and refuses a held-out seed without
   `--eval`; `evolve eval` refuses candidates from held-out runs; leaks are detected after the fact;
   seats with `bash` or unrooted `read` can reach the bundled files. *Why:* the literal sentence is
   unsatisfiable for the arm that runs a held-out seed, and v1 has no sandbox. *Forecloses:*
   prevention; v1 detects.
4. **§6, who writes a candidate, and the operator-delta category (ruling 7).** *Spec:* "candidate
   (from reflect, or written by the human)". *Now binding:* a candidate comes from reflect (playbook
   deltas only) or from the operator through `kiln evolve propose` (a playbook delta, or a whole-file
   replacement of one prompt other than `judge`, `kernel` or `reflector`) and is gated; an **operator
   delta** — `kiln evolve apply --op edit|retire --id …` — is applied directly, validated (structural
   rules and the arbiter verdict) but not evaluated, counters reset, committed with
   `Kiln-Operator-Delta`, journalled in `evolution/deltas.jsonl`. *Why:* ruling 7; A15's
   de-prescription needs E7's columns and the gate is where they exist. *Forecloses:*
   reflector-proposed prompt changes; an ungated `add`.
5. **§1 and §6, the unit of "twenty samples".** *Spec:* "below twenty samples per arm" / "labels n<20
   not evidence". *Now binding:* a sample is a collapsed judged pair, at most `k = 4` per seed
   (`sweepPairsPerSeed: 8` in sweep cells), or, for a build-class candidate on a freeze cloned at
   `freeze`, a **paired feature outcome** (controller ruling 1); the gate is the 95 percent Wilson
   lower bound over the pairs actually judged exceeding 0.5; `minPairs: 32` and `minUncensoredSeeds:
   8` are the floors and the spec's twenty is non-binding beneath them; `n`, the wins required and the
   wins observed are printed; `## form` and `critic` candidates are seed-level and `not_evidence` at
   12 seeds. *Why:* seeds are what the money buys, pairs are what the interval counts, and the floors
   decide `n`. *Forecloses:* a seed-level interval; a bar quoted as one number; a `## form`
   promotion in v1.
6. **§6, promotion.** *Spec:* "refused unless held-out lower bound > 0.5, or the human confirms a
   provisional win". *Now binding:* the ladder of §10 — ten refusal rungs (manifest; dirty tree or a
   changed `evals.judgeGate`; lock or an `incomplete` eval; invalid or stale candidate; no report;
   leak; over 120 active bullets; unswept grid-row effort; uncalibrated judge for a judge-based class
   — not overridable; `verdict !== "win"` — `--confirm` only for `not_evidence` pointing above 0.5)
   and **one flag** (the cost ratio — controller ruling 4, never a refusal); every refusal that names
   a candidate archives it with its rung's reason; "the human" is the supervisor at the CLI. *Why:*
   §5.1, A3, E1, rulings 1 and 8. *Forecloses:* promoting on cost, on an unswept effort, on an
   uncalibrated judge, or during another candidate's eval.
7. **§6, rollback.** *Spec:* "git revert". *Now binding:* `git revert --no-commit` of HEAD only, when
   HEAD carries `Kiln-Candidate` or `Kiln-Operator-Delta`, with `--confirm`, the journal line and the
   revert in one commit with `Kiln-Rollback-Of`; a reverted candidate is re-archived `rolled_back`.
   *Why:* older reverts conflict and kiln has no merge tool; a journal line after the revert's own
   commit would dirty the tree. *Forecloses:* reverting an older commit in one step.
8. **§7, effort (ruling 1).** *Spec:* "Effort: `medium` by default … Judge finals and the formation
   critique run at high." *Now binding:* `cfg.effort` stays `medium` as the fallback; `effortByRole`
   (the model-practices plan's Task 1) starts at brain / builder / form / critic `high`, judge /
   auditor / reflector `medium`, scout / arbiter / prober `low`, `generator` unlisted (flagged); the
   judge is `medium` per ideation record §2 ("no escalation in v1"), which had already superseded §7's
   "judge finals at high"; only this plan's per-(role, model ref, profile) sweep changes an entry —
   under the non-inferiority rule at `sweepPairsPerSeed: 8` with its admission probabilities stated as
   the named E7 risk, against twelve incumbent loop runs whose incumbent cell is the one pre-registered
   A/A (controller ruling 3) — recording the winner in `evals/effort.json` and committing it; every
   M0/M1/M3 comparison consumes and records it, and no comparison whose grid-row seats are unswept
   may promote. *Why:* ruling 1, A3, §C, E7. *Forecloses:* A3's "default `high`" for seats ruling 1
   lists at `medium`/`low`; a promotion at an unmeasured effort; a sweep winner chosen against a bare
   yardstick.
9. **§10, the home layout.** *Spec:* `evals/ seeds/, calibration.json, judge-rubric.md, metrics.ts`;
   `evolution/{candidates,archive}/`. *Now binding:* `evals/{seeds/dev,seeds/heldout,split.json,
   judge-rubric.md,README.md,manifest.json,calibration.json,calibration/,effort.json}`;
   `evolution/{candidates,archive,reports,work,promoted}/`, `evolution/deltas.jsonl`,
   `evolution/evolve.lock`; eval runs live only under `evolution/work/<evalId>/<arm>/runs/`;
   `evolution/reports/<evalId>/` holds `eval.json`, `judged.jsonl`, `record.jsonl`, `criteria/`; the
   home repo tracks `playbook/`, `prompts/`, `evals/`, `evolution/{archive,reports,promoted}/`,
   `evolution/deltas.jsonl`, `config.json` and ignores `runs/`, `auth.json`,
   `evolution/{candidates,work}/`, `evolution/evolve.lock`; `initHome` sets identity and makes the
   initial commit (an fs check, no spawn, thereafter); `calibrate`, `effort`, the gate write, `promote`,
   `archive`, `apply` and `rollback` are the committers, each with a trailer; the porcelain refusal
   covers `playbook/`, `prompts/`, `evals/` and `config.json`'s `evals.judgeGate` only (controller
   ruling 7). *Why:* §3's fingerprint applied to the evaluator's verdicts as well as its material;
   §6's attached eval; rollback's parent. *Forecloses:* `metrics.ts` under `evals/`; hand edits to
   gating files that no command notices.
10. **§13, size.** *Spec:* "under six thousand lines". *Now binding:* 12,798 lines at `10af486` before
    this plan plus about 2,500; the number is withdrawn, the direction kept (400 lines per module, a
    test file per module); the figure moves with every commit and each task report prints it.
11. **§14, the 120-bullet refusal.** *Spec:* "refuses a playbook over 120 bullets". *Now binding:*
    refuses a candidate that would leave more than 120 *active* bullets, at eval preflight and at
    promote; retired bullets sit under `## retired` and are not counted; an operator `retire` is always
    allowed. *Forecloses:* nothing.
12. **§5.3 and §5.4, metrics and M1 (rulings 10, 12; E1).** *Spec:* the §5.3 list; M1's two arms
    "judged pairwise … and blind human re-ranking on a subset". *Now binding:* `metrics.json` carries
    `cost: Record<Phase, CostBlock>` from the model-practices plan's Task 5, consumed here, with the
    ideation denominator = the ids with an `idea.insert` event and no later `idea.reject` with reason
    `restatement` or `collided`, `frontier.raw` and `backfilled` beside it; M1 has four arms on the
    same 12 held-out seeds — A0 baseline, B0 `--bare`, A1 Fable-at-low, A2 the frontier seating
    profile — in three paired tables, quality columns first then cost; every eval field is
    `pairCensored`, never the per-run `censored`; M1's human re-ranking is deferred and every table
    stamps `judgeCalibration.status`. *Why:* E1, rulings 10 and 12; there is no human. *Forecloses:*
    a human-anchored M1 until one exists; an M1 that assumes frontier seating as the default.
13. **§13, build order.** *Spec:* "Nothing in 8 is built before M0 passes." *Now binding:* the
    evolution code is built and tested on fixtures before M0; nothing is **promoted** before a
    human-labelled M0 passes, and in v1 only build-class candidates can promote at all. *Forecloses:*
    nothing.

**Not overridden:** `budgets.usd: 25`, `budgets.wallSeconds: 14400`, `ideation.rounds: 3`, and the
formation/build record's §12 money table — its `expectedAttemptUsd`, `builderUsdCap` and derived
`maxFeatures` are re-priced by ruling 1 and **flagged** to the supervisor as a cross-workstream
correction (§6), never overridden here.

## 16. Assumed interfaces from formation/build Tasks 10–11 and model-practices Tasks 1, 3, 5 (verify before execution)

Formation/build Task 10 is in the working tree, uncommitted, at HEAD `10af486`; Task 11 has not
started; nothing of the model-practices plan has landed. Every fallback was re-verified to exist
(`code-contact-round-2.md`, round 3's audit).

1. **`runReflect` reads `status.seed` and refuses held-out runs.** *State:* Task 10 reads no `seed`
   (`src/phases/reflect.ts:86-152`). *Fallback:* the runners never reflect on eval runs and `evolve
   eval` refuses held-out-run candidates — **works without Task 10**.
2. **`validateDelta`, `parseDelta`, `playbookSections`, `playbookBulletIds`, `writeCandidate` in
   `src/build/delta.ts`** (`:5-16,18-24,29-36,40-55,58-75,120-138`). *State:* **landed in Task 10,
   extended here** (controller ruling 5). `applyDelta`, `serializePlaybook`, `stripCounters`,
   `playbookHash` do not exist and are this plan's. *Fallback:* none needed.
3. **The candidate file** is `candidatePath(home, runId)` = `evolution/candidates/<runId>.json` with
   `{ runId, digestHash, playbookHash, reflectorModelRef, delta, createdAt }`. *State:* verified;
   the hash field is **`playbookHash`**, not `championPlaybookHash`. *Fallback:* `validateCandidate`
   defaults every field this plan adds — **works unconditionally**.
4. **`playbookHash` is counter-stripped.** *State:* Task 10 computes `hashInput(loadPlaybook(home))`
   (`reflect.ts:124`) — bytes, counters included. *Cross-workstream correction (controller ruling 2):*
   `hashInput(stripCounters(playbook))`, `stripCounters` exported from `delta.ts`. *Fallback:* a
   byte-hash candidate is archived `stale_champion` on first sight and re-reflected at $0.153 —
   **works by degrading**.
5. **`PlaybookDelta` carries optional `why` and `kind`; `playbookDeltaTool`'s schema lists them.**
   *State:* neither exists (`delta.ts:10-16`, `reflect.ts:45-59`). *Cross-workstream correction
   (ruling 5).* *Fallback:* `validateDelta` parses the `Why:` clause out of `text` and defaults
   `kind` — **works without the fields**; the fields are additive when they land.
6. **`prompts/reflector.md` carries A12's rubric.** *State:* **landed** in the working tree (four
   sentences; not the `Why:` form). This plan edits no prompt; the validator enforces the form.
7. **`kiln project build <run> --single-session --autonomous --json`** (Task 11) for M2's arm B.
   *Fallback:* call `runBuild` / `runBuildSingleSession` directly (`src/phases/build.ts:1`) — **works**.
8. **`--through form|build|reflect` and `--autonomous` reaching the autonomous pick and the build
   loop** (Task 11; `run.ts:49` still ends at `checkpoint`). *Fallback:* the eval runner drives the
   phase functions directly — **works**.
9. **`run resume` routing for `stopped`/`paused` eval runs** (Task 11, formation/build §12's table).
   *Fallback:* the runner re-enters through the phase functions with today's
   `checkpointReady`/`shouldRunIdeate` logic (`run.ts:64-75`) — **works but duplicates**; verify first.
10. **Task 10's digest carries no playbook bullet count.** *State:* consistent (`digest.ts:173`
    `digestHeadings`; no bullet count). *Fallback:* none needed.
11. **`delta.reason` is a free string.** *State:* **landed** (`events.ts:196`); this plan adds
    `source?`.
12. **Model-practices Task 1: `KilnConfig.effortByRole` with ruling 1's table and `effortFor(cfg,
    role, model)`, every literal site switched** (its lines 59, 62, 85), plus `spentByPhase` /
    `elapsedByPhase` now in `src/core/budget.ts` (working tree) which the eval floor imports.
    *Fallback:* the judge sweep works without them (`JudgeDeps.effort` is its own); the generator +
    brain, builder and auditor rows need per-seat effort and **do not work** without Task 1 — a hard
    prerequisite, which is why §1's order puts it first.
13. **Model-practices Task 1: `model.call.{effortSent, addendaHash, fallbackServed, reasoningTokens}`
    and the `refusal` failure class with `stopDetails`.** *Fallback:* judged lines carry the
    configured model with `fallbackUnknown: true`; a labeller refusal arrives as `stopped: "error"`
    and is counted in `refusedGroups` by stop reason — **works by degrading**.
14. **Model-practices Task 3: the kernel precedence sentence; Task 3 consumes this plan's `kiln
    evolve apply`** for the B1–B3 / FM1–FM2 operator deltas (a reverse dependency; §1's order).
    *Fallback:* a hand edit plus hand-written `evolution/deltas.jsonl` lines — **works by degrading**;
    the record names the order and the counter reset (controller ruling 6).
15. **Model-practices Task 5: `src/core/cost.ts` `foldCost(events, phase, successes): CostBlock` and
    `metrics.json.cost: Record<Phase, CostBlock>`** with the survivor denominator keyed by id (its
    lines 160–161; its wording "archive survivors at the last complete frontier" must adopt §5's
    id-keyed fold). *Fallback:* the report computes the same block evals-side over each eval run's
    `record.jsonl` — **works, duplicated, temporary**; flagged.

**Cross-workstream corrections, relayed by the supervisor:** (1) formation/build Task 10 —
`playbookHash = hashInput(stripCounters(playbook))`, field named `playbookHash`; (2) formation/build
Task 10 — optional `why` and `kind` on `PlaybookDelta` and the tool schema; (3) the model-practices
plan — the three-plan order in its Global Constraints, Task 3 waiting for evals Task 1, counters
**reset** not preserved, Task 5's denominator wording, and the eleventh `effort:` site
(`reflect.ts:139`) plus `builder.ts:222`'s `deps.cfg.effort` form in its `effortFor` switch; and the
flag to the formation/build record's §12 money table (`maxFeatures` 8 → 7 under ruling 1).

## 17. What must be measured before any of this is trusted

Every dollar, second and probability in §6, §7 and §9 is an estimate from list prices and an assumed
session shape; no paid call was made anywhere in this design. The first real eval replaces them, in
this order:

- **The incumbent A/A cell** (controller ruling 3): champion versus champion at one round, n = 96;
  its 95 percent interval must contain 0.5, or the judging scheme is biased and no sweep or M3
  result is trusted until it is understood. This is the one pre-registered paid step.
- `cost.<phase>.cacheReadRatio` per phase against the cost model's 0.387 / 0.706 / 0.727 / 0.320,
  and `cacheHealthy` on frame, form, build and reflect against E2's "> 0 after the first turn".
- The observed pair-level variance across seeds, to size `k` and to test whether pairs within a seed
  are as correlated as §14 fears; the same for paired feature outcomes within a project.
- `cost.<phase>.usdPerSuccess` against $1.276 (ideation, per raw-front idea), $1.315 (formation),
  $1.612 (build, per executed feature at ruling 1's table), $0.101 (bare); and `usdCapHits` and
  `budgetOvershootUsd` under ruling 1's `high` seats — the symptom ruling 1's own cost-if-wrong names.
- The judge sweep's agreement curve across `low..xhigh` on the M0 replay, against ideation record
  §2's `medium`.
- The 1-round frontier size (assumed 5) and the bare arm's collision rate (assumed 20 percent) — the
  two cost-model assumptions with no measurement behind them.
- M1's three paired tables: A0 vs B0 against spec §5.4's "≥ 65 percent" (which sits exactly on the
  n = 48 bar), A1 vs A0 and A2 vs A0 with `usdPerSuccess` beside them — the only thing that can
  answer whether Fable-at-low or the frontier profile is worth its price.
- The dev/held-out gap over the first three candidates (spec §5.4 M3's number to watch and its kill).
- `refusedGroups` and `fallbackUnknown` counts, to learn what the isolation seats' refusal path costs
  in lost material.
