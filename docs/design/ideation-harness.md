# kiln: a self-evolving harness for ideation and 0-to-1 project completion

Status: design specification, v1
Date: 2026-09-02
Working name: `kiln` (raw ideas go in, a fired first artifact comes out). The name is free on
this machine's PATH and can change before code lands.

Supersedes `AGENTIC_HARNESS_PLAN.md` as the design authority. Inherits the measured
mechanisms and the measurement policy of `SPEC_V1.md` and `SPEC_LONG_HORIZON.md`. The audit
that justifies this is `docs/superpowers/specs/2026-09-02-existing-plan-audit.md`. Evidence is
cited by report: `docs/research/2026-09-02-*.md`.

---

## 0. The one-paragraph version

One long-lived **brain** does the thinking. Stateless **scouts** do parallel, read-only
discovery and return short findings. Ideas are generated on isolated **islands** under
different lenses into a **quality-diversity archive** with named axes, deduplicated by
novelty rejection, and **falsified** by prior-art retrieval. Survivors are grounded by cheap
**executable probes**, ranked by an **order-swapped, commit-first pairwise judge** on value
and feasibility into a **Pareto frontier**, and shown to the human at one checkpoint. The
chosen idea is **formed** into a frozen spec and feature list, then **built** one feature
per fresh session with an independent **auditor** as the only cross-session memory and the
honest exit "cannot be satisfied." Every run leaves an immutable record. The harness
**evolves** only its playbook and prompt text, rarely, from candidates that win on a held-out
seed set under a judge that has been calibrated against human preference, with the evaluator
outside the mutable tree. The whole thing is a Bun/TypeScript program with an Amp-style TUI,
subscription auth for Claude and ChatGPT delegated to an MIT library, and a target size under
six thousand lines.

The one finding that shapes everything: **generation is not the bottleneck, selection is.**
Frontier models already beat expert humans on rated novelty, but reward models correlate with
true quality on open-ended work at about 0.12, LLM-rated novelty is anti-correlated with
whether an idea leads anywhere (about minus 0.29), and after real execution AI ideas fall
roughly two points on a ten-point scale while human ideas hold. So kiln spends its budget on
selection, grounding, and execution, not on generating more
(`docs/research/2026-09-02-ideation-evidence.md`).

---

## 1. Goals and non-goals

### Goals

1. Produce ideas that are non-obvious, novel, and still feasible, for a seed the user gives
   (a domain, a problem, a constraint set, or a vague itch).
2. Turn one chosen idea into a formed project: spec, acceptance list, bootstrap script.
3. Complete the first working artifact of that project autonomously.
4. Improve at 1 to 3 across runs, without a human rewriting prompts by hand, and without the
   improvement being fake.
5. Stay small enough that one person can read all of it.

### Non-goals for v1

- A coding or debugging agent. Use Claude Code, Codex, or omp for that. kiln's build phase
  calls its own small builder loop, but its edge is formation and verification, not editing
  ergonomics.
- Multi-user, remote, or hosted operation. One operator, one machine.
- A web UI, an HTTP API, MCP server hosting, or a plugin system.
- Self-modification of harness code, topology search, or weight-level learning.
- Graph-structured memory or a vector database.

### Evidence rules inherited as constitution

- No mechanism enters the harness without a measured result on a task set demonstrated to
  discriminate (`SPEC_LONG_HORIZON.md` §2).
- Before running an experiment, write down what observation the design makes impossible.
- Below twenty samples per arm, a result is labelled "not evidence" and cannot promote
  anything on its own.
- A gate whose only exits are success and retry is a reward-hacking prompt. Every loop has an
  honest exit that is scored as a legitimate outcome.

---

## 2. Approaches considered

**A. Wrap the existing CLIs as black boxes**, the way the experiments rig wraps `claude -p`
and `codex exec`. Cheapest to start. Rejected because the design's load-bearing parts happen
inside the loop: pinned constraints that survive compaction, a judge that never sees the
generator's context, a small tool set, shaped tool results. None of that is controllable
from outside a black box, and the TUI would be a wrapper around someone else's transcript.

**B. Native loop on `@oh-my-pi/pi-ai` and `@oh-my-pi/pi-agent-core`, own TUI on
`@oh-my-pi/pi-tui`.** Chosen. Providers, subscription OAuth, streaming, tool calling, the
agent loop, and compaction are MIT-licensed libraries already on this machine
(`docs/research/2026-09-02-omp-subscription-auth.md`). kiln writes only what is specific to
ideation, formation, verification, and evolution.

**C. Fork oh-my-pi and add ideation modes.** Largest head start on the TUI, but inherits a
coding-centric product with a 130 MB self-updating binary and hundreds of features. It cannot
be kept small, and its UI is not Amp's.

---

## 3. Architecture

