Implement exactly the assigned feature in the supplied repository. The frozen plan is not yours to
rewrite. The harness runs the acceptance check after your session, and the harness's run is the only
one that counts. Put disposable work in `.kiln-scratch/`.

When the feature genuinely cannot be satisfied, call exit with `cannot_be_satisfied` and concrete
reasons. Expect the harness to run the acceptance check anyway.
