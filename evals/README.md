# Evaluation seed rubric

Each seed is a plain-text brief used verbatim by the ideation harness. A conforming seed:

- contains two to six sentences and 200 to 900 characters;
- explicitly declares exactly one shape: research, product, or creative;
- identifies a concrete domain or problem and at least one material constraint;
- contains no URL, backticked identifier, or named product, paper, or repository that could be copied; and
- leaves its non-triviality rationale in split.json rather than arguing for its own difficulty.

The corpus contains twelve development seeds and twelve held-out seeds, with exactly four seeds of each shape in each split. IDs and file locations must agree with split.json, and every recorded digest is the SHA-256 hash of the exact file bytes.

The seed auditor also checks the judgement half of the rubric: the brief must require meaningful synthesis or trade-off reasoning, must not reduce to a lookup or a cosmetic rewrite, must not point at a named artifact to imitate, and must describe only one shape. Subjects should be diverse, specific, and safe enough to explore without specialized operational safeguards.
