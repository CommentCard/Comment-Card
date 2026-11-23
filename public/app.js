/* Comment Card frontend — plain JS, no dependencies. */
'use strict';

const KIND_LABELS = {
  bugged: 'Something bugged me',
  change: "Something I'd change",
  idea: 'An idea',
};
const AREA_LABELS = {
  service: 'Service',
  'wait-time': 'Wait time',
  price: 'Price',
  cleanliness: 'Cleanliness',
  'food-quality': 'Food / product quality',
  staff: 'Staff',
  other: 'Something else',
};
const VISIT_LABELS = {
  'first-time': 'First visit',
  sometimes: 'Comes sometimes',
  regular: 'Regular',
};
const STATUS_LABELS = {
  new: 'New',
  noted: 'Noted',
  acted_on: 'Acted on',
  archived: 'Archived',
};

// One-shot browser location, promise-based. Resolves { lat, lng } or null
// (denied, unavailable, or timed out). Cached — the browser asks once.
let locPromise = null;
function getLocation() {
  if (locPromise) return locPromise;
  locPromise = new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 8000, maximumAge: 600000 },
    );
  });
  return locPromise;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timeAgo(iso) {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
  const days = Math.floor(hrs / 24);
  if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...(opts || {}),
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Something went wrong.');
    err.status = res.status;
    throw err;
  }
  return data;
}

function showError(el, err) {
  if (!el) return;
  el.textContent = err && err.message ? err.message : 'Something went wrong.';
  el.classList.add('show');
}
function hideError(el) {
  if (!el) return;
  el.classList.remove('show');
  el.textContent = '';
}

function repliesHTML(c, businessName) {
  if (!c.replies || !c.replies.length) return '';
  return c.replies.map((r) => `
    <div class="owner-reply">
      <div class="reply-label">↩ Reply from ${esc(r.business_name || businessName || 'the business')}</div>
      <p>${esc(r.text)}</p>
      <div class="reply-when">${esc(timeAgo(r.created_at))}</div>
    </div>`).join('');
}

function commentCardHTML(c, opts) {
  const o = opts || {};
  const better = c.better_text
    ? `<p class="better"><b>What would have made it better:</b> ${esc(c.better_text)}</p>`
    : '';
  const byline = c.name
    ? `<div class="byline">— ${esc(c.name)}${c.visit_frequency && VISIT_LABELS[c.visit_frequency] ? ' · ' + esc(VISIT_LABELS[c.visit_frequency]) : ''}</div>`
    : (c.visit_frequency && VISIT_LABELS[c.visit_frequency]
      ? `<div class="byline">${esc(VISIT_LABELS[c.visit_frequency])}</div>` : '');
  const biz = o.businessName
    ? `<div class="byline">for <a href="/b/${esc(o.businessSlug || '')}">${esc(o.businessName)}</a></div>` : '';
  const statusLine = c.status === 'acted_on'
    ? '<div class="status-line">✓ This business acted on this one.</div>'
    : c.status === 'noted'
      ? '<div class="status-line">✓ Seen by the business.</div>' : '';
  return `
    <li class="kind-${esc(c.kind)}">
      <div class="meta">
        <span class="pill kind-${esc(c.kind)}">${esc(KIND_LABELS[c.kind] || c.kind)}</span>
        <span class="pill">${esc(AREA_LABELS[c.area] || c.area)}</span>
        <span>${esc(timeAgo(c.created_at))}</span>
      </div>
      <p class="comment-text">${esc(c.text)}</p>
      ${better}
      ${byline}
      ${biz}
      ${statusLine}
      ${repliesHTML(c, o.businessName)}
    </li>`;
}

/* ---------------- Home page: lookup + add business + discover + login ---------------- */

