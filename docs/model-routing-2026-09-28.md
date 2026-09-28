# Model routing review — September 28, 2026

All six categories were rechecked against current primary sources and published together in [the reviewed snapshot](../src/routing/evidence-2026-09-28.json). New general and business plans now select Opus 5.5 for planning and generation when Anthropic is connected. This replaces the September 9 ranking data; it does not rewrite saved runs.

## Comparison settings and results

This review prefers **xhigh** variants to match the current operator configuration. The model catalog supports that setting for the selected models. Gemini references use high; the retained Terminal-Bench Sol 5.6 reference uses max because no official xhigh row was found. Both exceptions are labeled in the data. Configured effort remains authoritative, and plans disclose any mismatch with the benchmark effort. Scores at max are never assigned to xhigh rows.

| Category | Leading reviewed xhigh result | Routing consequence |
| --- | --- | --- |
| General reasoning | Opus 5.5: 56; Fable 5.1: 53; Astra: 52 | Opus 5.5 planning and generation for general work |
| Expert knowledge | Fable 5.1: 58.7118%; Opus 5.5: 57.5070%; Astra: 54.5876% | Fable remains the science planning and generation prior |
| Business | Opus 5.5: 1780 Elo; Sonnet 5.5: 1746; Fable 5.1: 1669 | Opus 5.5 planning and generation for business work |
| Scientific coding | Opus 5.5: 65.0463%; Fable 5.1: 60.8796% | Opus 5.5 probing and independent audit of Astra builds |
| Tool execution | Astra/Codex and Fable/Claude Code: 57.88% each | Astra remains first by deterministic evidence order; the report now states the tie |
| Knowledge calibration | Astra: 43.4167; Opus 5.5: 42.65; Fable 5.1: 42.3833 | Astra for independent review of Anthropic producers and reflection |

Sources: [AA Intelligence Index v4.3.2](https://artificialanalysis.ai/leaderboards/models), [AA HLE](https://artificialanalysis.ai/evaluations/humanitys-last-exam), [AA-Briefcase v1.1](https://artificialanalysis.ai/evaluations/aa-briefcase), [AA SciCode](https://artificialanalysis.ai/evaluations/scicode), [official Terminal-Bench 4.0](https://www.tbench.ai/), and [AA-Omniscience](https://artificialanalysis.ai/evaluations/omniscience). Exact scores and individual model-page citations are in the snapshot.

The table describes point estimates within the reviewed model shortlist, not universal winners or statistically established differences. The Intelligence Index is rounded and includes several of the other evaluations; these are correlated signals, not six independent validations. Anthropic fallback-qualified variants retain that condition. AA results do not directly measure Kiln or the Codex subscription transport.

HLE uses 2,158 text-only questions, not the full multimodal set. SciCode v1.0.1 uses 288 subproblems, three repeats, supplied scientific background, and execution checks. Briefcase uses 91 independently run tasks across four scenarios. Omniscience is a 6,000-question abstention-aware knowledge proxy; it does not validate a model as a judge. See [AA methodology](https://artificialanalysis.ai/methodology/intelligence-benchmarking).

Terminal-Bench measures model and harness together. The xhigh Astra and Fable results have overlapping 95% intervals (±2.72 and ±3.36 percentage points respectively). Its official rows do not include Opus 5.5, Sonnet 5.5, or GPT-6 Sol at this observation. AA's separate terminal evaluation is not substituted for those missing native-harness results. The old `/leaderboard/terminal-bench/4.0` URL redirects to the current homepage.

Effort changes the comparison: Opus 5.5 **max** scores 58 on the overall index, 61.3531% on HLE, 66.8981% on SciCode, and 46.4167 on Omniscience. Those are distinct from the xhigh results used here. The refresh does not raise the user's effort or budgets to obtain those scores.

## What runs now

With Anthropic and OpenAI Codex connected, general and business plans use Opus 5.5 for brain, generator, prober, and auditor; Astra for builder, scout, judge, critic, arbiter, and reflector. Generic science plans retain Fable for brain and generator, with Opus 5.5 probing and auditing. The existing computational-biology preference still selects Astra for producing roles, with Opus 5.5 reviewing; that preference is explicitly separate from benchmark leadership.

Sonnet 5.5 is recorded but excluded because the installed catalog lacks it. Codex Sol and Luna variants remain excluded without their own approved tool adapter. Rankings cannot bypass compatibility checks, provider access, or producer/reviewer separation. Account entitlement is not established by catalog presence.

## Applying and inspecting the refresh

The bundled snapshot serves new native operator plans and homes without an imported override. CLI workflow plans prefer a home-imported snapshot, so an existing override must also be refreshed:

```sh
kiln model benchmarks import ./src/routing/evidence-2026-09-28.json --reviewed
kiln model benchmarks show --json
kiln model plan "Develop an application" --json
kiln model suggest "Develop an application" --step synthesize --json
```

Import validates all six categories before an atomic write. Back up any previous home snapshot before replacing it. Restart Kiln and start a new session to use the new bundle; frozen sessions retain their original configuration and routing evidence. `model roles` shows configured fallback lists, while `model plan` and `model suggest` show the actual adaptive selection.

September 28 is the source observation date, not an invented evaluation date. The snapshot expires after 30 days. The six-hour dependency updater refreshes package compatibility and catalog metadata; it does **not** refresh benchmark scores. Future ranking changes still require a new primary-source review and snapshot import.

Tests cover all six current category leaders, tied-score disclosure, compatibility exclusions, independent reviewer identities, historical snapshot behavior, and frozen resumes. These checks verify selection mechanics; no new paid model-quality evaluation was performed for this ranking refresh.
