# SmartHub Production Finalization — Remote Branch and Legacy Salvage Audit

日期：2026-08-02
Repository：`steven87090799/unifi-smarthub`
起始分支：`main`
START_MAIN_SHA：`3e2cd8b968c1f28eb0bcf5cccffbc60a27d10968`
工作分支：`fix/production-finalization-and-legacy-salvage`

## 審計規則

本次以 fetch 後的 `origin/main` 作為唯一基線。先建立全部 remote branch 的 tip、merge-base、ahead／behind，再對仍有 unique commits 的兩條 legacy branch 逐 commit 讀取 subject、stat、程式與測試語意。沒有整批 merge、整批 cherry-pick 或刪除任何 remote branch；所有仍需的修正以目前基線的模組與契約重新實作。

`git cherry origin/main <branch>` 顯示的是 commit patch-id 是否完全相同，不等同語意是否已整合。因此本表以目前 `origin/main` 的 source、test、merge history 與 runtime contract 作最終判定。

## Remote branch matrix

`behind` 是 main-only commits，`ahead` 是 branch-only commits。`origin/HEAD` 與 `origin` symbolic alias 不列為實際 branch。

| Remote branch | Tip | Merge-base | Behind | Ahead | 語意判定 | 本次處置 |
|---|---|---|---:|---:|---|---|
| `origin/main` | `3e2cd8b968c1` | `3e2cd8b968c1` | 0 | 0 | 唯一基線 | 不改寫 |
| `origin/codex/docs-zh-cleanup-20260717` | `4270ada4a1bc` | 同 tip | 44 | 0 | 已在 main ancestry | 不刪除 |
| `origin/codex/enrich-notification-reports` | `97cab47f0351` | 同 tip | 83 | 0 | 已在 main ancestry | 不刪除 |
| `origin/codex/fix-smarthub-audit-findings` | `7dddbfceab82` | 同 tip | 32 | 0 | 已在 main ancestry | 不刪除 |
| `origin/codex/integrate-unifi-device-telemetry` | `22edfba8871d` | 同 tip | 28 | 0 | PR #6 已整合 | 不刪除 |
| `origin/codex/polling-cache-hardening` | `1f4429053085` | `cc2ae4e80587` | 41 | 3 | 3 個 unique commits，語意已由 main 的後續 hardening 覆蓋 | 不刪除、逐 commit 審計 |
| `origin/codex/production-final-hardening` | `1a6d53b470da` | 同 tip | 71 | 0 | 已在 main ancestry | 不刪除 |
| `origin/codex/unifi-device-telemetry` | `9af92b28d9d7` | `cc2ae4e80587` | 41 | 8 | 8 個 unique commits，PR #6/#7/#14 後續行為已整合或強化 | 不刪除、逐 commit 審計 |
| `origin/codex/ups-live-sag-polling` | `eeb48547b93f` | 同 tip | 42 | 0 | PR #4 已整合 | 不刪除 |
| `origin/feature/sqlite-migration` | `f6b9bf8cd315` | 同 tip | 135 | 0 | 已在 main ancestry | 不刪除 |
| `origin/feature/ui-ux-redesign` | `22d989205288` | 同 tip | 100 | 0 | 已在 main ancestry | 不刪除 |
| `origin/feature/wiim-integration` | `88e9e3dee366` | 同 tip | 137 | 0 | 已在 main ancestry | 不刪除 |
| `origin/fix/production-long-run-hardening` | `86dcd67b66026` | 同 tip | 17 | 0 | PR #7 已整合 | 不刪除 |
| `origin/hotfix/unified-chart-reveal` | `0e47ce5a2aab` | 同 tip | 86 | 0 | 已在 main ancestry | 不刪除 |
| `origin/production-hardening-final` | `fb32e2b5ee15` | 同 tip | 48 | 0 | 已在 main ancestry | 不刪除 |

Branch cleanup is intentionally outside this task. Branches with `ahead=0` may be considered for deletion only after the final Draft PR is reviewed and merged by an authorized owner; the two legacy branches with unique commits should be retained until that review is complete.

## Legacy unique commits — `origin/codex/unifi-device-telemetry`

