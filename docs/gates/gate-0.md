# Gate 0: Foundation

Status: waiting for approval. Approve by merging the Gate 0 pull request.

## What this gate delivers

1. **Database schema** (`supabase/migrations/…01_core_schema.sql`): profiles, CV uploads, experiences, skills, stories (proof bank), "not on record" claims, suggestions, targets, versioned scoring configs, shared companies, sources and jobs, per user matches, applications, tailored CVs, scan runs, leads, transcripts, notification settings, monthly usage.
2. **Security** (`…02_security_and_snapshot.sql`): row level security on every table, explicit grants, and a profile snapshot that rebuilds itself whenever profile data changes.
3. **File storage** (`…03_storage.sql`): two private buckets. Users reach only their own folder. Only the worker writes tailored CVs.
4. **Web app** (`apps/web`): email sign in link, session refresh on every request, signed out visitors kept out of `/app`, a signed in page that reads through row level security.
5. **Worker skeleton** (`worker/`): settings from the environment only, and a `check` command that confirms database access.
6. **Automatic checks on every pull request** (`.github/workflows/ci.yml`): database tests, web lint, type check and build, worker tests.

## How it maps to your scheduled task

| Your scan today | Platform equivalent |
|---|---|
| Role fit plus location points, capped at 10, role fit never raised to reach a threshold | `job_matches.role_fit` and `location_points` are stored separately; `total_fit` is computed by the database as `least(10, role_fit + location_points)`, so it can't be edited or inflated |
| CV only at total fit 8 or above, max 3 per run | `scoring_configs.cv_threshold` (default 8.0) and `cv_cap_per_run` (default 3, hard max 5) |
| Only the company's current job list is proof a role is open | `companies.list_url` holds the list URL; `jobs.last_verified_at` and `jobs.status` record the last time the role was seen there |
| Board: never overwrite an application Yuval edited (`updated` field) | `applications.user_edited_at`; the worker will skip rows where it is set |
| "Not on your record" list in `cv-library.md` | `not_on_record` table, included in the snapshot the matching model reads |
| Confirmed facts and locked wording | `stories.locked_wording`, and every skill stores its source quote |
| Board shows no people, emails or phone numbers | `leads.signals` holds signals only; no people columns exist |
| `job-sources.md` status values WORKS, PARTIAL, BLOCKED, EMPTY, UNTESTED | `source_status` enum on `sources` and `companies` |

## Test results

**Database and isolation** (`supabase/tests`, embedded Postgres 17 with pgvector): 11 of 11 passed.

| Test | Result |
|---|---|
| User A writes and reads own profile, skills, stories, applications | pass |
| User B sees zero rows of A in 5 tables, including the snapshot | pass |
| User B cannot insert in A's name, update or delete A's rows | pass |
| Signed out visitors are refused on every table tried | pass |
| Scoring config: new version on each save, old one deactivated, weights must total 100, no direct edits | pass |
| Matches: only the worker can create scores; user can approve, skip or flag but not change a score; total fit caps at 10; jobs readable by all signed in users, writable by none | pass |
| Suggestions: user accepts or rejects but cannot change the content; a rejected suggestion can't be created again | pass |
| Snapshot rebuilds on change, leaves out rejected skills, phone and email; users can't call internal functions | pass |
| Storage: own folder only; users cannot write into the tailored CV bucket | pass |
| Transcripts past their delete date are purged | pass |
| Deleting an account removes the user's rows in all 10 tables checked; shared jobs stay | pass |

**Control check:** I turned security off on two tables and reran the suite. 4 tests failed as they should, which shows the tests detect a leak rather than passing by default.

**Web app:** lint clean, type check clean, production build passes. Running the built app: `/` and `/login` return 200, `/app` and `/app/anything` redirect signed out visitors to `/login`.

**Worker:** 3 of 3 tests pass. `check` reports a missing setting or an unreachable database clearly instead of crashing.

## Not verified yet (needs your Supabase project)

- A real sign in link email, and the full sign in round trip.
- Storage policies on Supabase's real storage service. The tests use a stand in with the same policy logic.
- The checks running on GitHub. They run once the pull request is open.

## Decisions I made that you may want to change

1. **Sign in by email link only.** No passwords to store or leak. Google sign in can be added later.
2. **Transcripts delete themselves after 180 days** by default.
3. **Embeddings are 1024 dimensions** (for matching stories to job descriptions). The embedding provider is chosen in Gate 3; the column size can change then.
4. **Account deletion of stored files** needs the worker, because Supabase only deletes storage files through its API. Database rows already cascade. The full delete button comes before any outside user signs up.
5. **Next.js 16** (current version) with its new request handling (`proxy.ts` instead of middleware, and streamed signed in content).

## What you need to do to finish Gate 0

1. Supabase project in Frankfurt (eu-central-1), if not done.
2. Run the three migration files in order in the Supabase SQL editor (or `supabase db push`).
3. Authentication > URL configuration: add `http://localhost:3000/auth/callback` and your Vercel address plus `/auth/callback`.
4. Vercel: new project from this repo, root directory `apps/web`, environment variables from `apps/web/.env.example`.
5. Sign in once with your email and tell me it worked, or what you saw.
6. Merge the pull request to approve.

## Next: Gate 1, profile from CV

Upload, parsing into a profile where every fact keeps its source line, skills and priorities, suggestion buttons. Test: your own CV parses into the confirmed facts in `cv-library.md`, nothing from "Not on your record" appears. Needs the Anthropic API key in the worker settings.
