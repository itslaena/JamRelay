"""API + database tests for server.py. Run from the repo root:

    python3 -m unittest discover -s tests -v

Each test starts a real server on a free port with its own temporary SQLite
file, then talks to it over HTTP exactly like the browser does.
"""

import json
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

VALID = {
    "creator": "Smoke Test Studio",
    "title": "Moth Lamp",
    "category": "Puzzle",
    "description": "A tiny moth follows your lamp through a maze of curtains. Ten short levels.",
    "link": "https://example.itch.io/moth-lamp",
}


class ApiTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "test.db"
        self.start()

    def tearDown(self):
        self.stop()
        self.tmp.cleanup()

    def start(self):
        self.server = server.make_server(port=0, db_path=self.db_path, quiet=True)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def call(self, method, path, body=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req) as res:
                text = res.read()
                return res.status, (json.loads(text) if res.headers.get_content_type() == "application/json" else text)
        except urllib.error.HTTPError as e:
            with e:
                text = e.read()
            try:
                return e.code, json.loads(text)
            except ValueError:
                return e.code, text

    def submit(self, **changes):
        return self.call("POST", "/api/entries", {**VALID, **changes})

    def count(self):
        return len(self.call("GET", "/api/entries")[1]["entries"])


class MissingFields(ApiTestCase):
    def test_empty_submission_is_rejected_with_all_five_errors(self):
        before = self.count()
        status, body = self.call("POST", "/api/entries", {})
        self.assertEqual(status, 400)
        self.assertEqual(sorted(body["errors"]), ["category", "creator", "description", "link", "title"])
        self.assertEqual(self.count(), before, "nothing should be saved")

    def test_each_missing_field_is_named(self):
        for field in server.FIELDS:
            with self.subTest(field=field):
                status, body = self.submit(**{field: "   "})
                self.assertEqual(status, 400)
                self.assertEqual(list(body["errors"]), [field])

    def test_short_description_says_how_much_more(self):
        status, body = self.submit(description="Too short.")
        self.assertEqual(status, 400)
        self.assertIn("add 30 more characters", body["errors"]["description"])

    def test_unknown_category_is_rejected(self):
        self.assertEqual(self.submit(category="Racing")[0], 400)


class InvalidLinks(ApiTestCase):
    def test_bad_links_are_rejected(self):
        for link in [
            "example.itch.io/game",
            "www.example.com",
            "ftp://example.com/game.zip",
            "javascript:alert(1)",
            "https://localhost:3000",
            "https://my game.itch.io",
        ]:
            with self.subTest(link=link):
                status, body = self.submit(link=link, title=f"Game {abs(hash(link))}")
                self.assertEqual(status, 400)
                self.assertIn("link", body["errors"])

    def test_good_links_are_accepted(self):
        for i, link in enumerate([
            "https://example.itch.io/moth-lamp",
            "http://games.example.org/play?id=42",
            "https://sub.example.co.uk:8443/build/index.html#start",
        ]):
            with self.subTest(link=link):
                self.assertEqual(self.submit(link=link, title=f"Moth Lamp {i}")[0], 201)


class Submissions(ApiTestCase):
    def test_valid_submission_is_saved_as_new_with_history(self):
        status, body = self.submit(title="  Moth Lamp  ")
        self.assertEqual(status, 201)
        entry = body["entry"]
        self.assertEqual(entry["status"], "submitted")
        self.assertEqual(entry["title"], "Moth Lamp", "whitespace trimmed")
        self.assertEqual([h["to"] for h in entry["history"]], ["submitted"])

    def test_duplicate_title_is_rejected_ignoring_case(self):
        self.submit()
        status, body = self.submit(title="moth LAMP")
        self.assertEqual(status, 400)
        self.assertIn("already uses this title", body["errors"]["title"])

    def test_database_also_refuses_duplicate_titles(self):
        self.submit()
        con = sqlite3.connect(self.db_path)
        with self.assertRaises(sqlite3.IntegrityError):
            con.execute(
                "INSERT INTO entries VALUES ('DJ-999','x','MOTH LAMP','Puzzle','d','l','submitted','t','t')"
            )
        con.close()

    def test_malformed_json_is_rejected(self):
        self.assertEqual(self.call("POST", "/api/entries", raw=b"{not json")[0], 400)
        self.assertEqual(self.call("POST", "/api/entries", raw=b"[1,2]")[0], 400)


