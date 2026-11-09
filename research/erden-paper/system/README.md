# Erden system workflow evidence

This directory belongs to the second, non-cybersecurity Erden systems paper. It preserves a controlled open-data catalog example and real Erden workflow outputs. It does not alter the first paper's experiments.

## Scope

The scenario has one consumer and a two-level dependency closure: `catalog-consumer -> catalog -> common`. `common` declares a resource taxonomy, an inherited SHACL shape, and a dependency competency question. `catalog` classifies online/offline resources. The consumer owns two catalog records and asks which are eligible. Only its root question executes; the dependency question remains documentation.

Package releases are encoded with Erden's real package codec. A local in-process registry supplies those immutable archives. Resolution, lock construction, store installation, dependency materialization, targeted update, checking, native reasoning, SHACL evaluation, question execution, and packaging all run through Erden's implementations. This demonstrates local composition and upgrade behavior; it does not evaluate a deployed HTTP registry, production publication, external ontology reuse, user productivity, or scale.

The catalog controls are:

| Candidate | Catalog change | Expected query answer set |
|---|---|---|
| identical | same snapshot | `{item-a}` |
| annotation | label only | `{item-a}` |
| addition | online and offline eligible | `{item-a,item-b}` |
| removal | neither eligible | `{}` |
| swap | offline replaces online as eligible | `{item-b}` |
| strict-swap | same swap, both root expectations are `rows == 1` | `{item-b}` |
| missing-suite | same swap; candidate omits root question | fixed baseline question still yields `{item-b}` |
| inconsistent | inhabited online class becomes a subclass of `owl:Nothing` | actual check refuses with `incomplete-certificate`; transition is unassessed |

The permissive suite uses `rows >= 0` so addition/removal are not stopped by the pre-existing row-count check. The separate strict pair establishes the motivating workflow gap: both snapshots satisfy `rows == 1`, yet their named answer is replaced. An additional handwritten SPARQL control adds `FILTER (?resource != <...#item-a>)` with `rows == 0`; ordinary competency questions can already express this expected answer condition. The extension automates baseline comparison and evidence capture; it adds no fundamental query expressiveness. This is a query-specific change contract, not a claim of general ontology compatibility.

## Reproduce

Run from the repository root, with dependencies already installed. This workspace uses Node 24.17.0 at `research/.tools/node.exe` and pnpm 10.15.0 at `research/.tools/pnpm/node_modules/pnpm/bin/pnpm.cjs`.

```powershell
$env:PATH = (Join-Path (Get-Location) 'research/.tools') + ';' + $env:PATH
$env:ERDEN_REASONER_BIN = Join-Path (Get-Location) 'research/.tools/native-target/release/erden-reasoner.exe'
& .\research\.tools\node.exe .\research\.tools\pnpm\node_modules\pnpm\bin\pnpm.cjs run build:runtime
& .\research\.tools\node.exe research/erden-paper/system/fetch-shacl-artifact.mjs 12827227859 --cached
& .\research\.tools\node.exe research/erden-paper/system/setup-fixtures.mjs catalog-replay
& .\research\.tools\node.exe research/erden-paper/system/setup-manual-controls.mjs catalog-replay
& .\research\.tools\node.exe research/erden-paper/system/verify-workflows.mjs catalog-replay
```

Use a fresh fixture run identifier for each setup. The setup refuses an existing run directory. Its installed store is local to that run. The native SHACL binary comes from the retained official upstream CI artifact. `--cached` verifies and installs the retained archive against the current committed distribution pin, then verifies its known answer; omit `--cached` to retrieve artifact metadata/bytes through `gh` while GitHub retains them. The source-build attempt did **not** reproduce the old pin on this host and is not used for the system evaluation. See `SHACL-MAINTENANCE.md` for the source-matched official mint refresh. The pre-existing native reasoner binary was built from this repository; it is identified in the saved doctor report. To build it in the same location on Windows with Rust 1.96.0 installed:

```powershell
cargo +1.96.0 build --manifest-path reasoner/Cargo.toml --release --locked --target-dir research/.tools/native-target
```

For a direct comparison after building the runtime:

```powershell
& .\research\.tools\node.exe apps/cli/dist/bin.js transition `
  research/erden-paper/system/fixtures/catalog-v2/strict-baseline `
  research/erden-paper/system/fixtures/catalog-v2/strict-swap `
  --policy preserve --json
```

Expected exit status is 1 for a violated or indeterminate transition; 0 for a satisfied transition. `commands.json` records actual invocations and exit statuses. Each command's stdout JSON and stderr are saved alongside it. Installation and upgrade outputs precede validation outputs. Archive manifests and actual tar bytes are in `artifacts/<run>/packages/`; root manifests, source files, lockfiles and installed closures are in `fixtures/<run>/`.

## Capability boundaries

- `init` writes an ontology project with a manifest and empty lock; `install` resolves or replays exact package versions and materializes the closure.
- `update` already reports changed package versions and archive hashes. The added transition operation supplies the consumer query comparison after independently checking both installed snapshots.
- `check` reasons over the assembled closure, checks inherited SHACL shapes, and executes root competency questions. Dependency questions are reported as dormant. Offline and normal checks should produce the same report because checking uses installed local content.
- Reasoning provenance identifies dependency contributions and source locations. It is not claimed to be a minimal explanation or causal attribution of a changed answer.
- `pack` produces a deterministic archive of the project and lock. Packing is independently tested; packing alone is not presented as a semantic validation gate.
- The inherited competency-question mechanism tests row-count expectations and reports bounded samples. The added transition compares complete supported answer sets using the baseline consumer suite.
- The controls are a small functional integration evaluation. No latency, scale, completeness beyond the declared reasoner/query profile, or broad adoption claim follows from them.

See `verification-summary.json` for the executed outcomes. A missing summary means the workflow has not completed; tables in this README describe the intended controls, not substitute results.

`catalog-v2` is the main run. It adds checked provider project directories and permissive provider guidance; `catalog-v1` is retained as an earlier fixture-construction run and should not be counted as independent evidence.

The complete v2 run succeeded: see [RESULTS.md](RESULTS.md) and [the machine-readable summary](artifacts/catalog-v2/verification-summary.json). The fixture named `inconsistent` is a deliberately inconsistent input, but the actual native outcome is a refusal (`incomplete-certificate`, diagnostic `uncheckable-inconsistency`), not a certified inconsistency result. Its provider similarly refuses with `uncheckable-unsatisfiable-class`. Neither is used as a passed semantic snapshot.
