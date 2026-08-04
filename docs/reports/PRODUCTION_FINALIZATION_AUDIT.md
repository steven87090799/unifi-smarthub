# SmartHub Production Finalization Audit

日期：2026-08-03
Repository：`steven87090799/unifi-smarthub`
AUDIT_BASELINE_MAIN_SHA：`3e2cd8b968c1f28eb0bcf5cccffbc60a27d10968`
AUDIT_BRANCH：`fix/production-finalization-and-legacy-salvage`
PR：Draft PR #15，target `main`；不得自行 merge

本文件是 checked-in 的 audit scope、契約與證據邊界說明，不記錄「包含本文件的 commit」作為自身的最終 SHA。每次交付的 exact branch SHA、GitHub run、artifact name/digest 與 release-evidence 對照，應放在 exact-head CI artifact 與 PR body；這樣更新 PR 狀態不會再造成文件自我指涉。

## Final decision boundary

本文件分開 local、runtime／Compose、hosted CI、真實環境與長期 staging 證據。mock、unit test、isolated smoke 或 short soak 不得代替真實 Controller、Device SSH、NAS、UPS、通知或 24／72 小時觀察。只要真實環境或長期 staging 尚未執行，最終 verdict 不得寫成 `PRODUCTION_ACCEPTANCE_COMPLETE`。

## Production findings and changes

| Finding | Root cause / risk | Current change or disposition | Evidence |
|---|---|---|---|
| Internet ambient proxy ambiguity | public Axios integrations implicitly inherited `HTTP(S)_PROXY`/`ALL_PROXY` while LAN behavior needed a hard boundary | `SMARTHUB_INTERNET_PROXY_MODE=disabled` is the default; `environment` is explicit; LAN requests use `proxy:false` | `test/http-egress-policy.test.js`; startup policy diagnostic |
| UPS explicit-source fallback | explicit `UPS_SOURCE=ppb` silently tried NUT/pwrstat/pmset | `UPS_ALLOW_FALLBACK=false` default; explicit fallback is opt-in; status exposes configured/actual/fallback fields and fail-closed unreachable state; auto order is PPB → NUT → pwrstat → pmset | `test/ups-source-selection.test.js`, `test/ups-runtime.test.js` |
| UPS degraded/offline presentation | any non-healthy sample was rendered as red `unreachable`, losing the last-known source/data semantics | `healthy/degraded/offline/unknown` are explicit API states; degraded keeps last-known values with amber presentation, offline sets `actualSource=null`, and a pure frontend presenter drives the mock and real UI | `test/frontend-ups-presenter.test.js`, `test/ups-state.test.js` |
| UPS hot configuration races | an in-flight response from an old source/host could become the new last-good sample | UPS connection fields increment a generation, prompt a sampler, preserve old data as stale, and reject stale-generation successes; PPB agent/token/discovered port rotate on every connection/TLS field change | `test/ups-state.test.js`, `test/ppb-client.test.js`, runtime contract |
| UPS GET side effects | `/api/ups/status` and `/api/ups/ppb-events` could poll upstream, write SQLite, transition state, and notify | GET routes read snapshots only; backend samplers own I/O, persistence, transitions and notification | runtime counter proof plus `test/ups-readonly-contract.test.js` |
| Dependency update visibility | all Dependabot ecosystems had `open-pull-requests-limit: 0` | ordinary Dependabot version-update PRs remain disabled across all four ecosystems; Dependabot Alerts/security updates remain owned by GitHub Code Security settings | `test/dependabot-contract.test.js`; `docs/operations/PRODUCTION-RELEASE-CHECKLIST.md` |
| Trivy unfixed visibility | blocking `--ignore-unfixed` output hid unfixed findings from reviewers | uploaded JSON remains complete and the blocking scan fails on any fixed or unfixed HIGH/CRITICAL finding | `test/ci-contract.test.js`; exact-head artifact is required |
| Production UID/write readiness | a host-created `config/.env` could be readable but fail temp fsync/atomic rename under container UID 1000 | `scripts/production-preflight.js` runs inside the image and probes config/data using the actual process UID without printing secrets | `test/production-preflight.test.js`; container preflight gate |
| Runtime/preflight contract drift | preflight duplicated env mode/readability checks and skipped an absent DB | preflight reuses `assertEnvFileReady`, shares directory fsync handling, requires SQLite DB plus writable sidecars, runs `quick_check`, and only runs `BEGIN IMMEDIATE; ROLLBACK;` with explicit `--offline` | `test/production-preflight.test.js` |
| Reverse-proxy transport diagnosis | missing trusted proxy configuration made TLS termination fail as an opaque HTTPS rejection | explicit proxy IP/CIDR remains required; production startup emits a diagnostic warning without trusting all forwarded headers | `test/panel-security.test.js`; release checklist topology split |
| CA file trust | `stat()` followed symlinks even though deployment documentation prohibited them | CA loaders use `lstat`, bounded regular-file checks, and no-follow descriptor validation where available | `test/tls-policy.test.js` and integration CA contracts |
| Artwork egress boundary | public CDN artwork and private literal artwork could take different proxy paths across redirects | every validated artwork request and redirect uses pinned resolution plus `proxy:false`; the server uses a dedicated direct Axios client and rejects private redirect targets | `test/wiim-art-proxy.test.js`, `test/http-egress-policy.test.js` |
| Host exposure | Compose host port default used `0.0.0.0` | host-side bind defaults to `127.0.0.1`; container process remains `0.0.0.0` for reverse-proxy network access | `test/deployment-contract.test.js` |
| Docker package reproducibility | direct Alpine packages were floating despite immutable Node base digest | direct runtime/build packages pinned to versions resolved from the pinned Alpine v3.24 base | Docker build and deployment contract |
| NAS Monitor socket | Docker socket grants host-root-equivalent authority even with `:ro` bind | accepted explicit risk; profile remains disabled by default, with non-root/read-only/cap-drop/no-new-privileges/resource limits, protected-container policy and allowlists | existing NAS monitor tests/docs; real socket mutation is `NOT RUN` |
| Telemetry source truth | temperature must not be estimated from absent fields | current main behavior retained: Controller temperature only when explicitly reported; Device SSH values typed, pinned, bounded and stale-aware | current telemetry/thermal tests and PR #6 ancestry proof |
| SQLite/history/backup lifecycle | long-running cleanup, backup, restore, shutdown and concurrent work can regress across modules | current main contracts retained; this task avoids whole legacy port and exercises the full local gate | full test suite, backup/SQLite/lifecycle contracts |
| Frontend lifecycle/CSP | UI polling and late responses can outlive navigation or violate same-origin policy | current main lifecycle/generation/CSP contracts retained; UPS setting is synchronized with production mock and UI | frontend/security contracts |
| Release evidence false positives | failure paths could upload a release-named artifact without exact image identities or complete reports | hygiene runs before success-only exact-head evidence; image IDs and SBOM/Trivy files are validated; failures upload only `smarthub-ci-diagnostics-*` | `test/ci-contract.test.js`; hosted artifact required |

