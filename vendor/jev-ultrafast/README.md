# Pinned upstream browser snapshot

`snapshot.js` is unmodified from browser-use/jev-ultrafast commit
`1231850a0bf1a0c0341fe408ef1668dbbfdfac46`:
https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/snapshot.js

SHA-256: `e50473501c8fb8e70f3b21866d987393e3f2315c639d638bd477d170e81ed78d`.
MIT license included. Kiln wraps this snapshot with a per-workflow cache namespace,
capability checks, bounds and native tab ownership. Its controller and dynamic
operation/target question construction adapt the upstream agent.py/model.py
rules from that same commit; the Python Agent itself is not embedded because it
constructs its own Browser Harness session.
