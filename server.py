#!/usr/bin/env python3
"""JamRelay server: serves the web app and a small JSON API backed by SQLite.

Standard library only. Run:  python3 server.py   then open http://localhost:8000

    Interface (browser)  --fetch JSON-->  API (this file)  --SQL-->  Database (data/jamrelay.db)

The API re-checks every rule the browser checks (js/rules.js), because the
browser can be bypassed: anyone can send a request straight to the API.
"""

import argparse
import json
import posixpath
import re
import sqlite3
import sys
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent
STATIC_DIRS = ("css/", "js/", "tests/")
STATIC_FILES = ("index.html",)

# ---------------------------------------------------------------- rules
# Mirrors js/rules.js. Keep the two in step; tests/test_api.py checks this side.

CATEGORIES = ["Action", "Puzzle", "Narrative", "Experimental", "Multiplayer"]
STATUS_LABELS = {
    "submitted": "New",
    "in_review": "In Review",
    "changes_requested": "Changes Requested",
    "resubmitted": "Resubmitted",
    "approved": "Approved",
    "declined": "Declined",
}
LIMITS = {"creator": (2, 40), "title": (3, 60), "description": (40, 600)}
ORGANIZER_NEXT = {
    "submitted": ["in_review", "changes_requested", "approved", "declined"],
    "resubmitted": ["in_review", "changes_requested", "approved", "declined"],
    "in_review": ["changes_requested", "approved", "declined"],
    "changes_requested": ["declined"],
    "approved": ["in_review"],
    "declined": ["in_review"],
}
NEEDS_FEEDBACK = ("changes_requested", "declined")
LINK_PATTERN = re.compile(
    r"^https?://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:\d{1,5})?([/?#]\S*)?$", re.I
)
FIELDS = ("creator", "title", "category", "description", "link")


def clean(value):
    return str(value if value is not None else "").strip()


def length_error(value, limits, noun):
    lo, hi = limits
    if len(value) < lo:
        more = lo - len(value)
        return f"{noun} is too short — add {more} more character{'' if more == 1 else 's'}."
    if len(value) > hi:
        return f"{noun} is {len(value) - hi} characters over the {hi} limit."
    return None


def validate_entry(data, title_taken):
    """Returns {field: message}. `title_taken(title)` checks the database."""
    errors = {}
    v = {f: clean(data.get(f)) for f in FIELDS}

    if not v["creator"]:
        errors["creator"] = "Add your name or team name."
    elif e := length_error(v["creator"], LIMITS["creator"], "Name"):
        errors["creator"] = e

    if not v["title"]:
        errors["title"] = "Add a title for your game."
    elif e := length_error(v["title"], LIMITS["title"], "Title"):
        errors["title"] = e
    elif title_taken(v["title"]):
        errors["title"] = "Another entry already uses this title. Pick a different one."

    if not v["category"]:
        errors["category"] = "Choose a category."
    elif v["category"] not in CATEGORIES:
        errors["category"] = "Choose one of the listed categories."

    if not v["description"]:
        errors["description"] = "Describe your game so reviewers know what to expect."
    elif e := length_error(v["description"], LIMITS["description"], "Description"):
        errors["description"] = e

    if not v["link"]:
        errors["link"] = "Add a link where reviewers can play your game."
    elif not LINK_PATTERN.match(v["link"]):
        errors["link"] = "Use a full web address, e.g. https://yourname.itch.io/your-game"

    return errors


def validate_review(from_status, to_status, feedback):
    if not to_status:
        return "Choose a new status."
    if to_status not in ORGANIZER_NEXT.get(from_status, []):
        return (
            f'An entry that is "{STATUS_LABELS.get(from_status, from_status)}" '
            f'can\'t move to "{STATUS_LABELS.get(to_status, to_status)}".'
        )
    if to_status in NEEDS_FEEDBACK and not clean(feedback):
        return (
            f'Feedback is required when marking an entry "{STATUS_LABELS[to_status]}" '
            "so the creator knows why."
        )
    return None