## Validation matrix

Results below must be refreshed on the exact final branch HEAD; `NOT RUN` is not a pass.

| Layer | Check | Result | Boundary |
|---|---|---|---|
| Local | `npm ci`, syntax, tests, CSS, audit, diff | `REFRESH PER DELIVERY` | exact command output belongs to the handoff for the current branch; no real devices |
| Runtime | smoke and soak | `REFRESH PER DELIVERY` | isolated fake integrations and bounded short soak only |
| Compose | default and `nas-monitor` config/build/preflight | `REFRESH PER DELIVERY` | configuration/build proof; no production deployment |
| Security | SBOM and strict fixed+unfixed Trivy scan | `REFRESH PER DELIVERY` | exact-head artifact must contain both reports, both SBOMs, and `smartHub_image_id`/`nas_monitor_image_id` |
| Hosted | `SmartHub CI / Repository gate` | `REFRESH PER DELIVERY` | PR body and artifact record the exact branch SHA and run; no merge or ready action is implied |
| Hardware | real UniFi Controller/device/NAS/UPS/WiiM/AdGuard/Linux | `NOT RUN` | requires authorized live environment |
| Staging | 24-hour minimum / 72-hour preferred soak | `NOT RUN` | requires production-like staging and monitoring |

## Remaining risk and terminal verdict

- NAS Docker socket remains an explicit accepted risk, not a claim that the socket is safe.
- Real-device authentication, source fields, host-key behavior, UPS failover, notification delivery, backup/restore on the deployment volume, host reboot, and destructive-operation recovery are `NOT RUN`.
- The required final verdict after local and hosted checks can be `CODE_READY_REAL_ENV_PENDING`; it must remain so until the staging matrix is executed. `PRODUCTION_ACCEPTANCE_COMPLETE` is not available in this delivery.

No merge, force-push, branch deletion, or rewrite of `main` is authorized by this task.