class ReviewsAndEdits(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.id = self.submit()[1]["entry"]["id"]

    def review(self, status, feedback=""):
        return self.call("POST", f"/api/entries/{self.id}/review", {"status": status, "feedback": feedback})

    def edit(self, **changes):
        return self.call("PUT", f"/api/entries/{self.id}", {**VALID, **changes})

    def test_requesting_changes_requires_feedback(self):
        status, body = self.review("changes_requested")
        self.assertEqual(status, 400)
        self.assertIn("Feedback is required", body["error"])
        self.assertEqual(self.call("GET", f"/api/entries/{self.id}")[1]["entry"]["status"], "submitted")

    def test_declining_requires_feedback(self):
        self.assertEqual(self.review("declined", "  ")[0], 400)

    def test_invalid_transition_is_rejected(self):
        self.review("approved")
        self.assertEqual(self.review("declined", "changed my mind")[0], 400)

    def test_cannot_edit_unless_changes_were_requested(self):
        status, _ = self.edit(description="Sneaky edit while waiting for review, which is not allowed.")
        self.assertEqual(status, 409)

    def test_full_edit_and_resubmit_loop(self):
        self.assertEqual(self.review("changes_requested", "Add a controls screen.")[0], 200)
        status, body = self.edit(
            description="A tiny moth follows your lamp through curtains. Now with a controls screen.",
            note="Added controls.",
        )
        self.assertEqual(status, 200)
        entry = body["entry"]
        self.assertEqual(entry["status"], "resubmitted")
        self.assertIn("controls screen", entry["description"])
        self.assertEqual(self.review("approved")[0], 200)
        history = self.call("GET", f"/api/entries/{self.id}")[1]["entry"]["history"]
        self.assertEqual([h["to"] for h in history], ["submitted", "changes_requested", "resubmitted", "approved"])
        self.assertEqual(history[1]["note"], "Add a controls screen.")
        self.assertEqual(history[2]["note"], "Added controls.")

    def test_invalid_edit_is_rejected_and_nothing_changes(self):
        self.review("changes_requested", "Fix the link.")
        status, body = self.edit(link="not a link")
        self.assertEqual(status, 400)
        self.assertIn("link", body["errors"])
        entry = self.call("GET", f"/api/entries/{self.id}")[1]["entry"]
        self.assertEqual(entry["status"], "changes_requested")
        self.assertEqual(entry["link"], VALID["link"])

    def test_entry_can_keep_its_own_title_when_edited(self):
        self.review("changes_requested", "Small fixes please.")
        self.assertEqual(self.edit()[0], 200)

    def test_unknown_entry_is_404(self):
        self.assertEqual(self.call("GET", "/api/entries/DJ-9999")[0], 404)
        self.assertEqual(self.call("POST", "/api/entries/DJ-9999/review", {"status": "approved"})[0], 404)


class SavedData(ApiTestCase):
    def test_data_survives_a_server_restart(self):
        entry_id = self.submit()[1]["entry"]["id"]
        self.call("POST", f"/api/entries/{entry_id}/review", {"status": "changes_requested", "feedback": "Needs a title screen."})
        self.stop()
        self.start()  # same database file, fresh server process state
        entry = self.call("GET", f"/api/entries/{entry_id}")[1]["entry"]
        self.assertEqual(entry["status"], "changes_requested")
        self.assertEqual(entry["history"][-1]["note"], "Needs a title screen.")

    def test_new_database_is_seeded_with_demo_entries(self):
        entries = self.call("GET", "/api/entries")[1]["entries"]
        self.assertEqual(len(entries), len(server.SEED))
        self.assertEqual({e["status"] for e in entries} >= {"submitted", "approved", "declined"}, True)

    def test_reset_restores_the_demo_data(self):
        self.submit()
        self.call("POST", "/api/reset")
        self.assertEqual(self.count(), len(server.SEED))


class StaticFiles(ApiTestCase):
    def test_app_files_are_served(self):
        self.assertEqual(self.call("GET", "/")[0], 200)
        self.assertEqual(self.call("GET", "/js/rules.js")[0], 200)

    def test_server_code_and_database_are_not_served(self):
        self.assertEqual(self.call("GET", "/server.py")[0], 404)
        self.assertEqual(self.call("GET", "/data/jamdesk.db")[0], 404)
        self.assertEqual(self.call("GET", "/js/../server.py")[0], 404)
        self.assertEqual(self.call("GET", "/js/%2e%2e/server.py")[0], 404)


if __name__ == "__main__":
    unittest.main()
