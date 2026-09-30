# Kiln user manual

Updated from the working implementation on **2026-09-30**.

Kiln is a local terminal workspace for building, researching and comparing ideas with an AI operator. One operator conversation can use tools, delegate scoped work, review returned artifacts and continue after interruption. The operator's final message is a report: inspect its checks and remaining work before treating the task as verified.

## 1. Install and open

You need Git and Bun 1.3.14 or newer. Keep the checkout and dependencies downloaded locally; cloud-evicted files can delay startup.

```sh
git clone https://github.com/vkalipat/kiln.git
cd kiln
bun install --frozen-lockfile
bun link
kiln
```

Without linking, run `bun run kiln` from the repository. Installation applies the tracked patch for Kiln's local OAuth callback page. Keep `patches/`, `package.json` and `bun.lock` together when updating or distributing the checkout.

Kiln stores its state in `~/.kiln` by default. `KILN_HOME` or the supported `--home DIR` command flag selects a different home. Use `--cwd DIR` to select the working repository separately from run artifacts and credential storage.

Opening the TUI does not call a model. A plain greeting such as `hello` or `hi Kiln`, or a simple getting-started question, receives a local response. A greeting followed by an actual task still starts that task. For a real task, type the outcome you want and press Enter. If a provider is not connected, Kiln opens its chooser and retains your task.

## 2. Connect your models

Use the TUI's `/login`, or run:

```sh
kiln auth login
kiln auth login anthropic
kiln auth login openai
```

The chooser distinguishes subscription sign-in from API-key billing. Browser sign-in uses your provider's authentication service. The local return page is branded Kiln and says **Authorization received**; the terminal confirms connection after token exchange completes. Provider-hosted consent continues to identify the actual registered OAuth application. Kiln does not rewrite that identity.

Kiln owns its prompts and local page while reusing the native protocol engine. Fully Kiln-named provider-hosted consent would require a Kiln-owned OAuth application registration, any required provider approval and matching client configuration; that registration has not been completed, and this patch does not spoof an application's identity.

If the browser callback is unavailable:

```sh
kiln auth login openai --device
kiln auth login openai --no-browser
```

The flow also retains a masked prompt for a redirect URL or authorization code. API keys use a separate masked prompt:

```sh
kiln auth key anthropic
kiln auth key openai
kiln auth status
kiln auth status --json
```

For automation, pipe a key from your secret manager to `kiln auth key openai --api-key-stdin`. Avoid placing actual secrets in command arguments or checked-in files. Existing provider environment variables, including `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, can be used without copying their values into Kiln's credential file. Saving a key does not prove that the provider accepts it. Status is local credential discovery, not a live connection test.

```sh
kiln auth logout openai
kiln auth logout all
```

Logout removes stored credentials; an environment variable can still provide access. Inside the TUI, `/auth` shows sources, `/login openai device` uses device authorization, `/login openai key` uses an API key, and `/logout openai` removes stored OpenAI credentials.

## 3. Work in the terminal

| Control | Result |
| --- | --- |
| Enter | Submit the prompt |
| Ctrl+O | Open the command palette |
| Ctrl+S | Change reasoning effort |
| Alt+T | Expand or collapse tool details |
| Esc | Pause the active step |
| Ctrl+C | Exit |

`NO_ANIMATION=1 kiln` keeps the welcome artwork static. Narrow terminals use a smaller layout. The conversation view stays stable after work begins.

The status area shows activity, cost, work type, model, effort and directory. A worker's route or a reviewer recommendation does not replace the main operator's model display. A failed switch is not presented as an applied route.

During a running turn, another message steers the current work. After the turn settles, another message continues the same operator session. Give concrete acceptance conditions: what should exist, how to check it, and which decisions require your input.

Kiln's [model instruction policy](model-instructions.md) keeps guidance specific to the task, reuses verified context, and avoids obligatory skills or repeated checks. It continues authorized work through the requested outcome; preparation alone does not authorize launching that workload. Your model and effort settings remain authoritative.

A scriptable equivalent is:

```sh
kiln task "Implement the CSV importer and check malformed input handling" --cwd . --budget 10 --wall-seconds 900
kiln task resume RUN_ID "Continue with the remaining checks"
kiln --run RUN_ID
```

Copy `RUN_ID` from the run output. `kiln task resume RUN_ID` without a message reports the retained session instead of dispatching more work. Resume uses its saved scope and allocations; it is not a new free budget. Use `--seed-file PATH` instead of inline task text when exact file contents should be the request. `--json` produces a structured final report for scripts.

Budget is an allocation, not an absolute invoice cap: an admitted in-flight request can finish after crossing its target. Paid provider work consumes API budget or subscription allowance. A resumed task preserves recorded spending. Do not describe an agent turn ending as proof that all acceptance conditions passed.

To keep working without an aggregate dollar or active-time allocation, run `kiln task limits --uncapped` for future native sessions, or `kiln task "Finish the task and its checks" --uncapped` for one new run. `null` allocations mean uncapped; usage accounting remains active. Restore finite defaults with `kiln task limits --budget 100 --wall-seconds 28800`. Existing runs retain their saved allocations. Provider, tool and concurrency limits still apply; legacy ideation batches retain finite planning targets. Work can stop for completion, a concrete blocker, cancellation or a detected loop.

`kiln task monitor RUN_ID --json` reads local accounting and repetition/context-growth diagnostics without a model call. Identical failures warn at three and pause at six; identical successful calls/results warn at four and pause at eight. Recognized polling only warns. Missing usage and limited fingerprint coverage stay visible; this monitor does not judge task quality. See [compute limits and monitoring](compute-limits.md) for policy, thresholds and coverage details. No model or selected `xhigh` effort is lowered.

## 4. Ask for parallel feature work

For independent features, describe the scope and required checks, for example:

> Implement import validation and the results panel in parallel. Give each worker disjoint files, define the interface first, and have the parent recheck both handoffs before integration.

Kiln's `team` tool records the plan; native `task` starts workers. In the current pinned native runtime 18.4.4, agents send peer messages through `write` to `agent://<id>`. Results and messages arrive automatically; `wait` is available when blocked on an owned job or message. The removed `hub` tool is not part of this runtime. The parent defines each feature's objective, literal relative file or directory scopes, dependencies and acceptance criteria. Workers obtain a current revision, claim a ready feature, work in their assigned scope and return artifact hashes plus check reports. Mutations return compact receipts with the changed features, revision and committed ledger hash; reuse that revision, and query for other features/history or after a revision conflict. Stale revisions, overlapping active scopes and unmet dependencies are rejected.

