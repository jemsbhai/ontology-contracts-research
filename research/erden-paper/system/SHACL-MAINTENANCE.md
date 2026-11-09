# Native SHACL distribution maintenance

This maintenance was necessary to execute Erden's existing native workflows. It is separate from the paper's consumer query transition contribution.

The checkout initially had no SHACL executable. An exact invocation of the repository's exported source-build plan, using Rust 1.98.0, the recorded source epoch, path remapping and `/Brepro`, completed in 16m25s. Its binary had the pinned size (13,892,608 bytes), but SHA-256 `df7fc421bb1acdac1283842537812f625da775701458183e52a6b88b180a36b3`, differing from the old committed Windows pin `c7ee9a4bff6d0e2cba6d089aa25a81af79c4fe4aee992643db7ef5f8148901a5`. It was not installed. The original build log, exported source, output location and investigation remain available. No claim is made that this host reproduced the old or refreshed binary pin.

The old recorded workflow was unavailable, no upstream release was listed, and the platform npm package was unpublished. The official upstream repository did retain a newer successful [SHACL build run 40711192325](https://github.com/cbnsndwch/erden/actions/runs/40711192325), built from commit `a65794c4d925c46d5ec31b5916d785b8e307010a` on 2026-10-28. All eleven artifacts were downloaded using `gh api`; every ZIP digest was verified against its GitHub artifact metadata before extraction. They are retained in `upstream-artifacts/run40711192325/`, including four native binaries, two-clean-build records, cross-platform comparison, requests, answers and qualification output.

The fresh records match the checkout's exact crate tree `e5bdb4a63590f075a0d6d34ffad2b88015ac6dab`, Cargo.lock SHA-256 `4f85d22854b0747423c286fd019533a6caf08a9dc3d4770ddbb637d307713244`, Rust 1.98.0 compiler commit and semantic engine digest. Their Windows binary is SHA-256 `c50d84c18c3587adfc9ddcd76052030c15d55370b13237e9aa947e2a63122b1e`. Its independently rerun known answer matches the fresh qualification record: 2,202 bytes, SHA-256 `554ae41554f2376b046d05f58a49423eb1c3aaeafaf8ddf06c7b0e91cb0b2cd7`. The local source build and official fresh binary give equal known-answer JSON after excluding the executable digest; this is a bounded check, not proof of identical behavior on all inputs.

The root agent applied the repository's existing official finalizer to **all four** platforms and the corresponding cross-platform comparison, then ran its `--check`. No pins were edited by hand and no identity bypass or source-build override was introduced. Linux and macOS executable hashes remained unchanged; the Windows executable and corresponding known-answer pin changed. Historical pins and qualification are preserved in `historical-shacl-pins/`.

```powershell
& .\research\.tools\node.exe shacl/qualification/finalize-artifacts.mjs `
  --artifacts research/erden-paper/system/upstream-artifacts/run40711192325 `
  --determinism research/erden-paper/system/upstream-artifacts/run40711192325/shacl-determinism-comparison `
  --run-id 40711192325
& .\research\.tools\node.exe shacl/qualification/finalize-artifacts.mjs --check
```

The subsequent system evaluation uses the official refreshed and digest-checked Windows artifact. The build mismatch plausibly reflects host linker or toolchain environment variation: unlike the source/Rust identity, the old SHACL qualification does not completely fix the Windows host toolchain. The precise cause was not established here. This limitation remains relevant to binary reproducibility and should not be hidden by a claim of successful local pinned rebuilding.
