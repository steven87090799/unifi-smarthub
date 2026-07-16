# SmartHub Production Readiness Report

Date: 2026-07-16  
Branch: `production-hardening-final`  
Final engineering revision reviewed: `58809e9c192af3a7092665473324018e7fc8689c`

## Executive verdict

READY WITH KNOWN RISKS

The repository reached the strongest production-readiness frontier demonstrated in the available local environment. All 20 confirmed findings are fixed and committed, including every investigated P0/P1 item and every confirmed Critical/High risk. The current full suite passes 483/483, the dependency audit reports zero vulnerabilities, clean paired images build with strict identity, and isolated Docker startup, restart, recreate, persistence, security, failure, and shutdown contracts pass.

This verdict is not a claim that the software is defect-free. Registry publication/pull, deployment on the final target host, real destructive device operations, and a months-long soak were outside authorization or the available execution window. Those limitations remain explicit release/operations responsibilities.

## Architecture reviewed

- Node.js/Express production entry point, middleware ordering, authentication, authorization, CSRF/origin policy, validation, error handling, startup, and shutdown.
- SQLite history, reports, Web Push, threat-policy persistence, migrations, hot queries, retention, restore sequencing, and single-owner lifecycle.
- Recurring work: notification and Auto Defense jobs, history samplers, UPS polling, threat and AdGuard reconciliation, report claims/renewal/deadlines, Telegram polling, diagnostics, and NAS Monitor SSE.
- External boundaries: UniFi local/Site Manager, UGREEN NAS, NAS Docker monitor, WiiM, CyberPower UPS, AdGuard, Linux/UCG SSH, Discord, Telegram, and Web Push.
- Single-page frontend critical loading, polling, write controls, restart-pending state, backup/restore, threat blocking, AdGuard policy, Web Push, offline assets, QR generation, and readonly behavior.
- Docker/Compose main service, optional privileged socket broker, health/readiness, volumes, config authority, immutable build identity, release transaction, restart policy, and graceful stop.

The hardening work progressively extracted security middleware, policies, routes, jobs, storage, integrations, Web Push backend routes, and a frontend Web Push module. It avoided a high-risk wholesale rewrite of `server.js` or `public/index.html`.

## Initial backlog disposition

| Backlog item | Disposition | Primary commits |
|---|---|---|
| P0 panel authentication, CSRF, Origin, throttling, readonly/admin roles | Fixed and contract-tested | `69ad002` |
| P0 unrestricted WiiM command proxy | Fixed with typed read/write allowlists, method split, validation, and high-risk confirmation | `0e8f05a` |
| P1 unified write/query validation and `.env` injection resistance | Fixed across production and mock routes | `8aeeb26` |
| P1 UPS debounce, last-good state, offline/recovery transitions | Fixed with deterministic failure/recovery runtime proof | `8aeeb26` |
| P1 scheduled report restart/concurrency idempotency | Fixed with SQLite claims, fencing, retries, deadlines, and retention | `8aeeb26` |
| P1 Site Manager pagination and 429 handling | Fixed with bounded pages/items, token-loop rejection, Retry-After/backoff, and terminal metadata | `8aeeb26` |
| Process shutdown, jobs, SSE, and SQLite lifecycle | Fixed and exercised with real processes/containers | `8aeeb26`, `601364b` |
| Read-only user mode | Implemented server-side across write categories | `69ad002` |
| Configuration backup/restore | Implemented with secret-safe export and restart-staged transactional restore | `c85e0a2` |
| Threat-source IP blocking | Implemented for expiring public IPv4 through the official Integration API boundary | `790d561` |
| AdGuard service policies and schedules | Implemented with persistent per-device policy and reconciliation | `19a1d1d` |
| Web Push | Implemented with bounded persistent subscriptions, delivery claims, cleanup, and fallback | `e945df5` |
| Backend/frontend decomposition | Performed at security, lifecycle, persistence, route, and Web Push boundaries | multiple; notably `d3df8f6`, `58809e9` |
| Documentation and production release checklist | Synchronized to immutable paired-image/config authority | `8870011` |

No requested new capability remains unimplemented or blocked.

## Critical and High findings

No Critical finding remained open. Confirmed High findings and their final disposition:

