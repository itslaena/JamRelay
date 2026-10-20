// JamRelay UI: hash-routed views for creators and the organizer.
(function () {
  'use strict';

  const R = window.JamRules;
  const S = window.JamStore;
  const view = document.getElementById('view');
  const FIELDS = ['creator', 'title', 'category', 'description', 'link'];

  let flash = null; // one-time banner shown on the next render

  // ---------- helpers ----------

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]);
  }

  function fmtDate(iso) {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function badge(status) {
    return `<span class="badge badge--${status}">${esc(R.STATUS_LABELS[status])}</span>`;
  }

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  function takeFlash() {
    const f = flash;
    flash = null;
    return f ? `<div class="flash" role="status">${esc(f)}</div>` : '';
  }

  function setActiveNav(name) {
    document.querySelectorAll('[data-nav]').forEach((a) => {
      if (a.dataset.nav === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  // ---------- creator: submit / edit form ----------

  // Draft status line: confirm the save, or warn when the browser blocks storage.
  function showSaved(ok, message) {
    const el = document.getElementById('draft-status');
    el.textContent = ok ? message : 'This browser isn’t letting the page save drafts, so your changes will be lost if you leave.';
    el.classList.toggle('save-warning', !ok);
  }

  function formHtml(values, mode) {
    const v = values || {};
    const opts = R.CATEGORIES.map(
      (c) => `<option value="${esc(c)}"${v.category === c ? ' selected' : ''}>${esc(c)}</option>`
    ).join('');
    const L = R.LIMITS;
    return `
      <div class="form-layout">
        <form id="entry-form" class="card" novalidate>
          <div id="error-summary" class="error-summary" role="alert" hidden></div>

          <div class="field">
            <label for="f-creator">Your name or team name</label>
            <input id="f-creator" name="creator" autocomplete="name" maxlength="${L.creator.max + 20}" value="${esc(v.creator)}" aria-describedby="e-creator">
            <p class="error" id="e-creator"></p>
          </div>

          <div class="field">
            <label for="f-title">Game title</label>
            <input id="f-title" name="title" maxlength="${L.title.max + 20}" value="${esc(v.title)}" aria-describedby="h-title e-title">
            <p class="hint" id="h-title">${L.title.min}–${L.title.max} characters. Must be unique in this jam.</p>
            <p class="error" id="e-title"></p>
          </div>

          <div class="field">
            <label for="f-category">Category</label>
            <select id="f-category" name="category" aria-describedby="e-category">
              <option value="">Choose a category…</option>${opts}
            </select>
            <p class="error" id="e-category"></p>
          </div>

          <div class="field">
            <label for="f-description">Description</label>
            <textarea id="f-description" name="description" rows="5" aria-describedby="h-description e-description">${esc(v.description)}</textarea>
            <p class="hint" id="h-description">What is it, and how do you play? <span id="desc-count"></span></p>
            <p class="error" id="e-description"></p>
          </div>

          <div class="field">
            <label for="f-link">Playable link</label>
            <input id="f-link" name="link" type="url" inputmode="url" placeholder="https://yourname.itch.io/your-game" value="${esc(v.link)}" aria-describedby="h-link e-link">
            <p class="hint" id="h-link">Where reviewers can play it in a browser or download a build.</p>
            <p class="error" id="e-link"></p>
          </div>

          ${
            mode === 'resubmit'
              ? `<div class="field">
                  <label for="f-note">What did you change? <span class="optional">(optional)</span></label>
                  <textarea id="f-note" name="note" rows="3">${esc(v.note)}</textarea>
                </div>`
              : ''
          }

          <div class="actions">
            <button type="submit" class="btn btn--primary">${mode === 'resubmit' ? 'Resubmit for review' : 'Submit entry'}</button>
            <span class="muted" id="draft-status">${mode === 'resubmit' ? 'Your changes save automatically.' : 'Drafts save automatically.'}</span>
          </div>
        </form>

        <aside class="card checklist" aria-labelledby="checklist-title">
          <h2 id="checklist-title">Ready to submit?</h2>
          <ul id="checklist"></ul>
          <p class="muted small" id="checklist-summary"></p>
        </aside>
      </div>`;
  }

  const CHECK_LABELS = {
    creator: 'Name or team',
    title: 'Unique title',
    category: 'Category',
    description: 'Description',
    link: 'Playable link',
  };

  function readForm(form) {
    const data = {};
    FIELDS.forEach((f) => (data[f] = form.elements[f].value));
    return data;
  }

  // Wires up live validation. `touched` fields show inline errors; the checklist
  // always reflects the current state so gaps are visible before submitting.
  function bindForm(form, opts) {
    const touched = new Set();
    let attempted = false;
    const summary = document.getElementById('error-summary');
    const button = form.querySelector('button[type=submit]');
    // Which fields the error summary currently lists, so it can be kept up to date.
    let summaryFields = '';

    // `evt` is set only for real edits, so the initial render doesn't count as a change.
    function update(evt) {
      const data = readForm(form);
      const { errors } = R.validateEntry(data, S.all(), opts.selfId);

      FIELDS.forEach((f) => {
        const show = (attempted || touched.has(f)) && errors[f];
        const el = form.elements[f];
        document.getElementById('e-' + f).textContent = show ? errors[f] : '';
        el.setAttribute('aria-invalid', show ? 'true' : 'false');
      });

      const list = document.getElementById('checklist');
      list.innerHTML = FIELDS.map((f) => {
        const ok = !errors[f];
        return `<li class="${ok ? 'ok' : 'missing'}">
            <span class="mark" aria-hidden="true">${ok ? '✓' : '!'}</span>
            <span><strong>${CHECK_LABELS[f]}</strong>${ok ? '' : `<br><span class="small">${esc(errors[f])}</span>`}</span>
            <span class="sr-only">${ok ? 'complete' : 'needs attention'}</span>
          </li>`;
      }).join('');
      const missing = Object.keys(errors).length;
      document.getElementById('checklist-summary').textContent = missing
        ? `${missing} item${missing === 1 ? '' : 's'} still need${missing === 1 ? 's' : ''} attention.`
        : 'Everything looks good. You can submit.';

      const len = data.description.trim().length;
      document.getElementById('desc-count').textContent = `${len} / ${R.LIMITS.description.max}`;

      if (summaryFields) renderSummary(errors);
      if (evt && opts.onChange) opts.onChange(data);
      return errors;
    }

    form.addEventListener('input', update);
    form.addEventListener('change', update);
    form.addEventListener(
      'blur',
      (e) => {
        if (FIELDS.includes(e.target.name)) {
          touched.add(e.target.name);
          update();
        }
      },
      true
    );

    // Lists the remaining problems, dropping each one as it's fixed and hiding
    // the summary once none are left. Only redraws when the list changes.
    function renderSummary(errors) {
      const bad = FIELDS.filter((f) => errors[f]);
      const key = bad.map((f) => f + ':' + errors[f]).join('|');
      if (key === summaryFields) return;
      summaryFields = key;
      summary.hidden = !bad.length;
      summary.innerHTML = bad.length
        ? `<strong>Please fix ${bad.length} thing${bad.length === 1 ? '' : 's'} before submitting:</strong><ul>` +
          bad.map((f) => `<li><a href="#" data-focus="${f}">${esc(errors[f])}</a></li>`).join('') +
          '</ul>'
        : '';
    }

    function showErrors(errors) {
      const bad = FIELDS.filter((f) => errors[f]);
      bad.forEach((f) => {
        document.getElementById('e-' + f).textContent = errors[f];
        form.elements[f].setAttribute('aria-invalid', 'true');
      });
      summaryFields = '';
      renderSummary(errors);
      form.elements[bad[0]].focus();
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      attempted = true;
      const errors = update();
      if (Object.keys(errors).length) return showErrors(errors);
      summaryFields = '';
      summary.hidden = true;
      button.disabled = true;
      try {
        await opts.onSubmit(readForm(form), form.elements.note ? form.elements.note.value : '');
      } catch (err) {
        // The server re-validates; show its field errors the same way, or a general message.
        if (err.errors) showErrors(err.errors);
        else {
          summaryFields = '';
          summary.hidden = false;
          summary.textContent = err.message;
        }
      } finally {
        button.disabled = false;
      }
    });

    form.addEventListener('click', (e) => {
      const link = e.target.closest('[data-focus]');
      if (link) {
        e.preventDefault();
        form.elements[link.dataset.focus].focus();
      }
    });

    update();
  }

  function renderSubmit() {
    setActiveNav('submit');
    const draft = S.loadDraft() || {};
    view.innerHTML = `
      ${takeFlash()}
      <header class="page-head">
        <h1>Submit your entry</h1>
        <p class="lede">Driftwood Jam 2026 · Theme: <em>“Small Light”</em>. Fill in all five items — the checklist shows what’s still missing.</p>
      </header>
      ${formHtml(draft, 'create')}`;

    bindForm(document.getElementById('entry-form'), {
      onChange(data) {
        showSaved(S.saveDraft(data), 'Draft saved.');
      },
      async onSubmit(data) {
        const { entry, tracked } = await S.create(data);
        S.clearDraft();
        if (tracked) {
          flash = `Submitted! “${entry.title}” is now waiting for review (${entry.id}).`;
          go('#/mine/' + entry.id);
        } else {
          // The entry is saved on the server, but this browser can't list it under
          // "My entries", so confirm here and give the creator the ID to keep.
          flash = `Submitted! “${entry.title}” is now waiting for review. Your entry ID is ${entry.id}. This browser couldn’t save it to “My entries”, so keep the ID somewhere.`;
          go('#/submit');
        }
      },
    });
  }

  // ---------- creator: my entries ----------

  function renderMine() {
    setActiveNav('mine');
    const entries = S.mine().slice().reverse();
    view.innerHTML = `
      ${takeFlash()}
      <header class="page-head">
        <h1>My entries</h1>
        <p class="lede">Entries submitted from this browser.</p>
      </header>
      ${
        entries.length
          ? `<ul class="entry-list">${entries
              .map(
                (e) => `<li class="card entry-row">
                  <a href="#/mine/${esc(e.id)}"><strong>${esc(e.title)}</strong></a>
                  ${badge(e.status)}
                  <span class="muted small">${esc(e.id)} · ${esc(e.category)} · updated ${fmtDate(e.updatedAt)}</span>
                  ${R.canResubmit(e.status) ? '<span class="callout-inline">Action needed: see feedback</span>' : ''}
                </li>`
              )
              .join('')}</ul>`
          : `<div class="card empty">
              <p>You haven’t submitted anything yet.</p>
              <a class="btn btn--primary" href="#/submit">Submit an entry</a>
            </div>`
      }`;
  }

  function historyHtml(entry, audience) {
    const items = entry.history
      .slice()
      .reverse()
      .map((h) => {
        let what;
        if (h.type === 'submitted') what = 'Submitted';
        else if (h.type === 'resubmitted') what = 'Resubmitted by creator';
        else what = `Marked ${badge(h.to)}`;
        const who = h.actor === 'organizer' ? (audience === 'creator' ? 'Organizer' : 'You') : 'Creator';
        return `<li>
            <div class="tl-head"><span>${what}</span><span class="muted small">${esc(who)} · ${fmtDate(h.at)}</span></div>
            ${h.note ? `<blockquote>${esc(h.note)}</blockquote>` : ''}
          </li>`;
      })
      .join('');
    return `<section class="card"><h2>History &amp; feedback</h2><ol class="timeline">${items}</ol></section>`;
  }

  function detailsHtml(entry) {
    return `
      <section class="card details">
        <dl>
          <div><dt>Creator</dt><dd>${esc(entry.creator)}</dd></div>
          <div><dt>Category</dt><dd>${esc(entry.category)}</dd></div>
          <div><dt>Submitted</dt><dd>${fmtDate(entry.submittedAt)}</dd></div>
          <div><dt>Playable link</dt><dd><a href="${esc(entry.link)}" target="_blank" rel="noopener noreferrer">${esc(entry.link)}</a></dd></div>
        </dl>
        <h2>Description</h2>
        <p class="prewrap">${esc(entry.description)}</p>
      </section>`;
  }

  function latestFeedback(entry) {
    for (let i = entry.history.length - 1; i >= 0; i--) {
      const h = entry.history[i];
      if (h.actor === 'organizer' && h.note) return h.note;
    }
    return '';
  }

  function renderMineDetail(id) {
    setActiveNav('mine');
    const entry = S.get(id);
    if (!entry || !S.isMine(id)) return renderNotFound();

    const needsAction = R.canResubmit(entry.status);
    if (!needsAction) S.clearDraft(entry.id);
    const draft = needsAction ? S.loadDraft(entry.id) : null;
    view.innerHTML = `
      ${takeFlash()}
      <p><a href="#/mine">← My entries</a></p>
      <header class="page-head">
        <h1>${esc(entry.title)} ${badge(entry.status)}</h1>
        <p class="lede muted">${esc(entry.id)}</p>
      </header>
      ${
        needsAction
          ? `<div class="callout">
              <h2>The organizer asked for changes</h2>
              <blockquote>${esc(latestFeedback(entry))}</blockquote>
              <p>Update your entry below and resubmit — it goes straight back into the review queue.</p>
            </div>
            ${formHtml(Object.assign({}, entry, draft), 'resubmit')}`
          : detailsHtml(entry)
      }
      ${historyHtml(entry, 'creator')}`;

    if (needsAction) {
      const form = document.getElementById('entry-form');
      bindForm(form, {
        selfId: entry.id,
        onChange(data) {
          showSaved(
            S.saveDraft(Object.assign({}, data, { note: form.elements.note.value }), entry.id),
            'Changes saved. You can leave and come back.'
          );
        },
        async onSubmit(data, note) {
          await S.resubmit(entry.id, data, note);
          S.clearDraft(entry.id);
          flash = 'Resubmitted. The organizer will take another look.';
          go('#/mine/' + entry.id);
        },
      });
    }
  }

  // ---------- organizer: dashboard ----------

  const dashFilter = { status: '', category: '', q: '' };

  function renderDashboard() {
    setActiveNav('dashboard');
    const now = Date.now();
    const entries = S.all();
    const counts = R.countByStatus(entries);
    const attention = R.needsAttention(entries, now);

    const statuses = [
      { key: '', label: 'All statuses', n: entries.length },
      { key: 'submitted', label: 'New', n: counts.submitted },
      { key: 'resubmitted', label: 'Resubmitted', n: counts.resubmitted },
      { key: 'in_review', label: 'In review', n: counts.in_review },
      { key: 'changes_requested', label: 'Waiting on creator', n: counts.changes_requested },
      { key: 'approved', label: 'Approved', n: counts.approved },
      { key: 'declined', label: 'Declined', n: counts.declined },
    ];

    view.innerHTML = `
      ${takeFlash()}
      <header class="page-head">
        <h1>Organizer dashboard</h1>
        <p class="lede">Driftwood Jam 2026 · ${entries.length} entries</p>
      </header>

      <section class="card attention" aria-labelledby="att-title">
        <h2 id="att-title">Needs your attention <span class="count">${attention.length}</span></h2>
        ${
          attention.length
            ? `<ol class="attention-list">${attention
                .map(
                  ({ entry, reason }) => `<li>
                    <a href="#/review/${esc(entry.id)}"><strong>${esc(entry.title)}</strong></a>
                    <span class="muted small">${esc(entry.creator)} · ${esc(entry.category)}</span>
                    <span class="reason">${esc(reason)}</span>
                  </li>`
                )
                .join('')}</ol>
              <p class="muted small">Oldest first. New and resubmitted entries always appear here; entries “In review” appear after ${R.STALE_REVIEW_DAYS} days without a decision.</p>`
            : '<p>You’re all caught up. 🎉</p>'
        }
      </section>

      <section class="card" aria-labelledby="filter-scope">
        <h2 class="filter-scope" id="filter-scope">Filter entries below <span class="muted small">(the list above always shows everything that needs you)</span></h2>
        <div class="filters">
          <label>Search <input id="q" type="search" placeholder="Title or creator" value="${esc(dashFilter.q)}"></label>
          <label>Status
            <select id="status">${statuses.map(
              (t) => `<option value="${t.key}"${dashFilter.status === t.key ? ' selected' : ''}>${esc(t.label)} (${t.n})</option>`
            ).join('')}</select>
          </label>
          <label>Category
            <select id="cat"><option value="">All</option>${R.CATEGORIES.map(
              (c) => `<option${dashFilter.category === c ? ' selected' : ''}>${esc(c)}</option>`
            ).join('')}</select>
          </label>
        </div>
        <div id="table"></div>
      </section>`;

    function drawTable() {
      const q = dashFilter.q.trim().toLowerCase();
      const rows = entries
        .filter((e) => !dashFilter.status || e.status === dashFilter.status)
        .filter((e) => !dashFilter.category || e.category === dashFilter.category)
        .filter((e) => !q || e.title.toLowerCase().includes(q) || e.creator.toLowerCase().includes(q))
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      document.getElementById('table').innerHTML = rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Entry</th><th>Creator</th><th>Category</th><th>Status</th><th>Updated</th></tr></thead>
            <tbody>${rows
              .map(
                (e) => `<tr>
                  <td><a href="#/review/${esc(e.id)}">${esc(e.title)}</a><br><span class="muted small">${esc(e.id)}</span></td>
                  <td>${esc(e.creator)}</td>
                  <td>${esc(e.category)}</td>
                  <td>${badge(e.status)}</td>
                  <td class="nowrap">${fmtDate(e.updatedAt)}</td>
                </tr>`
              )
              .join('')}</tbody></table></div>`
        : '<p class="muted">No entries match these filters.</p>';
    }

    document.getElementById('status').addEventListener('change', (e) => {
      dashFilter.status = e.target.value;
      drawTable();
    });
    document.getElementById('q').addEventListener('input', (e) => {
      dashFilter.q = e.target.value;
      drawTable();
    });
    document.getElementById('cat').addEventListener('change', (e) => {
      dashFilter.category = e.target.value;
      drawTable();
    });
    drawTable();
  }

  // ---------- organizer: review one entry ----------

  function renderReview(id) {
    setActiveNav('dashboard');
    const entry = S.get(id);
    if (!entry) return renderNotFound();

    const options = R.organizerOptions(entry.status);
    const reason = R.attentionReason(entry, Date.now());

    view.innerHTML = `
      ${takeFlash()}
      <p><a href="#/dashboard">← Dashboard</a></p>
      <header class="page-head">
        <h1>${esc(entry.title)} ${badge(entry.status)}</h1>
        <p class="lede muted">${esc(entry.id)}${reason ? ` · <span class="reason">${esc(reason)}</span>` : ''}</p>
      </header>
      <div class="review-layout">
        <div>
          ${detailsHtml(entry)}
          ${historyHtml(entry, 'organizer')}
        </div>
        <form id="review-form" class="card review-form" novalidate>
          <h2>Update status</h2>
          ${
            entry.status === 'changes_requested'
              ? '<p class="muted small">Waiting for the creator to resubmit. You can still decline it.</p>'
              : ''
          }
          <fieldset>
            <legend class="sr-only">New status</legend>
            ${options
              .map(
                (s) => `<label class="radio"><input type="radio" name="status" value="${s}"> ${badge(s)}</label>`
              )
              .join('')}
          </fieldset>
          <div class="field">
            <label for="r-feedback">Feedback for the creator <span id="fb-req" class="optional">(optional)</span></label>
            <textarea id="r-feedback" name="feedback" rows="5" aria-describedby="r-error"></textarea>
          </div>
          <p class="error" id="r-error" role="alert"></p>
          <button type="submit" class="btn btn--primary">Save decision</button>
        </form>
      </div>`;

    const form = document.getElementById('review-form');
    const req = document.getElementById('fb-req');
    const err = document.getElementById('r-error');
    // Read the checked radio directly: with a single option, form.elements.status
    // is one <input> whose .value is set even when it isn't checked.
    const checkedStatus = () => {
      const el = form.querySelector('input[name=status]:checked');
      return el ? el.value : '';
    };

    form.addEventListener('change', () => {
      const to = checkedStatus();
      const required = R.NEEDS_FEEDBACK.includes(to);
      req.textContent = required ? '(required)' : '(optional)';
      req.className = required ? 'required' : 'optional';
      err.textContent = '';
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const to = checkedStatus();
      const feedback = form.elements.feedback.value;
      const problem = R.validateReview(entry.status, to, feedback);
      if (problem) {
        err.textContent = problem;
        (to ? form.elements.feedback : form.querySelector('input[name=status]')).focus();
        return;
      }
      try {
        await S.setStatus(entry.id, to, feedback);
      } catch (e2) {
        err.textContent = e2.message;
        return;
      }
      flash = `“${entry.title}” marked ${R.STATUS_LABELS[to]}.`;
      go('#/review/' + entry.id);
    });
  }

  function renderNotFound() {
    view.innerHTML = `<div class="card empty"><h1>Entry not found</h1><p><a href="#/dashboard">Back to the dashboard</a></p></div>`;
  }

  // ---------- router ----------

  async function render() {
    try {
      await S.refresh();
    } catch (err) {
      view.innerHTML = `<div class="card empty"><h1>Can’t load entries</h1><p>${esc(err.message)}</p></div>`;
      return;
    }
    const parts = (location.hash || '#/submit').slice(2).split('/');
    const [page, id] = parts;
    if (page === 'submit' || page === '') renderSubmit();
    else if (page === 'mine' && id) renderMineDetail(decodeURIComponent(id));
    else if (page === 'mine') renderMine();
    else if (page === 'dashboard') renderDashboard();
    else if (page === 'review' && id) renderReview(decodeURIComponent(id));
    else renderNotFound();
    window.scrollTo(0, 0);
    const h1 = view.querySelector('h1');
    if (h1) {
      h1.setAttribute('tabindex', '-1');
      h1.focus({ preventScroll: true });
    }
  }

  document.getElementById('reset-demo').addEventListener('click', async () => {
    if (confirm('Reset all demo data? Your submissions and reviews will be cleared.')) {
      await S.reset();
      flash = 'Demo data reset.';
      go('#/dashboard');
    }
  });

  window.addEventListener('hashchange', render);
  render();
})();
