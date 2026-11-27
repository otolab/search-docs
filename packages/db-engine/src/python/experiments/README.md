# Embedding lifecycle experiments

This directory is an unpublished quarantine for Issue #168 work. Nothing here
is part of the supported CLI runtime or the `@search-docs/db-engine` tarball.
Keep it excluded by `src/python/.npmignore` until the relevant implementation
has passed independent review and is deliberately moved into the product path.
This PR only verifies the Linux prototype in CI; it does not productize it.

## Linux supervisor experiment

If the Linux managed-daemon work is approved for productization, its current
runtime dependency slice is:

- `embedding_linux_pidfd.py` for PIDFD references and listener ownership checks.
- `embedding_control_lock.py` for lifecycle and generation-state locking.
- `embedding_supervisor_state.py` for generation publication, validation, and
  recovery.
- `managed_supervisor_prototype.py` for the Linux-only supervisor, control
  endpoints, normal stop, and force interruption.
- A reviewed Node CLI adapter. The current
  `packages/cli/scripts/issue168-experimental-supervisor-cli.py` is a test
  driver and must not become the supported CLI entry point.

This list is a proposed extraction boundary, not an approval to publish or
connect the prototype. Environment parsing and fault-injection behavior live
under `src/python/tests/`; the runtime has only an optional callback seam, which
is unset in normal invocation and is not exposed through the supervisor CLI.
The pidfd helper here is only a prototype dependency; this PR does not add or
change the supported explicit-`--port` stop path.
Review that seam before any module leaves this directory. Startup force is not
part of the current requirement: force before readiness remains deferred. The
supported explicit-`--port` route is distinct because it observes and pins the
listener that currently owns the requested port.

## Tests and release boundary

- `tests/test_embedding_supervisor_prototype_stdlib.py` covers Linux
  supervisor state and process behavior using standard-library fixtures. It
  skips outside Linux with pidfd support.
- `tests/embedding_supervisor_faults.py` contains the environment-driven fault
  injection and barriers; `tests/embedding_supervisor_test_launcher.py` is the
  only entry point that installs them.
- `packages/cli/scripts/test-embedding-supervisor-prototype-cli.py` exercises
  only the experimental CLI against the supervisor and a prepared Python
  runtime. In the private-namespace container, CI runs both this driver and the
  suite with the already-synchronized
  `packages/db-engine/.venv/bin/python` mounted read-only. It invokes that
  interpreter directly; `uv run` is not used inside the container and no
  dependencies are fetched there. The separate host-negative preflight uses
  `uv run --project packages/db-engine --offline --no-sync` to call this
  prototype's procfs verifier.

The container commands, from the repository root, are:

```sh
packages/db-engine/.venv/bin/python -m unittest discover \
  -s packages/db-engine/src/python/tests \
  -t packages/db-engine/src/python/tests \
  -p test_embedding_supervisor_prototype_stdlib.py -v
packages/db-engine/.venv/bin/python \
  packages/cli/scripts/test-embedding-supervisor-prototype-cli.py
```

The package boundary is checked in CI: db-engine excludes `experiments/` and
`tests/`, including `embedding_linux_pidfd.py`, while the CLI package ships
`dist` only. CI inspects both packed artifacts and verifies that supported
source paths do not import the prototype. Any future product PR must name its
exact added runtime files, keep test drivers and fault-injection fixtures out
of both tarballs, and verify the packed artifacts. macOS and Windows
managed-supervisor lifecycle behavior is not implemented or validated by this
Linux experiment.
