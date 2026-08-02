# SmartHub Production Finalization Audit

日期：2026-08-02
Repository：`steven87090799/unifi-smarthub`
START_BRANCH：`main`
START_MAIN_SHA：`3e2cd8b968c1f28eb0bcf5cccffbc60a27d10968`
WORK_BRANCH：`fix/production-finalization-and-legacy-salvage`
FINAL_HEAD：以本次分支最後 exact HEAD 為準，並在交付訊息與 Draft PR 中再次核對
PR：Draft PR #15，target `main`；不得自行 merge
PR_STATE：`OPEN`／`DRAFT`／`CLEAN`（以 GitHub live state 為準）
MERGED：`false`

## Final decision boundary

本文件分開 local、runtime／Compose、hosted CI、真實環境與長期 staging 證據。mock、unit test、isolated smoke 或 short soak 不得代替真實 Controller、Device SSH、NAS、UPS、通知或 24／72 小時觀察。只要真實環境或長期 staging 尚未執行，最終 verdict 不得寫成 `PRODUCTION_ACCEPTANCE_COMPLETE`。

## Production findings and changes

| Finding | Root cause / risk | Current change or disposition | Evidence |
|---|---|---|---|
| Global proxy environment deletion | process startup deleted `HTTP(S)_PROXY` globally, changing public and LAN integrations unpredictably | removed global mutation; LAN requests use explicit `proxy:false`, public clients retain ambient proxy resolution | `test/http-egress-policy.test.js`; LAN/public request split |
| UPS explicit-source fallback | explicit `UPS_SOURCE=ppb` silently tried NUT/pwrstat/pmset | `UPS_ALLOW_FALLBACK=false` default; explicit fallback is opt-in; status exposes configured/actual/fallback fields and fail-closed unreachable state | `test/ups-source-selection.test.js`, `test/ups-runtime.test.js` |
| UPS GET side effects | `/api/ups/status` and `/api/ups/ppb-events` could poll upstream, write SQLite, transition state, and notify | GET routes read snapshots only; backend samplers own I/O, persistence, transitions and notification | runtime counter proof plus `test/ups-readonly-contract.test.js` |
| Dependency update visibility | all Dependabot ecosystems had `open-pull-requests-limit: 0` | weekly bounded updates, minor/patch groups, major updates held for explicit review | `test/dependabot-contract.test.js` |
| Trivy unfixed visibility | blocking `--ignore-unfixed` output hid unfixed findings from reviewers | fixed+unfixed HIGH/CRITICAL JSON report is uploaded; separate fixed-only scan remains blocking | `test/ci-contract.test.js`; hosted artifact is required |
| Host exposure | Compose host port default used `0.0.0.0` | host-side bind defaults to `127.0.0.1`; container process remains `0.0.0.0` for reverse-proxy network access | `test/deployment-contract.test.js` |
| Docker package reproducibility | direct Alpine packages were floating despite immutable Node base digest | direct runtime/build packages pinned to versions resolved from the pinned Alpine v3.24 base | Docker build and deployment contract |
| NAS Monitor socket | Docker socket grants host-root-equivalent authority even with `:ro` bind | accepted explicit risk; profile remains disabled by default, with non-root/read-only/cap-drop/no-new-privileges/resource limits, protected-container policy and allowlists | existing NAS monitor tests/docs; real socket mutation is `NOT RUN` |
| Telemetry source truth | temperature must not be estimated from absent fields | current main behavior retained: Controller temperature only when explicitly reported; Device SSH values typed, pinned, bounded and stale-aware | current telemetry/thermal tests and PR #6 ancestry proof |
| SQLite/history/backup lifecycle | long-running cleanup, backup, restore, shutdown and concurrent work can regress across modules | current main contracts retained; this task avoids whole legacy port and exercises the full local gate | full test suite, backup/SQLite/lifecycle contracts |
| Frontend lifecycle/CSP | UI polling and late responses can outlive navigation or violate same-origin policy | current main lifecycle/generation/CSP contracts retained; UPS setting is synchronized with production mock and UI | frontend/security contracts |

## Validation matrix

Results below must be refreshed on the exact final branch HEAD; `NOT RUN` is not a pass.

| Layer | Check | Result | Boundary |
|---|---|---|---|
| Local | `npm ci` | `PASS` | locked dependency install; Node engine warning only because host Node is v26.4.0 while package requires v24.18.x |
| Local | `npm run check:js` | `PASS` (185 files) | syntax discovery only |
| Local | `npm test` | `PASS` (683/683) | unit/integration/contract/security; no real devices |
| Local | `npm run check:css` | `PASS` | checked-in CSS only |
| Local | `npm audit --audit-level=low` | `PASS` (0 vulnerabilities) | dependency advisory state at run time |
| Runtime | `npm run test:smoke` | `PASS` | loopback fake integrations only; restart persistence and CSRF/read-only assertions included |
| Runtime | `npm run test:soak` | `PASS` (90,000 ms) | short simulated soak only; zero active handles/requests and zero unhandled errors |
| Compose | default and `nas-monitor` `config --quiet` | `PASS` | configuration parse only |
| Compose | SmartHub and NAS Monitor image builds | `PASS` | build proof; no production deployment |
| Release | immutable paired-image/release identity check | `PASS` | clean release workflow verified paired main/monitor image labels and immutable revision identity |
| Security | Trivy fixed blocking scan | `PASS` | hosted exact-head run passed; both built images reported zero HIGH/CRITICAL vulnerabilities |
| Security | Trivy full fixed+unfixed artifact | `PASS` | hosted artifact contains both Trivy JSON reports and both CycloneDX SBOMs; both Trivy reports contain zero vulnerabilities |
| Hosted | `SmartHub CI / Repository gate` | `PASS` | exact-head GitHub check passed in 3m44s; no merge or ready action taken |
| Hardware | real UniFi Controller/device/NAS/UPS/WiiM/AdGuard/Linux | `NOT RUN` | requires authorized live environment |
| Staging | 24-hour minimum / 72-hour preferred soak | `NOT RUN` | requires production-like staging and monitoring |

## Remaining risk and terminal verdict

- NAS Docker socket remains an explicit accepted risk, not a claim that the socket is safe.
- Real-device authentication, source fields, host-key behavior, UPS failover, notification delivery, backup/restore on the deployment volume, host reboot, and destructive-operation recovery are `NOT RUN`.
- The required final verdict after local and hosted checks can be `CODE_READY_REAL_ENV_PENDING`; it must remain so until the staging matrix is executed. `PRODUCTION_ACCEPTANCE_COMPLETE` is not available in this delivery.

No merge, force-push, branch deletion, or rewrite of `main` is authorized by this task.
