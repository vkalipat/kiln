# Frontier dependency updates

Kiln can discover new native harness releases automatically and prepare a tested draft pull request. It does not silently change a running harness or automatically merge dependency updates. The automation is source code in this checkout; scheduling starts only after the workflow is merged to the repository's default branch, Actions is enabled, and repository policy allows GitHub Actions to create pull requests.

## Scheduling and manual checks

[The workflow](../.github/workflows/frontier-update.yml) polls at minute 17 every six hours in UTC and supports **Run workflow** on the default branch. GitHub scheduling can be delayed; this is a recurring poll, not an immediate release webhook or an availability guarantee. Manual dispatches from other branches are skipped. Runs are serialized.

For a local, read-only check:

```sh
bun scripts/frontier-update.ts
# Equivalent:
bun scripts/frontier-update.ts --check
```

This fetches only public package metadata from the official npm registry. It does not install packages, edit the checkout, change provider credentials, call a model, push a branch, or create a pull request. The result includes the current pin, the newest common stable version, and whether an update exists. It rejects loose ranges, `latest` aliases, mismatched installed package versions, downgrades, deprecated candidates, and candidates without official tarball URLs and SHA-512 integrity metadata. Each of the six requests has a 15-second timeout and an 8 MiB response cap; redirects are disabled. Raw metadata and raw network errors are never printed.

The six packages move together: `pi-agent-core`, `pi-ai`, `pi-catalog`, `pi-coding-agent`, `pi-tui`, and `pi-utils` under `@oh-my-pi`. The newest stable version present in all six registry histories is selected numerically. Partial upstream publishing waits for the complete release. Other direct dependencies are preserved.

The mutating command is intentionally restricted:

```sh
bun scripts/frontier-update.ts --apply --artifacts "$RUNNER_TEMP/frontier-update"
```

It requires `GITHUB_ACTIONS=true`, `KILN_FRONTIER_DISPOSABLE=1`, a clean checkout, and an `automation/frontier-*` branch. Artifacts must live outside that checkout. The workflow prepares this disposable branch; do not run this mode in your working project. A version already installed is a no-op. Failure leaves a disposable checkout for diagnosis, never an automatically published partial change.

## Verification and publication boundary

The read-only job updates exact pins and runs these gates in order:

1. `bun install --ignore-scripts --registry https://registry.npmjs.org`.
2. Verify the reviewed callback hook is present exactly once in source, declaration, and callback-server files.
3. `bun run typecheck` and the complete `bun test` suite.
4. `bun bin/kiln.ts evals verify --home . --json`.
5. `bun bin/kiln.ts evals leakcheck --home . --json`.

No install lifecycle scripts are permitted. A dependency requiring a new install script, a changed evaluator manifest, a compiler error, or a test failure stops the update for review. The automation never regenerates evaluation-manifest hashes to hide drift.

After these gates, the workflow captures `kiln model catalog check --json` with the update artifact. This is an advisory metadata audit, not an admission decision: an exit code of zero can include blocked model findings. It does not establish provider access, tool reliability, benchmark performance, or availability. See [catalog checks](model-catalog-updates.md).

The artifact contains only `package.json`, `bun.lock`, a verification receipt, and the catalog audit. A separate fresh job receives repository write permission. That job checks out the trusted base commit, installs no dependencies, and runs no upgraded code. Its script validates artifact names, file sizes, hashes, the pinned base SHA, the exact allowed package delta, and the unchanged reviewed patch. The only published changes are `package.json` and `bun.lock`.

Only then does `gh` create a draft PR on `automation/frontier-VERSION`. An existing open PR is left alone. An existing branch without an open PR stops the job rather than being reset or force-pushed. No auto-merge is configured. The repository setting **Allow GitHub Actions to create and approve pull requests** must permit creation; this workflow never requests approval or merges its own PR. If publication fails after the push, inspect the retained branch and open the draft manually, or remove that bot branch deliberately before retrying.

Upgraded dependencies execute only in the first job with read-only repository permission and no model-provider credentials. No `pull_request_target` trigger or arbitrary checkout input is used. A dependency update is still third-party code: the draft and its lockfile require human review. A receipt records successful CI commands; it is not a supply-chain attestation. Actions-created commits may not trigger downstream workflows through `GITHUB_TOKEN`; the update job itself runs all listed gates.

## OAuth patch compatibility

The reviewed patch `patches/@oh-my-pi%2Fpi-ai@18.1.14.patch` remains byte-for-byte unchanged. The updater changes its `patchedDependencies` key to the new exact native version while retaining that original patch path. A pinned SHA-256 in the updater identifies the reviewed baseline. Bun applies the same patch during installation; its added hook bodies are checked afterward.

The optional receipt-page hook receives only a safe status, never authorization codes, state, credentials, or raw provider errors. This property must survive upgrades. If upstream changes the relevant files, incorporates a similar hook, or rejects the patch, the updater fails closed. It never guesses that a similarly named upstream hook is compatible and never skips, weakens, rewrites, or double-applies the patch automatically. A maintainer must review the upstream implementation, test the callback boundary, and deliberately update the patch and reviewed digest if needed.

After a merge, install the updated locked dependencies and restart Kiln to use them. Active sessions are not upgraded in place. Resume checks may reject a saved session when installed catalog or runtime identity differs; follow that diagnostic and retain the original run instead of bypassing its evidence checks.

Implementation: [updater](../scripts/frontier-update.ts), [offline boundary tests](../test/scripts/frontier-update.test.ts). Patch behavior follows [Bun's patch mechanism](https://bun.sh/docs/pm/cli/patch); job permissions follow [GitHub's token guidance](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token).
