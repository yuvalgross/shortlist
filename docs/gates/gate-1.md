# Gate 1: Profile from CV

Status: waiting for approval. Two things only you can do are listed at the bottom; after those I run the live check and add the results here.

## What this gate delivers

1. **Upload** (`/app/upload`): PDF or Word, up to 5 MB, with a consent tick. The browser sends the file straight to your private storage folder (Vercel caps requests at 4.5 MB, so files never pass through the server).
2. **Reading the CV** (`src/lib/cv/`): text is pulled from the file, then the matching model returns roles, results, skills and up to 8 suggestions. It runs after the page responds, with your own sign in token, so row level security still applies.
3. **Checks before anything is saved** (`verify.ts`). Each one mirrors a rule from `tailoring-rules.md` and `cv-library.md`:
   - every role, result and skill must quote the CV word for word, or it is dropped
   - a number in a metric must appear in its quote, or the metric is removed (the result stays, tagged NO NUMBER)
   - a date is kept only if its year is on the role's header line
   - links and phone must be in the CV
   - anything on your Not on your record list is dropped, including parts of "X or Y" claims
   - title suggestions that add seniority (Senior, Lead, Head, Director and so on) are blocked
   - "What we left out" on the profile page lists every drop and the reason
4. **Review** (`/app/profile`): everything arrives as *suggested*. You edit dates and basics, delete what's wrong, add skills, accept or reject suggestions, then press confirm. Only confirmed facts go into the snapshot the matching model reads later.
5. **Proof bank** (`/app/proof`): results as STAR stories you can edit, plus the Not on your record editor (one item per line).
6. **Database** (`…20261018000001_cv_parsing.sql`): upload status and audit columns, a suggested or confirmed state on roles, and three functions: save a parse, confirm an upload, accept a suggestion. Re-reading the same CV replaces only unreviewed facts. It never duplicates a role you already confirmed and never overwrites a profile field you filled in.
7. **Approval check** (`supabase/checks/gate-1-approval.sql`): a read only query that grades a real parse against `cv-library.md`.

## Test results

| Suite | Result |
|---|---|
| Database (embedded Postgres 17, all 5 migrations) | 23 of 23 pass: Gate 0's 11, the 11 new CV tests, and the approval query smoke test |
| Web unit tests (vitest) | 20 of 20 pass |
| Lint, type check, production build | clean |

The new database tests cover:
- user B can't read or save into user A's upload
- parsed facts start as suggested and stay out of the snapshot until confirmed
- re-parsing replaces unreviewed facts only and doesn't duplicate confirmed roles
- profile fields are never overwritten
- a deleted fact stays deleted after confirm
- accepting a skill, title or story suggestion applies it; a rejected one never comes back
- signed out visitors can't call any of the functions

The web tests use a fictional CV (Mara Lindqvist, PDF and Word) with a model answer I planted mistakes into: an invented quote, a number not in the CV, a wrong year, an invented link, a skill from her Not on your record list, and a title suggestion adding "Senior". All six are caught. A scanned image PDF is refused before the model is called, so it costs nothing.

**Control check:** I switched off the quote check and the number check and reran. 3 tests failed, so the tests catch the mistakes rather than passing by default.

## Decisions you may want to change

1. **The API key now lives in Vercel, not the worker.** This changes what I told you in Gate 0. The CV is read inside the web app's server function, so the key has to be there. It is a server only, Sensitive variable, never sent to the browser. Moving it to the worker would mean the worker polling for uploads, which adds a moving part for no gain at this stage.
2. **Model: Sonnet 5.5** (`claude-sonnet-5-5`, change with `CV_PARSE_MODEL`). The approval query prints the real cost per parse. My estimate is a few cents.
3. **Target titles and their priorities move to Gate 2.** They only matter for scoring, so they get built with the scoring rules. Gate 1 covers the profile, skills and proof.
4. **The save function can be called directly by a signed in user.** Someone could skip the checks and write unchecked facts, but only into their own profile, still as suggested. It cannot touch anyone else's data.
5. **Suggestion kinds today:** add skill, ATS title, story. Other kinds from the mockups come with the gates that use them.

## Live database

Applied on Oct 18 2026. Yuval ran the migration file in the Supabase SQL editor, because the connector's approval prompt kept cancelling.

| Check on the live database | Result |
|---|---|
| New upload columns | 8 of 8 |
| New columns on roles, skills and stories | 5 of 5 |
| Status check on uploads | present |
| The 3 new functions | signed in users can call them, signed out visitors can't |
| Supabase security advisor | 4 warnings, all intended: the 3 new functions plus `set_scoring_config`. Each one writes only the caller's own rows. Leaked password protection doesn't apply, since sign in is by email link |

## What you need to do

1. ~~Database change~~ done.
2. ~~API key in Vercel~~ done, preview redeployed with it. Steps kept for reference:
   - Project shortlist > Settings > Environment Variables > Add.
   - Name `ANTHROPIC_API_KEY`, value from console.anthropic.com > API Keys.
   - Tick Sensitive, then Production and Preview. Save.
   - Redeploy the preview: Deployments > latest gate-1 > ⋯ > Redeploy.
3. On the preview, open **Proof** and paste your Not on your record list.
4. **Upload your CV** (the latest cv_engine PDF), wait for it to finish, and tell me.
   - I run the approval query and add the results here.
   - Expected: OEB/CloserStill Nov 2024 to present, Pragma Aug 2023 to present, CoachHub Nov 2021 to Sep 2024, Luns Jan 2017 to Jan 2020, plus earlier roles if listed.
   - Every metric in the CV saved with its number: €921k, 2.4x, 42%, €295k to €390k, 17 to 5 tools, €1.1M.
   - Nothing from Not on your record.
5. Optional: upload `apps/web/test/fixtures/fictional-cv.pdf` from a second address (gross.yuval+cv2@gmail.com) to see a stranger's experience.
6. Merge the pull request to approve.

## Next: Gate 2, scoring rules per user

Target titles with priorities, location points, weights and thresholds per user. Test: roles from past scans replay within 0.5 of the score the scheduled task gave them, and role fit is never raised to reach a threshold.