| Commit | Subject | 語意抽取 | Current main evidence | Disposition |
|---|---|---|---|---|
| `89e6e9f7dd0d` | `fix: harden polling collectors and caches` | collector singleflight、bounded history／cleanup、SSE backpressure、WiiM artwork bounds | `device-collector-cache.js`、`adaptive-sampler.js`、`sse-backpressure.js`、`wiim-art-proxy.js` 及相關 tests 已在 PR #7/#14 後續版本存在 | `SUPERSEDED_BY_STRONGER_IMPLEMENTATION` |
| `e87cbe9271a9` | `fix: harden frontend and runtime lifecycle` | 前端 lifecycle、generation fence、resource cleanup、runtime soak plumbing | `public/js/frontend-lifecycle.js`、server shutdown/resource ownership、CI `npm run test:soak` 與 current lifecycle tests 已存在；舊 patch 的 API 不能直接移植 | `SUPERSEDED_BY_STRONGER_IMPLEMENTATION` |
| `1f4429053085` | `test: finalize runtime soak validation` | fake-upstream failure/recovery、active handle/request bounds、exit-code assertions | current main 使用 `scripts/runtime-soak.js`、`test:soak` 與 CI 90 秒 blocking gate；舊 test-only layout 已被 current harness 取代 | `SUPERSEDED_BY_STRONGER_IMPLEMENTATION` |
| `07a09eba7776` | `feat: add verified UniFi device telemetry` | Controller device telemetry normalization、history rows、UI/mock/tests | main first-parent 包含 `Merge pull request #6`；目前 telemetry source、history contract、UI/mock 與 tests 均更完整 | `ALREADY_IN_MAIN` |
| `eb1ae7e42ace` | `feat: add verified UniFi device SSH thermal monitoring` | Device SSH thermal fallback、temperature alerts、policy、UI | PR #6/#7 已整合，current `unifi-device-thermal-ssh.js` 有 allowlist、pinning、bounded command、two-job cap | `ALREADY_IN_MAIN` |
| `d8c2b5adcd4b` | `fix: harden UniFi device thermal SSH lifecycle` | pool close、late-ready、generation／shutdown races | current thermal SSH and `ssh-connection-pool.js` retain lifecycle fencing with dedicated regression tests | `ALREADY_IN_MAIN` |
| `2a349d337139` | `fix: finalize UniFi telemetry stale handling` | stale snapshot status、null temperature、history exclusion | current telemetry snapshot marks stale values, suppresses stale history rows, and tests source truth | `ALREADY_IN_MAIN` |
| `9af92b28d9d7` | `fix: finalize UniFi device thermal monitoring` | final device thermal transport/policy test coverage | current main contains the later thermal implementation and tests; no missing unique behavior was found | `ALREADY_IN_MAIN` |

## Legacy unique commits — `origin/codex/polling-cache-hardening`

This branch contains the first three commits above and no additional unique commit:

| Commit | Disposition |
|---|---|
| `89e6e9f7dd0d` — polling collectors and caches | `SUPERSEDED_BY_STRONGER_IMPLEMENTATION` |
| `e87cbe9271a9` — frontend and runtime lifecycle | `SUPERSEDED_BY_STRONGER_IMPLEMENTATION` |
| `1f4429053085` — runtime soak validation | `SUPERSEDED_BY_STRONGER_IMPLEMENTATION` |

## Salvage conclusion

`SALVAGE_REQUIRED`: **none**. All 11 unique branch appearances were inspected; the three shared hardening commits are represented by stronger current-main modules/tests, and the five telemetry/thermal commits are represented by the merged PR #6 behavior plus later hardening. No legacy commit is classified `UNSAFE_TO_PORT`, but none is safe to wholesale cherry-pick because the current composition root, route contracts, UI asset layout, and SQLite lifecycle have moved on.

The production fixes in this task are new, narrow changes against `origin/main`: LAN egress policy, strict UPS source selection and snapshot-only UPS GET routes, ordinary Dependabot version-update PRs disabled while security remediation remains Code Security-managed, complete Trivy reporting, loopback host publishing, and explicitly versioned Alpine packages.

## Main integration proof

- `origin/main` first-parent history contains `1f931756a159` — `Merge pull request #6 from steven87090799/codex/integrate-unifi-device-telemetry`.
- `origin/codex/integrate-unifi-device-telemetry` is an ancestor of `origin/main` (`merge-base` equals its tip).
- Current tests cover Controller telemetry truthfulness, stale snapshots, Device SSH restrictions/lifecycle, frontend telemetry rendering, cache/sampler behavior, SQLite history, SSE cleanup, and shutdown.
- No remote branch was deleted or force-updated during this audit.
