# Gate 2: scoring rules

Point 2 of the plan: what a 7/10 and a 9/10 mean for this user, and a score built the way the job scan builds it.

## What is in this gate

| Part | Where | PR |
|---|---|---|
| Fit factors after role fit and location: pay band, team size, sales ops, run and report, ops years gap, the minus 1 cap, CV bar 8.5 for run and report | `supabase/migrations/20261030000001_scoring_factors.sql` | #7 |
| Score one pasted job, private pasted jobs, recent rejection flag | `supabase/migrations/20261031000001_score_pasted_job.sql`, `apps/web/src/lib/score/` , `/app/jobs` | this PR |
| Targets screen (titles, salary floor, blocklist, languages, places to move to) | `/app/targets` | this PR |
| Rules screen (9/7/5/3 anchors, ideal role, location points, factor values, bars; each save is a new version) | `/app/rules` | this PR |

## Personal rules start switched off (Yuval, 10-30)

Shortlist is for anyone looking for work, so one person's search habits are not the default. New users start with:
- pay band on (minus 1.5 below the floor, 0 inside, plus 0.5 at or above), compared with their own floor;
- team size points, the sales ops, run and report and ops years deductions, and any higher CV bar at 0 (off).

Each user switches on their own personal rules in Rules. Yuval's scan values are entered there like any other user's; the tests set them explicitly.

## How a score is built

1. The matching model reads the confirmed profile (roles, results, skills), the Not on your record list, the user's 9/7/5/3 anchors, the ideal role and the location rules, then the job ad.
2. It returns a role fit (work only) and labels, each with a quote from the ad: salary, headcount, location rule, role shape, sales ops, run and report, ops years gap, required languages.
3. Code checks every quote against the ad. A label whose quote is not in the ad is dropped and listed under "What the checks removed". Ops years gap also needs a quote that asks 5 or more years.
4. Numbers must be in their quote: pay amounts in the pay quote, the headcount in the headcount quote. A role shape needs its own quote before team size points apply. Pay with an unclear period (not stated as yearly or monthly) is not compared. A range such as "3-5 years" asks for its lower end. A role fit off the 0 to 10 scale is refused.
5. Code decides the pay band against the salary floor (call pay beats the ad; other currencies and hourly pay are not compared; OTE only counts as half), the team size label from the headcount (typed headcount beats the ad), and the location points from the rule the ad backs.
6. The database trigger turns the labels into points with the user's active rules version and computes the total and the CV bar.

The model never sees the CV bar, the queue bar or any points, so it has no reason to push a role fit toward a bar. Role fit is stored exactly as returned, only rounded to the nearest half.

## Tests

- Database: `supabase/tests/score-pasted-job.test.mjs` (12 tests) plus `gate-2-scoring.test.mjs`.
  - Pasted jobs and companies are invisible to other users; users cannot insert jobs, companies or matches directly; removing a pasted job removes its score.
  - Scan replay: 14 fit lines from `claude/job-scan-log.md` (Kubermatic 10, Cygrid 10, REMATIQ 9.5, Checkpoint GTM 9.5, Platform Engineering 9, Legartis 8.5, Lucanet 8, vCluster 7.5, NavVis 7.5, OpenUp 7, Brighter AI 6.5, Coverflex 6.5, Dandy 6, ML6 7) come out with the same total. Checkpoint GTM was scored before the team size rule of 10-28, so it is replayed with team size unknown.
- Web: `apps/web/test/score.test.ts` (47 tests): quote checks, pay bands (Coverflex, Checkpoint, Gigs, Wingify OTE, vCluster GBP), team size, dropped labels, role fit rounding, fit line wording, the full run with a fake database and model (the message to the model contains no `cv_threshold`), and the SDK call.

## Cold review (10-30)

A separate review found no data leak between users and no way to write another user's rows. It found 13 defects; all but two are fixed in this PR, each with a test:
- High: decimal pay amounts and pay typed high to low made saving fail; valid but wide Rules settings could make every score fail (the point columns now hold the full range).
- Medium: "70.000" read as 70 in the form; role shape, pay amounts and headcount could give points without a matching quote; unclear pay periods treated as yearly; "3-5 years" counted as 5.
- Low: role fit on a 0 to 100 scale clamped to 10 (now refused); very short quotes accepted (now 8 characters at least); Cyprus 1.25 stored as 1.3 (now two decimals).
- Not fixed, noted: another user can store a reference to a private pasted job id in their own watchlist or application (nothing becomes readable; ids are random). The future worker must skip pasted jobs (`added_by is not null`) when it matches or verifies jobs for everyone (Gate 3).

## Approval test still to run live

The replay above checks the arithmetic with the scan's own role fits. The live part checks the matching model's role fit:

1. Enter your Targets (salary floor EUR 70000) and Rules (your personal rules: team size plus 0.5 under 150 and minus 0.5 over 300, sales ops, run and report and ops years gap minus 0.5 each, cap minus 1, CV bar 8.5 for run and report; location points from the scan rule of 10-17: Berlin 1.5, remote anywhere in the EU 1.5, Spain remote 1.5, Cyprus 1.25, Malta 1, Netherlands remote 0.75, Southern Europe remote 0.5, other EU city 0; ideal role from job-sources.md section 5).
2. Paste five ads the scan scored, for example Kubermatic, Lucanet, Dandy, vCluster Labs and Checkpoint GTM.
3. Pass: each total within 0.5 of the scan's total, and no role fit that only reaches a bar after rounding.

## Notes

- A pasted job's score belongs to the user who pasted it, so `score_pasted_job()` accepts the numbers from the web app. A user calling it directly can only change their own pasted scores.
- The recent rejection flag reads the Applications table. It stays empty until applications are imported (Gate 6, or the one time import offered on 10-30).
