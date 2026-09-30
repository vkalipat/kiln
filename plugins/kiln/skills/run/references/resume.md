# Pause or resume the same run

Resolve the helper from the root skill location as described in [launch.md](launch.md); keep the same Kiln home. Read [watch.md](watch.md) to interpret state and the requested endpoint.

## Pause and resume

```sh
python3 /absolute/plugin/root/scripts/kiln_operator.py pause --request-id REQUEST_ID
python3 /absolute/plugin/root/scripts/kiln_operator.py resume --request-id REQUEST_ID --confirm-spend
```

Pause uses Kiln's cooperative pause mechanism; distinguish a request from a completed pause. Resume uses the existing run, saved allocation and frozen routing. Apply the user’s existing authorization for further work; do not ask again when the authorized goal and scope already cover continuation. Ask only for genuinely missing authority. If the user explicitly requests delivery after ideation, resume with `--through reflect`; do not start another seed. Never use `--force`, remove locks, kill arbitrary PIDs, reset work, or raise targets to get past a refusal. Report the blocker and obtain any genuinely missing authority.

Pause and resume are mutually serialized. A temporary "another control operation" response means one is already being prepared; inspect the same request after that operation finishes. Lock ownership is released automatically if the helper process crashes, so never delete lock files manually.

For an existing CLI-created run with no operator request ID, inspect it using `kiln run show RUN_ID --json` and operate that same ID with Kiln's CLI. Do not create an operator job just to attach. Authentication stays in Kiln; never copy credentials into the plugin, seed, command line, or job metadata.
