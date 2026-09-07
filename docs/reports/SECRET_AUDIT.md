# Secret Audit (historical snapshot)

This report records the earlier point-in-time audit below; it is not a current
release verdict. The current `SmartHub CI / Repository gate` now performs a
pinned full-history Gitleaks scan with a complete checkout. Its result belongs
to the exact workflow run for the release candidate.

Audit base: `cb48da28fe58932dc26f1d785787a4293a6bae17`; current branch head at
the follow-up scan: `a58aff3`. The scan used tracked files from the current
branch/working tree and excluded the user-owned untracked
`scripts/runtime-smoke-test.js`.

| Check | Result |
|---|---|
| `.env` ignored | PASS: `.gitignore` ignores `.env`. |
| `config/.env` ignored | PASS: `.gitignore` ignores `config/`. |
| Tracked secret-like paths | PASS: no tracked PEM/private-key/SSH-key path; `.env.example` is the only expected env template. |
| Tracked GitHub PAT/cloud token/private-key marker patterns | PASS: no matches for `ghp_`, `github_pat_`, `xoxb-`, AWS access-key marker, or private-key PEM markers in tracked current-branch content (excluding this report's literal marker names). |
| Full git-history scanner | NOT RUN: neither `gitleaks` nor `trufflehog` is installed; no scanner was installed for this audit. |

This is not a claim that historical secrets never existed. If the full-history
gate is required, run an approved scanner in a controlled environment and
rotate any exposed credential before production acceptance.