- F-001–F-002: missing panel security controls and unrestricted WiiM control — fixed.
- F-003–F-005 and F-007: unsafe write inputs, UPS state loss, report duplication, and process lifecycle gaps — fixed.
- F-008 and F-010: privileged Docker broker boundary and deployed config/build identity — fixed; clean socket-backed rehearsal passed.
- F-011: third-party frontend runtime dependency and WiFi QR credential egress — fixed with same-origin pinned assets and local QR rendering.
- F-012: AdGuard credentials over implicit plaintext HTTP — fixed with HTTPS default and exact insecure opt-in.
- F-017: permanent Auto Defense suppression and unbounded rotating-MAC retention — fixed with a bounded expiring owner and destructive timestamp validation.
- F-018: truncate-in-place JSON settings and mutate-before-persist live state — fixed with atomic private replacement and persist-before-publish transactions.
- F-019: DATA_DIR claim races and PID-namespace duplicate ownership — fixed with transactional leased runtime/PID/token ownership, exact heartbeat/release, and fail-safe owner-loss shutdown.
- F-020: unbounded/stalled UCG/Linux SSH command streams — fixed with an end-to-end deadline, combined byte cap, abort, and cleanup owner.

## Important Medium findings

- F-006: Site Manager pagination/429 behavior — fixed.
- F-009: optional NAS Monitor incorrectly affecting deployment readiness — fixed; main readiness remains independent.
- F-013: release identity invalidated Docker dependency/payload cache layers — fixed; identity-only rebuilds dropped from a reproduced 52.9-second reinstall to 2.6 seconds main and 2.0 seconds monitor.
- F-014: Docker metric cooldown retention — fixed with removal cleanup and a 2,000-entry bound.
- F-015: recoverable-failure cooldown retention — fixed with explicit ownership, removal cleanup, and a 2,000-key bound.
- F-016: operator/release documentation drift — fixed with one config authority and immutable paired-image procedure.

## Repairs

Major accepted repair groups include:

- Central authorization/CSRF/origin/rate-limit middleware and common exact input policies.
- Durable report scheduling, bounded jobs, owned timers/SSE, and graceful shutdown.
- Fail-closed Docker socket broker credentials, canonical 64-hex identities, action/log allowlists, proxy isolation, response/queue/concurrency limits, and protected containers.
- Atomic `.env` and JSON persistence, restart-pending truth, transactional restore, and exact DATA_DIR ownership.
- Same-origin frontend runtime assets, strict CSP, local QR generation, and release-scoped PWA caching.
- Secure AdGuard transport and persistent AdGuard/threat/Web Push capabilities.
- Bounded long-lived Sets/Maps, telemetry/history/report retention, and failure cooldowns.
- Strict clean build identity, immutable paired-image transaction, deployment checklist, and cache-efficient Dockerfiles.
- End-to-end bounded SSH command channel/stream ownership for UCG and Linux.

## Security review

Validated boundaries include:

- Admin/readonly/unauthenticated matrices across safe reads and all unsafe methods.
- CSRF token plus same-origin enforcement, hostile Origin rejection, Basic Auth throttling/cooldown, bounded limiter state, and explicit trusted-proxy policy.
- Exact write bodies/queries, identifier/MAC/port/enumeration bounds, unknown-field rejection, oversized JSON rejection, and CR/LF/NUL/shell assignment injection rejection.
- WiiM allowlists and confirmations; threat blocking and device actions require server-side policy and explicit confirmation.
- Docker logs are admin-only; mutations require admin, CSRF, canonical ID, explicit broker capability, and target allowlisting. Broker and SmartHub containers remain protected.
- NAS Monitor and AdGuard credentials are origin-scoped, proxy-disabled, bounded, redacted, and secure-by-default for remote transport.
- Frontend executable assets and WiFi QR data stay same-origin; CSP and browser tests cover the critical flow.
- `npm audit --audit-level=high` reports zero vulnerabilities at the final revision.

No live credential was committed or exported by the backup format. Runtime log scans found none of the rehearsal passwords, API keys, SSH fixture secret, or Basic credential patterns.

## Reliability review

- Named `runSerialJob` ownership prevents recurring job overlap and tracks skips/failures.
- Report claims, renewals, deadlines, completion ambiguity, retries, and stale recovery are token-fenced in SQLite.
- UPS retains last-good data and distinguishes degraded, confirmed offline, and recovered states without alert storms.
- External HTTP clients use finite timeouts; Site Manager and Web Push retries are bounded and side-effect aware.
- UCG/Linux SSH now has an 8-second ready timeout plus a 12-second total command deadline and 1 MiB combined output cap.
- JSON and env updates use same-directory private temporary files, fsync, atomic rename, and explicit ambiguous-durability errors.
- One leased SQLite authority fences DATA_DIR restore, main SQLite, jobs, and notifications across processes and PID namespaces.
- Shutdown clears owned timers/SSE, stops bots/monitor/report runner, drains jobs, closes SQLite when safe, and removes only the exact instance owner.

