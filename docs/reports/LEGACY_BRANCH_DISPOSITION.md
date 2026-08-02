# Legacy Branch Disposition

Compared against the actual source and behavior at the PR start (`f822bc2e4b1790ac036070abddc1ff3ed18c6276`) and the final PR worktree.
This is a semantic salvage audit: dispositions below come from source inspection and behavior tests, not commit subjects. No legacy branch was merged or cherry-picked.

## Unique commits

| Branch / commit | Subject | Disposition | Reason |
|---|---|---|---|
| `origin/codex/polling-cache-hardening` / `89e6e9f7dd0dd439b6eb6c99d8e75e2bd90f22f` | harden polling collectors and caches | PARTIALLY_SUPERSEDED | Retained: artwork SSRF/cache hardening, SSE backpressure, adaptive scheduling, and SQLite history behavior verified in current source/tests. This PR adds: the shared collector cache and central Active/Idle policy across the priority device scopes, including watcher snapshot-only reads. Not present at start HEAD: the required collector health fields, shared singleflight path, and recovery semantics. |
| `origin/codex/polling-cache-hardening` / `e87cbe9271a964a26531a1b66464273702361c25` | harden frontend and runtime lifecycle | PARTIALLY_SUPERSEDED | Retained: lazy page routing, pinned observer lifecycle, visibility leases, and bounded polling. This PR adds: explicit hydration success/failure results, retryable incomplete jobs, stale-generation protection, and heartbeat/settings fallback decoupling. The old simple cache implementation was not treated as complete because it lacked the final health/freshness contract. |
| `origin/codex/polling-cache-hardening` / `1f4429053085757c7dd383a209f89fa621e51bef` | finalize runtime soak validation | PARTIALLY_SUPERSEDED | Retained: injected offline/recovery, activity leases, cache singleflight, SQLite cleanup coalescing, SSE/backpressure, artwork bounds, and terminal resource checks. This PR adds: a fixed 30-minute default, the test-only `SOAK_TEST_DURATION_MS` override, explicit active-handle/request and exit-code assertions, and current service API compatibility. Production-process smoke remains a separate `scripts/runtime-smoke-test.js` contract and is not claimed by this local lifecycle soak. |
| `origin/codex/unifi-device-telemetry` / `07a09eba7776c794f9d623ee0c2b2c52e218525b` | add verified UniFi device telemetry | ALREADY_IN_MAIN | Actual current source contains the retained telemetry snapshot, SQLite history, API, and production/mock behavior tests; no legacy-only portion was required by this PR. |
| `origin/codex/unifi-device-telemetry` / `eb1ae7e42ace82620640795913d6867a7743c69a` | add verified UniFi device SSH thermal monitoring | ALREADY_IN_MAIN | Actual current source contains the pinned SSH thermal collector, selection policy, stale/offline handling, and behavior tests. |
| `origin/codex/unifi-device-telemetry` / `d8c2b5adcd4b5a521d779f0d657a05309c499eb3` | harden thermal SSH lifecycle | ALREADY_IN_MAIN | Actual current source contains the bounded SSH pool, host-key policy, cancellation, queue limits, and lifecycle tests. |
| `origin/codex/unifi-device-telemetry` / `2a349d3371398f018c0e88248047deeac39897b7` | finalize telemetry stale handling | ALREADY_IN_MAIN | Actual current source contains retained snapshots, explicit stale/offline truth, null unavailable temperatures, and recovery tests. |
| `origin/codex/unifi-device-telemetry` / `9af92b28d9d7a958b769ee1794314757d2d352fe` | finalize device thermal monitoring | ALREADY_IN_MAIN | The final behavior is present in current source and tests; no whole-file legacy port was used. |

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
