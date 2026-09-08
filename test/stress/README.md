# Kiln stress matrix

Run the deterministic provider-free matrix from the repository root:

```sh
bun run scripts/stress-kiln.ts all
bun test test/stress
```

The script drives Kiln's production CLI, phases, tools, run journal, filesystem,
Git, acceptance checks, pause/resume, and failure classification. Model streams
and network responses are fixtures, so it never reads credentials or makes paid
provider calls. Standalone runs leave their temporary root in the JSON report
for inspection; the Bun tests remove their own temporary roots.

Each fixture is bounded and deterministic. The matrix checks observable
invariants rather than requiring every task to use one workflow: open-ended
research and business prompts exercise ideation, while a concrete CLI delivery
must skip unnecessary search and competitive ideation but retain formation,
independent review, executable acceptance, Git cleanliness, and reflection.