## Performance measurements

- Docker cache reproduction: a 52.9-second dependency reinstall was eliminated from identity-only rebuilds; measured rebuilds were 2.6 seconds main and 2.0 seconds monitor.
- Six equal endurance waves showed no material SQLite latency degradation:
  - 60,000 telemetry writes: 198.82–207.34 ms per wave.
  - 2,000 manual reports: 80.92–82.54 ms.
  - 1,000 schedule identities: 145.23–148.15 ms.
  - 15,000 Web Push claims: 1,388.01–1,468.84 ms.
- Query plans used `idx_history_series_ts`, `idx_report_runs_schedule_key`, and the Web Push created-time covering index.
- Database pool size remained one, active connections returned to zero, and slow-query count remained zero in the accelerated protocol.

## Failure injection

Executed deterministic scenarios included:

- Missing/invalid CSRF, hostile Origin, readonly mutation, repeated failed auth, cooldown recovery, malformed/oversized bodies, and `.env` injection.
- UPS timeout waves through degraded/offline/recovered transitions.
- Site Manager repeated/cyclic tokens, malformed pagination, 429 with valid/invalid Retry-After, retry exhaustion, and timeout.
- Report overlap, process-restart recovery, lease loss, hard deadline, partial delivery, false completion, and completion retry ambiguity.
- Atomic env/JSON partial write, fsync, rename, and directory-fsync failures; interrupted restore rollback.
- NAS Monitor stalled SSE, Docker response/queue/concurrency limits, action timeout ambiguity, stopped monitor, broker socket lifecycle, and credential rotation.
- Docker instance-lock missing/stale contention, two PID-1 containers with different and identical hostnames, unexpected process crash, token replacement, lease expiry, and exact release.
- SSH channel-open stall, stream stall, combined output overflow, stream error, late callback, start failure, and invalid asynchronous stream.
- Repeated external connection refusal for threat, UPS, monitor, and final UCG SSH runtime paths.

Rejected or false-green attempts were retained as evidence and corrected rather than rerun blindly.

## Endurance and resource observations

The accelerated protocol ran six waves in one Node process. It exercised 600,000-cycle owners for tasks, issues, Docker cooldowns, recoverable failures, activity leases, and UPS state; 300,000 auth identities; 360,000 telemetry inserts; 90,000 Web Push claims; and bounded report/subscription/reconciliation workloads.

- SQLite `quick_check` passed after every wave; the temporary database stabilized at 5,464,064 bytes.
- Retained rows/entries matched configured caps, including telemetry 1,000 per series, manual reports 50, schedule identities 512, Web Push claims 10,000, auth maps 1,000, and cooldown maps 2,000.
- Post-GC heap grew 797,416 bytes from baseline to final; the last three waves added 31,304 bytes.
- External memory and array buffers returned to the same values; active-handle delta was zero.
- RSS rose from 53,608,448 to 174,243,840 bytes while V8 committed heap in steps; the final three-wave RSS delta was 12,189,696 bytes, below the declared 32 MiB tail threshold.

This is strong bounded-cycle evidence, not a 365-day proof. Production RSS/heap/handle and database-size monitoring remains required.

## Docker and release rehearsal

The full socket-backed release rehearsal exercised exact build identity, health/readiness, authentication, readonly/admin Docker logs, canonical IDs, protected containers, one disposable action target, config persistence, credential rotation, ordinary restart, coordinated recreate, optional monitor outage, SQLite integrity, secret scans, and graceful shutdown.

F-019 ownership acceptance at `601364b` additionally proved:

- Different-hostname and same-hostname PID-1 duplicates sharing one DATA_DIR both exited 1.
- Unexpected Node failure was fenced for six restart attempts and recovered healthy after lease expiry in 15 seconds.
- Exact-token replacement emitted one critical owner-loss event, shut down fail-safe, and recovered after expiry in 16 seconds.
- Two graceful stop/start cycles exited zero and left no owner row while stopped.

The final clean release transaction at `58809e9` produced:

