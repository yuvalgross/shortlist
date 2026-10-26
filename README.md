# Shortlist (working name)

Job matching and CV tailoring platform, built from Yuval's scheduled job scan and CV engine.

## How this repo is built: gates

Every component arrives as one pull request, a "gate". Nothing moves on until the gate is approved.

| Gate | Component | Status |
|---|---|---|
| 0 | Foundation: schema, data isolation, login, repo layout | Approved (PR #1) |
| 1 | Profile from CV: upload, parsing, skills, proof bank, suggestions | Approved (PR #2) |
| 2 | Scoring rules per user, target titles and priorities | Not started |
| 3 | Job sources and validation | Not started |
| 4 | Job updates (digest) | Not started |
| 5 | CV tailoring on the template | Not started |
| 6 | Live dashboard | Not started |

Each gate has a report in `docs/gates/` with what was built, the test results against the scheduled task's real output, and open questions.

## Layout

```
apps/web/            Next.js app (Vercel). Uses only the publishable key; row level security protects data.
worker/              Python worker: sourcing, scoring, CV building, digests. Uses the secret key. Never runs in the browser.
supabase/migrations/ Database schema, security policies, storage buckets.
supabase/tests/      Embedded Postgres tests: proves users can never see each other's data.
docs/gates/          One report per gate.
docs/reference/      What the scheduled task does today: the spec each gate is measured against.
```

## Run the checks

```
cd supabase/tests && npm ci && npm test     # database: isolation, CV parsing, audit
cd apps/web && npm ci && npm test && npm run build   # web app (needs the env vars from .env.example)
cd worker && pip install -e ".[dev]" && pytest -q
```

The same checks run on every pull request (`.github/workflows/ci.yml`).

## Database changes

New files in `supabase/migrations/` are applied to the live Supabase project automatically when they reach `main` (`.github/workflows/migrate.yml`). Merging the pull request is the approval; the same migrations have already passed the database tests in CI. The workflow needs two repository secrets, `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`; without them it skips with a warning.
