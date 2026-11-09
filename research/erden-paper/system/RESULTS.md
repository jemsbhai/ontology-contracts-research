# Executed system results

The complete `catalog-v2` workflow exited successfully. Raw stdout/stderr, command arguments, statuses and hashes are in `artifacts/catalog-v2/`; the synthesis is `verification-summary.json`. These are controlled integration results, not independent benchmark datasets or a performance study.

## Consumer transitions

The fixed baseline answer is `{item-a}`. Each row below was executed with all three policies through the compiled Erden CLI, yielding **24 checked policy decisions** across eight controls.

| Candidate | Candidate full check | Candidate answers to fixed baseline query | Preserve | No loss | No gain |
|---|---|---|---|---|---|
| Identical | passed | `{item-a}` | satisfied | satisfied | satisfied |
| Annotation only | passed | `{item-a}` | satisfied | satisfied | satisfied |
| Addition | passed | `{item-a,item-b}` | violated | satisfied | violated |
| Removal | passed | `{}` | violated | violated | satisfied |
| Swap | passed | `{item-b}` | violated | violated | violated |
| Strict swap | passed, `rows == 1` | `{item-b}` | violated | violated | violated |
| Candidate omits CQ | passed, no root CQ executes | `{item-b}` | violated | violated | violated |
| Refused candidate | failed (`incomplete-certificate`) | not assessed | indeterminate | indeterminate | indeterminate |

The strict baseline and strict swap both pass their inherited `rows == 1` competency check. The new transition reports one named binding removed and one added. The separate ordinary-SPARQL control adds a handwritten expected-answer condition: the baseline passes and the swap fails, demonstrating that the improvement is automation and workflow evidence, not additional logical expressiveness.

The candidate named `inconsistent` is deliberately inconsistent, but the native engine refuses with `incomplete-certificate` and diagnostic `uncheckable-inconsistency`; this is not recorded as a certified inconsistency. Its provider also fails by refusal (`uncheckable-unsatisfiable-class`). The state machine correctly leaves all three transitions unassessed.

## Existing system workflows

- Seven provider projects were checked: common 1.0.0 and catalog 1.0.0–1.4.0 passed; catalog 1.5.0 refused as described above.
- Ten consumer snapshots were checked; nine passed and the deliberately inconsistent input refused. The baseline has 10 normalized input axioms and three inferred RDF statements. The root owns two catalog records, and the complete installed closure includes two dependency packages with one transitive edge.
- The inherited SHACL shape has one target in the baseline, conforms, and reports its owning dependency. Its self-test fired. Dependency attribution is retained for inferred types.
- One root competency question executes; one dependency question is explicitly dormant. The baseline's normal and `--offline` check JSON are equal.
- Actual dependency updates changed the targeted catalog release while retaining/reusing the common dependency. Raw resolver/store/install/update reports and archive bytes are retained.
- CLI `init`, offline frozen `install`, `check`, and the repository demo check passed.
- Two CLI `pack` operations produced byte-identical `.erdenpkg` output: SHA-256 `cbdfe82c788d4aa01341ed2d508407efe1cb7096bbf705310c20a4a235f5174a`.

The reports use the official upstream native SHACL artifact after the coherent qualification refresh described in [SHACL-MAINTENANCE.md](SHACL-MAINTENANCE.md). No local binary mismatch was concealed or accepted by weakening identity checks.

These historical controls precede the exact graph-identity export and conservative literal-admission corrections. The final external release study and ROBOT comparison, replayed after those corrections, are documented in `../real-release/README.txt`. Historical controls and repeated diagnostic attempts are retained separately from the final external evidence.