- `unifi-smarthub:58809e9c192a` — `sha256:7565af80a309d51da1cf9a51a25bc4935f4f0f51d70998a74387e3adbd53d219`
- `unifi-smarthub-nas-monitor:58809e9c192a` — `sha256:23bec7001d4d8fdd6df043be8e6eba815cd92b9941d871812185883408e90f13`

Fresh final-HEAD startup, broker/security/config flow, actual bounded SSH failure, ordinary restart, force-recreate, SQLite checks, exact image checks, secret scan, and graceful shutdown passed. All disposable containers, networks, and volumes were removed.

## Testing commands and actual results

Final accepted commands/results:

| Command or gate | Result |
|---|---|
| `node --test test/ssh-command-stream.test.js test/server-lifecycle.test.js` | 10/10 passed |
| `npm test` | 483/483 passed |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `npm run check:css` | passed; checked-in CSS reproducible |
| syntax check for every repository JavaScript file | passed |
| `docker compose config --quiet` | passed |
| `docker compose --profile nas-monitor config --quiet` | passed |
| `git diff --check` | passed |
| `npm run release:build` | passed from clean `58809e9` |
| isolated final-HEAD Docker rehearsal | passed and cleaned up |

Earlier focused matrices include 100 production/mock route checks, browser/runtime flows, real process restart/restore, 12-process lock contention, 50,000/600,000-entry retention proofs, and the six-wave endurance protocol.

## Blocked or unavailable validations

- Registry push/pull and digest-based clean-host deployment were not authorized. Local immutable tags and image IDs are not registry digests.
- Production deployment, merge, and push were not authorized.
- Destructive calls were not sent to real UniFi, NAS, WiiM, PoE, AdGuard, UPS, or non-disposable Docker resources.
- Final target-host kernel/filesystem/network compatibility and external service versions were not available for validation.
- A months-long or 365-day soak cannot be completed in this execution window.
- Browser checks covered available local critical flows; no exhaustive cross-browser/device matrix was available.

## Known remaining risks

- Short accelerated endurance cannot exclude slow native/V8 RSS growth; monitor RSS, heap, handles, SQLite size, job failures, and restart count in production.
- Instance ownership deliberately favors safety: an unexpected crash can cause several restart attempts and roughly one lease/health window of unavailability before recovery.
- Several trusted local-device integrations support self-signed TLS or explicit insecure transport for device compatibility. Keep them on controlled networks and use secure options where supported.
- Real upstream firmware/API drift, target-host Docker socket permissions, certificate chains, push delivery, and notification providers require deployment-environment verification.
- Local release images were verified by image ID, but registry provenance/signing and disaster-recovery restoration on the final host remain operator gates.

## Commit timeline

| Commit | Outcome |
|---|---|
| `69ad002` | Panel authorization, CSRF/origin protection, auth throttling, readonly role |
| `0e8f05a` | Restricted WiiM command policy and write boundary |
| `8aeeb26` | Write validation, UPS state, durable reports, Site Manager, shutdown/jobs/SSE |
| `46cd237` | Docker monitor security, release/config identity, restart/recreate durability |
| `c85e0a2` | Transactional secret-safe configuration backup/restore |
| `790d561` | Expiring public IPv4 threat blocks |
| `80bbec2` | Self-hosted frontend runtime, CSP, local QR generation |
| `a7c0e40` | Secure AdGuard credential transport |
| `19a1d1d` | Persistent scheduled AdGuard service policies |
| `e945df5` | Persistent bounded Web Push |
| `d3df8f6` | Web Push backend/frontend module extraction |
| `be24c43` | Docker dependency/payload cache preservation |
| `4bc3024` | Bounded Docker notification cooldown state |
| `f3ab9a7` | Bounded recoverable-failure state |
| `8870011` | Production release/config/operator contract |
| `b1ceb92` | Bounded Auto Defense block state |
| `6d051f7` | Atomic JSON settings and persist-before-publish behavior |
| `d077366` | Initial transactional instance owner; later reopened by PID-namespace evidence |
| `601364b` | Leased cross-container instance ownership and fail-safe owner loss |
| `58809e9` | Bounded end-to-end SSH command execution |

## Release decision

The repository is ready for a controlled production deployment process, subject to the blocked validations and known risks above. Deployment should follow `PRODUCTION-RELEASE-CHECKLIST.md`, use the immutable paired-image transaction, validate target-host Docker socket GID/config permissions, perform the documented health/readiness and restart checks, and retain rollback images/config backups.
