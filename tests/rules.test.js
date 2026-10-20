// Unit tests for js/rules.js. Runs in two places:
//   - the browser: open tests/index.html
//   - the terminal on macOS: ./tests/run.sh (uses the built-in JavaScriptCore)
(function (root) {
  'use strict';

  const R = root.JamRules;
  const results = [];
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = new Date('2026-10-20T12:00:00Z').getTime();

  function test(name, fn) {
    try {
      fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, message: e.message });
    }
  }

  function eq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${label || 'value'}: expected ${b}, got ${a}`);
  }

  function ok(value, label) {
    if (!value) throw new Error(label || 'expected a truthy value');
  }

  const valid = {
    creator: 'Moss & Pixel',
    title: 'Lantern Ferry',
    category: 'Narrative',
    description: 'Guide a tiny ferry across a foggy river at night, one passenger at a time.',
    link: 'https://example.itch.io/lantern-ferry',
  };
  const withChange = (patch) => Object.assign({}, valid, patch);
  const ago = (days) => new Date(NOW - days * DAY).toISOString();

  // ---- entry validation ----

  test('a complete entry passes', () => {
    const r = R.validateEntry(valid, []);
    eq(r.ok, true, 'ok');
    eq(r.errors, {}, 'errors');
  });

  test('an empty form flags all five fields', () => {
    const r = R.validateEntry({}, []);
    eq(r.ok, false, 'ok');
    eq(Object.keys(r.errors).sort(), ['category', 'creator', 'description', 'link', 'title']);
  });

  test('whitespace-only values count as missing', () => {
    const r = R.validateEntry(withChange({ title: '   ', description: '\n\t ' }), []);
    ok(r.errors.title, 'title error');
    ok(r.errors.description, 'description error');
  });

  test('short description says how many more characters are needed', () => {
    const r = R.validateEntry(withChange({ description: 'x'.repeat(35) }), []);
    ok(/add 5 more characters/.test(r.errors.description), r.errors.description);
  });

  test('description length boundaries (40 ok, 600 ok, 601 too long)', () => {
    eq(R.validateEntry(withChange({ description: 'x'.repeat(40) }), []).ok, true, '40');
    eq(R.validateEntry(withChange({ description: 'x'.repeat(600) }), []).ok, true, '600');
    ok(R.validateEntry(withChange({ description: 'x'.repeat(601) }), []).errors.description, '601');
  });

  test('title length boundaries (3 ok, 2 short, 61 long)', () => {
    eq(R.validateEntry(withChange({ title: 'Orb' }), []).ok, true, '3');
    ok(R.validateEntry(withChange({ title: 'Ob' }), []).errors.title, '2');
    ok(R.validateEntry(withChange({ title: 'x'.repeat(61) }), []).errors.title, '61');
  });

  test('category must be one of the listed options', () => {
    ok(R.validateEntry(withChange({ category: 'Racing' }), []).errors.category);
    R.CATEGORIES.forEach((c) => eq(R.validateEntry(withChange({ category: c }), []).ok, true, c));
  });

  test('duplicate titles are caught regardless of case and spacing', () => {
    const existing = [{ id: 'DJ-1', title: 'Lantern Ferry' }];
    ok(R.validateEntry(withChange({ title: '  lantern FERRY ' }), existing).errors.title);
  });

  test('editing an entry does not clash with its own title', () => {
    const existing = [{ id: 'DJ-1', title: 'Lantern Ferry' }];
    eq(R.validateEntry(valid, existing, 'DJ-1').ok, true);
  });

  // ---- playable links ----

  test('accepts normal playable links', () => {
    [
      'https://example.itch.io/lantern-ferry',
      'http://games.example.org/play?id=42',
      'https://sub.domain.example.co.uk:8443/build/index.html#start',
      '  https://example.itch.io/game  ',
    ].forEach((link) => eq(R.isValidPlayableLink(link), true, link));
  });

  test('rejects links reviewers could not open', () => {
    [
      '',
      'example.itch.io/game',
      'www.example.com',
      'ftp://example.com/game.zip',
      'javascript:alert(1)',
      'https://localhost:3000',
      'https://my game.itch.io',
      'https://example',
      'C:\\Games\\build.exe',
    ].forEach((link) => eq(R.isValidPlayableLink(link), false, link));
  });

  // ---- review decisions ----

  test('organizer cannot skip feedback when requesting changes or declining', () => {
    ok(R.validateReview('submitted', 'changes_requested', ''), 'changes');
    ok(R.validateReview('in_review', 'declined', '   '), 'declined');
    eq(R.validateReview('in_review', 'declined', 'Made before the jam.'), null);
  });

  test('approving or starting review does not require feedback', () => {
    eq(R.validateReview('submitted', 'in_review', ''), null);
    eq(R.validateReview('in_review', 'approved', ''), null);
  });

  test('no status chosen is an error', () => {
    ok(R.validateReview('submitted', '', 'anything'));
  });

  test('invalid transitions are rejected', () => {
    ok(R.validateReview('approved', 'declined', 'x'), 'approved -> declined');
    ok(R.validateReview('changes_requested', 'approved', ''), 'changes -> approved');
    ok(R.validateReview('submitted', 'submitted', ''), 'same status');
  });

  test('every status offers the organizer at least one next step', () => {
    Object.keys(R.STATUS_LABELS).forEach((s) => ok(R.organizerOptions(s).length > 0, s));
  });

  test('only entries with requested changes can be resubmitted', () => {
    eq(Object.keys(R.STATUS_LABELS).filter(R.canResubmit), ['changes_requested']);
  });

  // ---- needs attention ----

  test('new and resubmitted entries always need attention', () => {
    ok(R.attentionReason({ status: 'submitted', updatedAt: ago(0) }, NOW));
    ok(R.attentionReason({ status: 'resubmitted', updatedAt: ago(0) }, NOW));
  });

  test('in-review entries need attention only after 2 days', () => {
    eq(R.attentionReason({ status: 'in_review', updatedAt: ago(1.9) }, NOW), null, '1.9 days');
    ok(R.attentionReason({ status: 'in_review', updatedAt: ago(2) }, NOW), '2 days');
  });

  test('decided or waiting-on-creator entries do not need attention', () => {
    ['approved', 'declined', 'changes_requested'].forEach((s) =>
      eq(R.attentionReason({ status: s, updatedAt: ago(30) }, NOW), null, s)
    );
  });

  test('attention reason shows how long a new entry has waited', () => {
    eq(R.attentionReason({ status: 'submitted', updatedAt: ago(3) }, NOW), 'New — waiting 3 days');
    eq(R.attentionReason({ status: 'submitted', updatedAt: ago(1) }, NOW), 'New — waiting 1 day');
  });

  test('attention list is oldest first and skips entries that are fine', () => {
    const list = R.needsAttention(
      [
        { id: 'a', status: 'submitted', updatedAt: ago(1) },
        { id: 'b', status: 'approved', updatedAt: ago(9) },
        { id: 'c', status: 'resubmitted', updatedAt: ago(4) },
        { id: 'd', status: 'in_review', updatedAt: ago(3) },
      ],
      NOW
    );
    eq(list.map((x) => x.entry.id), ['c', 'd', 'a']);
  });

  test('status counts include every status, even at zero', () => {
    const counts = R.countByStatus([{ status: 'approved' }, { status: 'approved' }, { status: 'submitted' }]);
    eq(counts, { submitted: 1, in_review: 0, changes_requested: 0, resubmitted: 0, approved: 2, declined: 0 });
  });

  root.JamTestResults = results;
})(typeof window !== 'undefined' ? window : globalThis);
