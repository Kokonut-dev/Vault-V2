/**
 * Import from Google Drive (Upload page).
 *
 *  - Paste a share link → preview what's inside → pick a library → Import.
 *  - "Connect Google account" (when an OAuth client ID is set up in
 *    Settings → Links & imports) → browse My Drive, tick files/folders.
 *  - Running and recent imports with live progress (SSE `import:progress`).
 *
 * The Google token comes from Google Identity Services in this browser,
 * lives only in memory, and is sent to the Vault server per request.
 */
import { api } from '../api.js';
import { toast } from './toast.js';
import { icon } from '../utils/icons.js';
import { escapeHtml, escapeAttr } from '../utils/format.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DESTINATIONS = [
  ['auto', 'Automatic (by file type)'],
  ['movies', 'Movies & series'],
  ['music', 'Music'],
  ['videos', 'Videos'],
  ['audiobooks', 'Audiobooks'],
  ['podcasts', 'Podcasts'],
  ['comics', 'Comics & books'],
];
const KIND_ICON = { video: 'film', audio: 'music', audiobook: 'book', subtitle: 'captions', image: 'palette', comic: 'book', folder: 'folder', other: 'file-question', 'google-doc': 'file-question' };
const KIND_LABEL = { video: 'Video', audio: 'Music', audiobook: 'Audiobook', subtitle: 'Subtitles', image: 'Artwork', comic: 'Comic/book', other: 'Not media', 'google-doc': 'Google Docs file' };

// One token per page load, never persisted.
let google = { token: null, expiresAt: 0, email: null };

export function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve(window.google);
  return new Promise((resolve, reject) => {
    let script = document.querySelector('script[data-gis]');
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.dataset.gis = '1';
      document.head.append(script);
    }
    const timer = setTimeout(() => reject(new Error('Google sign-in didn’t load — check your connection or content blockers')), 15000);
    script.addEventListener('load', () => { clearTimeout(timer); resolve(window.google); }, { once: true });
    script.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Google sign-in is blocked on this page')); }, { once: true });
  });
}

async function requestToken(clientId, { prompt = '' } = {}) {
  const g = await loadGis();
  return new Promise((resolve, reject) => {
    const client = g.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      prompt,
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        resolve(resp);
      },
      error_callback: (err) => reject(new Error(err?.type === 'popup_closed' ? 'The Google window was closed' : err?.message || 'Google sign-in failed')),
    });
    client.requestAccessToken();
  });
}

function tokenValid() {
  return google.token && Date.now() < google.expiresAt - 60000;
}

