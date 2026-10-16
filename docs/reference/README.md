# Reference: the scheduled task setup this platform must match

The platform is built to reproduce what Yuval's scheduled job scan already does, then improve on it.
Every gate is tested against these. They stay the source of truth until a gate replaces them.

| Spec | Where it lives | Used by gate |
|---|---|---|
| Scan task prompt (scoring, location points, validation, CV trigger, board updates, email format) | `scan-task-prompt.md` in this folder (redacted copy, password and salt removed) | 2, 3, 4, 6 |
| CV tailoring rules, sections 0 to 6, rubric, 9/10 bar | Project doc `claude/cv-library/tailoring-rules.md` | 5 |
| Confirmed facts, "Not on your record" list, locked wording | Project doc `claude/cv-library/cv-library.md` | 1, 5 |
| CV template engine (layout, fonts, checks) | Project doc `claude/cv-library/cv_engine.py` | 5 |
| Job sources, ATS list URLs, watchlist, hidden market signals, benchmark role | Project doc `claude/job-sources.md` | 2, 3 |
| Past runs and roles found | Project doc `claude/job-scan-log.md` | 2, 3 |
| Job Hunt Board data model (open, apps, cvs, runs, leads, skills) | Project doc `claude/board/refresh-board.md` and the board artifact | 6 |

The Project docs are not copied here on purpose: copies drift. Each gate reads the current version when it runs its comparison.