Only the real parent operator can plan, accept or reopen features. Handoffs remain unverified claims until parent review. Acceptance records the parent's assessment and checks artifact identity; it does not independently prove a command ran. A failed feature can be reopened with a reason, preserving the old handoff history. Dependency artifacts are checked before downstream claims and acceptance.

Ask the operator to call `team` with `action: "review_packet"` and the feature `id` to see every stable acceptance-criterion ID, worker-declared artifact/check mappings and current artifact identity. Workers can include `coverage` in handoffs, mapping each `criterionId` to exact artifacts and zero-based `checkIndices`. Unmapped requirements remain visible. This is deterministic organization with no Jev call; check text remains an unverified claim and the parent must still review completeness and run appropriate checks.

A synthetic 32-feature claim response fell from 17,270 to 997 UTF-8 bytes with compact receipts; this is not a measured token or billing reduction. Full query and review-packet access remain available. The ledger is `team.json` in the run directory. It coordinates collaborators but does not sandbox their tools. The parent remains responsible for integration checks and the original requirements.

## 5. Models, effort and idea search

Model choice and reasoning effort are separate. Roles describe jobs; effort controls how an eligible model reasons. Inspect the actual configuration and routing evidence:

```sh
kiln model roles --json
kiln model routing
kiln model plan "Build a tested data import tool" --json
kiln model benchmarks show --json
kiln mode show
kiln mode set high
kiln mode set auto
```

`kiln model routing adaptive` enables adaptive planning; `manual` keeps configured role routing. Fresh homes use adaptive defaults; existing choices are preserved. `mode set auto` restores role effort defaults. The TUI label `ultra` maps to stored `xhigh`; it is not a different model. Effort changes during work apply at the next turn.

Adaptive routing filters candidates through configured access and compatibility, then uses the available role evidence. A benchmark snapshot has a source and date; it is not live proof that a model is best for your task. Fresh default Codex role candidates now include GPT-6 Astra for critic/judge and GPT-5.5 as a retrieval/probe/arbiter fallback when the smaller model is absent. A compatible fallback can cost more, so inspect `kiln model roles --json` and keep an appropriate run budget. Explicit pinned choices are not silently replaced when unavailable. An explicit benchmark import requires a reviewed snapshot and does not independently verify its claims.

