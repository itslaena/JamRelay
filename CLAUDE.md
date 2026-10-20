# JamRelay — project notes for Claude

Portfolio project for a **PM internship application**. A small creator-submission and review tool for a **fictional** game jam ("Driftwood Jam 2026"). All content must stay fictional, with no real company branding. The code was written from scratch.

## What exists
- **Creator:** a submit form (title, category, description, playable link, name) with a live "Ready to submit?" checklist, a draft that autosaves, and "My entries" showing status and feedback, with edit and resubmit when changes are requested.
- **Organizer:** a dashboard with a "Needs your attention" queue (oldest first), and an entries table filtered by search, a Status dropdown (with counts) and category. The review screen changes status; feedback is required for *Changes requested* and *Declined*. Each entry keeps an append-only history.
- **Statuses:** submitted (shown as "New"), in_review, changes_requested, resubmitted, approved, declined. Allowed moves are in `ORGANIZER_NEXT`.

## Architecture (no installs; Python 3 standard library plus vanilla JS)
- `server.py`: serves the app and a JSON API, stores data in SQLite at `data/jamrelay.db` (gitignored) and seeds demo data. It re-validates everything, and only `index.html`, `css/`, `js/` and `tests/` are served (paths are normalized to block `../`).
- `js/rules.js`: the pure rules (validation, transitions, needs-attention). **These are mirrored in Python in `server.py`, so keep the two in sync.**
- `js/store.js`: the API client with an in-memory cache. `js/app.js`: the screens plus a hash router.
- API: `GET /api/entries`, `GET /api/entries/:id`, `POST /api/entries`, `PUT /api/entries/:id` (resubmit; 409 unless changes_requested), `POST /api/entries/:id/review`, `POST /api/reset`.

## Run and test
- Run: `python3 server.py`, then open http://localhost:8000
- `python3 -m unittest discover -s tests`: 23 API and database tests
- `./tests/run.sh`: 23 rule tests (macOS JavaScriptCore). Same tests in the browser at `/tests/index.html`
- `/tests/smoke.html` with the server running: 35 end-to-end browser checks (it resets the demo data)
- All of these passed as of 2026-10-20.

## Write-up (`WRITEUP.md`): the most important deliverable
Its six sections follow the user's rubric: the user's problem, scope cuts, acceptance criteria, quality checks, responding to feedback, and how the interface, API and database interact.
- **Section 5 (responding to feedback):** round 1 is an AI-assisted workflow test (2026-10-20), and it must stay labeled as AI-assisted, never as human participants. Round 2 (two real people) is still a placeholder. Never invent results; help the user fill it in after real sessions.
- Section 1 states that the user problems are assumptions, not research. Keep that honest.
- Next feature named in the write-up: checking that playable links actually load. After that: a "What changed" view for resubmissions.

## Status
- Committed on `main` and pushed to the public repo https://github.com/itslaena/JamRelay (renamed from JamDesk).
- The user's preferences: readable, larger font sizes, and plain-language explanations.
