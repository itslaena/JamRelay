// Pure rules for JamRelay: validation, status transitions and "needs attention".
// No DOM or storage access here, so everything in this file is unit-testable.
(function (root) {
  'use strict';

  const CATEGORIES = ['Action', 'Puzzle', 'Narrative', 'Experimental', 'Multiplayer'];

  const STATUS_LABELS = {
    submitted: 'New',
    in_review: 'In review',
    changes_requested: 'Changes requested',
    resubmitted: 'Resubmitted',
    approved: 'Approved',
    declined: 'Declined',
  };

  const LIMITS = {
    creator: { min: 2, max: 40 },
    title: { min: 3, max: 60 },
    description: { min: 40, max: 600 },
  };

  // Which statuses an organizer may move an entry to, from each status.
  const ORGANIZER_NEXT = {
    submitted: ['in_review', 'changes_requested', 'approved', 'declined'],
    resubmitted: ['in_review', 'changes_requested', 'approved', 'declined'],
    in_review: ['changes_requested', 'approved', 'declined'],
    changes_requested: ['declined'],
    approved: ['in_review'],
    declined: ['in_review'],
  };

  // Decisions the creator can't act on without an explanation.
  const NEEDS_FEEDBACK = ['changes_requested', 'declined'];

  const STALE_REVIEW_DAYS = 2;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  // A full public web address: http(s)://, a dotted host name ending in a
  // letters-only TLD, optional port, optional path. No spaces anywhere.
  // (A regex rather than `new URL()` so this file runs outside the browser too.)
  const LINK_PATTERN = /^https?:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:\d{1,5})?([/?#]\S*)?$/i;

  function isValidPlayableLink(value) {
    return LINK_PATTERN.test(clean(value));
  }

  function lengthError(value, limits, noun) {
    if (value.length < limits.min) {
      const more = limits.min - value.length;
      return `${noun} is too short — add ${more} more character${more === 1 ? '' : 's'}.`;
    }
    if (value.length > limits.max) {
      return `${noun} is ${value.length - limits.max} characters over the ${limits.max} limit.`;
    }
    return null;
  }

  // Returns { ok, errors } where errors maps field name -> message.
  // `existing` is the current list of entries, used for the duplicate-title check;
  // `selfId` excludes the entry being edited from that check.
  function validateEntry(input, existing, selfId) {
    const errors = {};
    const creator = clean(input.creator);
    const title = clean(input.title);
    const description = clean(input.description);
    const category = clean(input.category);
    const link = clean(input.link);

    if (!creator) errors.creator = 'Add your name or team name.';
    else {
      const e = lengthError(creator, LIMITS.creator, 'Name');
      if (e) errors.creator = e;
    }

    if (!title) errors.title = 'Add a title for your game.';
    else {
      const e = lengthError(title, LIMITS.title, 'Title');
      if (e) errors.title = e;
      else {
        const taken = (existing || []).some(
          (entry) => entry.id !== selfId && clean(entry.title).toLowerCase() === title.toLowerCase()
        );
        if (taken) errors.title = 'Another entry already uses this title. Pick a different one.';
      }
    }

    if (!category) errors.category = 'Choose a category.';
    else if (!CATEGORIES.includes(category)) errors.category = 'Choose one of the listed categories.';

    if (!description) errors.description = 'Describe your game so reviewers know what to expect.';
    else {
      const e = lengthError(description, LIMITS.description, 'Description');
      if (e) errors.description = e;
    }

    if (!link) errors.link = 'Add a link where reviewers can play your game.';
    else if (!isValidPlayableLink(link)) {
      errors.link = 'Use a full web address, e.g. https://yourname.itch.io/your-game';
    }

    return { ok: Object.keys(errors).length === 0, errors };
  }

  function organizerOptions(fromStatus) {
    return (ORGANIZER_NEXT[fromStatus] || []).slice();
  }

  // Returns an error message, or null if the organizer's decision is allowed.
  function validateReview(fromStatus, toStatus, feedback) {
    if (!toStatus) return 'Choose a new status.';
    if (!organizerOptions(fromStatus).includes(toStatus)) {
      return `An entry that is "${STATUS_LABELS[fromStatus]}" can't move to "${STATUS_LABELS[toStatus]}".`;
    }
    if (NEEDS_FEEDBACK.includes(toStatus) && !clean(feedback)) {
      return `Feedback is required when marking an entry "${STATUS_LABELS[toStatus]}" so the creator knows why.`;
    }
    return null;
  }

  function canResubmit(status) {
    return status === 'changes_requested';
  }

  function daysBetween(fromIso, now) {
    return Math.floor((now - new Date(fromIso).getTime()) / DAY_MS);
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  // Why an entry needs the organizer's attention, or null if it doesn't.
  function attentionReason(entry, now) {
    const waited = daysBetween(entry.updatedAt, now);
    if (entry.status === 'submitted') {
      return waited < 1 ? 'New today — not reviewed yet' : `New — waiting ${plural(waited, 'day')}`;
    }
    if (entry.status === 'resubmitted') return 'Resubmitted after changes — ready for another look';
    if (entry.status === 'in_review' && waited >= STALE_REVIEW_DAYS) {
      return `In review for ${plural(waited, 'day')} with no decision`;
    }
    return null;
  }

  // Entries needing attention, oldest first (longest wait at the top).
  function needsAttention(entries, now) {
    return entries
      .map((entry) => ({ entry, reason: attentionReason(entry, now) }))
      .filter((item) => item.reason)
      .sort((a, b) => new Date(a.entry.updatedAt) - new Date(b.entry.updatedAt));
  }

  function countByStatus(entries) {
    const counts = {};
    Object.keys(STATUS_LABELS).forEach((s) => (counts[s] = 0));
    entries.forEach((entry) => {
      if (entry.status in counts) counts[entry.status] += 1;
    });
    return counts;
  }

  const api = {
    CATEGORIES,
    STATUS_LABELS,
    LIMITS,
    NEEDS_FEEDBACK,
    STALE_REVIEW_DAYS,
    isValidPlayableLink,
    validateEntry,
    organizerOptions,
    validateReview,
    canResubmit,
    attentionReason,
    needsAttention,
    countByStatus,
  };

  root.JamRules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
