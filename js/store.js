// JamRelay data layer: talks to the JSON API in server.py.
//
// Keeps an in-memory copy of the entries so the UI can read synchronously
// (e.g. the duplicate-title check on every keystroke). The router calls
// refresh() before each page render; writes go to the API and update the copy.
//
// The only thing kept in the browser is which entries *this* browser submitted
// ("My entries") and unsent form drafts — there are no accounts in this demo.
(function (root) {
  'use strict';

  const MINE_KEY = 'jamrelay.mine.v1';
  const DRAFT_KEY = 'jamrelay.draft.v1';

  let entries = [];

  const draftKey = (id) => (id ? `${DRAFT_KEY}.${id}` : DRAFT_KEY);

  // Error thrown for any non-2xx API response. `errors` holds per-field
  // messages for validation failures; `message` is a general one.
  class ApiError extends Error {
    constructor(status, body) {
      super((body && body.error) || 'Something went wrong. Please try again.');
      this.status = status;
      this.errors = (body && body.errors) || null;
    }
  }

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError(0, { error: 'Can’t reach the JamRelay server. Is it running? (python3 server.py)' });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  function upsert(entry) {
    const i = entries.findIndex((e) => e.id === entry.id);
    if (i >= 0) entries[i] = entry;
    else entries.push(entry);
    return entry;
  }

  // ---- local-only bits (wrapped: storage can be blocked in private windows)

  function read(key) {
    try {
      return JSON.parse(root.localStorage.getItem(key));
    } catch (e) {
      return null;
    }
  }

  // Returns false when the browser won't store it, so the UI can say so honestly.
  function write(key, value) {
    try {
      root.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function remove(key) {
    try {
      root.localStorage.removeItem(key);
    } catch (e) {
      /* ignore */
    }
  }

  function mineIds() {
    return read(MINE_KEY) || [];
  }

  // ---- public API

  async function refresh() {
    entries = (await api('GET', '/api/entries')).entries;
  }

  function all() {
    return entries;
  }

  function get(id) {
    return entries.find((e) => e.id === id) || null;
  }

  function isMine(id) {
    return mineIds().includes(id);
  }

  function mine() {
    const ids = mineIds();
    return entries.filter((e) => ids.includes(e.id));
  }

  // `tracked` is false when this browser couldn't remember the entry for "My entries".
  async function create(input) {
    const { entry } = await api('POST', '/api/entries', input);
    const tracked = write(MINE_KEY, mineIds().concat(entry.id));
    return { entry: upsert(entry), tracked };
  }

  async function resubmit(id, input, note) {
    const { entry } = await api('PUT', '/api/entries/' + encodeURIComponent(id), Object.assign({}, input, { note }));
    return upsert(entry);
  }

  async function setStatus(id, status, feedback) {
    const { entry } = await api('POST', '/api/entries/' + encodeURIComponent(id) + '/review', { status, feedback });
    return upsert(entry);
  }

  async function reset() {
    await api('POST', '/api/reset');
    remove(MINE_KEY);
    // Entry ids restart after a reset, so drop every draft, not just the new-entry one.
    try {
      Object.keys(root.localStorage)
        .filter((k) => k.startsWith(DRAFT_KEY))
        .forEach(remove);
    } catch (e) {
      /* ignore */
    }
    await refresh();
  }

  root.JamStore = {
    ApiError,
    refresh,
    all,
    get,
    mine,
    isMine,
    create,
    resubmit,
    setStatus,
    reset,
    // Pass an entry id for a resubmission draft; omit it for the new-entry form.
    saveDraft: (draft, id) => write(draftKey(id), draft),
    loadDraft: (id) => read(draftKey(id)),
    clearDraft: (id) => remove(draftKey(id)),
  };
})(window);