```
kiln (Bun, TypeScript)
├── core/            run lifecycle, state files, record, budgets, deadlines
├── brain/           the single deciding agent: prompts, context discipline, tools
├── scouts/          stateless read-only research workers
├── ideation/        islands, novelty rejection, prior-art, probes, tournament, frontier
├── formation/       spec, feature list with acceptance checks, critique pass, freeze
├── build/           one-feature-per-session loop, external verification, read-only auditor
├── evolution/       reflector, candidates, held-out eval, promotion, rollback
├── evals/           seeds, calibration, metrics (read-only to evolution)
├── providers/       thin adapter over pi-ai: auth store, model roles, effort mapping
├── tui/             Amp-style interface on pi-tui
└── cli/             non-interactive commands with --json parity
```

Rules that hold across every module:

- **One brain.** Exactly one agent carries state and makes decisions in a run. Scouts,
  judges, probes, and builders are stateless workers that receive a file-based brief and
  return text or a verdict. They never talk to each other. Evidence: independent multi-agent
  amplified errors 17.2x and cut sequential-task performance by 70 percent; dense
  communication accelerates diversity collapse (`loops-and-self-evolution.md` §3.4,
  `harness-benchmark-evidence.md` §1G).
- **Files are the state.** A run is a directory. Crash recovery is "read the directory and
  continue." No database, no workflow engine.
- **Fresh context per unit of work.** Each scout task, each probe, each feature build, each
  judge comparison starts from an empty context plus the files it needs. Only the brain is
  long-lived, and it compacts at 70 percent of its window with the contract region pinned.
- **The evaluator is outside the mutable tree.** Judge prompts, seeds, calibration data, and
  scoring code live in `evals/`, which the brain, the reflector, and `kiln evolve` cannot
  write. Evidence: hiding the evaluator reduced objective hacking in DGM; fingerprinting it
  is the stronger form (`SPEC_V1.md` mechanism 3).
- **Everything is recorded.** Every model call is appended to `record.jsonl` with model,
  role, effort, input hash, token counts, cost, and a head-and-tail excerpt of the output.
  Every tool call, verdict, and state transition is appended too. The record is never read
  back into model context.

---

## 4. Run lifecycle

A run has a seed and moves through five phases. Each phase has an entry file, an exit file,
and an honest exit.

### 4.1 Frame