For an open-ended question, the operator can call `ideate`: research, distinct candidate generation, prior-art assessment, assigned probes and order-swapped pairwise comparisons produce inspectable artifacts and evidence gaps. It is more than a prose brainstorming prompt, but its output is still not experimental validation. Inadequate research stays unknown. A simple implementation task need not run competitive ideation.

## 6. Explicit workflow runs

Use `task` for the persistent operator. Use `run new` when you want the explicit phase workflow and checkpoint controls:

```sh
kiln run new "Explore ways to compare household energy use" --through checkpoint
kiln ideas frontier RUN_ID --json
kiln ideas pick RUN_ID IDEA_ID
kiln project form RUN_ID
kiln project build RUN_ID --yes
kiln run resume RUN_ID --through reflect
```

The phases are frame, discover, ideate, checkpoint, form, build and reflect. The adaptive route can omit unnecessary research or competitive ideation. `--through` controls this invocation. Opening an existing phase run in the TUI preserves that workflow rather than converting it to an operator session.

```sh
kiln run list
kiln run show RUN_ID
kiln run record RUN_ID
kiln project status RUN_ID --json
kiln project audit RUN_ID --json
kiln build pause RUN_ID
```

After a transient discovery outage, inspect the diagnostic and use `kiln run resume RUN_ID` when connectivity returns. Do not bypass integrity failures: inspect changed artifacts before considering explicit `kiln project relock RUN_ID --confirm`. See [detailed lifecycle and recovery](usage.md).

## 7. Optional integrations

**Jev:** configure a key with the masked `kiln auth key jev` prompt (stored as `typesafe`), or supply `TYPESAFE_API_KEY` through your secret manager. With a key, new operator runs can classify ambiguous work transitions through `route_step auto`. Ordinary prompts keep their current role without a routing request. Explicit roles bypass Jev. Old Jev runs retain their saved per-prompt behavior on resume; changing mode requires a new run. `KILN_JEV_ENABLED=0 kiln` disables external classification. No key means local routing.
```sh
kiln model suggest "Implement and test the parser" --step implement --json
kiln model suggest "Compare candidate approaches" --step synthesize --jev --json
```

The first is local; the second explicitly calls Jev. Neither dispatches the main model or changes a live session.

### Experimental browser and research workflows

Save the workflow policy and inspect offline readiness:

```sh
kiln auth key jev
kiln integrations jev enable
kiln integrations jev status --json
kiln doctor --require jev --json
kiln
```

`enable`/`disable` persist the policy for new sessions without contacting TypeSafe. Existing sessions retain their saved policy. `KILN_JEV_WORKFLOWS=1` is an invocation override; `KILN_JEV_WORKFLOWS=0` removes workflow tools even on resume, while `KILN_JEV_ENABLED=0` disables Jev decisions. Neither override erases saved policy.

Ask the operator to use `browser_task` on its existing owned tab. For example: “Use the existing search tab, fill the field labeled Search with kiln, click Search, and check that the results contain kiln.” The operator calls the tool directly outside `eval`, supplying exact allowed action labels, literal field values and fresh checks. Supported actions are click, fill, select, scroll and wait. It runs at most eight decisions over 30 seconds, returning when done, unsupported, stale, ambiguous or interrupted. It does not open a second browser. Uncertain inputs are not automatically repeated. A stale target can be reobserved within the same limits only when the executor proves no input occurred; completion checks and their observation are captured together. Already-satisfied literal fills are omitted from fresh actions, and code confirms satisfied primitive checks without requiring another model verdict.

A browser receipt marked `verified` means its specified URL/text/field checks passed; it still reports `taskQualityValidated: false`. Review whether the checks establish your actual objective. Authentication, recognized consequential controls and unsupported page structures need native handling.

For research, ask for named evidence fields and explicit source hosts: “Use research_task to collect the context limit and pricing from https://docs.typesafe.ai/models, allowing docs.typesafe.ai; show the captured passages and unresolved fields.” The tool can search/fetch allowed HTTPS sources and return captured artifacts, citation locations, hashes, contradictions and unknowns. Labels are not verified facts. Defaults are six sources, three concurrent fetches and a 30-second deadline. Up to three independent source-classification batches run concurrently without adding requests; unresolved opposing classification answers remain unknown with citations retained. Dynamic pages that fail to fetch remain gaps; browser work is a separate tool call, not an automatic fallback.

