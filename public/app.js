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
    </li>`;
}

/* ---------------- Home page: signup / login / discover ---------------- */

function initHome() {
  const signupForm = document.getElementById('signup-form');
  const loginForm = document.getElementById('login-form');
  const toLogin = document.getElementById('show-login');
  const toSignup = document.getElementById('show-signup');

  if (toLogin) toLogin.addEventListener('click', (e) => {
    e.preventDefault();
    signupForm.hidden = true; loginForm.hidden = false;
  });
  if (toSignup) toSignup.addEventListener('click', (e) => {
    e.preventDefault();
    loginForm.hidden = true; signupForm.hidden = false;
  });

  if (signupForm) signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('signup-error');
    hideError(err);
    const btn = signupForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('signup-name').value,
          email: document.getElementById('signup-email').value,
          password: document.getElementById('signup-password').value,
        }),
      });
      window.location.href = '/dashboard';
    } catch (ex) { showError(err, ex); btn.disabled = false; }
  });

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

  // Discover feed
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

  // If already logged in, point the top nav at the dashboard.
  api('/api/auth/me').then(() => {
    const nav = document.getElementById('authed-nav');
    if (nav) nav.hidden = false;
  }).catch(() => {});
}

/* ---------------- Public business page: form + feed ---------------- */

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

  function renderFeed(comments, append) {
    if (!append) feedEl.innerHTML = '';
    feedEl.insertAdjacentHTML('beforeend', comments.map((c) => commentCardHTML(c)).join(''));
    loaded += comments.length;
    emptyEl.hidden = loaded > 0;
    loadMoreBtn.hidden = loaded >= total;
  }

  async function loadFeed(append) {
    try {
      const data = await api(`/api/public/${encodeURIComponent(slug)}?limit=20&offset=${append ? offset : 0}`);
      if (!append) {
        document.getElementById('biz-name').textContent = data.business.name;
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
      const data = await api(`/api/public/${encodeURIComponent(slug)}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          kind,
          area,
          text,
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
      // New comment appears at the top of the feed right away.
      feedEl.insertAdjacentHTML('afterbegin', commentCardHTML(data.comment));
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

/* ---------------- Dashboard ---------------- */

function initDashboard() {
  const inboxList = document.getElementById('inbox-list');
  const inboxEmpty = document.getElementById('inbox-empty');
  const statsEl = document.getElementById('stats');
  const errEl = document.getElementById('dash-error');
  let comments = [];

  function setTab(name) {
    document.querySelectorAll('.tab').forEach((t) =>
      t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    document.getElementById('tab-inbox').hidden = name !== 'inbox';
    document.getElementById('tab-settings').hidden = name !== 'settings';
  }
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => setTab(t.dataset.tab)));

  async function loadStats() {
    const s = await api('/api/comments/stats');
    statsEl.innerHTML = `
      <div class="stat"><div class="num">${s.total}</div><div class="lbl">Total cards</div></div>
      <div class="stat"><div class="num">${s.unread}</div><div class="lbl">Unread</div></div>
      <div class="stat"><div class="num">${s.mostMentionedArea ? esc(AREA_LABELS[s.mostMentionedArea] || s.mostMentionedArea) : '—'}</div><div class="lbl">Most mentioned area</div></div>
      <div class="stat"><div class="num">${s.byKind.bugged || 0}</div><div class="lbl">Bugged me</div></div>
      <div class="stat"><div class="num">${s.byKind.change || 0}</div><div class="lbl">I'd change</div></div>
      <div class="stat"><div class="num">${s.byKind.idea || 0}</div><div class="lbl">Ideas</div></div>`;
  }

  function renderInbox() {
    const statusF = document.getElementById('filter-status').value;
    const kindF = document.getElementById('filter-kind').value;
    const q = document.getElementById('filter-search').value.trim().toLowerCase();
    const shown = comments.filter((c) =>
      (!statusF || c.status === statusF) &&
      (!kindF || c.kind === kindF) &&
      (!q || (c.text + ' ' + (c.better_text || '') + ' ' + (c.name || '')).toLowerCase().includes(q)));
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
      await loadStats();
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
    document.getElementById('dash-biz-name').textContent = data.business.name;
    document.getElementById('public-link').textContent =
      `${window.location.origin}/b/${data.business.slug}`;
    document.getElementById('settings-name').value = data.business.name;
    document.getElementById('settings-note').value = data.business.welcome_note || '';
    await loadStats();
    await loadComments();
  }).catch(() => { window.location.href = '/'; });
}

document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  if (page === 'home') initHome();
  else if (page === 'card') initCardPage();
  else if (page === 'dashboard') initDashboard();
});
