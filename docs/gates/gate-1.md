# Gate 1: Profile from CV

Status: approved by Yuval and merged on Oct 18 2026 (PR #2).

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
| Database (embedded Postgres 17, all 6 migrations) | 46 of 46 pass: Gate 0's 11, the 11 CV tests, the approval query smoke test, and 23 audit tests |
| Web unit tests (vitest) | 50 of 50 pass, including 24 audit tests and a test that sends the real request through the Anthropic library |
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

## First live run, and the deep check that followed (Oct 18 2026)

Yuval's first upload on the preview failed before the request reached the model: I had set the model's answer limit so high that the Anthropic library refused to send it. My tests had not caught it because they used a stand-in for the model. Fixed, with a test that now sends the real request to a fake server.

He then asked for a deep check of Gates 0 and 1. Two independent reviews, one of the database and one of the web code, wrote 47 adversarial tests. 15 failed, meaning 15 real problems. **None of them let one user reach another user's data**: every one of the 22 tables has row level security on and forced, nothing is granted to signed out visitors, storage is folder per user, and the live database matches the migration files exactly (same fingerprint for columns, functions, indexes, policies and enums). The problems were about the app working correctly for its own user.

| # | Problem a user would have hit | Fix |
|---|---|---|
| 1 | An upload could sit on "Reading…" forever: a model retry could outlast Vercel's 5 minute limit, so the function was killed before it could record a failure | No automatic retry; one attempt of at most 4 minutes |
| 2 | Same outcome if the sign in token expired during a long read: the save at the end fails, and so does the attempt to record the failure | Token refreshed before the read when under 10 minutes remain; a failure to record is logged |
| 3 | After a stuck read, no way to retry unless the tab stayed open 5 minutes | The profile page treats a read older than 6 minutes as failed and shows "Try again" |
| 4 | "Save role" wiped the role's location every time (the form has no location box) | Only fields the form sent are updated |
| 5 | A role's "From your CV" line was saved without checking it was in the CV; an invented year passed if it appeared anywhere in the CV | Unverified lines are dropped and listed; dates are checked in the text around the job title |
| 6 | "Present" with a capital P produced a false "not a valid date" note | Case no longer matters |
| 7 | Items over the limits (15 results per role, 80 skills, 8 suggestions) vanished without a note | Listed under "What we left out" |
| 8 | Retry on an already confirmed upload reopened the review | Refused in the app and in the database |
| 9 | A story could point at a role that is not the user's; a failed save still said "Saved." | Role ownership checked; save errors show a message |
| 10 | Save buttons on the profile and proof pages hid database errors | Every save reports "Saving failed. Try again." |
| 11 | The login redirect leaked the page's query into the login URL and lost it on return | Fixed |
| 12 | Deleting an upload left its unreviewed facts floating with no way to confirm or remove them | Deleting an upload removes its unreviewed facts |
| 13 | The same role from two uploads appeared twice in review | The newer upload's version replaces the older unreviewed one; confirmed roles still never duplicate |
| 14 | A decided suggestion could be flipped back to pending and applied again, which duplicated stories | The update policy only reaches pending suggestions |
| 15 | The scoring rules function accepted nonsense: negative weights, a daily limit of 0, a queue threshold of 50 | Lower bounds and allowed values, also as table constraints |
| 16 | The profile snapshot was rebuilt once per saved row: 91 times for one CV read | Unreviewed rows no longer trigger a rebuild; at most 2 per read |
| 17 | Twelve user id and foreign key columns had no index (row level security filters on user id) | Indexes added |
| 18 | Accepting a title suggestion for a deleted role reported success and changed nothing; a negative role index pointed at the last role | Error instead; negative index skipped |
| 19 | Profile list fields could be set to JSON null and then never filled | Treated as empty; array constraint on the columns |

All fixes are in migration `20261018000002_audit_fixes.sql` and the commits of Oct 18. The audit tests stay in the suite (`supabase/tests/audit.test.mjs`, `apps/web/test/audit.test.ts`) so none of this can come back unnoticed.

A real CV read on Vercel end to end is now proven (see the live run below).

## Live approval run (Oct 18 2026, 20:35)

Yuval's CV `Yuval_Gross_Cosuno_GTM_Growth_Engineer.pdf` (3,309 characters of text) read on the preview in 40 seconds by `claude-sonnet-5-5`, 3,998 tokens in and 7,738 out. Earlier tries that day failed because the API account had no credit; that is now reported as "Reading CVs is paused" instead of a generic error.

| Check against cv-library.md | Result |
|---|---|
| Every saved fact quotes the CV word for word | pass, 50 of 50 |
| Job bullets saved as results | 12 of 12 |
| Results with their number | 11 of 12. The twelfth, "GTM foundation ... in three weeks", lost its number because the check only knew digits; number words now count (fixed after this run) |
| Roles and dates | 6 of 6: CloserStill / OEB Nov 2024 to present, Pragma Aug 2023 to present, CoachHub Nov 2021 to Sep 2024, Luns Jan 2017 to Jan 2020, Boogie Feb 2020 to Nov 2021, DotC 2016 (start only; the CV gives one year) |
| Locked numbers | 921k, 2.4x, 42%, 1.1M saved with their bullets. 390k and 17 to 5 are not in this CV version, so nothing to find |
| Profile | name, headline, Berlin, phone, email, LinkedIn and site links, 3 languages, education, certifications: all as written in the CV |
| Not on your record | no conflicts, but the list was empty at the time, so this check has not been exercised live yet. Manual comparison against the list in cv-library.md: none of the 32 skills is on it |
| Suggestions | 3: add "CRM scoring" and "paid user acquisition" (both quoted from bullets), shorten the Luns title to "Senior Key Account Manager" (no seniority added) |

Two observations, not failures:
- The screenshot Yuval sent showed a "Dedupe" suggestion that is no longer in the database: the reading ran twice and the second replaced the first's suggestions. The most likely cause is two clicks on "Try again", which started two paid readings. Starting a reading is now a single claim on the upload, so a second click while one is running does nothing.
- The education line reads Tel Aviv University, as the CV says. cv-library.md lists this as an open inconsistency with LinkedIn; the parser copies the CV faithfully and does not resolve it.

## Decisions you may want to change

1. **The API key now lives in Vercel, not the worker.** This changes what I told you in Gate 0. The CV is read inside the web app's server function, so the key has to be there. It is a server only, Sensitive variable, never sent to the browser. Moving it to the worker would mean the worker polling for uploads, which adds a moving part for no gain at this stage.
2. **Model: Sonnet 5.5** (`claude-sonnet-5-5`, change with `CV_PARSE_MODEL`). The approval query prints the real cost per parse. My estimate is a few cents.
3. **Target titles and their priorities move to Gate 2.** They only matter for scoring, so they get built with the scoring rules. Gate 1 covers the profile, skills and proof.
4. **The save function can be called directly by a signed in user.** Someone could skip the checks and write unchecked facts, but only into their own profile, still as suggested. It cannot touch anyone else's data.
5. **Suggestion kinds today:** add skill, ATS title, story. Other kinds from the mockups come with the gates that use them.

## Live database

Migration `cv_parsing` applied on Oct 18 2026. Yuval ran the file in the Supabase SQL editor, because the connector's approval prompt kept cancelling. Migration `audit_fixes` applied the same way on Oct 18 2026, 20:26. Checked afterwards: 5 of 5 scoring bounds, 3 of 3 profile list checks, 12 of 12 new indexes, 2 of 2 new triggers, the pending only suggestion policy, all three rewritten functions, and the cleanup function not callable by users. Security advisor unchanged (the same 4 intended warnings); performance advisor lists only indexes not used yet, expected with an almost empty database.

| Check on the live database | Result |
|---|---|
| New upload columns | 8 of 8 |
| New columns on roles, skills and stories | 5 of 5 |
| Status check on uploads | present |
| The 3 new functions | signed in users can call them, signed out visitors can't |
| Supabase security advisor | 4 warnings, all intended: the 3 new functions plus `set_scoring_config`. Each one writes only the caller's own rows. Leaked password protection doesn't apply, since sign in is by email link |

## What you need to do

1. ~~Database change `cv_parsing`~~ done. ~~Database change `audit_fixes`~~ done.
2. ~~API key in Vercel~~ done, preview redeployed with it. Steps kept for reference:
   - Project shortlist > Settings > Environment Variables > Add.
   - Name `ANTHROPIC_API_KEY`, value from console.anthropic.com > API Keys.
   - Tick Sensitive, then Production and Preview. Save.
   - Redeploy the preview: Deployments > latest gate-1 > ⋯ > Redeploy.
3. On the preview, open **Proof** and paste your Not on your record list.
4. On **Profile**, press **Try again** on the upload that failed (or upload your full master CV), wait for it to finish, and tell me.
   - I run the approval query and add the results here.
   - Expected: OEB/CloserStill Nov 2024 to present, Pragma Aug 2023 to present, CoachHub Nov 2021 to Sep 2024, Luns Jan 2017 to Jan 2020, plus earlier roles if listed.
   - Every metric in the CV saved with its number: €921k, 2.4x, 42%, €295k to €390k, 17 to 5 tools, €1.1M.
   - Nothing from Not on your record.
5. Optional: upload `apps/web/test/fixtures/fictional-cv.pdf` from a second address (gross.yuval+cv2@gmail.com) to see a stranger's experience.
6. Merge the pull request to approve.

## Next: Gate 2, scoring rules per user

Target titles with priorities, location points, weights and thresholds per user. Test: roles from past scans replay within 0.5 of the score the scheduled task gave them, and role fit is never raised to reach a threshold.

## Second review after merge (Oct 18 2026, evening)

A reviewer that had not seen any of the day's work read `main` cold and wrote 15 more tests (`apps/web/test/review.test.ts`, `supabase/tests/review.test.mjs`); 7 failed. 14 problems in total, none crossing user boundaries. Fixed in PR #4 and migration `20261018000003_review_fixes.sql`:

| # | Problem | Fix |
|---|---|---|
| 1 | High: a CV with the title and the dates on separate lines lost its dates (Yuval's CV keeps them on one line, so his read was fine) | Dates are checked in the text around the quoted line plus around the title |
| 2 | Two stints with the same title at one company in one CV were collapsed into one | The "newer upload replaces older" rule only touches earlier uploads |
| 3 | After a second unreviewed upload, confirming left facts from the first one waiting for review forever | Confirm confirms every unreviewed fact the review screen shows |
| 4 | A CV too long for one reading said "try again in a minute", which would repeat (and pay) forever | Says the CV is too long; skill quotes asked shorter to cut the output |
| 5 | New bullets under an already confirmed role were dropped silently on a second CV | Saved for review under that role |
| 6 | A Not on record item could be listed twice | One line per name |
| 7 | "twenty-five" was read as 20 and 5 | Read as 25 |
| 8 | "Try again" showed a minute before the server would accept it | Same limit on page and server |
| 9 | A failed second upload hid the whole confirmed profile | The failure shows above the profile |
| 10 | A title suggestion for a deleted role stayed as a dead button | Not offered |
| 11 | Role order mixed between uploads | Follows the role's position in the CV |
| 12 | Typing a skill that was already suggested did nothing | Confirms it |
| 13 | The approval check flagged roles without a quote, which is now correct behaviour | Check updated |
| 14 | Skip sign in works for anyone who can reach the site | Known, on the launch checklist |

Tests after the fixes: database 54 of 54, web 62 of 62, lint, types and build clean.
