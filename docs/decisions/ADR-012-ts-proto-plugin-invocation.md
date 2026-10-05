# ADR-012 — Invoke the ts-proto plugin through `node`, not the `.bin` shim

- **Status:** Accepted
- **Date:** 2026-10-05
- **Milestone:** M0
- **Type:** **Deviation from ARCHITECTURE.md**

## Context

Section 2 gives `buf.gen.yaml` with `local: node_modules/.bin/protoc-gen-ts_proto`.
`node_modules/.bin/protoc-gen-ts_proto` is a POSIX shell shim on Linux and macOS. On
Windows, npm writes `protoc-gen-ts_proto.cmd`. buf finds it, but `cmd.exe` parses the
forward-slash path `node_modules/.bin/...` as a command followed by a `/.bin` switch
and fails with `'node_modules' is not recognized`. The development machine is Windows,
so `npm run proto:gen` (and so `npm run build`) cannot work with the verbatim line.

## Decision

Use buf v2's list form of `local`, which runs a program with arguments:

```yaml
- local: ['node', 'node_modules/ts-proto/protoc-gen-ts_proto']
```

This is the same file the `.bin` shim points at (`ts-proto`'s `bin` entry), run by the
same interpreter. The `out` path and every `opt` are unchanged and verbatim.

## Consequences

- `buf generate` works identically on Windows, Linux (Docker build, CI) and macOS.
- Still pinned to the locally installed, exact-version `ts-proto`; nothing on `PATH` is
  consulted for the plugin.
- If `ts-proto` ever moves its bin file, generation fails loudly rather than silently
  picking up another version.

## Alternatives considered

- **`local: protoc-gen-ts_proto`** (resolved from `PATH`, which `npm run` and `npx`
  prefix with `node_modules/.bin`). Works, but a globally installed `ts-proto` could be
  picked up if buf is ever run outside npm. Rejected: less deterministic.
- **Backslash path.** Works on Windows only, breaks Docker and CI. Rejected.
- **Generate only inside Docker/WSL.** Makes the local `build`/`typecheck` loop depend
  on a container. Rejected.
