'use strict';
(() => {
  const api = window.zentro;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ------------------------------------------------------------ icons (static, trusted markup)
  const ICONS = {
    home: '<path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10"/>',
    download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    paste: '<rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V4h6v1M9 11h6M9 15h4"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    pause: '<rect x="6.5" y="5" width="3.6" height="14" rx="1"/><rect x="13.9" y="5" width="3.6" height="14" rx="1"/>',
    play: '<path d="M8 5.5l11 6.5-11 6.5z"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    retry: '<path d="M4 4v6h6M20 20v-6h-6"/><path d="M5.6 15a8 8 0 0 0 13.9-1.5M18.4 9A8 8 0 0 0 4.5 10.5"/>',
    open: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  };

  function hydrateIcons() {
    $$('svg[data-icon]').forEach((svg) => { svg.innerHTML = ICONS[svg.dataset.icon] || ''; });
  }
  function svgIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name] || '';
    return svg;
  }

  // ------------------------------------------------------------ tiny DOM helper (text only, never innerHTML)
  function h(tag, props = {}, kids = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids) if (kid) el.append(kid);
    return el;
  }

  // ------------------------------------------------------------ formatting
  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const v = n / Math.pow(1024, i);
    return `${i === 0 || v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
  }
  function fmtEta(s) {
    if (s == null || !Number.isFinite(s)) return '';
    if (s < 60) return `${s}s left`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s left`;
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m left`;
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) return `Today, ${time}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
  }
  const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,4})$/.exec(name || ''); return m ? m[1].toLowerCase() : 'file'; };
  const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

  const STATUS_LABEL = {
    queued: 'Queued', downloading: 'Downloading', paused: 'Paused',
    completed: 'Completed', failed: 'Failed', canceled: 'Canceled',
  };

  // ------------------------------------------------------------ cards
  function createCard() {
    const el = h('article', { class: 'card' }, [
      h('div', { class: 'ftype' }, [h('span', { class: 'ftype-ext' })]),
      h('div', { class: 'card-main' }, [
        h('div', { class: 'card-top' }, [h('div', { class: 'name' }), h('span', { class: 'chip' })]),
        h('div', { class: 'meta' }),
        h('div', { class: 'bar' }, [h('div', { class: 'bar-fill' })]),
        h('div', { class: 'progress-row' }, [h('span', { class: 'pct' }), h('span', { class: 'speed' }), h('span', { class: 'eta' })]),
        h('div', { class: 'error-line' }),
      ]),
      h('div', { class: 'actions' }),
    ]);
    el._q = {
      ext: $('.ftype-ext', el), name: $('.name', el), chip: $('.chip', el), meta: $('.meta', el),
      bar: $('.bar', el), fill: $('.bar-fill', el), pct: $('.pct', el), speed: $('.speed', el),
      eta: $('.eta', el), error: $('.error-line', el), actions: $('.actions', el),
    };
    return el;
  }

  function iconBtn(action, iconName, label, { cls = '', disabled = false } = {}) {
    const b = h('button', { class: `icon-btn ${cls}`.trim(), type: 'button', 'data-action': action, title: label, 'aria-label': label, disabled });
    b.append(svgIcon(iconName));
    return b;
  }

  function actionsFor(it) {
    switch (it.status) {
      case 'downloading':
        return [
          iconBtn('pause', 'pause', it.resumable ? 'Pause' : 'This server doesn\u2019t allow pausing', { disabled: !it.resumable }),
          iconBtn('cancel', 'x', 'Cancel download', { cls: 'danger' }),
        ];
      case 'queued': return [iconBtn('cancel', 'x', 'Cancel download', { cls: 'danger' })];
      case 'paused':
        return [iconBtn('resume', 'play', 'Resume', { cls: 'accent' }), iconBtn('cancel', 'x', 'Cancel download', { cls: 'danger' })];
      case 'failed': case 'canceled':
        return [iconBtn('retry', 'retry', 'Try again', { cls: 'accent' }), iconBtn('remove', 'trash', 'Remove from list', { cls: 'danger' })];
      case 'completed':
        return [
          iconBtn('open', 'open', 'Open file', { cls: 'accent', disabled: it.missing }),
          iconBtn('reveal', 'folder', 'Show in folder', { disabled: it.missing }),
          iconBtn('remove', 'trash', 'Remove from list', { cls: 'danger' }),
        ];
      default: return [];
    }
  }

  function updateCard(el, it) {
    const sig = [it.status, it.fileName, it.receivedBytes, it.totalBytes, Math.round(it.speed), it.eta, it.note, it.error, it.missing, it.resumable].join('|');
    if (el._sig === sig) return;
    el._sig = sig;
    const q = el._q;
    el.dataset.id = it.id;
    el.dataset.status = it.status;

    q.ext.textContent = extOf(it.fileName);
    q.name.textContent = it.fileName;
    q.name.title = `${it.fileName}\n${it.url}`;
    q.chip.className = `chip chip-${it.status}`;
    q.chip.textContent = STATUS_LABEL[it.status] || it.status;

    // size, source, finish time
    const known = it.totalBytes > 0;
    let sizeText;
    if (it.status === 'completed') sizeText = fmtBytes(it.totalBytes);
    else if (known) sizeText = `${fmtBytes(it.receivedBytes)} of ${fmtBytes(it.totalBytes)}`;
    else sizeText = it.receivedBytes > 0 ? `${fmtBytes(it.receivedBytes)} (size unknown)` : 'Size unknown';
    const metaParts = [sizeText, hostOf(it.url)];
    if (it.status === 'completed' && it.completedAt) metaParts.push(fmtDate(it.completedAt));
    q.meta.replaceChildren(...metaParts.filter(Boolean).map((t) => h('span', { text: t })));

    // progress
    const pct = known ? Math.min(100, (it.receivedBytes / it.totalBytes) * 100) : 0;
    q.fill.style.width = `${pct}%`;
    q.bar.classList.toggle('indeterminate', it.status === 'downloading' && !known);
    q.pct.textContent = known && it.status !== 'queued' ? `${pct.toFixed(pct >= 99.95 || pct === 0 ? 0 : 1)}%` : '';
    if (it.status === 'downloading') {
      q.speed.textContent = it.note || (it.speed > 0 ? `${fmtBytes(it.speed)}/s` : '');
      q.eta.textContent = it.note ? '' : fmtEta(it.eta);
    } else if (it.status === 'queued') {
      q.speed.textContent = 'Waiting in the queue';
      q.eta.textContent = '';
    } else if (it.status === 'paused') {
      q.speed.textContent = 'Paused. Press play to continue.';
      q.eta.textContent = '';
    } else {
      q.speed.textContent = '';
      q.eta.textContent = '';
    }

    // problems
    let problem = '';
    if (it.status === 'failed' || it.status === 'canceled') problem = it.error || '';
    else if (it.status === 'completed' && it.missing) problem = 'This file was moved or deleted.';
    q.error.textContent = problem;
    q.error.hidden = !problem;

    // buttons only change when the state does
    const key = [it.status, it.resumable, it.missing].join('|');
    if (el._actionsKey !== key) {
      el._actionsKey = key;
      q.actions.replaceChildren(...actionsFor(it));
    }
  }

  class CardList {
    constructor(container) {
      this.container = container;
      this.cards = new Map();
      this.seeded = false; // the first fill should not animate, later additions do
    }
    sync(items) {
      const keep = new Set();
      items.forEach((it, idx) => {
        keep.add(it.id);
        let el = this.cards.get(it.id);
        if (!el) {
          el = createCard();
          if (this.seeded) el.classList.add('is-new');
          this.cards.set(it.id, el);
        }
        updateCard(el, it);
        const at = this.container.children[idx] || null;
        if (at !== el) this.container.insertBefore(el, at);
      });
      for (const [id, el] of this.cards) {
        if (!keep.has(id)) { el.remove(); this.cards.delete(id); }
      }
      this.seeded = true;
    }
  }

  // ------------------------------------------------------------ state + rendering
  const state = { items: new Map(), view: 'home', filter: 'all', settings: null, info: null };
  const lists = {
    homeActive: new CardList($('#list-home-active')),
    homeRecent: new CardList($('#list-home-recent')),
    downloads: new CardList($('#list-downloads')),
    completed: new CardList($('#list-completed')),
  };
  const ACTIVE = new Set(['downloading', 'queued', 'paused']);
  const byNewest = (a, b) => b.createdAt - a.createdAt;
  const byFinished = (a, b) => (b.completedAt || 0) - (a.completedAt || 0);

  function setCount(sel, n) {
    const el = $(sel);
    el.textContent = String(n);
    el.hidden = n === 0;
  }

  const FILTER_EMPTY = {
    all: ['No downloads yet', 'Paste a link in the bar above to start your first download.'],
    active: ['Nothing is downloading', 'Downloads that are running, queued or paused will show up here.'],
    failed: ['No failed downloads', 'Anything that fails or is canceled appears here with a button to try again.'],
  };

  function render() {
    const all = [...state.items.values()];
    const active = all.filter((i) => ACTIVE.has(i.status)).sort(byNewest);
    const failed = all.filter((i) => i.status === 'failed' || i.status === 'canceled').sort(byNewest);
    const done = all.filter((i) => i.status === 'completed').sort(byFinished);
    const speed = all.reduce((s, i) => s + (i.status === 'downloading' ? i.speed : 0), 0);

    setCount('#count-downloads', active.length);
    setCount('#count-completed', done.length);
    $('#total-speed').textContent = `${fmtBytes(speed)}/s`;

    if (state.view === 'home') {
      $('#stat-active').textContent = String(active.length);
      $('#stat-completed').textContent = String(done.length);
      $('#stat-failed').textContent = String(failed.length);
      lists.homeActive.sync(active);
      $('#empty-home-active').hidden = active.length > 0;
      const recent = done.slice(0, 3);
      lists.homeRecent.sync(recent);
      $('#recent-title').hidden = recent.length === 0;
    } else if (state.view === 'downloads') {
      $('#tab-all').textContent = String(all.length);
      $('#tab-active').textContent = String(active.length);
      $('#tab-failed').textContent = String(failed.length);
      const shown = state.filter === 'active' ? active : state.filter === 'failed' ? failed : all.slice().sort(byNewest);
      lists.downloads.sync(shown);
      const empty = shown.length === 0;
      $('#empty-downloads').hidden = !empty;
      if (empty) {
        $('#empty-downloads-title').textContent = FILTER_EMPTY[state.filter][0];
        $('#empty-downloads-text').textContent = FILTER_EMPTY[state.filter][1];
      }
    } else if (state.view === 'completed') {
      lists.completed.sync(done);
      $('#empty-completed').hidden = done.length > 0;
      $('#clear-completed').hidden = done.length === 0;
    }
  }

  let raf = 0;
  function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; render(); });
  }

  function renderSettings() {
    if (!state.settings) return;
    $('#setting-dir').textContent = state.settings.downloadDir;
    $('#setting-notifications').checked = !!state.settings.notifications;
    $('#setting-concurrent').value = String(state.settings.maxConcurrent);
    if (state.info) {
      $('#about-line').textContent = `Zentro ${state.info.version} for Windows 10 and 11. Your download history is stored on this computer only.`;
    }
  }

  const TITLES = { home: 'Home', downloads: 'Downloads', completed: 'Completed', settings: 'Settings' };
  function setView(view) {
    state.view = view;
    $$('.nav-item').forEach((b) => {
      if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $$('.view').forEach((s) => { s.hidden = s.id !== `view-${view}`; });
    $('#page-title').textContent = TITLES[view];
    $('#urlzone').hidden = !(view === 'home' || view === 'downloads');
    if (view === 'settings') renderSettings();
    render();
    $('#views').scrollTop = 0;
  }

  // ------------------------------------------------------------ toasts
  function toast(message, kind = 'info') {
    const box = $('#toasts');
    while (box.children.length >= 4) box.firstChild.remove();
    const t = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status', text: message });
    box.append(t);
    setTimeout(() => t.remove(), kind === 'error' ? 7000 : 4000);
  }

  // ------------------------------------------------------------ add download
  const urlInput = $('#url-input');
  const urlError = $('#url-error');
  const downloadBtn = $('#download-btn');

  function showUrlError(msg) {
    urlError.textContent = msg;
    urlError.hidden = false;
    $('#urlbar').classList.add('is-error');
  }
  function clearUrlError() {
    urlError.hidden = true;
    $('#urlbar').classList.remove('is-error');
  }

  async function submitUrl() {
    const value = urlInput.value.trim();
    if (!value) { showUrlError('Paste a download link first.'); urlInput.focus(); return; }
    downloadBtn.disabled = true;
    try {
      const item = await api.add(value);
      state.items.set(item.id, item);
      urlInput.value = '';
      clearUrlError();
      if (state.view === 'downloads') state.filter = 'all';
      render();
    } catch (err) {
      showUrlError(err.message);
    } finally {
      downloadBtn.disabled = false;
    }
  }

  downloadBtn.addEventListener('click', submitUrl);
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitUrl(); } });
  urlInput.addEventListener('input', clearUrlError);

  $('#paste-btn').addEventListener('click', async () => {
    try {
      const text = (await api.readClipboard()).trim();
      if (!text) { toast('Your clipboard is empty.'); return; }
      urlInput.value = text;
      clearUrlError();
      urlInput.focus();
    } catch (err) { toast(err.message, 'error'); }
  });

  // paste or drop a link anywhere in the window
  function takeLink(text) {
    if (!text || $('#urlzone').hidden) return false;
    urlInput.value = text.split(/\r?\n/)[0].trim().slice(0, 2048);
    clearUrlError();
    urlInput.focus();
    return true;
  }
  document.addEventListener('paste', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (takeLink(e.clipboardData.getData('text'))) e.preventDefault();
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    takeLink(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'));
  });

  // ------------------------------------------------------------ card actions (event delegation)
  const ACTIONS = {
    pause: (id) => api.pause(id),
    resume: (id) => api.resume(id),
    cancel: (id) => api.cancel(id),
    retry: (id) => api.retry(id),
    remove: (id) => api.remove(id),
    open: (id) => api.open(id),
    reveal: (id) => api.showInFolder(id),
  };

  $('#views').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const card = btn.closest('.card');
    const run = ACTIONS[btn.dataset.action];
    if (!card || !run) return;
    btn.disabled = true;
    try {
      await run(card.dataset.id);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  });

  // ------------------------------------------------------------ navigation + toolbar
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    state.filter = t.dataset.filter;
    $$('.tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    render();
  }));

  $('#open-downloads-folder').addEventListener('click', () => api.openFolder('windows').catch((e) => toast(e.message, 'error')));
  $('#clear-completed').addEventListener('click', async () => {
    try {
      const n = await api.clearCompleted();
      toast(n ? `Cleared ${n} ${n === 1 ? 'entry' : 'entries'}. The files stay on your computer.` : 'Nothing to clear.');
    } catch (err) { toast(err.message, 'error'); }
  });

  // ------------------------------------------------------------ settings
  async function saveSetting(patch) {
    try {
      state.settings = await api.setSettings(patch);
    } catch (err) {
      toast(err.message, 'error');
    }
    renderSettings();
  }
  $('#choose-folder').addEventListener('click', async () => {
    try {
      const dir = await api.chooseFolder();
      if (!dir) return;
      await saveSetting({ downloadDir: dir });
      toast('Download folder updated.');
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#open-configured-folder').addEventListener('click', () => api.openFolder('configured').catch((e) => toast(e.message, 'error')));
  $('#setting-notifications').addEventListener('change', (e) => saveSetting({ notifications: e.target.checked }));
  $('#setting-concurrent').addEventListener('change', (e) => saveSetting({ maxConcurrent: Number(e.target.value) }));

  // ------------------------------------------------------------ live updates from the main process
  api.onUpdates((batch) => {
    if (!Array.isArray(batch)) return;
    for (const it of batch) if (it && typeof it.id === 'string') state.items.set(it.id, it);
    scheduleRender();
  });
  api.onRemoved((id) => { state.items.delete(id); scheduleRender(); });

  // ------------------------------------------------------------ start
  async function init() {
    hydrateIcons();
    try {
      const [items, settings, info] = await Promise.all([api.list(), api.getSettings(), api.getInfo()]);
      items.forEach((it) => state.items.set(it.id, it));
      state.settings = settings;
      state.info = info;
      $('#version').textContent = `Version ${info.version}`;
    } catch (err) {
      toast(err.message, 'error');
    }
    setView('home');
    urlInput.focus();
  }
  init();
})();
