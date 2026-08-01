# Post-Merge Production Audit Hardening

## Baseline audit

- `START_BASE_SHA`: `cb48da28fe58932dc26f1d785787a4293a6bae17`
- `BASE_AUDIT_SHA`: `cb48da28fe58932dc26f1d785787a4293a6bae17`
- `BRANCH`: `fix/post-merge-audit-hardening`
- `AUDIT_TIME`: 2026-08-01 Asia/Taipei

This report records the audit before source changes on the new branch created from
the latest `origin/main`. Classifications are intentionally preserved as the
baseline disposition; the final section is updated after implementation and
validation.

| Finding | Baseline classification | Root cause / evidence | Planned disposition |
|---|---|---|---|
| Activity heartbeat scope isolation | CONFIRMED / P1 | `public/js/app.js` sends `ucg,unifi-device-telemetry`, while `server/policies/query-input-policy.js` omits `unifi-device-telemetry` from `ACTIVITY_SCOPES`; the heartbeat route therefore rejects the documented UCG contract. | Fix the shared contract, preserve per-session lease/focus/expiry isolation, and add backend/frontend contract tests. |
| WiiM artwork proxy boundary | CONFIRMED / P1 | `/api/wiim/art` in `server.js` uses a broad hostname regex, does not validate all DNS answers, does not pin the connection target, accepts upstream content without a bounded stream/MIME/byte policy, and has no deterministic bounded total-size cache. | Extract an independently testable proxy service with strict URL, DNS, redirect, TLS, stream, MIME, cache, and safe-error policies. |
| Optional WiiM integration | CONFIRMED / P2 | `server.js` and `server-mock.js` use `192.168.0.170` as a default; hot reload uses `process.env.WIIM_IP || wiimIP`, so clearing the setting retains the previous address. Samplers, diagnostics, commands, and status routes can operate as if WiiM were configured. | Make empty configuration a real disabled state in production, mock, runtime reads, startup, diagnostics, commands, and page hydration. |
| NAS alert configuration DOM XSS | CONFIRMED / P2 | `fetchAlertConfig()` interpolates server-provided `metric` and other fields into `innerHTML`; the action attribute is escaped but the rendered text boundary is not a safe DOM construction boundary. | Build rows with DOM APIs/text nodes and safe data attributes; retain delegated action dispatch without inline handlers; add payload tests. |
| Lazy initial hydration | CONFIRMED / P2 | `window.load` invokes fetchers for UCG, NAS, WiiM, UPS, AdGuard, Linux, settings, notification, reports, and other pages before navigation. Page-aware recurring polling does not prevent this initial fan-out. | Restrict boot to essentials and hydrate each page once on first navigation, with retry after failure and no duplicate requests. |
| Pinned-card synchronization | CONFIRMED / P2/P3 | Pinned mirrors use `setInterval(syncPinned, 2000)`, copy `innerHTML`, and separately copy canvas pixels. The interval and mirror lifecycle are not tied to pin/rerender teardown. | Replace with change-driven observers/explicit updates, disconnect observers on unpin/rerender/teardown, and preserve IDs/CSP/chart behavior. |
| UniFi Network TLS | PARTIALLY_FIXED | `server/integrations/unifi-traffic-list-client.js` defaults TLS verification to true and rejects non-loopback HTTP, but still exposes `UNIFI_NETWORK_TLS_VERIFY=false` as an accepted loopback opt-out and requires the final environment contract/docs/test matrix to be explicit. | Align the final policy with strict TLS and explicit insecure opt-in semantics without weakening existing protections. |
| Unused `cors` dependency | CONFIRMED / P3 | The server comment says CORS was removed and source search found no runtime import, but `cors` remains in `package.json` and the lockfile. | Verify the dependency tree and remove only the unused package files if no consumer exists. |
| Documentation truth | CONFIRMED / P2/P3 | `.env.example` and WiiM integration docs advertise the hardcoded WiiM IP; release/acceptance documents still describe the historical PR #7 scope rather than this post-merge audit. | Update configuration, TLS, no-fake-data, polling/scope, report, and historical-PR wording to match the resulting implementation. |
| Legacy branch salvage | NOT YET CLASSIFIED | Remote branch deltas include `codex/polling-cache-hardening` and `codex/unifi-device-telemetry` commits not reachable from `origin/main`; semantic disposition requires commit-by-commit comparison. | Record each unique commit as already in main, superseded, salvaged, deferred, obsolete, or unsafe; do not wholesale merge. |
| Dependabot Express 5 / dotenv 17 | CONFIRMED / DEFERRED | PR #8 and PR #9 are open non-draft dependency branches after PR #7; compatibility and conflict/rebase state require a live report. | Do not merge or upgrade in this task. Document risks and recommendation. |
| Secret audit | NOT RUN (full history) | `.env` and `config/` are ignored; no `gitleaks` or `trufflehog` executable is installed. Working-tree pattern checks can be performed, but a full-history scanner must remain explicitly NOT RUN. | Audit ignored/config/PEM/key/token patterns without installing scanners; report exact scope and limitations. |

