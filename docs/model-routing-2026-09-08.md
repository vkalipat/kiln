# Benchmark-informed model routing — 2026-09-08

The active local configuration uses Claude Fable 5.1 for ideation and GPT-6 Astra for tool work and independent review. The reusable role overlay is [the dated profile](../profiles/benchmark-leaders-2026-09-08.json); it is not an automatically loaded configuration or a change to fresh-install defaults.

| Roles | Primary model | Evidence informing the choice |
| --- | --- | --- |
| Brain, generator | Claude Fable 5.1 | Overall reasoning, expert knowledge, business work |
| Prober | Claude Fable 5.1 | Scientific coding |
| Builder | GPT-6 Astra | Terminal task execution |
| Scout, judge, critic, arbiter, reflector | GPT-6 Astra | Knowledge calibration; independent review of Fable output |
| Auditor | Claude Fable 5.1 | Independent review of Astra builds |

## Benchmark evidence

Rankings were inspected through the browser on September 8, 2026. These are provider/benchmark results, not evaluations run in Kiln.

- [Artificial Analysis overall index](https://artificialanalysis.ai/leaderboards/models): Fable 5.1 max with fallback displayed 54 with an asterisk; Fable xhigh and Astra max/xhigh displayed 53. Rounded ties do not establish superiority.
- [Humanity's Last Exam](https://artificialanalysis.ai/evaluations/humanitys-last-exam): Fable 5.1 max 59.1%, xhigh 58.7%; Astra max 54.7%, xhigh 54.6%.
- [SciCode](https://artificialanalysis.ai/evaluations/scicode): Fable 5.1 max 63.1%, xhigh 60.9%.
- [AA-Briefcase](https://artificialanalysis.ai/evaluations/aa-briefcase): Fable 5.1 max 1662 Elo, xhigh 1650; Astra max 1562.
- [Terminal-Bench 4.0](https://www.tbench.ai/leaderboard/terminal-bench/4.0): Astra max with Codex 58.2% ±2.8%, Fable max with Claude Code 57.9% ±3.8%. These measure model-plus-harness combinations, and uncertainty intervals overlap.
- [AA-Omniscience](https://artificialanalysis.ai/evaluations/omniscience): Astra high led the calibration-aware index at 44; Fable max and Astra xhigh scored 43. Fable max led raw accuracy at 67%. The index penalizes incorrect guesses and allows abstention; raw accuracy is not a hallucination measure.
- [Official OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model) confirms the `gpt-6-astra` identifier and tool-oriented capabilities.

Mapping benchmarks to Kiln roles is an engineering inference. None directly measures Kiln ideation quality, reviewer reliability, or biomedical validity. The user's Ultra (`xhigh`) setting is preserved, not silently promoted to `max`. Benchmark effort, fallback behavior, tools, and harnesses are not reproduced exactly.

## Hallucination controls

The kernel now requires separating sourced facts, inferences, and hypotheses; inspecting sources behind consequential claims; preserving conflicting or missing evidence; and recording what still needs validation. Search snippets and model agreement are not proof. Reviewers without browsing tools must flag missing evidence rather than claim independent verification.

Generator and prober lists stay on Anthropic so ideation islands do not use the Astra judge as their generator. Astra critiques Fable's proposals; Fable audits Astra's builds. Existing strict decision-tool gates remain enabled. The existing producer-only Opus fallback policy is preserved. These controls reduce opportunities for unsupported claims; they do not eliminate hallucinations or constitute measured reliability gains.

This profile requires Anthropic access for ideation. All three islands use Fable with different lenses; the configured cheap island is no longer cheaper or model-diverse. Role-list alternatives are catalog/provider-selection fallbacks, not automatic retries after a model request fails.

## Local application and verification

- Updated the four direct pi packages together to 18.1.14 so the installed catalog recognizes Astra. Type checking and the full offline suite passed: 1,400 tests. No paid provider calls were made, and account-level model entitlement remains untested.
- Applied role lists to `~/.kiln/config.json` and its `seating.default` mirror. The separate experimental frontier seating is unchanged. Connected-provider metadata shows Anthropic and OpenAI Codex; credentials were not copied or displayed.
- Preserved the $25 total planning target, effort settings, turn limits, and per-unit build caps. Shifted phase shares from ideate 42% / build 47.5% to ideate 50% / build 39.5%, leaving other shares unchanged. Shares affect both phase dollar and wall-time allocations; the overall wall-time setting is unchanged.
- At current catalog prices and the planner's assumed token counts, one ideation round projects to $11.46. Its former $10.50 allocation would fail the startup floor; the new allocation is $12.50. These are estimates, not observed spend or a hard ceiling. Less build allocation can mean fewer completed features.
- This funds one full projected round (30 generated candidates), not all three configured rounds. Later rounds require actual spending substantially below projection. Under current build assumptions, the derived maximum feature count drops from seven to six despite preserving the stored maximum and per-unit caps.
- Backed up the prior local config and kernel under `~/.kiln/evolution/work/config-backups/benchmarks-20260908T072341/`. Unrelated local fields were preserved. Restart Kiln after the current run to load the updated dependencies and routing.

The profile contains only role lists. Applying it elsewhere requires merging into both `roles` and `seating.default`, checking provider access, and checking that the local ideation allocation covers the projected round. It does not import credentials or change budgets by itself.