function initHome() {
  const input = document.getElementById('lookup-input');
  const dropdown = document.getElementById('lookup-results');
  const addForm = document.getElementById('add-business-form');
  const addName = document.getElementById('add-name');
  const addEmail = document.getElementById('add-email');
  const addPlaceId = document.getElementById('add-place-id');
  const addAddress = document.getElementById('add-address');
  const addWebsite = document.getElementById('add-website');
  const emailSuggBox = document.getElementById('email-suggestions');
  const emailPick = document.getElementById('email-pick');

  let items = []; // {kind:'local'|'place'|'manual', ...}
  let activeIndex = -1;
  let debounceTimer = null;
  let lookupSeq = 0; // ignore stale responses
  let locationUsed = false;
  let selectedPlace = null; // lookup result the form was filled from, with its coords
  let userLoc = null; // { lat, lng } once the browser shares it
  let locRequested = false;

  // Ask the browser for the user's location (once, on first typing) so
  // results can be sorted nearest first. Denied/unavailable is fine —
  // search works without it, just unsorted.
  function ensureLocation() {
    if (locRequested || !('geolocation' in navigator)) return;
    locRequested = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => { userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude }; },
      () => { userLoc = null; },
      { timeout: 5000, maximumAge: 600000 },
    );
  }

  function closeDropdown() {
    dropdown.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
  }

  function setActive(i) {
    activeIndex = i;
    dropdown.querySelectorAll('.lookup-item').forEach((el, idx) => {
      el.classList.toggle('active', idx === i);
      el.setAttribute('aria-selected', String(idx === i));
    });
  }

  function renderDropdown(loading) {
    if (loading) {
      dropdown.innerHTML = '<li class="lookup-loading"><span class="spinner"></span>Looking for that place…</li>';
      dropdown.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      return;
    }
    if (!items.length) {
      dropdown.innerHTML = '';
      dropdown.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      return;
    }
    const note = (locationUsed && items.some((it) => it.kind === 'place'))
      ? '<li class="lookup-note">Nearest first — based on your location</li>' : '';
    dropdown.innerHTML = note + items.map((it, i) => {
      if (it.kind === 'manual') {
        return `<li><button type="button" class="lookup-item" role="option" data-i="${i}"><span class="name">No matches — add “${esc(it.query)}” manually</span><span class="addr">We'll start a fresh page for this business.</span></button></li>`;
      }
      if (it.kind === 'local') {
        return `<li><button type="button" class="lookup-item" role="option" data-i="${i}"><span class="name">${esc(it.name)}<span class="tag on-card">On Comment Card</span></span><span class="addr">Already has a page — open it and leave a card.</span></button></li>`;
      }
      const dist = (it.distanceMi != null) ? ` · ${it.distanceMi} mi away` : '';
      return `<li><button type="button" class="lookup-item" role="option" data-i="${i}"><span class="name">${esc(it.name)}</span><span class="addr">${esc(it.address || '')}${dist}</span></button></li>`;
    }).join('');
    dropdown.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    setActive(-1);
  }

  async function runLookup(query) {
    const seq = ++lookupSeq;
    renderDropdown(true);
    const placesUrl = `/api/places/search?query=${encodeURIComponent(query)}`
      + (userLoc ? `&lat=${userLoc.lat}&lng=${userLoc.lng}` : '');
    const [local, cascade] = await Promise.all([
      api(`/api/businesses/search?q=${encodeURIComponent(query)}`).catch(() => ({ businesses: [] })),
      api(placesUrl).catch(() => ({ results: [] })),
    ]);
    if (seq !== lookupSeq) return; // a newer keystroke already superseded this
    locationUsed = !!cascade.locationUsed;
    items = [];
    for (const b of (local.businesses || [])) {
      items.push({ kind: 'local', slug: b.slug, name: b.name });
    }
    for (const r of (cascade.results || [])) {
      items.push({ kind: 'place', ...r });
    }
    items.push({ kind: 'manual', query });
    renderDropdown(false);
  }

  // Fill the add-business form from a lookup result and, when a website is
  // known, scan it for email addresses the business publishes itself.
  async function selectPlace(it) {
    closeDropdown();
    selectedPlace = it;
    addName.value = it.name || '';
    addPlaceId.value = it.placeId || '';
    addAddress.hidden = !it.address;
    addAddress.textContent = it.address ? `📍 ${it.address}` : '';
    addWebsite.hidden = true;
    emailSuggBox.hidden = true;
    emailPick.innerHTML = '';
    input.value = it.name || '';

    if (it.source === 'places' && it.placeId && !it.placeId.startsWith('osm:')) {
      // Get the full details (phone + website) for a Google Places result.
      try {
        const d = await api(`/api/places/details?placeId=${encodeURIComponent(it.placeId)}`);
        if (d.place) {
          if (d.place.website) showWebsite(d.place.website);
          if (d.place.address) {
            addAddress.hidden = false;
            addAddress.textContent = `📍 ${d.place.address}`;
          }
        }
      } catch (e) { /* details are a bonus — manual entry still works */ }
    } else if (it.website) {
      showWebsite(it.website);
    }
    addName.focus();
  }

  async function showWebsite(website) {
    addWebsite.hidden = false;
    addWebsite.innerHTML = `Website: <a href="${esc(website)}" target="_blank" rel="noopener">${esc(website)}</a> — check there for their email if we can't find one.`;
    emailSuggBox.hidden = true;
    try {
      const data = await api(`/api/lookup/emails?url=${encodeURIComponent(website)}`);
      if (data.emails && data.emails.length) {
        emailPick.innerHTML = data.emails.map((e) =>
          `<button type="button" class="chip teal" data-email="${esc(e)}">${esc(e)}</button>`).join('');
        emailSuggBox.hidden = false;
      }
    } catch (e) { /* no published emails found — the commenter types one in */ }
  }

  emailPick.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-email]');
    if (!btn) return;
    addEmail.value = btn.dataset.email;
    emailPick.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
    btn.setAttribute('aria-pressed', 'true');
  });

  function chooseItem(i) {
    const it = items[i];
    if (!it) return;
    if (it.kind === 'local') {
      window.location.href = `/b/${it.slug}`;
      return;
    }
    if (it.kind === 'manual') {
      closeDropdown();
      selectedPlace = null;
      addName.value = it.query;
      addName.focus();
      return;
    }
    selectPlace(it);
  }

  dropdown.addEventListener('click', (e) => {
    const btn = e.target.closest('.lookup-item');
    if (!btn) return;
    chooseItem(parseInt(btn.dataset.i, 10));
  });

  input.addEventListener('input', () => {
    ensureLocation();
    const q = input.value.trim();
    clearTimeout(debounceTimer);
    if (q.length < 2) {
      items = [];
      closeDropdown();
      return;
    }
    debounceTimer = setTimeout(() => runLookup(q), 300);
  });

  input.addEventListener('keydown', (e) => {
    if (dropdown.hidden) return;
    const count = dropdown.querySelectorAll('.lookup-item').length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((activeIndex + 1) % count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((activeIndex - 1 + count) % count);
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0) {
        e.preventDefault();
        chooseItem(activeIndex);
      }
    } else if (e.key === 'Escape') {
      closeDropdown();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.lookup')) closeDropdown();
  });

  // If the name is edited after picking a place, the pick no longer applies.
  addName.addEventListener('input', () => { selectedPlace = null; addPlaceId.value = ''; });

  // Add a business (or open the existing one) and go to its page.
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('add-error');
    hideError(err);
    const btn = addForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const data = await api('/api/businesses/find-or-create', {
        method: 'POST',
        body: JSON.stringify({
          name: addName.value,
          email: addEmail.value,
          place_id: addPlaceId.value || undefined,
          lat: selectedPlace ? selectedPlace.lat : undefined,
          lng: selectedPlace ? selectedPlace.lng : undefined,
          address: selectedPlace ? selectedPlace.address : undefined,
        }),
      });
      window.location.href = `/b/${data.business.slug}`;
    } catch (ex) { showError(err, ex); btn.disabled = false; }
  });

  // Owner login (small, at the bottom of the page).
  const loginForm = document.getElementById('login-form');
  if (loginForm) loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('login-error');
    hideError(err);
    const btn = loginForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('login-email').value,
          password: document.getElementById('login-password').value,
        }),
      });
      window.location.href = '/dashboard';
    } catch (ex) { showError(err, ex); btn.disabled = false; }
  });

  // Discover feed — latest comments across all businesses, newest first.
  const list = document.getElementById('discover-list');
  const empty = document.getElementById('discover-empty');
  if (list) {
    api('/api/discover').then((data) => {
      if (!data.comments.length) { empty.hidden = false; return; }
      list.innerHTML = data.comments.map((c) => commentCardHTML(c, {
        businessName: c.business_name, businessSlug: c.business_slug,
      })).join('');
    }).catch(() => { empty.hidden = false; });
  }

  // If already logged in, point the top nav at the inbox.
  api('/api/auth/me').then(() => {
    const nav = document.getElementById('authed-nav');
    if (nav) nav.hidden = false;
  }).catch(() => {});
}