# ---------------------------------------------------------------- database

SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
  id            TEXT PRIMARY KEY,
  creator       TEXT NOT NULL,
  title         TEXT NOT NULL,
  category      TEXT NOT NULL,
  description   TEXT NOT NULL,
  link          TEXT NOT NULL,
  status        TEXT NOT NULL,
  submitted_at  TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
-- Titles are unique ignoring case, enforced by the database itself too.
CREATE UNIQUE INDEX IF NOT EXISTS entries_title_unique ON entries (lower(title));

-- Every submission, decision and resubmission is an event, so nothing is overwritten.
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id     TEXT NOT NULL REFERENCES entries(id),
  at           TEXT NOT NULL,
  actor        TEXT NOT NULL,      -- 'creator' | 'organizer'
  type         TEXT NOT NULL,      -- 'submitted' | 'status' | 'resubmitted'
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT ''
);
"""


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def now_iso():
    return iso(datetime.now(timezone.utc))


class DB:
    def __init__(self, path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as con:
            con.executescript(SCHEMA)
            if con.execute("SELECT COUNT(*) FROM entries").fetchone()[0] == 0:
                seed(con)

    @contextmanager
    def connect(self):
        """One connection per request: commits on success, rolls back on error, always closes."""
        con = sqlite3.connect(self.path)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        try:
            with con:
                yield con
        finally:
            con.close()

    # -- reads

    def _to_json(self, con, row):
        events = con.execute(
            "SELECT at, actor, type, from_status, to_status, note FROM events "
            "WHERE entry_id = ? ORDER BY id",
            (row["id"],),
        ).fetchall()
        return {
            "id": row["id"],
            "creator": row["creator"],
            "title": row["title"],
            "category": row["category"],
            "description": row["description"],
            "link": row["link"],
            "status": row["status"],
            "submittedAt": row["submitted_at"],
            "updatedAt": row["updated_at"],
            "history": [
                {
                    "at": e["at"],
                    "actor": e["actor"],
                    "type": e["type"],
                    "from": e["from_status"],
                    "to": e["to_status"],
                    "note": e["note"],
                }
                for e in events
            ],
        }

    def list(self):
        with self.connect() as con:
            rows = con.execute("SELECT * FROM entries ORDER BY id").fetchall()
            return [self._to_json(con, r) for r in rows]

    def get(self, entry_id):
        with self.connect() as con:
            row = con.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
            return self._to_json(con, row) if row else None

    @staticmethod
    def _title_taken(con, title, except_id=None):
        return (
            con.execute(
                "SELECT 1 FROM entries WHERE lower(title) = lower(?) AND id IS NOT ?",
                (title, except_id),
            ).fetchone()
            is not None
        )

    # -- writes. Each returns (entry, None) or (None, (http_status, error_body)).

    def create(self, data):
        with self.connect() as con:
            errors = validate_entry(data, lambda t: self._title_taken(con, t))
            if errors:
                return None, (400, {"errors": errors})
            n = con.execute(
                "SELECT COALESCE(MAX(CAST(substr(id, 4) AS INTEGER)), 100) + 1 FROM entries"
            ).fetchone()[0]
            entry_id, at = f"DJ-{n}", now_iso()
            v = {f: clean(data.get(f)) for f in FIELDS}
            con.execute(
                "INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?)",
                (entry_id, v["creator"], v["title"], v["category"], v["description"], v["link"], at, at),
            )
            con.execute(
                "INSERT INTO events (entry_id, at, actor, type, from_status, to_status) "
                "VALUES (?, ?, 'creator', 'submitted', NULL, 'submitted')",
                (entry_id, at),
            )
        return self.get(entry_id), None

    def resubmit(self, entry_id, data):
        with self.connect() as con:
            row = con.execute("SELECT status FROM entries WHERE id = ?", (entry_id,)).fetchone()
            if not row:
                return None, (404, {"error": "Entry not found."})
            if row["status"] != "changes_requested":
                return None, (409, {"error": "Only entries with requested changes can be resubmitted."})
            errors = validate_entry(data, lambda t: self._title_taken(con, t, entry_id))
            if errors:
                return None, (400, {"errors": errors})
            at = now_iso()
            v = {f: clean(data.get(f)) for f in FIELDS}
            con.execute(
                "UPDATE entries SET creator=?, title=?, category=?, description=?, link=?, "
                "status='resubmitted', updated_at=? WHERE id=?",
                (v["creator"], v["title"], v["category"], v["description"], v["link"], at, entry_id),
            )
            con.execute(
                "INSERT INTO events (entry_id, at, actor, type, from_status, to_status, note) "
                "VALUES (?, ?, 'creator', 'resubmitted', 'changes_requested', 'resubmitted', ?)",
                (entry_id, at, clean(data.get("note"))),
            )
        return self.get(entry_id), None

    def review(self, entry_id, data):
        with self.connect() as con:
            row = con.execute("SELECT status FROM entries WHERE id = ?", (entry_id,)).fetchone()
            if not row:
                return None, (404, {"error": "Entry not found."})
            to_status, feedback = clean(data.get("status")), clean(data.get("feedback"))
            problem = validate_review(row["status"], to_status, feedback)
            if problem:
                return None, (400, {"error": problem})
            at = now_iso()
            con.execute(
                "UPDATE entries SET status=?, updated_at=? WHERE id=?", (to_status, at, entry_id)
            )
            con.execute(
                "INSERT INTO events (entry_id, at, actor, type, from_status, to_status, note) "
                "VALUES (?, ?, 'organizer', 'status', ?, ?, ?)",
                (entry_id, at, row["status"], to_status, feedback),
            )
        return self.get(entry_id), None

    def reset(self):
        with self.connect() as con:
            con.execute("DELETE FROM events")
            con.execute("DELETE FROM entries")
            seed(con)


# ---------------------------------------------------------------- demo data
# Entirely fictional entries for the fictional "Driftwood Jam 2026".
# Each step is (days_ago, actor, to_status, note); dates are relative to now
# so the "needs attention" ages look right whenever the demo is started.

SEED = [
    ("Lantern Ferry", "Moss & Pixel", "Narrative",
     "Guide a tiny ferry across a foggy river at night. Each passenger tells a story, and your lantern only has enough oil for some of them.",
     [(3, "creator", "submitted", "")]),
    ("Spark Relay", "Team Quickfuse", "Multiplayer",
     "A two-player couch game where you pass a single spark between moving platforms before the timer burns out.",
     [(0.2, "creator", "submitted", "")]),
    ("Glowworm Garden", "Juniper Okafor", "Puzzle",
     "Light up a dark garden by routing glowworms through hedges. Thirty hand-made levels, each solvable in under two minutes.",
     [(6, "creator", "submitted", ""), (4, "organizer", "in_review", "")]),
    ("Candle Count", "R. Vasquez", "Experimental",
     "A one-button rhythm toy: blow out candles on the beat. The song changes depending on which candles you leave lit.",
     [(5, "creator", "submitted", ""),
      (3, "organizer", "changes_requested", "The build link opened a 404 page. Please re-upload and resubmit."),
      (1, "creator", "resubmitted", "Re-uploaded the build — the link works now.")]),
    ("Beacon Run", "Northgate Games Club", "Action",
     "Sprint between lighthouses and relight each beacon before the storm reaches the coast. Controller recommended.",
     [(4, "creator", "submitted", ""),
      (2, "organizer", "changes_requested", "Fun core loop! Please add a short controls screen — testers did not know how to jump.")]),
    ("The Last Firefly", "Ada Lindqvist", "Narrative",
     "A short interactive poem about the final firefly of summer. About ten minutes long, playable in the browser.",
     [(8, "creator", "submitted", ""), (6, "organizer", "in_review", ""),
      (5, "organizer", "approved", "Lovely writing and a clear fit for the theme. Approved for showcase.")]),
    ("Static Bloom", "Kit Moreau", "Experimental",
     "An audio-visual piece where flowers grow from radio static. Made before the jam started and lightly reskinned.",
     [(8, "creator", "submitted", ""),
      (6, "organizer", "declined", "Jam rules require games to be made during the jam window. Thank you for sharing it — we hope you join the next one.")]),
]


def seed(con):
    now = datetime.now(timezone.utc)
    for i, (title, creator, category, description, steps) in enumerate(SEED):
        entry_id = f"DJ-{101 + i}"
        slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
        times = [iso(now - timedelta(days=d)) for d, *_ in steps]
        con.execute(
            "INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (entry_id, creator, title, category, description,
             f"https://example.itch.io/{slug}", steps[-1][2], times[0], times[-1]),
        )
        prev = None
        for at, (_, actor, to, note) in zip(times, steps):
            kind = "submitted" if to == "submitted" else "resubmitted" if to == "resubmitted" else "status"
            con.execute(
                "INSERT INTO events (entry_id, at, actor, type, from_status, to_status, note) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (entry_id, at, actor, kind, prev, to, note),
            )
            prev = to


# ---------------------------------------------------------------- HTTP

ENTRY_PATH = re.compile(r"^/api/entries/(DJ-\d+)(/review)?$")


class Handler(SimpleHTTPRequestHandler):
    db = None  # set in make_server

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        if not getattr(self.server, "quiet", False):
            super().log_message(fmt, *args)

    def end_headers(self):
        # App files: let the browser cache them but check for a newer copy on each
        # load, so edits show up on a normal reload. (API replies set no-store.)
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 64_000:
            return None
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, UnicodeDecodeError):
            return None
        return data if isinstance(data, dict) else None

    def respond(self, result):
        entry, err = result
        if err:
            self.send_json(*err)
        else:
            self.send_json(200, {"entry": entry})

    # -- routes

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/entries":
            return self.send_json(200, {"entries": self.db.list()})
        if m := ENTRY_PATH.match(path):
            entry = self.db.get(m.group(1))
            return self.send_json(200, {"entry": entry}) if entry else self.send_json(404, {"error": "Entry not found."})
        if path.startswith("/api/"):
            return self.send_json(404, {"error": "Unknown API route."})
        # Only serve the app's own files — never server.py or the database.
        # Normalise first so "/js/../server.py" can't sneak past the allowlist.
        path = posixpath.normpath(unquote(path))
        rel = path.lstrip("/")
        if path == "/" or rel in STATIC_FILES or rel.startswith(STATIC_DIRS):
            self.path = path
            return super().do_GET()
        self.send_error(404)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/reset":
            self.db.reset()
            return self.send_json(200, {"ok": True})
        data = self.read_json()
        if data is None:
            return self.send_json(400, {"error": "Request body must be a JSON object."})
        if path == "/api/entries":
            entry, err = self.db.create(data)
            return self.send_json(*err) if err else self.send_json(201, {"entry": entry})
        m = ENTRY_PATH.match(path)
        if m and m.group(2) == "/review":
            return self.respond(self.db.review(m.group(1), data))
        self.send_json(404, {"error": "Unknown API route."})

    def do_PUT(self):
        m = ENTRY_PATH.match(self.path.split("?", 1)[0])
        if not m or m.group(2):
            return self.send_json(404, {"error": "Unknown API route."})
        data = self.read_json()
        if data is None:
            return self.send_json(400, {"error": "Request body must be a JSON object."})
        self.respond(self.db.resubmit(m.group(1), data))


def make_server(port=8000, db_path=ROOT / "data" / "jamrelay.db", quiet=False):
    handler = type("BoundHandler", (Handler,), {"db": DB(db_path)})
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.quiet = quiet
    return server


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run the JamRelay app and API.")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--db", default=str(ROOT / "data" / "jamrelay.db"), help="SQLite file path")
    args = parser.parse_args(argv)
    server = make_server(args.port, args.db)
    print(f"JamRelay running at http://localhost:{args.port}  (database: {args.db})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    sys.exit(main())
