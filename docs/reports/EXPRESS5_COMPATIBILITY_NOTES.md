# Express 5 Compatibility Notes

This release-blocker remediation selects Express `5.2.1` with `qs` `6.16.0`
and body-parser `2.3.0`, using the complete lockfile resolution from the
Dependabot dependency update as the dependency baseline. The Dependabot PR
itself is not merged into this branch; compatibility changes and regression
coverage live here.

## Static compatibility decisions

- Both production and mock applications set `query parser` to `extended`, so
  repeated, array, nested, and prototype-like query values remain visible to
  the existing exact-query schemas instead of silently changing parser policy.
- The production and mock error middleware retain the four-argument Express
  contract, delegate after `headersSent`, map malformed URLs to a non-leaking
  400 response, and preserve bounded JSON/raw-body 413 responses.
- Existing route strings use named parameters rather than Express 5 wildcard or
  optional path syntax. The regression test exercises an encoded parameter and
  a malformed percent-encoded URL.
- Existing security and lifecycle suites remain the owners for login,
  Origin/CSRF, readonly/admin authorization, SSE, and graceful shutdown
  behavior; the new Express regression test checks their middleware ordering
  contract in the production bootstrap as well as async rejection and
  after-response error handling in an Express 5 harness.

## Validation boundary

`SmartHub CI / Repository gate` is the only validation authority for this
dependency migration. The gate runs locked install, JavaScript and CSS checks,
the full test suite, low-level npm audit, Compose/profile checks, preflight,
smoke/soak, SBOM/Trivy, and the full-history secret scan. No local test,
install, audit, build, Docker, or runtime command is evidence for this report.

Real UniFi Controller/NAS/UPS/AdGuard/WiiM/SSH, Docker socket, disaster
recovery, and 24/72-hour acceptance remain `NOT RUN` until an authorized
production-like environment is available.
