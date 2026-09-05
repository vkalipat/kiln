# Design records

Kiln is a local, inspectable harness: idea discovery and selection, project formation,
verified feature builds, and evaluation-gated prompt/playbook changes.

These records preserve the reasoning behind that design:

- [Original design and research inspirations](ideation-harness.md)
- [Formation and build decisions](formation-build.md)
- [Evaluation and evolution decisions](evals-evolution.md)

The original design is historical. Later decision records override its earlier
defaults and mechanisms; current source and tests define the implemented behavior.
Cost and quality projections in these documents are planning estimates, not results
from live-provider benchmarks.

Paths inside the preserved records describe the original authoring workspace:

| Original path | Included copy |
| --- | --- |
| `docs/superpowers/specs/2026-09-02-kiln-ideation-harness-design.md` | [ideation-harness.md](ideation-harness.md) |
| `docs/superpowers/specs/2026-09-04-kiln-formation-build-decisions.md` | [formation-build.md](formation-build.md) |
| `docs/superpowers/specs/2026-09-05-kiln-evals-evolution-decisions.md` | [evals-evolution.md](evals-evolution.md) |

Other references to `docs/research/`, implementation plans, `.superpowers/`,
`SPEC_*.md`, and `AGENTIC_HARNESS_PLAN.md` are historical research/coordination
artifacts, not dependencies of this repository. They are intentionally not included
in the standalone release. Public inspiration links are collected in the main README.
