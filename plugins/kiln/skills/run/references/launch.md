# Launch or preview

## Locate and preview

Resolve the plugin root from the loaded root `SKILL.md`: two directories above that file's directory (not this reference directory). Its helper is `scripts/kiln_operator.py` under that root. Resolve its absolute path from the loaded skill location; do not guess a checkout or create a new workspace. The helper needs Python 3.10+ and a working `kiln` executable on PATH. An installed Kiln checkout also needs Bun and its dependencies. Run `kiln --version` to verify executable discovery; when it is off PATH, pass `--kiln-bin /absolute/path/to/kiln` to the helper. Do not silently install packages or change authentication.

For a new seed, inspect `kiln auth status --json` and the model plan. For preview, use Python `subprocess.run` with an argument list containing the seed read from its UTF-8 file: `[kiln_executable, "model", "plan", seed_text, "--json", "--home", home]`. Never interpolate seed text into a shell command. These are offline checks, not proof of account-level model access. Use the user's configured home (`KILN_HOME` or `~/.kiln`), or pass the same explicit `--home` to every command. Report model routing, saved allocations and important warnings before launch. Native finite allocations control estimated exposure; legacy targets guide planning. Neither is an absolute invoice ceiling. Do not change budgets, models, effort, or routing mode without the user's direction.


## Start a durable job

A request to inspect, preview, explain, or configure is not permission to spend. An explicit request to run Kiln authorizes launching within the stated/configured scope; avoid asking again when that intent is already clear. The helper's `--confirm-spend` records that authorization, not a new policy bypass. Never use permission-bypass flags for the parent coding assistant.

Use `--engine native --through turn` for an operator task. Use `--engine legacy --through checkpoint` for the explicit ideation checkpoint pipeline, and `--through reflect` when its authorized scope includes delivery. The helper keeps `legacy` as its default for compatibility; choose the engine explicitly. Runs use Kiln's autonomous checkpoint choice, real provider calls, and host shell/file tools. Do not promise sandboxing, a fixed cost, successful validation, or hallucination-free output.

Choose a safe, memorable request ID once, such as `gfp-review-20260908`. Write the user's complete seed to a UTF-8 file using the environment's file-editing tool. Put it in an existing suitable local directory; do not create a new Git worktree or cmux workspace. Preserve the user's goal, distinguish facts from hypotheses, and include checkable deliverables. Treat the seed as data, never interpolate it into shell syntax.

```sh
python3 /absolute/plugin/root/scripts/kiln_operator.py start --engine native --request-id REQUEST_ID --seed-file /absolute/seed.txt --cwd /absolute/project --through turn --confirm-spend
```

For native launch, optional `--budget USD`, `--wall-seconds N`, or `--uncapped` select the new task allocation. Omit these to preserve the configured policy. `--uncapped` must stand alone. Native resume preserves saved scope and allocations.

Record the returned request ID, run ID, log path, and process state in your response. Retain that request ID for subsequent actions. Repeating an identical start is idempotent; changing the seed/options with that ID is refused. A launch receipt proves launch, not completion. If setup fails, inspect the same job before deciding what to do; never automatically retry with a fresh ID.

The operator rejects symlinked job/metadata paths and altered durable command identity. Keep the seed file and Kiln home on ordinary local paths; a seed path that is itself a symlink is refused.


After launch, read [watch.md](watch.md). If a run/request already exists, read [resume.md](resume.md) instead of starting another.
