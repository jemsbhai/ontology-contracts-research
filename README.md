# Erden

GitHub for ontologies: versioned, proof-checked company knowledge that AI agents can build on.

Open-source local tools for Erden: the `erden`/`den` CLI, registry client, contracts, local checking, package format, reasoner protocol, and both engines. Apache-2.0.

The local tools in this repository are Apache-2.0 (see [LICENSE](/LICENSE)). The hosted Erden registry is closed source and not part of this repository. Publishing, discovery, and the web UI are provided by the hosted service at [erden.sh](https://erden.sh). Self-hosting isn't offered. The name "Erden" is a trademark of cbnsndwch LLC (see [TRADEMARKS.md](/TRADEMARKS.md)).

## What is here

| Path                       | What it is                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `apps/cli/`                | the `erden` CLI: `init`, `check`, `transition`, `install`, `pack`, `publish`, `doctor` |
| `packages/client/`         | registry client: upload, download, reads                                               |
| `packages/contracts/`      | manifest, lockfile, check report and registry wire formats                             |
| `packages/project/`        | local project operations: check, install, pack, the package store                      |
| `packages/ontology/`       | local assembly, SHACL, competency questions                                            |
| `packages/package-format/` | the package archive format                                                             |
| `reasoner/`                | the reasoner's Rust source, qualification, protocol and resolver                       |
| `shacl/`                   | the `erden-shacl` engine's Rust source, qualification and resolver                     |

The engine binaries are never committed. A release ships them inside the CLI archive; a checkout builds them from
source.

## Installing

The first public release is being prepared. Until its archives are published, use the source build below.

Each release has one archive per platform: Linux x64 and arm64 (glibc), macOS arm64 and Windows x64. An archive
holds the `erden` CLI, the Node.js runtime it runs on, and both engines. Each release also has `install.sh`,
`install.ps1` and `SHA256SUMS`. An install script carries its release's archive digests and refuses any other
file. It installs for the current user, with no administrator rights, to `~/.local/share/erden/<version>/` with
`erden` and `den` linked into `~/.local/bin` (Windows: `%LOCALAPPDATA%\Programs\Erden\<version>\`).

```bash
curl -fsSLO https://github.com/cbnsndwch/erden/releases/latest/download/install.sh
sh install.sh
```

On Windows, download `install.ps1` from the same release and run `powershell -ExecutionPolicy Bypass -File install.ps1`.

### Installing without network access

1. On a connected machine, download the install script (`install.sh`, or `install.ps1` on Windows) and the archive for
   the offline machine's platform, both from the same release.
2. Carry both files to the offline machine.
3. Run `sh install.sh --archive erden-<version>-<platform>.tar.gz`. On Windows, run
   `powershell -ExecutionPolicy Bypass -File install.ps1 -Archive erden-<version>-win32-x64.zip`.

The script checks the archive's size and SHA-256 before it extracts anything, and makes no network request. The CLI
makes none either, except to a registry you configure. It also checks each engine binary against its pinned size and
SHA-256 before every use.

## Building from source

Node.js 24 (the exact version is in `.node-version`) and pnpm 10.15.0 (`packageManager`). The engines build in a
pinned Docker builder image on Linux, or with the Rust toolchain each engine's `rust-toolchain.toml` names on macOS and Windows, and
each build is installed only if it is byte-identical to its pin.

```bash
pnpm run bootstrap:workspace
pnpm run reasoner:build:linux   # the reasoner, built twice and compared
pnpm run build:shacl            # erden-shacl, checked against its pin
ERDEN_REASONER_BIN="$PWD/reasoner/source-build/x86_64-unknown-linux-gnu/erden-reasoner" pnpm test
```

These commands are for Linux x64. On Linux arm64, use `aarch64-unknown-linux-gnu` in the executable path.
On macOS arm64 and Windows x64, install the toolchain in `reasoner/rust-toolchain.toml`, build the reasoner
with `pnpm run reasoner:build`, then run `pnpm run build:shacl` and `pnpm test`. The CLI finds that native
reasoner in `reasoner/target/release/` without an environment override.

`pnpm test` runs the workspace gate: the repository guards, formatting, lint, typecheck, the package packs, a packed
CLI install, and every test.

The local `research/` archive contains immutable third-party inputs and recorded experiment outputs. It is excluded
from code formatting and linting so those checks cannot rewrite or reinterpret the retained evidence. Maintained
code and tests in `apps/`, `packages/`, `reasoner/`, `shacl/` and `scripts/` remain checked.

## Comparing checked projects

This checkout adds a prototype command for comparing a consumer's competency-question answers across two
installed project snapshots:

```bash
erden transition ./before-project ./after-project --policy preserve --json
```

Both snapshots run the ordinary checks first. The comparison then evaluates the **baseline project's root
questions** on both materialized graphs, even if the candidate changes or removes its own questions. The
projects must have the same canonical IRI and compatible reasoning configurations. The command reads the
projects and reports the comparison; it does not apply a dependency update.

Choose `preserve` for equal answer sets, `no-loss` to retain every baseline answer, or `no-gain` to permit no
new answers. JSON reports include typed added/removed bindings, the fixed queries, and source, dependency,
and toolchain identities. These policies use set semantics: duplicate rows and result ordering are ignored.

Only complete results in the supported SELECT/ASK fragment can satisfy a policy. Unsupported queries,
blank-node answers, or resource limits leave a query indeterminate. A known violation determines the suite's
outcome; otherwise every query must satisfy the policy. Failed semantic checks leave the comparison
indeterminate. Exit status is 0 for satisfied, 1 for violated or indeterminate, and 3 for operational errors.
Evaluation bounds apply to the added comparison stage; the ordinary checks run first with their existing behavior.

For structural queries, an exact-term route preserves typed literal spellings and datatype IRIs through the
query worker. It admits graph patterns, paths, OPTIONAL/UNION/MINUS/VALUES and identity filters (`sameTerm`,
`BOUND`), while refusing value-sensitive expressions on numeric input graphs. Reports distinguish original
graph/query identities from the internally encoded execution. This does not extend the native reasoner's
ontology profile or bypass ordinary validation.

See [the transition specification](research/erden-paper/extension-spec.txt) for boundaries and
[the reproducible system examples](research/erden-paper/system/README.md) for installed dependency updates.

## Stateful consumer transitions

The experimental `consumer` commands evaluate a declared Python application's original unittest classes across
explicit cache states. A consumer plan names complete source trees, exact test identities, interpretation resources
and ordered runs with empty, seeded or inherited caches. It has its own versioned lock and local capsule format;
ordinary ontology checks and their reasoning policies are unchanged.

```bash
erden consumer lock consumer.plan.json --output consumer.lock.json --json
erden consumer pack consumer.plan.json --lock consumer.lock.json --output consumer.capsule.json --json
erden consumer install consumer.capsule.json --output installed-consumer --json
erden consumer run consumer.plan.json --lock consumer.lock.json --output new-run --json
erden consumer verify consumer.plan.json --lock consumer.lock.json --report new-run/report.json --json
```

The runner supplies pinned HTTP resource bytes to the unchanged consumer through an explicit transport adapter.
It records observed cache reads and runs every declared original test. An `observe` arm can reproduce a stale cache
and retain its test failures; an `enforce` arm refuses a known wrong cached resource before executing tests. A
separate seeded arm makes an explicit repair control. Missing arms, missing or skipped tests, changed inputs and
inconsistent cache histories cannot produce a successful evaluation.

Evidence verification checks the declared coverage and byte bindings. A valid record can describe a failed
transition: `verify` does not turn failing consumer tests into passes. The runner and original oracle remain trusted.
The interpreter executable is pinned; observed Python module identities are recorded and checked, while the broader
OS and native runtime remain external. This is a local execution workflow, not OWL reasoning, an execution proof,
an OS sandbox, or registry publication. See the
[consumer contract specification](research/erden-paper/consumer-extension/specification.txt) for the precise scope.

## Contributing and security

Outside contributions are not accepted at this time; issues are welcome (see [CONTRIBUTING.md](/CONTRIBUTING.md)).
Report vulnerabilities privately as [SECURITY.md](/SECURITY.md) describes.
