# JamDesk: write-up

A small tool for running game jam submissions. Creators submit an entry, the organizer reviews it, and a dashboard shows what needs attention. The jam and every entry in it are fictional. Setup and code are in the [README](README.md).

---

## 1. The user and the problem

**Who struggles:** the organizer of a small online game jam, usually one or two volunteers handling dozens of entries around a deadline. The creators submitting are affected too.

**Why it's hard today:** with a generic form plus a spreadsheet (a common setup), three things go wrong:

1. **Entries arrive incomplete or unplayable.** There's no description, the link is missing `https://`, or it points to a private page. The organizer only finds out while reviewing, after the deadline, and then has to chase the creator by DM.
2. **The organizer loses track.** Status lives in a spreadsheet column that someone has to update by hand. Nothing shows which entries have waited longest or which came back after changes.
3. **Creators are left guessing.** They don't know whether their entry was seen, and a rejection often comes with no reason.

**The problem I chose:** *catch incomplete submissions before they reach the organizer, and make sure no entry gets stuck without a decision.* Everything in scope serves one of those two halves.

> These are my assumptions from how jams are typically run, not findings from research. Talking to two or three real organizers would be the first step before building further.

## 2. Scope: what I built, and what I deliberately left out

**Built:** a submission form with a live "Ready to submit?" checklist; a creator view with status and feedback, plus edit and resubmit; an organizer dashboard (a needs-attention queue, status tiles, search and filter); a review screen where feedback is required for negative decisions; and a full history of every entry.

| Left out | Why |
|---|---|
| **Accounts and login** | This is the biggest gap. Anyone can open the organizer dashboard. For a demo, the roles are separate pages and "My entries" is tracked per browser. Real auth adds a lot of work without changing the core flow I wanted to test. |
| **Checking that links actually load** | The app checks that a link is a well-formed public web address, not that the page works. A live check needs a server-side fetch with timeouts and handling for itch.io's private pages. Because broken links are the problem's #1 cause, **this is the first thing I'd add next.** |
| **Judging, scoring and ratings** | That's a separate job that happens after a jam. This tool stops at *accepted into the jam*. |
| **File uploads** | Jam games are almost always hosted on itch.io or similar, so a link covers the real case without storage or virus-scanning work. |
| **Email notifications** | Creators check status in the app. Email is useful but adds an outside service and failure cases. |
| **Multiple jams, multiple organizers, deadline enforcement** | One jam with one organizer keeps the data model simple. A deadline is a single date check to add later. |

## 3. Acceptance criteria: "flag missing information before submission"

This is the most important feature, because it attacks the first half of the problem directly.

| # | Given / When / Then | Verified by |
|---|---|---|
| AC1 | **Given** an empty form, **then** the checklist shows all five items (name, unique title, category, description, playable link) as needing attention before I type anything. | smoke test |
| AC2 | **When** I press Submit with anything missing, **then** nothing is saved, a summary lists every problem as a link to that field, and focus moves to the first problem. | smoke test |
| AC3 | **When** I'm typing in a field for the first time, **then** I don't see an error for it until I leave the field or try to submit. The checklist still updates live. | manual |
| AC4 | **When** my link isn't a full public web address (e.g. `itch.io/my-game`, `localhost`, `ftp://…`), **then** it's flagged with an example of the right format. | rule, API and smoke tests |
| AC5 | **When** my title matches an existing entry, ignoring capitalization and extra spaces, **then** it's flagged before I submit. | rule, API and smoke tests; also a database constraint |
| AC6 | **When** all five items are complete, **then** the checklist says I'm ready, and submitting saves the entry as **New** and shows a confirmation with the entry ID. | smoke test |
| AC7 | **When** someone skips the form and sends data straight to the API, **then** the same rules apply and the API returns the same field-by-field messages. | API tests |
| AC8 | **When** I leave the page halfway through, **then** my draft is still there when I come back. | manual |

## 4. How I checked quality

There are three layers of automated tests, plus manual checks in a real browser.