/* ---------------- Public business page: claim banner, form + feed ---------------- */

function initCardPage() {
  const slug = window.location.pathname.split('/').pop();
  const feedEl = document.getElementById('feed');
  const emptyEl = document.getElementById('feed-empty');
  const loadMoreBtn = document.getElementById('load-more');
  const form = document.getElementById('comment-form');
  const thanks = document.getElementById('thanks');
  const errEl = document.getElementById('form-error');
  let offset = 0;
  let total = 0;
  let loaded = 0;
  let bizName = '';

  function renderFeed(comments, append) {
    if (!append) feedEl.innerHTML = '';
    feedEl.insertAdjacentHTML('beforeend', comments.map((c) => commentCardHTML(c, { businessName: bizName })).join(''));
    loaded += comments.length;
    emptyEl.hidden = loaded > 0;
    loadMoreBtn.hidden = loaded >= total;
  }

  async function loadFeed(append) {
    try {
      const data = await api(`/api/public/${encodeURIComponent(slug)}?limit=20&offset=${append ? offset : 0}`);
      if (!append) {
        bizName = data.business.name;
        document.getElementById('biz-name').textContent = data.business.name;
        document.getElementById('paper-biz').textContent = `For: ${data.business.name}`;
        document.title = `${data.business.name} — Comment Card`;
        const note = document.getElementById('welcome-note');
        if (data.business.welcome_note) {
          note.textContent = data.business.welcome_note;
          note.hidden = false;
        }
        document.getElementById('biz-heading').textContent = `${data.business.name} — Comment Card`;
        total = data.total;
        offset = 0;
        loaded = 0;
        // Unclaimed business: show the claim QR + copyable claim link.
        if (!data.business.claimed && data.business.claim_url) {
          const banner = document.getElementById('claim-banner');
          banner.hidden = false;
          document.getElementById('claim-link').textContent = data.business.claim_url;
          const qr = document.getElementById('claim-qr');
          if (data.business.claim_qr) qr.src = data.business.claim_qr;
          else qr.remove();
        }
      }
      offset += data.comments.length;
      renderFeed(data.comments, append);
    } catch (ex) {
      document.getElementById('biz-heading').textContent = 'Business not found';
      document.getElementById('biz-missing').hidden = false;
      form.hidden = true;
      feedEl.innerHTML = '';
      emptyEl.hidden = true;
      loadMoreBtn.hidden = true;
    }
  }

  const copyClaimBtn = document.getElementById('copy-claim-link');
  if (copyClaimBtn) copyClaimBtn.addEventListener('click', async () => {
    const link = document.getElementById('claim-link').textContent;
    try {
      await navigator.clipboard.writeText(link);
      copyClaimBtn.textContent = 'Copied!';
      setTimeout(() => { copyClaimBtn.textContent = 'Copy claim link'; }, 2000);
    } catch (e) {
      window.prompt('Copy the claim link:', link);
    }
  });

  // Chip groups (single-select)
  function chipGroup(id) {
    const wrap = document.getElementById(id);
    if (!wrap) return { value: () => null };
    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      wrap.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
    });
    return {
      value: () => {
        const sel = wrap.querySelector('.chip[aria-pressed="true"]');
        return sel ? sel.dataset.value : null;
      },
      reset: () => wrap.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false')),
    };
  }
  const kindChips = chipGroup('kind-chips');
  const areaChips = chipGroup('area-chips');

  if (loadMoreBtn) loadMoreBtn.addEventListener('click', () => loadFeed(true));

  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError(errEl);
    const kind = kindChips.value();
    const area = areaChips.value();
    const text = document.getElementById('comment-text').value.trim();
    if (!kind || !area || !text) {
      showError(errEl, new Error('Pick what kind of comment this is, which part of the visit it is about, and write your comment.'));
      return;
    }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      // The 20-mile rule: the commenter's location rides along with the card.
      const loc = await getLocation();
      const data = await api(`/api/public/${encodeURIComponent(slug)}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          kind,
          area,
          text,
          lat: loc ? loc.lat : undefined,
          lng: loc ? loc.lng : undefined,
          better_text: document.getElementById('better-text').value,
          visit_frequency: document.getElementById('visit-frequency').value,
          name: document.getElementById('commenter-name').value,
          contact: document.getElementById('commenter-contact').value,
        }),
      });
      form.reset();
      kindChips.reset();
      areaChips.reset();
      thanks.classList.add('show');
      feedEl.insertAdjacentHTML('afterbegin', commentCardHTML(data.comment, { businessName: bizName }));
      emptyEl.hidden = true;
      total += 1;
      loaded += 1;
      loadMoreBtn.hidden = loaded >= total;
      window.scrollTo({ top: form.offsetTop - 20, behavior: 'smooth' });
    } catch (ex) { showError(errEl, ex); }
    btn.disabled = false;
  });

  loadFeed(false);
}

/* ---------------- Dashboard: a simple inbox ---------------- */

function initDashboard() {
  const inboxList = document.getElementById('inbox-list');
  const inboxEmpty = document.getElementById('inbox-empty');
  const countLine = document.getElementById('inbox-count');
  const errEl = document.getElementById('dash-error');
  let comments = [];
  let bizName = '';

  function setTab(name) {
    document.querySelectorAll('.tab').forEach((t) =>
      t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    document.getElementById('tab-inbox').hidden = name !== 'inbox';
    document.getElementById('tab-settings').hidden = name !== 'settings';
  }
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => setTab(t.dataset.tab)));

  function renderInbox() {
    const statusF = document.getElementById('filter-status').value;
    const kindF = document.getElementById('filter-kind').value;
    const q = document.getElementById('filter-search').value.trim().toLowerCase();
    const shown = comments.filter((c) =>
      (!statusF || c.status === statusF) &&
      (!kindF || c.kind === kindF) &&
      (!q || (c.text + ' ' + (c.better_text || '') + ' ' + (c.name || '')).toLowerCase().includes(q)));
    const fresh = comments.filter((c) => c.status === 'new').length;
    countLine.innerHTML = `${comments.length} card${comments.length === 1 ? '' : 's'} so far · <b>${fresh} new</b> — read them, reply to the ones worth answering.`;
    inboxEmpty.hidden = shown.length > 0;
    inboxList.innerHTML = shown.map((c) => `
      <article class="inbox-item ${c.hidden ? 'is-hidden' : ''}">
        <div class="meta">
          <span class="pill kind-${esc(c.kind)}">${esc(KIND_LABELS[c.kind])}</span>
          <span class="pill">${esc(AREA_LABELS[c.area] || c.area)}</span>
          <span class="status-badge status-${esc(c.status)}">${esc(STATUS_LABELS[c.status])}</span>
          ${c.hidden ? '<span class="status-badge status-archived">Hidden from public</span>' : ''}
          <span>${esc(timeAgo(c.created_at))}</span>
        </div>
        <p class="comment-text">${esc(c.text)}</p>
        ${c.better_text ? `<p class="better"><b>What would have made it better:</b> ${esc(c.better_text)}</p>` : ''}
        <div class="byline">${c.name ? `— ${esc(c.name)}` : 'Anonymous'}${c.visit_frequency && VISIT_LABELS[c.visit_frequency] ? ' · ' + esc(VISIT_LABELS[c.visit_frequency]) : ''}${c.contact ? ` · Reply: ${esc(c.contact)}` : ''}</div>
        ${repliesHTML(c, bizName)}
        <div class="reply-box">
          <label for="reply-${c.id}">Reply to this card <span class="hint">— shows publicly, under their comment</span></label>
          <textarea id="reply-${c.id}" placeholder="Answer them straight."></textarea>
          <button class="btn teal small" data-reply="${c.id}" type="button">Reply publicly</button>
        </div>
        <div class="actions">
          ${c.status !== 'noted' ? `<button class="btn small quiet" data-act="noted" data-id="${c.id}">Mark noted</button>` : ''}
          ${c.status !== 'acted_on' ? `<button class="btn small quiet" data-act="acted_on" data-id="${c.id}">Mark acted on</button>` : ''}
          ${c.status !== 'archived' ? `<button class="btn small quiet" data-act="archived" data-id="${c.id}">Archive</button>` : ''}
          <button class="btn small ghost" data-act="${c.hidden ? 'unhide' : 'hide'}" data-id="${c.id}">${c.hidden ? 'Show on public feed' : 'Hide from public'}</button>
          <button class="btn small danger" data-act="delete" data-id="${c.id}">Delete</button>
        </div>
      </article>`).join('');
  }

  async function loadComments() {
    comments = (await api('/api/comments')).comments;
    renderInbox();
  }

  inboxList.addEventListener('click', async (e) => {
    const replyBtn = e.target.closest('button[data-reply]');
    if (replyBtn) {
      const id = replyBtn.dataset.reply;
      const ta = document.getElementById(`reply-${id}`);
      const text = ta.value.trim();
      if (!text) { showError(errEl, new Error('Write your reply first.')); return; }
      hideError(errEl);
      replyBtn.disabled = true;
      try {
        await api(`/api/comments/${id}/replies`, { method: 'POST', body: JSON.stringify({ text }) });
        await loadComments();
      } catch (ex) { showError(errEl, ex); }
      replyBtn.disabled = false;
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    hideError(errEl);
    try {
      if (act === 'delete') {
        if (!window.confirm('Delete this comment? This cannot be undone.')) return;
        await api(`/api/comments/${id}`, { method: 'DELETE' });
      } else if (act === 'hide') {
        await api(`/api/comments/${id}`, { method: 'PATCH', body: JSON.stringify({ hidden: true }) });
      } else if (act === 'unhide') {
        await api(`/api/comments/${id}`, { method: 'PATCH', body: JSON.stringify({ hidden: false }) });
      } else {
        await api(`/api/comments/${id}`, { method: 'PATCH', body: JSON.stringify({ status: act }) });
      }
      await loadComments();
    } catch (ex) { showError(errEl, ex); }
  });

  ['filter-status', 'filter-kind'].forEach((id) =>
    document.getElementById(id).addEventListener('change', renderInbox));
  let searchTimer = null;
  document.getElementById('filter-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderInbox, 200);
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  });

  // Settings
  const settingsForm = document.getElementById('settings-form');
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('settings-error');
    hideError(err);
    try {
      const data = await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          name: document.getElementById('settings-name').value,
          welcome_note: document.getElementById('settings-note').value,
        }),
      });
      document.getElementById('settings-saved').classList.add('show');
      bizName = data.business.name;
      document.getElementById('dash-biz-name').textContent = data.business.name;
      document.getElementById('public-link').textContent =
        `${window.location.origin}/b/${data.business.slug}`;
      setTimeout(() => document.getElementById('settings-saved').classList.remove('show'), 3000);
    } catch (ex) { showError(err, ex); }
  });

  document.getElementById('copy-link').addEventListener('click', async () => {
    const link = document.getElementById('public-link').textContent;
    try {
      await navigator.clipboard.writeText(link);
      document.getElementById('copy-link').textContent = 'Copied!';
      setTimeout(() => { document.getElementById('copy-link').textContent = 'Copy link'; }, 2000);
    } catch (e) {
      window.prompt('Copy your public link:', link);
    }
  });

  // Boot
  api('/api/auth/me').then(async (data) => {
    bizName = data.business.name;
    document.getElementById('dash-biz-name').textContent = data.business.name;
    document.getElementById('public-link').textContent =
      `${window.location.origin}/b/${data.business.slug}`;
    document.getElementById('settings-name').value = data.business.name;
    document.getElementById('settings-note').value = data.business.welcome_note || '';
    await loadComments();
  }).catch(() => { window.location.href = '/'; });
}

/* ---------------- Claim page ---------------- */

function initClaim() {
  const token = window.location.pathname.split('/').pop();
  const loading = document.getElementById('claim-loading');
  const main = document.getElementById('claim-main');
  const invalid = document.getElementById('claim-invalid');
  const claimed = document.getElementById('claim-claimed');

  api(`/api/claim/${encodeURIComponent(token)}`).then((data) => {
    loading.hidden = true;
    if (data.business.claimed) {
      claimed.hidden = false;
      return;
    }
    main.hidden = false;
    document.getElementById('claim-heading').textContent =
      `Someone left ${data.business.name} a comment`;
    document.getElementById('claim-intro').textContent =
      `A customer left a comment for ${data.business.name} on Comment Card. Claim the page to read it and answer them.`;
    document.getElementById('claim-name').value = data.business.name;
    document.getElementById('claim-email').value = data.business.email;
  }).catch(() => {
    loading.hidden = true;
    invalid.hidden = false;
  });

  document.getElementById('claim-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('claim-error');
    hideError(err);
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api(`/api/claim/${encodeURIComponent(token)}`, {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('claim-name').value,
          email: document.getElementById('claim-email').value,
          password: document.getElementById('claim-password').value,
        }),
      });
      window.location.href = '/dashboard';
    } catch (ex) { showError(err, ex); btn.disabled = false; }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  if (page === 'home') initHome();
  else if (page === 'card') initCardPage();
  else if (page === 'dashboard') initDashboard();
  else if (page === 'claim') initClaim();
});
