# Legacy Branch Disposition

Compared against `origin/main` at `cb48da28fe58932dc26f1d785787a4293a6bae17`.
This is a semantic salvage audit; no legacy branch was merged or cherry-picked.

## Unique commits

| Branch / commit | Subject | Disposition | Reason |
|---|---|---|---|
| `origin/codex/polling-cache-hardening` / `89e6e9f7dd0dd439b6eb6c99d8e75e2bd90f22f` | harden polling collectors and caches | SALVAGED_IN_THIS_PR | The artwork-proxy/cache idea was independently rewritten here with stricter DNS, special-range, redirect, stream, MIME, TLS, and cache limits. The remaining collector changes are already represented or superseded by main/PR #7. |
| `origin/codex/polling-cache-hardening` / `e87cbe9271a964a26531a1b66464273702361c25` | harden frontend and runtime lifecycle | SUPERSEDED | Main already contains the merged lifecycle, health, cache, and long-running hardening. This task implements only the still-required page hydration/pinned lifecycle behavior in the current frontend. |
| `origin/codex/polling-cache-hardening` / `1f4429053085757c7dd383a209f89fa621e51bef` | finalize runtime soak validation | ALREADY_IN_MAIN | The runtime soak and acceptance path are present on main after PR #7. |
| `origin/codex/unifi-device-telemetry` / `07a09eba7776c794f9d623ee0c2b2c52e218525b` | add verified UniFi device telemetry | ALREADY_IN_MAIN | The feature is present in main through the secure telemetry integration commit and current production/mock/tests. |
| `origin/codex/unifi-device-telemetry` / `eb1ae7e42ace82620640795913d6867a7743c69a` | add verified UniFi device SSH thermal monitoring | ALREADY_IN_MAIN | Current main contains the pinned SSH thermal collector and its tests. |
| `origin/codex/unifi-device-telemetry` / `d8c2b5adcd4b5a521d779f0d657a05309c499eb3` | harden thermal SSH lifecycle | ALREADY_IN_MAIN | Current main contains the pool/lifecycle/stale-state hardening. |
| `origin/codex/unifi-device-telemetry` / `2a349d3371398f018c0e88248047deeac39897b7` | finalize telemetry stale handling | ALREADY_IN_MAIN | Current main contains the retained snapshot and stale semantics. |
| `origin/codex/unifi-device-telemetry` / `9af92b28d9d7a958b769ee1794314757d2d352fe` | finalize device thermal monitoring | SUPERSEDED | The final semantics are represented by the merged current-main implementation; the old branch is not a safe source for whole-file porting. |

The full object IDs above were read from the remote branch histories.

## Branch-level disposition

| Remote branch family | Status relative to main | Disposition | Rule |
|---|---:|---|---|
| `origin/codex/polling-cache-hardening` | 25 behind / 3 ahead | KEEP_TEMPORARILY | `SAFE_TO_DELETE_AFTER_PR_MERGE`; retain until this PR's proxy/cache salvage is reviewed. |
| `origin/codex/unifi-device-telemetry` | 25 behind / 8 ahead | KEEP_TEMPORARILY | `SAFE_TO_DELETE_AFTER_PR_MERGE`; no direct merge. |
| `origin/fix/production-long-run-hardening` | 1 behind / 0 ahead | KEEP_TEMPORARILY | Historical PR #7 branch; `SAFE_TO_DELETE_AFTER_PR_MERGE` after hosted evidence is archived. |
| `origin/codex/docs-zh-cleanup-20260717`, `enrich-notification-reports`, `fix-smarthub-audit-findings`, `production-final-hardening`, `ups-live-sag-polling`, `feature/*`, `hotfix/*` | behind / 0 ahead | DO_NOT_MERGE | Historical or unrelated work; no unique commit is required for this task. `SAFE_TO_DELETE_AFTER_PR_MERGE` only if the owner no longer needs the reference. |
| `origin/dependabot/*` | 0 behind / 1 ahead | KEEP_TEMPORARILY | Managed dependency PR heads; evaluate in their own PRs. `DO_NOT_MERGE` from this task. |

No branch is authorized for deletion by this task. `DO_NOT_MERGE` means no
branch is a source for a wholesale merge or cherry-pick here.