| Area | What was checked | Tests |
|---|---|---|
| **Missing fields** | An empty submission is rejected with all five errors and nothing saved. Each field is checked alone. Whitespace-only counts as missing. Messages give exact length guidance ("add 30 more characters"). | rules, API, smoke |
| **Invalid links** | Missing scheme, `www.` only, `ftp://`, `javascript:`, `localhost`, spaces and Windows file paths are rejected. Normal itch.io links, query strings, ports and subdomains are accepted. | rules, API, smoke |
| **Edits** | Resubmitting is only allowed after changes are requested (`409` otherwise). An invalid edit is rejected and leaves the entry unchanged. An entry can keep its own title. The full loop is checked: submitted → changes requested → resubmitted → approved. | API, smoke |
| **Saved data** | Data survives a page reload *and* a server restart against the same database file. History records every step with its feedback. A new database seeds itself, and reset restores it. | API, smoke |
| **Review rules** | Feedback is required to request changes or decline. Impossible status changes are blocked. | rules, API, smoke |
| **Safety** | A title containing HTML is shown as text, not run. The server won't serve its own code or the database file. | smoke, API |

**Totals:** 23 rule tests, 23 API and database tests, and 27 end-to-end browser checks, all passing. I also looked at every screen at desktop and phone width (390px).

**Problems I caught along the way:**

- **The server would hand out its own source code.** The API test `/js/../server.py` returned the file. I fixed it by normalizing the path before checking it against the list of files the app is allowed to serve, and added a test for the URL-encoded version too.
- **A single status option counted as chosen.** When an entry had only one possible next status, the review form treated that option as selected even when it wasn't checked. I found this while reviewing my own code. The fix reads the checked option directly, and a smoke-test check now covers it.
- **Link validation depended on the browser.** The first version used the browser's `URL` parser, which isn't available everywhere the rules run. I replaced it with one explicit pattern, used the same way in the browser and on the server and tested on both.

## 5. Responding to feedback

> **To fill in after a real session.** I haven't yet had someone else try JamDesk. I'm leaving this section as a plan rather than inventing results.

**Plan:** two people, about 10 minutes each, thinking aloud. One plays a creator, one plays the organizer. I watch and don't help.

1. *Creator:* "Submit your game. Here's the title, description and link." (Give them a link without `https://`.)
2. *Organizer:* "Which entry should you look at first, and why?"
3. *Organizer:* "Ask the creator of Beacon Run to add a controls screen." Then *creator:* "Find out what the organizer wants and fix it."

| What I observed | What I changed | Why |
|---|---|---|
| *(fill in)* | *(fill in)* | *(fill in)* |

## 6. How the interface, API and database work together

```
┌──────────────────────┐   fetch(JSON)   ┌──────────────────────┐    SQL    ┌─────────────────────┐
│ Interface (browser)  │ ──────────────> │ API  (server.py)     │ ────────> │ Database (SQLite)   │
│ app.js   screens     │ <────────────── │ checks the rules     │ <──────── │ entries  (current)  │
│ store.js API calls   │  entry / errors │ again, then saves    │           │ events   (history)  │
│ rules.js instant     │                 │                      │           │                     │
│          feedback    │                 │                      │           │                     │
└──────────────────────┘                 └──────────────────────┘           └─────────────────────┘
```

**One request, end to end (an organizer requests changes):**

1. The organizer picks *Changes requested*, types feedback and saves. `rules.js` checks right away in the browser that feedback isn't empty, so the user gets an instant answer without waiting on the network.
2. `store.js` sends `POST /api/entries/DJ-105/review` with `{status, feedback}`.
3. `server.py` loads the entry's current status and **checks the same rules again**. The browser can't be trusted: anyone can send a request directly. If the change isn't allowed, it returns `400` with a message, and the page shows that message under the form.
4. If the change is allowed, a single database transaction updates the entry's status in `entries` **and** appends a row to `events` with who did what, when, and the feedback. Either both writes happen or neither does.
5. The API returns the updated entry, and the page re-renders. When the creator opens *My entries*, the browser fetches the entry and shows the feedback from `events`.

**Design choices worth noting:**

- **History is append-only.** Decisions are new rows, never overwrites, so the creator and organizer always see the full conversation, and nothing is lost if someone changes their mind.
- **Title uniqueness is enforced twice.** The API checks it and returns a friendly message, and the database has a case-insensitive unique index as a backstop.
- **Trade-off:** the rules exist in both JavaScript and Python, so they can drift apart. They're kept side by side and tested on both sides. In a larger product I'd generate both from one shared definition, or only validate on the server and accept the slower feedback.
- **"Needs attention" is computed, not stored.** New and resubmitted entries always qualify, and *In review* entries qualify after two days without a decision. Because it's calculated on each page load from timestamps, it can't go stale.