export function renderDriveImport(host) {
  host.innerHTML = `
    <section class="drive-import" aria-labelledby="drive-title">
      <header class="drive-head">
        <span class="drive-logo" aria-hidden="true">${icon('drive', { size: 22 })}</span>
        <div>
          <h2 class="drive-title" id="drive-title">Import from Google Drive</h2>
          <p class="drive-sub">Files are copied to this server and added to your library.</p>
        </div>
        <div class="drive-account" id="drive-account"></div>
      </header>

      <form class="drive-link" id="drive-link-form" novalidate>
        <label class="form-label" for="drive-link">Share link</label>
        <div class="input-with-actions">
          <input type="url" inputmode="url" class="form-input" id="drive-link" placeholder="https://drive.google.com/drive/folders/…" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="drive-link-help drive-link-error">
          <button type="submit" class="btn btn-primary" id="drive-preview-btn">${icon('search', { size: 15 })}<span>Preview</span></button>
        </div>
        <p class="setting-help" id="drive-link-help">In Google Drive: <strong>Share → General access → Anyone with the link</strong>, then <strong>Copy link</strong>. Works for single files and whole folders.</p>
        <p class="field-error" id="drive-link-error" role="alert" hidden></p>
      </form>

      <div class="drive-browser" id="drive-browser" hidden></div>
      <div class="drive-preview" id="drive-preview" hidden></div>

      <div class="drive-jobs" id="drive-jobs" aria-live="polite"></div>
    </section>`;

  const form = host.querySelector('#drive-link-form');
  const input = host.querySelector('#drive-link');
  const linkError = host.querySelector('#drive-link-error');
  const previewHost = host.querySelector('#drive-preview');
  const browserHost = host.querySelector('#drive-browser');
  const accountHost = host.querySelector('#drive-account');
  const jobsHost = host.querySelector('#drive-jobs');
  let config = { clientId: null, apiKeyConfigured: false };
  let listing = null;
  let listingSource = null; // { link } | { files }
  const jobs = new Map();

  // ------------------------------------------------------------ account
  function paintAccount() {
    if (!config.clientId) {
      accountHost.innerHTML = `<a class="btn btn-ghost btn-sm" href="settings#links" data-route="/settings#links">${icon('settings', { size: 14 })}<span>Private files…</span></a>`;
      return;
    }
    accountHost.innerHTML = tokenValid()
      ? `<span class="drive-chip">${icon('check-circle', { size: 14 })}<span>Google account connected</span></span>
         <button type="button" class="btn btn-ghost btn-sm" data-action="disconnect">Disconnect</button>`
      : `<button type="button" class="btn btn-secondary btn-sm" data-action="connect">${icon('user', { size: 14 })}<span>Connect Google account</span></button>`;
  }

  async function connect() {
    try {
      const resp = await requestToken(config.clientId);
      google = { token: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
      paintAccount();
      toast.success('Google account connected');
      browse('root');
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function ensureToken() {
    if (!config.clientId) return undefined;
    if (tokenValid()) return google.token;
    if (!google.token) return undefined; // never connected: public mode
    const resp = await requestToken(config.clientId, { prompt: '' });
    google = { token: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
    return google.token;
  }

  // ------------------------------------------------------------ browser
  const crumbs = [{ id: 'root', name: 'My Drive' }];
  async function browse(folderId, { query = '' } = {}) {
    browserHost.hidden = false;
    browserHost.innerHTML = `<div class="drive-loading">${icon('loader', { size: 16 })}<span>Loading your Drive…</span></div>`;
    try {
      const token = await ensureToken();
      const data = await api.browseDrive({ folder: folderId, q: query }, token);
      if (!query) {
        const at = crumbs.findIndex(c => c.id === folderId);
        if (at >= 0) crumbs.splice(at + 1);
        else crumbs.push({ id: folderId, name: data.folder.name });
      }
      paintBrowser(data, query);
    } catch (err) {
      if (err.code === 'TOKEN_EXPIRED') { google.token = null; paintAccount(); }
      browserHost.innerHTML = `<p class="settings-callout is-error">${icon('alert-circle', { size: 15 })}<span>${escapeHtml(err.message)}</span></p>`;
    }
  }

  function paintBrowser(data, query) {
    const items = data.items || [];
    browserHost.innerHTML = `
      <div class="drive-browser-bar">
        <nav class="drive-crumbs" aria-label="Folder">
          ${query ? `<button type="button" class="btn-link" data-crumb="root">My Drive</button><span aria-hidden="true">›</span><span>${escapeHtml(data.folder.name)}</span>`
            : crumbs.map((c, i) => (i === crumbs.length - 1 ? `<span aria-current="location">${escapeHtml(c.name)}</span>` : `<button type="button" class="btn-link" data-crumb="${escapeAttr(c.id)}">${escapeHtml(c.name)}</button><span aria-hidden="true">›</span>`)).join('')}
        </nav>
        <form class="drive-search" role="search"><label class="sr-only" for="drive-search">Search your Drive</label>
          <input type="search" class="form-input" id="drive-search" placeholder="Search your Drive" value="${escapeAttr(query)}"></form>
      </div>
      ${items.length ? `
        <ul class="drive-list" role="list">
          ${items.map(it => `
            <li class="drive-row${it.supported ? '' : ' is-unsupported'}">
              <label class="drive-row-check">
                <input type="checkbox" value="${escapeAttr(it.id)}" data-name="${escapeAttr(it.name)}"${it.supported ? '' : ' disabled'} aria-label="Select ${escapeAttr(it.name)}">
              </label>
              <span class="drive-row-icon" aria-hidden="true">${icon(KIND_ICON[it.kind] || 'file-question', { size: 16 })}</span>
              ${it.kind === 'folder'
                ? `<button type="button" class="drive-row-name btn-link" data-open="${escapeAttr(it.id)}">${escapeHtml(it.name)}</button>`
                : `<span class="drive-row-name">${escapeHtml(it.name)}</span>`}
              <span class="drive-row-meta">${it.kind === 'folder' ? 'Folder' : `${KIND_LABEL[it.kind] || ''}${it.size != null ? ` · ${formatBytes(it.size)}` : ''}`}</span>
            </li>`).join('')}
        </ul>` : `<p class="drive-empty">${query ? 'Nothing matches that search.' : 'This folder is empty.'}</p>`}
      <div class="drive-browser-actions">
        <span class="drive-selected" id="drive-selected">Nothing selected</span>
        <button type="button" class="btn btn-primary btn-sm" data-action="preview-selected" disabled>${icon('check', { size: 14 })}<span>Review selection</span></button>
      </div>`;
    const updateCount = () => {
      const picked = browserHost.querySelectorAll('.drive-list input:checked').length;
      browserHost.querySelector('#drive-selected').textContent = picked ? `${picked} selected` : 'Nothing selected';
      browserHost.querySelector('[data-action="preview-selected"]').disabled = !picked;
    };
    browserHost.querySelectorAll('.drive-list input').forEach(cb => cb.addEventListener('change', updateCount));
    browserHost.querySelector('.drive-search').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = browserHost.querySelector('#drive-search').value.trim();
      browse(q ? 'root' : crumbs.at(-1).id, { query: q });
    });
  }

  browserHost.addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    if (open) return browse(open.dataset.open);
    const crumb = e.target.closest('[data-crumb]');
    if (crumb) return browse(crumb.dataset.crumb);
    if (e.target.closest('[data-action="preview-selected"]')) {
      const ids = [...browserHost.querySelectorAll('.drive-list input:checked')].map(cb => cb.value);
      runPreview({ files: ids });
    }
  });

  // ------------------------------------------------------------ preview
  function showLinkError(message) {
    linkError.textContent = message;
    linkError.hidden = !message;
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  async function runPreview(source) {
    showLinkError('');
    previewHost.hidden = false;
    previewHost.innerHTML = `<div class="drive-loading">${icon('loader', { size: 16 })}<span>Looking inside…</span></div>`;
    const btn = host.querySelector('#drive-preview-btn');
    btn.disabled = true;
    try {
      listingSource = source;
      if (source.files) {
        // Picked in the browser: names/sizes were already shown there.
        listing = null;
        paintPicked(source.files);
        return;
      }
      const token = await ensureToken();
      listing = await api.inspectDrive(source.link, token);
      paintPreview();
    } catch (err) {
      previewHost.hidden = true;
      if (source.link) {
        showLinkError(err.message);
        input.focus();
      } else {
        toast.error(err.message);
      }
    } finally {
      btn.disabled = false;
    }
  }

  function destinationSelect() {
    return `
      <div class="drive-dest">
        <label class="form-label" for="drive-dest">Add to</label>
        <select class="form-input" id="drive-dest">
          ${DESTINATIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select>
      </div>`;
  }

  /** Hand-picked files from the browser: no per-file preview needed. */
  function paintPicked(ids) {
    previewHost.innerHTML = `
      <div class="drive-summary">
        <div><p class="drive-summary-title">${ids.length} item${ids.length === 1 ? '' : 's'} selected</p>
        <p class="setting-help">Folders are imported with everything inside them. Files Vault can’t play are skipped.</p></div>
      </div>
      <div class="drive-preview-actions">${destinationSelect()}
        <button type="button" class="btn btn-primary" data-action="import">${icon('download', { size: 15 })}<span>Import</span></button>
      </div>`;
  }

  function paintPreview() {
    const items = listing.items || [];
    const supported = items.filter(i => i.supported);
    const skipped = items.length - supported.length;
    const known = supported.every(i => i.size != null);
    const total = supported.reduce((s, i) => s + (i.size || 0), 0);
    const counts = {};
    for (const it of supported) counts[it.kind] = (counts[it.kind] || 0) + 1;
    const breakdown = Object.entries(counts).map(([k, n]) => `${n} ${(KIND_LABEL[k] || k).toLowerCase()}`).join(' · ');
    previewHost.innerHTML = `
      <div class="drive-summary">
        <span class="drive-summary-icon" aria-hidden="true">${icon(listing.kind === 'folder' ? 'folder' : KIND_ICON[items[0]?.kind] || 'file-question', { size: 20 })}</span>
        <div>
          <p class="drive-summary-title">${escapeHtml(listing.name || 'Google Drive')}</p>
          <p class="setting-help">${supported.length ? `${breakdown}${known && total ? ` · ${formatBytes(total)}` : ''}` : 'No media Vault can play'}${skipped ? ` · ${skipped} other file${skipped === 1 ? '' : 's'} skipped` : ''}${listing.truncated ? ' · showing the first 2000' : ''}</p>
        </div>
      </div>
      ${items.length > 1 ? `
        <details class="drive-files"${items.length <= 12 ? ' open' : ''}>
          <summary>Choose files (${supported.length} of ${supported.length} selected)</summary>
          <div class="drive-files-tools"><button type="button" class="btn-link" data-action="all">Select all</button> · <button type="button" class="btn-link" data-action="none">None</button></div>
          <ul class="drive-list" role="list">
            ${items.map(it => `
              <li class="drive-row${it.supported ? '' : ' is-unsupported'}">
                <label class="drive-row-check"><input type="checkbox" value="${escapeAttr(it.id)}"${it.supported ? ' checked' : ' disabled'} aria-label="Import ${escapeAttr(it.name)}"></label>
                <span class="drive-row-icon" aria-hidden="true">${icon(KIND_ICON[it.kind] || 'file-question', { size: 16 })}</span>
                <span class="drive-row-name">${it.relDir ? `<span class="drive-row-dir">${escapeHtml(it.relDir)}/</span>` : ''}${escapeHtml(it.name)}</span>
                <span class="drive-row-meta">${KIND_LABEL[it.kind] || ''}${it.size != null ? ` · ${formatBytes(it.size)}` : ''}</span>
              </li>`).join('')}
          </ul>
        </details>` : ''}
      ${supported.length ? `
        <div class="drive-preview-actions">${destinationSelect()}
          <button type="button" class="btn btn-primary" data-action="import">${icon('download', { size: 15 })}<span>Import ${supported.length} file${supported.length === 1 ? '' : 's'}</span></button>
        </div>
        ${listing.mode === 'public' && listing.kind === 'folder' ? '<p class="setting-help drive-note">Public folders are read without sizes. A Google API key or a connected account (Settings → Links & imports) makes big folders faster and more reliable.</p>' : ''}` : ''}`;
    const sync = () => {
      const boxes = [...previewHost.querySelectorAll('.drive-files input:not(:disabled)')];
      const picked = boxes.filter(b => b.checked).length;
      const summary = previewHost.querySelector('.drive-files summary');
      if (summary) summary.textContent = `Choose files (${picked} of ${boxes.length} selected)`;
      const go = previewHost.querySelector('[data-action="import"]');
      if (go) {
        go.disabled = !picked;
        go.querySelector('span').textContent = `Import ${picked} file${picked === 1 ? '' : 's'}`;
      }
    };
    previewHost.querySelectorAll('.drive-files input').forEach(b => b.addEventListener('change', sync));
    previewHost.addEventListener('click', (e) => {
      const a = e.target.closest('[data-action="all"], [data-action="none"]');
      if (!a) return;
      previewHost.querySelectorAll('.drive-files input:not(:disabled)').forEach(b => { b.checked = a.dataset.action === 'all'; });
      sync();
    });
  }

  previewHost.addEventListener('click', async (e) => {
    const go = e.target.closest('[data-action="import"]');
    if (!go) return;
    go.disabled = true;
    const destination = previewHost.querySelector('#drive-dest')?.value || 'auto';
    const boxes = [...previewHost.querySelectorAll('.drive-files input:not(:disabled)')];
    const selection = boxes.length ? boxes.filter(b => b.checked).map(b => b.value) : undefined;
    try {
      const token = await ensureToken();
      const job = await api.importFromDrive({
        link: listingSource.link,
        files: listingSource.files,
        selection: listingSource.link ? selection : undefined,
        destination,
        accessToken: token,
      });
      jobs.set(job.id, job);
      paintJobs();
      previewHost.hidden = true;
      previewHost.innerHTML = '';
      browserHost.querySelectorAll('.drive-list input:checked').forEach(cb => { cb.checked = false; });
      input.value = '';
      toast.info(`Importing “${job.name}”…`);
    } catch (err) {
      toast.error(err.message);
      go.disabled = false;
    }
  });

  // ------------------------------------------------------------ jobs
  function jobLine(job) {
    const pct = job.totalBytes ? Math.min(100, Math.round((job.receivedBytes / job.totalBytes) * 100)) : null;
    const done = job.files.filter(f => f.status === 'done').length;
    const running = job.status === 'running';
    const statusText = {
      running: `${done} of ${job.files.length} files${job.totalBytes ? ` · ${formatBytes(job.receivedBytes)} of ${formatBytes(job.totalBytes)}` : job.receivedBytes ? ` · ${formatBytes(job.receivedBytes)}` : ''}`,
      done: `Done — ${job.imported} file${job.imported === 1 ? '' : 's'} added`,
      partial: `${job.imported} added, ${job.failed} failed`,
      error: job.error || 'Failed',
      cancelled: 'Cancelled',
    }[job.status] || job.status;
    const failed = job.files.filter(f => f.status === 'error');
    return `
      <li class="drive-job is-${job.status}" data-job="${escapeAttr(job.id)}">
        <div class="drive-job-head">
          <span class="drive-job-icon" aria-hidden="true">${icon(running ? 'loader' : job.status === 'done' ? 'check-circle' : job.status === 'cancelled' ? 'x' : 'alert-circle', { size: 16 })}</span>
          <div class="drive-job-text">
            <p class="drive-job-name">${escapeHtml(job.name)}</p>
            <p class="drive-job-status">${escapeHtml(statusText)}</p>
          </div>
          ${running ? `<button type="button" class="btn btn-ghost btn-sm" data-cancel="${escapeAttr(job.id)}">Cancel</button>` : ''}
        </div>
        ${running ? `<div class="progress" role="progressbar" aria-label="Import progress"${pct != null ? ` aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"` : ''}><div class="progress-bar${pct == null ? ' is-indeterminate' : ''}" style="width:${pct ?? 30}%"></div></div>` : ''}
        ${failed.length ? `<details class="drive-job-errors"><summary>${failed.length} file${failed.length === 1 ? '' : 's'} failed</summary><ul>${failed.slice(0, 50).map(f => `<li><strong>${escapeHtml(f.name)}</strong> — ${escapeHtml(f.error || 'failed')}</li>`).join('')}</ul></details>` : ''}
      </li>`;
  }

  function paintJobs() {
    const list = [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 6);
    jobsHost.innerHTML = list.length ? `<h3 class="drive-jobs-title">Imports</h3><ul class="drive-job-list" role="list">${list.map(jobLine).join('')}</ul>` : '';
  }

  jobsHost.addEventListener('click', async (e) => {
    const cancel = e.target.closest('[data-cancel]');
    if (!cancel) return;
    cancel.disabled = true;
    try { await api.cancelImport(cancel.dataset.cancel); } catch (err) { toast.error(err.message); cancel.disabled = false; }
  });

  const onProgress = (e) => {
    const job = e.detail;
    if (!job?.id) return;
    jobs.set(job.id, job);
    if (!host.isConnected) return;
    paintJobs(); // the finish toast comes from events.js (job:finished)
  };
  window.addEventListener('vault:import-progress', onProgress);
  // While a job runs, also poll in case live updates are unavailable.
  const poll = setInterval(async () => {
    if (!host.isConnected) { clearInterval(poll); window.removeEventListener('vault:import-progress', onProgress); return; }
    if (![...jobs.values()].some(j => j.status === 'running')) return;
    try {
      const { jobs: list } = await api.importJobs();
      for (const job of list) onProgress({ detail: job });
    } catch { /* offline */ }
  }, 3000);

  // ------------------------------------------------------------ wiring
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const link = input.value.trim();
    if (!link) { showLinkError('Paste a Google Drive link first'); input.focus(); return; }
    if (!/drive\.google\.com|docs\.google\.com|drive\.usercontent\.google\.com/i.test(link)) {
      showLinkError('That isn’t a Google Drive link — it should start with https://drive.google.com/');
      input.focus();
      return;
    }
    runPreview({ link });
  });
  input.addEventListener('input', () => showLinkError(''));
  input.addEventListener('paste', () => setTimeout(() => {
    if (/drive\.google\.com/.test(input.value)) form.requestSubmit();
  }, 0));
  accountHost.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'connect') connect();
    if (action === 'disconnect') {
      try { window.google?.accounts?.oauth2?.revoke?.(google.token, () => {}); } catch { /* best effort */ }
      google = { token: null, expiresAt: 0 };
      browserHost.hidden = true;
      paintAccount();
    }
  });

  (async () => {
    try {
      config = await api.driveConfig();
    } catch (err) {
      if (err.code === 'ADMIN_REQUIRED') {
        host.querySelector('.drive-import').innerHTML = `<p class="settings-callout">${icon('lock', { size: 15 })}<span>Only an admin profile can import from Google Drive.</span></p>`;
        return;
      }
      if (err.status === 404) {
        form.querySelector('#drive-link-help').textContent = 'Your Vault server is older than this page — update and restart it to import from Google Drive.';
        form.querySelector('button').disabled = true;
        return;
      }
    }
    paintAccount();
    if (tokenValid()) browse('root');
    try {
      const { jobs: list } = await api.importJobs();
      for (const job of list) jobs.set(job.id, job);
      paintJobs();
    } catch { /* none yet */ }
  })();
}

export default { renderDriveImport };