Input: `seed.md` (the user's prompt, verbatim) and any files the user attached.
The brain writes `brief.md`: the problem restated, hard constraints, what counts as success
for the *search* (not the project), explicit non-goals, the idea **shape**, and a discovery
plan of at most four questions for scouts. The shape is one of `research`, `product`, or
`creative`, and it sets what the value axis means in ranking: for research, excitement and
expected follow-on work; for product, utility to a named user; for creative, the effect on a
named audience. Evidence: the novelty-feasibility trade-off is near zero for expert-rated
research ideas and strongly negative (about minus 0.74) for lay-rated product ideas, so the
same selection rule cannot serve both. The user can edit `brief.md` in the TUI before
discovery starts; in autonomous mode the brain proceeds after writing it.

Honest exit: "the seed is too underspecified to search" with the questions that would fix it.

### 4.2 Discover

The brain dispatches at most four scouts in parallel, each with one question from the
discovery plan. A scout has read, search, web search, and web fetch tools, a fixed turn cap,
and returns a findings file of at most 1,500 tokens in `discovery/`. Scouts return text, not
conclusions about what to build.

The brain writes `landscape.md` with four sections that the ideation prompts consume
directly:

- **The obvious list.** Ideas anyone would propose in five minutes. These are excluded from
  generation by name. Evidence: frontier models put about 96 percent of their probability
  mass in the ten most common concept clusters for a topic; naming the mode is the cheapest
  way to leave it.
- **Atoms.** The twenty to forty concepts, mechanisms, and constraints that appear in the
  discovery findings, each tagged with how common it is in the landscape. Evidence:
  availability-aware sampling over concept atoms, which prefers coherent but rarely
  co-occurring combinations, was the one method that raised human-rated novelty and
  feasibility at the same time.
- **Tensions.** Constraints that fight each other, assumptions everyone in the domain shares,
  and things that were tried and failed with the stated reason. This is the raw material for
  non-obvious ideas.
- **Distant domains.** Three to five fields with a structurally similar problem that are far
  from the seed's field. Evidence: enforced analogical distance roughly tripled domain
  distance and was preferred on novelty 78 percent of the time, at a stated cost in
  reasonableness that the feasibility probe is there to catch.

Each section is a list with one line per item, so it can be quoted into prompts verbatim.

### 4.3 Ideate

This is the ideation loop. Default budget: three rounds.

The loop has two halves that use different machinery. **Divergence** is structural: islands,
lenses, and a quality-diversity archive make the population spread out, because asking a
model to be diverse does not work past a low threshold. **Selection** is grounded: novelty is
falsified by retrieval rather than scored, feasibility is probed by execution where possible,
and the judge compares only what is left, on value and feasibility, with its biases
engineered out.

**Islands and lenses.** Three islands run per round, each with a distinct lens drawn from the
playbook's lens list. Defaults: *invert a shared assumption* (from the tensions),
*recombine two atoms that never co-occur in the landscape*, and *transfer the mechanism of a
distant domain*. Islands do not see each other's output during a round. When both providers
are logged in, islands alternate provider; when a cheap small model is configured, one island
uses it, because small models produce two to three times more distinct outputs than their
large siblings. Evidence: AlphaEvolve's island model; FunSearch's single-island ablation never
found a full-size result; diversity collapse measurements
(`loops-and-self-evolution.md` §1.4, §3.4; `ideation-evidence.md` §1c).

**Generation prompt shape.** Each island is asked for five ideas *as a distribution*: the
prompt asks for five candidates with a rough probability that a domain expert would land on
each, and instructs that at least three be under 10 percent. This is verbalized sampling,
which raised diversity 1.6 to 2.1 times at no cost and survives alignment far better than
direct prompting. The prompt uses plain divergence language ("unconventional," "would surprise
an expert") rather than a named brainstorming method; simple divergence instructions measured
better than SCAMPER, C-K, or design-thinking scaffolds. After the first five, the island is
asked once for five more that are *unlike everything above*; in-context regeneration brought
frontier models to roughly human diversity. The obvious list is excluded by name.

Each idea is a dossier in a fixed template with length caps: title, one-paragraph mechanism,
the two atoms or the source domain it draws on, which axis values it occupies (below), a
**testable claim** that would show it works, the cheapest test of that claim, and the
strongest reason it fails. Requiring a testable claim at generation time raised feasibility
by about 0.8 on a ten-point scale and nearly doubled execution success without touching
novelty (HARPA), and it is what makes the feasibility probe cheap to write.

**Archive with named axes.** Every idea enters a quality-diversity archive keyed by a small
set of behavior axes the brain writes into `brief.md` at framing time, defaulting to: *who it
serves*, *the mechanism class*, *what it assumes that others do not*, and *where the value
shows up*. The archive keeps at most one champion per cell plus everything else in a
`rejected` list with the reason. Evidence: an archive over named axes gave 4.8 times the
yield of non-obvious, non-duplicate ideas and found something on 27 of 32 topics versus 6 of
32 for sequential generation; the axes are the design, because the archive fills only along
the dimensions you named (`ideation-evidence.md` §1a, §1c).

**Novelty rejection.** Every new idea is compared to the archive by trigram Jaccard over
title plus mechanism. Above a threshold (default 0.45), one judge call asks "meaningfully
different or a restatement?" and rejects restatements. Evidence: ShinkaEvolve reached state
of the art in about 150 samples with novelty rejection versus 800 without, and its embedding
filter gave "substantial" gains where an LLM novelty judge gave "marginal" ones. Lexical
similarity plus an LLM tie-break is the v1 mechanism; no embedding service.

**Prior-art falsification.** For every surviving idea a scout searches for the mechanism,
decomposed into purpose, mechanism, and evaluation facets, and returns the closest existing
thing with a one-line distance statement. The judge then answers one question: *is this the
same thing?* An idea that is the same thing is marked `collided` and leaves the frontier;
nothing else about novelty is scored. Evidence: facet-matched retrieval caught 90 percent of
known non-novel ideas versus 14 percent for relevance ranking; on realistic distributions
the dominant judge error is refusing to say "not novel," so retrieval is used as a falsifier
and never as a novelty score (`ideation-evidence.md` §1d).

**Feasibility probe.** If the dossier's cheapest test is executable in under two minutes
(fetch a dataset, hit an API, run a thirty-line script, render a page), the brain requests a
probe for it in one batched `probe_request` call, a stateless prober worker writes the probe
from the dossier alone with a pre-committed success predicate and declared dependencies, and
the harness runs it in a scratch directory under a process-group deadline. The harness
captures exit code and output itself; neither the brain nor the prober reports a probe
result. Outcomes are pass, fail, timeout, or error (a missing declared dependency or a spawn
failure), and error is excluded from the pass rate. If nothing executable exists, the idea is
marked `unprobed` and its feasibility is judged from the prior-art finding and the failure
reason. (Amended 2026-09-03; see the decision record §6.) Evidence: about 80 percent of autonomous
research-agent runs fabricated or invalidated results when allowed to self-report; execution
is the only selection signal that does not invert after contact with reality.

**Tournament.** Ideas that are neither rejected nor collided are ranked by pairwise
comparison on two questions only, *value for the shape named in the brief* and *feasibility
given the evidence*. The judge never scores novelty: comparative judging amplifies novelty
bias rather than correcting it. Before seeing any candidate, the judge is given the brief and
writes its own short statement of what a strong idea for this seed would have to do and
where such ideas usually fail; only then does it see the pair. Evidence: making the judge
commit first cut a gamed judge's false-positive rate from 72 percent to 1 percent, the
largest single judging fix found. The judge receives two dossiers rendered into the same
fixed template with the same length caps and their evidence, and nothing else: not the
generator's context, not its self-rating, not the other ideas. Every pair is judged twice
with the order swapped; a win counts only if the same idea wins both orderings, otherwise
the pair is a tie. Bradley-Terry strengths with bootstrap confidence intervals are computed
from the results, and two ideas whose intervals overlap are treated as tied. When both
providers are logged in, the judge is the provider that did not generate the idea. Pairing is
round-robin up to eight ideas, Swiss-style beyond that. Evidence: swap-and-agree removed
most position bias at the same cost as more samples; style bias in current judges is 0.10 to
0.76 while verbosity bias is near zero, which is why presentation is normalized instead of
the judge being asked to ignore it; self-preference bias reaches 25 percent and a stronger
judge does not fix it (`ideation-evidence.md` §1d).

**Frontier.** The archive keeps every idea. The frontier is the Pareto set over (value,
feasibility) among uncollided, distinct ideas, with tournament strength as the tie-break.
Novelty is not an axis: it is already enforced by the archive cells and the collision
filter. The frontier, not the argmax, is what the next round evolves and what the human
sees.

**Evolve.** Each subsequent round selects a diversity-maximizing subset of the frontier (a
maximal-marginal-relevance pick of k, default four) and seeds islands with it plus a
meta-review: a short critique of why the round's losers lost, written by the judge model
from the tournament record. Refining a diversity-selected subset gave the best yield and
lowest duplication per dollar; uniform refinement of everything misallocated the budget.
Islands apply mutation operators from the playbook: combine two frontier ideas, specialize to
a narrower user, generalize the mechanism, swap the domain, turn the failure reason into a
feature. Evidence: the co-scientist's evolve and meta-review agents are what turn parallel
generation into an improving loop.

**Stop.** Whichever comes first: the round budget, no new frontier entrant in a round, the
cost or wall-clock budget, or the honest exit "no idea clears the bar," which the brain may
declare with the reasons and which is recorded as a legitimate outcome.

**Checkpoint.** The TUI shows the frontier (five to eight dossiers with their evidence and
strengths). The human ranks by best-worst scaling: the frontier is presented as groups of
four, and the human picks the best and worst of each group, which yields five of six pairwise
relations per group at about a third of the annotation cost of rating scales. The human can
also pick outright, reject with a reason, or ask for another round with a steering note.
Evidence: one human re-ranking pass moved AI ideas' overall rating from no better than human
ideas to significantly better, the highest-return human touchpoint in the literature. In
autonomous mode the top Bradley-Terry idea on the frontier is chosen and the record marks
the choice as unreviewed.

### 4.4 Form

For the chosen idea the brain writes, in `project/`:

- `spec.md`: what, for whom, why now, scope, non-goals, risks, and the first milestone that
  would prove the idea, stated as something a user could see.
- `features.json`: an ordered list of features, each with `id`, `description`,
  `acceptance` (a shell command, an HTTP check, a rendered-page check, or a manual
  description when nothing executable exists), `passes: false`, and `attempts: 0`.
- `init.sh`: environment bootstrap.

Then a **critique pass**: a second model, different provider when available, reviews the
spec and feature list for scope creep, missing acceptance checks, and features that cannot be
verified; the brain revises once. Evidence: plan refinement before execution is worth 4 to 7
points and a subpar plan is worse than no plan (`harness-benchmark-evidence.md` §1G).

Then **freeze**: `acceptance.lock` records the sha256 of every feature's acceptance check.
The build loop refuses to run if the lock does not match. The brain and the builder cannot
edit acceptance checks after this point; the human can, which rewrites the lock and is
recorded. Evidence: a prompt-level prohibition did not stop a fraudulent pass in the rig;
fingerprinting did (`SPEC_V1.md` mechanism 3).

Honest exit: "this idea is not formable" with the reason, which returns to the checkpoint.

### 4.5 Build

The completion loop, taken from Anthropic's long-running harness with three additions from
the measured specs.

```
repeat:
  fresh builder session
  read: git log, project/progress.md, project/audit.md, project/features.json,
        playbook (build section)
  pick the first feature with passes=false and attempts<3
  implement it in project/repo
  harness runs the feature's acceptance check (never the builder)
  fresh auditor session, read-only tools, sees repo + acceptance criteria + check output
  auditor writes project/audit.md: what is verified, what is claimed but unverified,
        what regressed, what the next session should know
  on pass and audit agrees: commit, set passes=true, append progress.md
  on fail or audit disagrees: attempts+=1, append progress.md with head+tail of the output
until: all features pass
     | three identical (tool, result-preview) fingerprints in a row
     | budget or deadline
     | the builder files "cannot be satisfied" citing what it examined
```

- The **auditor** is a separate model call with read-only tools and no access to the
  builder's transcript. Its report is the only cross-session memory besides the append-only
  progress log. Evidence: a manage-execute-audit loop with exactly this shape moved a
  long-horizon benchmark from 52 to 81 percent, and the auditor consumed 19 to 38 percent of
  tokens; poor self-verification signals appeared in 99.6 percent of failures on the hardest
  long-horizon suite (`ideation-evidence.md` §1e). Budget for it.
- The builder session starts from environment state only. A failed attempt's transcript is
  never fed to the next attempt. Evidence: environment-only beats environment plus summary
  beats environment plus full history on recovery (`Recovery-Bench`).
- Retry branches on failure class. Transient (crash, killed group, API error, rate limit):
  clean retry, not counted against the feature. Verify failure: counted, fresh session.
  Budget, deadline, integrity: terminal.
- Deadlines are enforced on the process group with setsid, graduated SIGTERM then SIGKILL,
  a bounded drain, and overruns recorded rather than absorbed.
- After every feature passes, the harness re-runs all earlier acceptance checks. Evidence:
  in continuous milestone streams recall grows while precision saturates; regressions from
  earlier work are the long-horizon failure (`SWE-Milestone`).
- The builder's tool set is read, write, edit, bash, and search. Five tools.

Honest exit: the "cannot be satisfied" report is a scored terminal outcome of the run.

### 4.6 Reflect

After a run ends in any state, a reflector reads `record.jsonl` and the run files and
proposes **at most one** playbook delta: a new bullet, an edit to an existing bullet, or a
retirement, each tied to specific evidence in the record. The delta is written to
`evolution/candidates/` and is not applied. Evidence: ACE's incremental deltas avoid the
context collapse that wholesale rewrites cause; GEPA's reflective mutation is the learning
signal that works when there is no scalar reward (`loops-and-self-evolution.md` §2.4, §2.5).

---

## 5. Evaluation: the part that decides whether self-evolution is real

There is no test suite for an idea. Four signals substitute, in order of trust:

1. **Execution.** Probe results during ideation; acceptance checks and the auditor during
   build. Cannot be argued with, so it dominates wherever it exists.
2. **Human preference.** The checkpoint ranking and the calibration set. Sparse and
   expensive, so it anchors the judge rather than replacing it. Evidence: judge bias is not
   identifiable from machine comparisons alone, and scaling comparisons 26 times bought
   nothing; human-labelled anchors are the only fix that measured.
3. **Grounded retrieval.** Prior-art collision as a falsifier of novelty. External, cheap,
   and gameable only by a poor search, which the record exposes. Never a score.
4. **The pairwise judge.** Commit-first, order-swapped, style-normalized,
   generator-isolated, cross-provider when possible, on value and feasibility only. Usable
   for promotion only after calibration.

### 5.1 Judge calibration

`kiln evals calibrate` shows the human at least twenty groups of four ideas from past runs
as best-worst questions, records the implied pairwise preferences, and runs the judge on
the same pairs with the swap rule. The judge is **calibrated** when it agrees with the human
on at least 70 percent of pairs where the human expressed a preference and its
order-agreement rate is at least 80 percent. Below that, the judge can still rank inside a
run (the human checkpoint catches it), but it cannot gate promotion in `kiln evolve`.
Calibration results live in `evals/calibration.json` and expire when the judge prompt or
model changes. Evidence: the co-scientist validated its Elo against an external ground truth
before trusting it; the best LLM judge reproduced a 6,000-comparison human expert arena at
only 73 percent, so 70 percent is the realistic bar, not a low one; expert inter-rater
agreement on ideas is itself only about 56 percent, so the human signal is noisy and the
calibration set must be large enough to average it.

What this design makes impossible to observe: whether the judge is right about ideas the
human is also wrong about. That is accepted for v1 and named here.

### 5.2 Seeds and splits

`evals/seeds/` holds at least twenty-four ideation seeds, split into twelve development
seeds and twelve held-out seeds, with all three shapes represented in each split. Nearly all
published ideation evidence comes from research and software; whether these mechanisms
transfer to product and creative work is unmeasured, so the seed set must contain the cases
the literature does not. The reflector and the brain never see the held-out seeds;
`kiln evolve` uses them only for the final comparison. Seeds are added by humans, never by
the harness.

### 5.3 Metrics per run

Written to `metrics.json` at the end of every run and every eval:

- frontier size, archive cells filled, and mean pairwise lexical distance (diversity)
- prior-art collision rate: fraction of generated ideas whose closest prior art was judged
  "the same thing"
- tie rate in the tournament, which rises when the judge cannot separate ideas
- probe coverage and probe pass rate
- features passed, features blocked, regressions caught
- cost in dollars, tokens by role, wall time, turns per phase
- honest exits taken, by kind

### 5.4 Pre-registered measurements

Each has a prediction, a kill condition, and a statement of what the design cannot observe.

**M0, judge calibration.** Prediction: a strong model with the swap rule reaches 70 percent
agreement. Kill: below 60 percent, the pairwise judge is removed from evolution and the
checkpoint becomes mandatory. Cannot observe: judge accuracy on pairs the human misjudges.

**M1, ideation loop versus bare prompt.** Twelve held-out seeds; arm A is the full ideation
loop; arm B is a single strong-model call asking for ten ideas with the same brief. Outputs
are judged pairwise with the swap rule and blind human re-ranking on a subset. Prediction:
arm A wins at least 65 percent of pairs and has a lower prior-art collision rate. Kill: if arm
A does not beat arm B, the islands, tournament, and evolve machinery are removed and v1
becomes discover, generate once, human pick. Cannot observe: whether either arm's ideas
succeed when executed, which is M2's job.

**M2, build loop continuity.** Five formed projects; arm A is one feature per fresh session;
arm B is one long session with the same budget. Prediction: A passes at least as many
features at lower cost. Kill: if B wins, fresh-context-per-feature is dropped. Cannot
observe: projects longer than the budget.

**M3, one evolution step.** One playbook delta, dev seeds versus held-out seeds, champion
versus candidate, swap-rule judge. Prediction: a delta that wins on dev seeds wins on held-out
seeds at a lower rate, and the gap is the number to watch. Kill: if held-out win rate is
below 50 percent for the first three candidates, evolution is paused and the reflector prompt
is the suspect.

---

## 6. Self-evolution

`kiln evolve` is a manual command. It is never scheduled and never runs inside a run.
Evidence: the proxy-to-real gap in self-improving agents grew from 26 percent at 10 steps to
58 percent at 100, and the obvious mitigation of self-critique made it worse in some settings
(`loops-and-self-evolution.md` §2.8).

What can evolve, in order, and nothing else in v1:

1. `playbook/playbook.md`: numbered bullets with an id, a section (frame, discover, ideate,
   form, build), and helpful and harmful counters. Delta edits only.
2. `prompts/*.md`: the role prompt templates. A candidate is a full replacement of one file.

What cannot evolve: anything in `evals/`, the tool set, the loop structure, the harness code.

Pipeline:

```
candidate (from reflect, or written by the human)
  -> kiln evolve eval <candidate>
       runs champion and candidate on dev seeds, then held-out seeds
       swap-rule judge on frontier outputs; execution metrics on build seeds
       prints Wilson intervals; labels n<20 "not evidence"
  -> kiln evolve promote <candidate>
       refused unless held-out lower bound > 0.5, or the human confirms a provisional win
       commits the change to the kiln home git repo with the eval attached
  -> kiln evolve rollback
       git revert
```

Losers stay in `evolution/archive/`. Evidence: DGM without the archive could not recover from
dips.

---

## 7. Providers, auth, models

- Providers via `@oh-my-pi/pi-ai` 18.1.3: `anthropic` (Claude subscription OAuth, PKCE,
  loopback on port 54545 with paste fallback) and `openai-codex` (ChatGPT subscription OAuth,
  PKCE, fixed loopback on port 1455, device-code fallback). Credentials are stored by kiln in
  `~/.kiln/auth.json` with mode 0600 using the library's `login*`, `refreshOAuthToken`, and
  `getOAuthApiKey` functions. API keys from `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are the
  fallback and are preferred when both exist only if the user says so in config.
- **Risk, stated plainly.** The Anthropic subscription path works because the library
  presents itself as the Claude Code client. Anthropic has blocked third-party clients from
  subscription OAuth before. kiln treats this as a dependency that may stop working, keeps
  the API-key path first-class, and does not implement client fingerprinting itself.
- Model roles in `~/.kiln/config.json`, each a list of `provider/model` in preference order:
  `brain`, `scout`, `judge`, `builder`, `auditor`, `critic`, `reflector`. Defaults: brain and
  builder on the strongest available model; scouts on the cheapest capable model; judge,
  auditor, and critic on the other provider from the generator when two are logged in. Evidence: the most expensive model was
  on the cost-accuracy frontier in 1 of 9 benchmarks; cheap-for-exploration routing retains
  95 percent of quality at 15 percent of cost (`harness-benchmark-evidence.md` §1B, §1H).
- Effort: `medium` by default; the TUI dial maps low, medium, high, ultra to the provider's
  thinking levels. Judge finals and the formation critique run at high. Evidence: maximum
  reasoning effort was equal or worse in 21 of 36 settings.
- Usage: the 5-hour and 7-day subscription windows are read from the providers' usage
  endpoints and shown in the TUI; a run pauses with a resumable state when a window is
  exhausted, recorded as a transient failure class.

---

## 8. Context discipline for the brain

- System prompt is stable across the run and cache-friendly: kernel rules, the role prompt,
  the tool descriptions with one example each. Nothing volatile in the prefix.
- The **pinned region** follows the system prompt and survives compaction untouched:
  `brief.md`, the current phase contract, the honest-exit clause, and the budget remaining.
  Evidence: constraint violation went from 0 percent to 30 percent average after compaction
  when the constraint was not pinned.
- Compaction triggers at 70 percent of the window. Order: drop tool results whose file is now
  on disk and whose dependent action completed, then summarize the oldest exploratory turns,
  never the pinned region. Evidence: pruning stale tool results alone was worth 29 percent;
  degradation starts at 70 to 80 percent of the window.
- Tool results are shaped before they enter context: head and tail with an omitted-line
  count, and a path to the full payload for re-reading.
- Turn cap per phase is the 75th percentile of observed successful runs, with one automatic
  extension and a "turns remaining" reminder. Until there are observations, defaults are
  frame 10, discover 20, ideate 60 per round, form 30, build 40 per feature.
- The brain's tool set is read, write, edit, bash, search, web_search, web_fetch, scout,
  probe_request, note, and exit. Eleven tools. `exit` is how the brain declares an honest
  exit with its kind and reasons; making it a tool means the record captures it structurally
  and the loop ends cleanly. Nothing is loaded that the current phase cannot use: `bash` is
  not available in ideate (the brain has `probe_request` and `scout` there), `probe_request`
  exists only in ideate, and `scout` only in discover and ideate. (Amended 2026-09-03.)

---

## 9. TUI

Modeled on Amp's current terminal interface as documented in
`docs/research/2026-09-02-amp-tui-anatomy.md`, built on `@oh-my-pi/pi-tui`.

- Full-screen alternate buffer. A transcript view fills the screen; a rounded-border prompt
  box is pinned at the bottom. No header bar, no footer bar: status lives on the prompt box
  border. Top-right: cost or tokens, then the phase label in its phase color. Bottom-left: a
  wave spinner and the activity label (Framing, Scouting, Ideating round 2 of 3, Judging 14
  of 28, Probing, Forming, Building feature 3 of 12, Reflecting). Bottom-right: the run
  directory and git branch.
- User turns: a two-cell green left bar with italic text. Brain turns: bare markdown with
  literal `- ` bullets, blue and cyan bold headings, yellow-bold inline code, four-column
  indented code blocks with no border.
- Tool rows: one line each with a status glyph (`✓` `✗` `⊘` `?`) or a Braille spinner, the
  verb in plain foreground, arguments dim, a `▸` or `▾` toggle, and bodies indented two
  columns. Scouts and probes render as activity groups: `Scout: prior art for "X" ▸`, with
  their steps revealed under the row. The tournament renders as a compact group:
  `Judged 28 pairs, 6 ties ▸` with the frontier table under it.
- The checkpoint is a modal: the frontier as rows with tournament strength, value,
  feasibility, probe status, archive cell, and the closest prior art; best-worst groups of
  four for ranking; keys to pick, reject with a note, or request another round with
  steering.
- Command palette on Ctrl+O with `noun: verb` commands: `run: new`, `run: resume`,
  `run: show record`, `ideas: frontier`, `ideas: pick`, `ideas: another round`,
  `project: form`, `build: start`, `build: pause`, `evolve: eval`, `evolve: promote`,
  `evolve: rollback`, `evals: calibrate`, `auth: login anthropic`, `auth: login openai`,
  `model: roles`, `mode: toggle`.
- Ctrl+S cycles the effort dial. Alt+T expands all details. Esc cancels the current phase
  step with the state saved.
- Colors are the terminal's ANSI palette; the only RGB accents are the phase colors, one per
  phase, in the same spirit as Amp's mode colors.
- Every palette command has a CLI equivalent with `--json` output.

---

## 10. Files

```
~/.kiln/
  auth.json                  OAuth credentials (0600)
  config.json                model roles, effort default, budgets, autonomous flag
  home.git/                  git repo containing playbook/, prompts/, evolution/
  playbook/playbook.md
  prompts/{brain,scout,judge,builder,auditor,critic,reflector}.md
  evals/                     seeds/, calibration.json, judge-rubric.md, metrics.ts
                             (read-only to the brain, reflector, and evolve)
  evolution/{candidates,archive}/
  runs/<run-id>/
    seed.md  brief.md  landscape.md  status.json  metrics.json  record.jsonl
    discovery/<n>.md
    ideas/<id>.md            dossier + prior art + probe + scores
    tournament.jsonl         one line per comparison, both orderings
    frontier.json
    project -> <project dir> (symlink; the project lives where the user asked)

<project dir>/
  spec.md  features.json  acceptance.lock  init.sh  progress.md  audit.md  repo/ (git)
```

`record.jsonl` is append-only and never truncated. `progress.md` is append-only. The playbook
is edited by delta only. Nothing regenerates a summary of everything so far.

---

## 11. Error handling

- Every failure in a worker is classified before anything else happens: `transient`,
  `verify`, `unsatisfiable`, `budget`, `deadline`, `integrity`, `policy`. Retry policy is a
  function of class only.
- A provider error mid-stream is transient; the brain's turn is retried from the last
  complete message with the same context.
- A usage-window exhaustion pauses the run with a resumable state and a wake time from the
  provider's reset header.
- An acceptance lock mismatch is `integrity` and terminal.
- The brain declaring an honest exit is not an error. It is recorded as the run's outcome
  with its stated reasons.
- Any uncaught exception writes the current state to `status.json` before exiting, so
  `kiln run resume` can continue from the last completed step.

---

## 12. Testing

- Unit tests for: novelty rejection thresholds, Bradley-Terry over recorded tournaments, the
  swap-and-agree rule, Pareto frontier computation, acceptance lock verification, failure
  classification, stall fingerprinting, record schema.
- Replay tests: a recorded run's `record.jsonl` replays through the state machine and
  reproduces `status.json` and `frontier.json` exactly.
- Fault injection: kill the process group at a random point during build and confirm the
  run resumes without repeating a committed feature or losing progress lines.
- Deadline tests: a probe that ignores SIGTERM is killed within the graduated window and the
  overrun is recorded.
- The eval harness itself is tested with a fixture judge that returns deterministic verdicts.

---

## 13. Size and build order

Target: under six thousand lines of TypeScript excluding tests and prompts. Build order,
each step usable on its own:

1. `providers/` and `auth`: login, refresh, model roles, one streaming call. `kiln auth login`.
2. `core/`: run directory, record, budgets, process-group runner ported from the rig.
3. `brain/` with the eleven tools and the pinned-region context discipline. `kiln run new`
   through Frame and Discover, in the CLI, with `--json`.
4. `ideation/`: islands, novelty rejection, prior art, probes, tournament, frontier, evolve.
   Checkpoint in the CLI.
5. `tui/`: the Amp-style interface over everything above.
6. `formation/` and `build/`.
7. `evals/` with the first twenty-four seeds and `kiln evals calibrate`. Run M0 and M1.
8. `evolution/`. Run M3.

Steps 1 through 4 are the minimum for an honest M1. Nothing in 8 is built before M0 passes.

---

## 13a. Amendments

- 2026-09-03: the ideation loop's detailed decisions live in
  `docs/superpowers/specs/2026-09-03-kiln-ideation-loop-decisions.md`, produced by a design
  interview and four owner decisions. Where §4.3 and that record differ, the record wins.
  The substantive changes: axes are a closed vocabulary; tournament admission is capped at 16
  entrants with at least 3 comparisons per axis before an idea can reach the frontier;
  novelty tie-breaks and collision verdicts run on a cheap `arbiter` role; the prober is a
  worker and the brain's tool is `probe_request`; `bash` leaves the ideate tool set; the
  search falsifier reports its own health and novelty enforcement is suspended when it fails.

## 14. Risks

| Risk | Handling |
|---|---|
| Anthropic subscription OAuth stops working for third-party clients | API keys are first-class; the provider layer is a library boundary. |
| The judge cannot be calibrated | M0 kill condition: evolution loses the judge; the checkpoint becomes mandatory. |
| Tournaments are expensive | Round-robin capped at eight ideas per round; Swiss pairing beyond; scouts and dedupe on the cheap model. |
| Probes run arbitrary code | Scratch directory under the run, credential-stripped environment, process-group deadline, and declared dependencies checked before running. Network use is declared and recorded, not enforced: v1 has no sandbox. In interactive mode the human sees the probe script before the session's first probe run. (Owner-accepted 2026-09-03.) |
| The playbook grows without bound | Bullets carry helpful and harmful counters; the reflector may retire; `kiln evolve` refuses a playbook over 120 bullets. |
| The judge is gamed by presentation | Fixed dossier template with length caps; judge commits to its criteria before seeing candidates; swap rule; calibration anchors from humans. |
| Novelty that is only novel-sounding | Novelty is never scored by the judge. Archive cells and the prior-art collision filter enforce it, and the probe and the build are the real test. |
| The evidence base is research-shaped | Seeds and calibration include product and creative shapes; M1 reports results per shape. |
| The harness is used as a coding agent and disappoints | Stated non-goal; the build loop's edge is verification, and the TUI says so in the welcome. |