## Validation plan

The final report will separate local tests, isolated runtime/soak evidence,
Compose/build/Trivy evidence, hosted CI on the exact final SHA, and real-device,
staging, backup/restore, and long-duration environment gates. Unexecuted real
environment gates will remain `NOT RUN` and will not be inferred from mocks or
unit tests.

## Final delivery record

Implementation and local delivery evidence is recorded below. Hosted evidence is
reported separately after the final branch push because it is tied to the exact
GitHub commit SHA, not to an older local result.

- `IMPLEMENTATION_HEAD_SHA`: `f2104544f9b267e068437c085b56c7ee58070541`
- `COMMITS`: `f210454` — `fix: harden post-merge production audit findings`; a documentation-only audit closure commit follows after this record is staged.
- `FILES_CHANGED`: 34 implementation/audit files; user-owned untracked `scripts/runtime-smoke-test.js` was preserved and not staged.
- `CONFIRMED_FINDINGS`: heartbeat scope contract; WiiM artwork SSRF boundary; empty-disabled WiiM integration; NAS alert DOM construction; lazy page hydration; observer-based pinned cards; strict UniFi Network TLS; unused `cors` removal; documentation truth.
- `LEGACY_BRANCH_DISPOSITION`: recorded in [LEGACY_BRANCH_DISPOSITION.md](LEGACY_BRANCH_DISPOSITION.md); no legacy branch was merged, cherry-picked, or deleted.
- `DEPENDABOT`: PR #8 (`express` 5.2.1) and PR #9 (`dotenv` 17.4.2) remain open, non-draft, clean/mergeable with their own `Repository gate` PASS; neither was merged or upgraded here.
- `VALIDATION`: `npm test` PASS 615/615; `npm run check:js` PASS (161 files); `npm run build:css` and `npm run check:css` PASS; `npm run test:smoke` PASS with health/readiness/auth/CSRF/restart persistence; `git diff --check` PASS; both Compose configurations PASS; both Docker builds PASS; strict clean temporary-worktree `npm run release:build` PASS with OCI identity verification for both images; `cors` absent from the runtime dependency tree.
- `SOAK`: 90,000 ms PASS; requests 1,851; SSE clients 3; active upstream SSE 0; active handles peak 9; active requests peak 1; RSS 91,095,040 → 112,885,760 → 112,885,760 bytes; heap 19,414,776 → 28,570,128 → 19,394,040 bytes.
- `SCANNERS`: `trivy`, `gitleaks`, and `trufflehog` were not installed; pinned vulnerability scan and full-history secret scan are `NOT RUN`. Working-tree/tracked marker audit is recorded in [SECRET_AUDIT.md](SECRET_AUDIT.md).
- `HOSTED_CI_CODE_HEAD`: `bc762db50ad17af30213301c12059bef05d05dde` — PR #14 Draft/Open, `Repository gate` PASS; run [30698331756](https://github.com/steven87090799/unifi-smarthub/actions/runs/30698331756), job [91364872281](https://github.com/steven87090799/unifi-smarthub/actions/runs/30698331756/job/91364872281).
- `HOSTED_CI_FINAL_HEAD`: this audit-report closure commit intentionally triggers a new exact-head gate; its result is recorded in the final handoff after completion.
- `REAL_ENVIRONMENT_GATES`: `NOT RUN` for real UCG/UniFi/WiiM/NAS/UPS/AdGuard/Linux devices, staging deployment, independent DR restore, production traffic, and 24/72-hour observation; hardware/PMIC/thermal acceptance is also `NOT RUN`.
- `FINAL_VERDICT`: `LOCAL_AND_CI_READY_REAL_ENV_PENDING`.