The two tools share a maximum of four active workflows. Finite-policy new runs default to 64 Jev requests and one million input-token exposure per run; new runs with both aggregate allocations uncapped default to uncapped aggregate Jev allowances. Explicit and saved allowances remain authoritative, and per-call limits and cancellation still apply. Each request conservatively reserves 64,000 input tokens; unknown usage retains that exposure. `KILN_JEV_WORKFLOWS=0` removes these tools for the current invocation, including resume; it does not erase an enabled saved policy. Removing the override later can restore that policy. `KILN_JEV_ENABLED=0` disables Jev decisions without removing workflow tools. Old runs do not gain workflows merely by resuming with the enable flag. Identical decisions can share a request or an accepted in-memory result without another charge; usage survives resume, cached answers do not.

Kiln now vendors the pinned jev-ultrafast snapshot and adapts its operation/target decisions to the native browser. It does not run the separate Python agent or launch another Chrome process. Supported browser observations and research passages are sent to TypeSafe for classification. These workflows remain experimental. A [live qualification](testing/2026-09-28-jev-live-qualification.md) passed three synthetic fixtures using nine provider requests; it demonstrated batching and request reuse. A subsequent native form fixture completed in two Jev decisions after five incomplete calibration attempts. These are development checks, not representative accuracy or a frontier-model speedup. See [optional integrations](optional-integrations.md) for exact bounds and data handling.

**Hindsight:** supply an existing server and project bank. Kiln does not provision them, retain conversations automatically or insert recalled material into arbitrary sessions.

```sh
kiln memory status --url http://127.0.0.1:8888 --bank example-project
kiln memory retain --file ./verified-project-notes.md --url http://127.0.0.1:8888 --bank example-project
kiln memory recall "Which checks caught regressions?" --url http://127.0.0.1:8888 --bank example-project --max-tokens 2048
```

Only run `retain` with the curated file you intend to send. `status` is offline. Recall returns untrusted JSON with provenance; review it against current artifacts. `KILN_HINDSIGHT_URL` and `KILN_HINDSIGHT_BANK` replace flags; use the masked `kiln auth key hindsight` prompt or `HINDSIGHT_API_KEY` for authentication. Nonempty environment keys take precedence over stored keys; integration keys stay in credential storage, not config or run metadata. Full bounds and examples are in [optional integrations](optional-integrations.md).

`kiln doctor --json` checks local dependencies, configured model compatibility and credentials without provider, DNS or service calls. Optional-service gaps are warnings by default; `kiln doctor --require jev,hindsight --json` makes those configuration gaps blockers. A ready result is not live authentication, quota, service health or challenge completion. Hindsight endpoint and bank remain explicit flags/environment settings; saving a key provisions neither.

## 8. Keep the installation current

```sh
kiln model catalog status --json
kiln model catalog check --json
kiln model catalog check --snapshot models.json --json
bun scripts/frontier-update.ts --check
```

Catalog status inspects installed metadata. Catalog check fetches public upstream metadata unless given a local snapshot. The frontier script's `--check` inspects published native package versions without installing an update. Run that script from the Kiln checkout. None of these commands changes roles or proves current account availability. A local snapshot is explicitly not proof of upstream freshness.

The [six-hour frontier-update workflow](frontier-updates.md) prepares validated, exact-pin dependency changes as draft pull requests for review. It is not operational merely because its files exist: it must be merged and enabled in GitHub Actions. It does not auto-merge or hot-swap running sessions. Patches, type checking, tests, evaluation verification and leak checks must survive the proposed update. Review before merging, and restart using the validated installation. See [catalog maintenance](model-catalog-updates.md).

New operator runs fingerprint their admitted model definitions and selected role references. Resume rejects changed model API, cost, tool, token, reasoning or selection metadata before dispatch. Restore the original dependencies or start a reviewed new run. Older runs without a fingerprint establish their baseline on first resume; the fingerprint detects drift but cannot reconstruct old definitions.

## 9. What is verified and what remains your responsibility

The current toolkit is detailed in [architecture and integrations](architecture-and-integrations.md). Shell and file tools run locally without a host sandbox. Authorize the actual task and external actions you intend; tool availability is not permission to publish, contact others or spend outside that task. Use an appropriate isolated environment for untrusted work.

Provider-free checks can be run with:

```sh
bun test
bun run typecheck
kiln evals verify --home /path/to/kiln-home --json
kiln evals leakcheck --home /path/to/kiln-home --json
```

These establish software behavior within their tested boundaries. They do not establish live provider access, biological validity, improved model quality, or reduced end-to-end cost. Paid evaluations require an explicit budget; comparative performance remains unqualified until representative live experiments are completed and reviewed.
