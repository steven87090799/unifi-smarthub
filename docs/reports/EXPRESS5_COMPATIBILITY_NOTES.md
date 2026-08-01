# Express 5 Compatibility Notes

Dependabot PR #8 (`express` 4.22.2 → 5.2.1) remains open, non-draft, based on
`main`, with a clean merge state and a passing historical `Repository gate` on
its own head. This task does not merge it or upgrade Express.

## Required compatibility review before a separate upgrade

- Express 5 forwards rejected promises from async handlers to the error
  middleware. Review every route that currently catches, sends a response, or
  intentionally returns after an async operation so a second response is not
  attempted.
- Review all custom error middleware and `apiError` paths for the Express 5
  four-argument error-handler contract and for errors raised after headers are
  sent.
- Re-run the exact body-parser, raw backup upload, URL-encoded, CSP/static
  asset, SSE, and graceful-shutdown tests; middleware ordering is security
  sensitive in this application.
- Review route/path parsing for Express 5's newer `path-to-regexp` behavior,
  especially encoded identifiers and wildcard/parameter routes.
- Re-test `req.query`, `req.params`, `req.body`, response status/header
  behavior, and the panel Origin/CSRF middleware using both production and
  mock servers.
- Rebuild the CSS and run the release build, isolated runtime smoke, short
  soak, both Docker builds, and the pinned vulnerability scan against the
  dependency-updated lockfile.

Recommendation: keep PR #8 separate and non-merged until this compatibility
matrix is run on a dedicated branch. Current status is `DEFERRED`; no conflict
or rebase is required at the time of this audit, but that is not evidence that
the application is Express 5 compatible.
