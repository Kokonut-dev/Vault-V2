/**
 * Move to another server — the export and import panels.
 *
 * Used by Settings → Move to another server, and (import only) by the setup
 * wizard of a brand-new server ("Import from another Vault").
 */
import { api } from '../api.js';
import { icon } from '../utils/icons.js';
import { escapeHtml, formatBytes } from '../utils/format.js';
import { confirmDialog } from './confirmDialog.js';
import { waitForServer, waitForServerDown } from '../utils/serverLauncher.js';
import { fieldError, clearFieldError } from '../views/settings/ui.js';

const n = (value) => Number(value || 0).toLocaleString();
const PHASES = {
  prepare: 'Getting ready…',
  upload: 'Uploading the package',
  media: 'Copying your media',
  copy: 'Copying',
  data: 'Relinking playlists, history and artwork',
  done: 'Finishing',
};

function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

function eta(job, startedAt) {
  if (!job.bytesTotal || !job.bytesDone || !startedAt) return '';
  const elapsed = (Date.now() - startedAt) / 1000;
  if (elapsed < 5) return '';
  const rate = job.bytesDone / elapsed;
  const left = (job.bytesTotal - job.bytesDone) / Math.max(rate, 1);
  if (!Number.isFinite(left) || left <= 0) return '';
  if (left < 90) return ' · less than 2 min left';
  if (left < 3600) return ` · about ${Math.round(left / 60)} min left`;
  return ` · about ${(left / 3600).toFixed(1)} h left`;
}

/** A progress card with a Cancel button. `update(job)` repaints it. */
export function jobCard({ onCancel } = {}) {
  const node = el(`<div class="transfer-job" hidden>
      <div class="transfer-job-head">
        <span class="transfer-job-icon" aria-hidden="true"></span>
        <div class="transfer-job-text">
          <p class="transfer-job-title"></p>
          <p class="transfer-job-status" role="status" aria-live="polite"></p>
        </div>
        <button type="button" class="btn btn-ghost btn-sm transfer-job-cancel">Cancel</button>
      </div>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width:0%"></div></div>
    </div>`);
  const bar = node.querySelector('.progress-bar');
  const progress = node.querySelector('.progress');
  const cancel = node.querySelector('.transfer-job-cancel');
  let started = null;
  cancel.addEventListener('click', () => onCancel?.());
  node.update = (job, { title } = {}) => {
    if (!job) { node.hidden = true; return; }
    node.hidden = false;
    const running = job.status === 'running';
    if (running && !started) started = Date.now();
    node.className = `transfer-job is-${job.status}`;
    node.querySelector('.transfer-job-icon').innerHTML = icon(running ? 'loader' : job.status === 'done' ? 'check-circle' : 'alert-triangle', { size: 18, className: running ? 'icon spin' : 'icon' });
    node.querySelector('.transfer-job-title').textContent = title || (job.kind === 'import' ? 'Importing from another Vault' : 'Saving a transfer copy');
    const pct = job.bytesTotal ? Math.min(100, Math.floor((job.bytesDone / job.bytesTotal) * 100)) : (job.status === 'done' ? 100 : 0);
    bar.style.width = `${pct}%`;
    bar.classList.toggle('is-indeterminate', running && !job.bytesTotal);
    progress.setAttribute('aria-valuenow', String(pct));
    cancel.hidden = !running;
    let text;
    if (running) {
      text = PHASES[job.phase] || 'Working…';
      if (job.bytesTotal) text += ` — ${formatBytes(job.bytesDone)} of ${formatBytes(job.bytesTotal)} (${pct}%)${eta(job, started)}`;
      else if (job.filesTotal) text += ` — ${n(job.filesDone)} of ${n(job.filesTotal)} files`;
    } else if (job.status === 'done') {
      text = 'Done';
    } else if (job.status === 'cancelled') {
      text = 'Cancelled. Files copied so far are kept, so trying again picks up where it stopped.';
    } else {
      text = job.error || 'Something went wrong';
    }
    node.querySelector('.transfer-job-status').textContent = text;
  };
  return node;
}

/** Poll the server's job until it stops running. */
export async function followJob(card, { title, signal } = {}) {
  for (;;) {
    if (signal?.aborted) return null;
    let state;
    try {
      state = await api.transferStatus();
    } catch (err) {
      // The server restarting after an import looks like this too.
      return { status: 'unreachable', error: err.message };
    }
    card.update(state.job, { title });
    if (!state.job || state.job.status !== 'running') return state.job;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, 1000));
  }
}

function folderList(folders = []) {
  return folders.length
    ? `<ul class="transfer-folders">${folders.map(f => `<li><strong>${escapeHtml(f.label)}</strong> <code>${escapeHtml(f.path)}</code></li>`).join('')}</ul>`
    : '';
}

/** After an import: wait for the restart, then reload into the sign-in screen. */
async function finishImport(report, job) {
  const result = job.result || {};
  const where = folderList(result.folders);
  const restarting = job.restarting || job.status === 'unreachable';
  if (!restarting) {
    report.innerHTML = `<div class="settings-callout is-ok">${icon('check-circle', { size: 15 })}<div>
        <p><strong>Import ready.</strong> Restart Vault to finish: press <kbd>Ctrl</kbd>+<kbd>C</kbd> in its terminal window, then run <code>npm start</code> again.</p>
        ${where ? `<p>Your media is in:</p>${where}` : ''}
      </div></div>`;
    return;
  }
  report.innerHTML = `<p class="settings-callout is-info">${icon('loader', { size: 15, className: 'icon spin' })}<span>Imported ${n(result.items)} library items. Restarting Vault to load them…</span></p>`;
  await waitForServerDown({ timeoutMs: 20000 });
  const back = await waitForServer({ timeoutMs: 180000 });
  report.innerHTML = back
    ? `<div class="settings-callout is-ok">${icon('check-circle', { size: 15 })}<div>
        <p><strong>Your library has moved in.</strong> Sign in with the username, password and grid from your old server. Vault checks every file once in the background, so thumbnails can take a few minutes to appear.</p>
        ${where ? `<p>Your media is in:</p>${where}` : ''}
        <p><button type="button" class="btn btn-primary btn-sm" data-reload>${icon('arrow-right', { size: 14 })}<span>Continue to sign in</span></button></p>
      </div></div>`
    : `<p class="settings-callout is-error">${icon('alert-circle', { size: 15 })}<span>Vault didn’t come back after restarting. Start it again (<code>npm start</code>) — the import finishes when it starts.</span></p>`;
  report.querySelector('[data-reload]')?.addEventListener('click', () => {
    localStorage.removeItem('vault_token');
    window.location.reload();
  });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
export function mountImport(container, { setupMode = false } = {}) {
  container.innerHTML = `
    <form class="transfer-form" novalidate>
      <div class="transfer-field">
        <label class="setting-label" for="tr-media-dir">Where should the media go on this computer?</label>
        <p class="setting-help" id="tr-media-dir-help">Each library becomes a folder in here, organised exactly like before. Pick a drive with enough space.</p>
        <input class="form-input" id="tr-media-dir" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="tr-media-dir-help">
      </div>

      <fieldset class="transfer-field transfer-source">
        <legend class="setting-label">The package from your old server</legend>
        <div class="segmented" role="radiogroup" aria-label="Where the package is">
          <label class="segmented-option"><input type="radio" name="tr-source" value="upload" checked><span>Upload it from this device</span></label>
          <label class="segmented-option"><input type="radio" name="tr-source" value="path"><span>It’s already on the server computer</span></label>
        </div>
        <div class="transfer-source-pane" data-pane="upload">
          <p class="setting-help">Choose the <code>.zip</code> you downloaded. For very big libraries, copying it to the server computer first (e.g. with a USB drive) is faster.</p>
          <input type="file" class="form-input" id="tr-file" accept=".zip,application/zip">
        </div>
        <div class="transfer-source-pane" data-pane="path" hidden>
          <p class="setting-help" id="tr-path-help">The full path to the <code>.zip</code>, or to the folder if you unzipped it or saved it to a drive — e.g. <code>/Volumes/MyDrive/Vault transfer - …</code></p>
          <div class="input-with-actions">
            <input class="form-input" id="tr-path" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="tr-path-help">
            <button type="button" class="btn btn-secondary" id="tr-check">Check</button>
          </div>
          <label class="transfer-check" id="tr-copy-wrap" hidden><input type="checkbox" class="checkbox" id="tr-copy" checked> Copy the media into the folder above <span class="setting-help">(untick to keep using it where it is, e.g. on that drive)</span></label>
        </div>
      </fieldset>

      <div class="transfer-preview" id="tr-preview" hidden></div>
      <p class="setting-help transfer-note">${setupMode
        ? 'This replaces the setup wizard: your account, settings and library come from the old server.'
        : 'This replaces this server’s library and settings with the old server’s. The current ones are kept in a backup folder (server/backups).'}</p>
      <div class="settings-actions">
        <button type="submit" class="btn btn-primary" id="tr-import">${icon('upload', { size: 15 })}<span>Import</span></button>
      </div>
      <div class="transfer-report" id="tr-report" aria-live="polite"></div>
    </form>`;

  const form = container.querySelector('form');
  const mediaDir = form.querySelector('#tr-media-dir');
  const file = form.querySelector('#tr-file');
  const pathInput = form.querySelector('#tr-path');
  const preview = form.querySelector('#tr-preview');
  const report = form.querySelector('#tr-report');
  const importBtn = form.querySelector('#tr-import');
  const copyWrap = form.querySelector('#tr-copy-wrap');
  const inputs = { source: pathInput, mediaDir, file };
  /** Show a failure next to its field when the server says which one, else below. */
  function showError(err) {
    const [key, message] = Object.entries(err.fields || {})[0] || [];
    const input = inputs[key === 'source' && mode() === 'upload' ? 'file' : key];
    if (input && message) { fieldError(input, message); input.focus(); return; }
    report.innerHTML = `<p class="settings-callout is-error">${icon('alert-circle', { size: 15 })}<span>${escapeHtml(err.message)}</span></p>`;
  }
  function clearErrors() {
    report.innerHTML = '';
    Object.values(inputs).forEach(clearFieldError);
  }
  Object.values(inputs).forEach(i => i.addEventListener('input', () => clearFieldError(i)));
  let upload = null;
  let inspected = null;
  const card = jobCard({
    onCancel: async () => {
      upload?.abort();
      try { await api.cancelTransfer(); } catch { /* already stopped */ }
    },
  });
  form.querySelector('.settings-actions').after(card);

  const mode = () => form.querySelector('input[name="tr-source"]:checked').value;
  form.querySelectorAll('input[name="tr-source"]').forEach(r => r.addEventListener('change', () => {
    form.querySelectorAll('.transfer-source-pane').forEach(p => { p.hidden = p.dataset.pane !== mode(); });
    preview.hidden = true;
    report.innerHTML = '';
  }));

  api.transferStatus().then((state) => {
    if (!mediaDir.value) mediaDir.value = state.defaults?.mediaDir || '';
    if (state.job?.status === 'running' && state.job.kind === 'import') watch();
  }).catch((err) => {
    report.innerHTML = `<p class="settings-callout is-error">${icon('alert-circle', { size: 15 })}<span>${escapeHtml(err.status === 404 ? 'This Vault server is too old to import. Update it (git pull, npm install), restart it, then reload this page.' : err.message)}</span></p>`;
    importBtn.disabled = true;
  });

  function showPreview(info) {
    inspected = info;
    copyWrap.hidden = !(info.kind === 'folder' && info.includesMedia);
    preview.hidden = false;
    preview.innerHTML = `<div class="transfer-summary">
        <span class="transfer-summary-icon" aria-hidden="true">${icon('package', { size: 20 })}</span>
        <div>
          <p class="transfer-summary-title">From ${escapeHtml(info.source?.hostname || 'another server')} · ${info.createdAt ? new Date(info.createdAt).toLocaleString() : ''}</p>
          <p class="setting-help">${n(info.counts?.libraryItems)} library items${info.includesMedia ? ` · ${n(info.counts?.mediaFiles)} media files · ${formatBytes(info.counts?.mediaBytes || 0)}` : ' · settings and library only, no media files'}</p>
          <p class="setting-help">${(info.roots || []).map(r => escapeHtml(r.label)).join(', ')}</p>
        </div>
      </div>`;
  }

  form.querySelector('#tr-check').addEventListener('click', async () => {
    clearErrors();
    if (!pathInput.value.trim()) { fieldError(pathInput, 'Enter the path to the .zip or folder.'); pathInput.focus(); return; }
    try {
      showPreview(await api.inspectTransfer(pathInput.value.trim()));
    } catch (err) {
      preview.hidden = true;
      showError(err);
    }
  });

  async function watch() {
    importBtn.disabled = true;
    const job = await followJob(card, { title: 'Importing from another Vault' });
    if (job?.status === 'done' || (job?.status === 'unreachable')) {
      card.hidden = job.status === 'unreachable';
      await finishImport(report, job.status === 'done' ? job : { status: 'unreachable', result: {} });
      return;
    }
    importBtn.disabled = false;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();
    const dir = mediaDir.value.trim();
    if (!dir) { fieldError(mediaDir, 'Enter the folder for your media.'); mediaDir.focus(); return; }
    if (mode() === 'upload' && !file.files?.[0]) { fieldError(file, 'Choose the transfer .zip first.'); file.focus(); return; }
    if (mode() === 'path') {
      if (!pathInput.value.trim()) { fieldError(pathInput, 'Enter the path to the .zip or folder.'); pathInput.focus(); return; }
      try { showPreview(await api.inspectTransfer(pathInput.value.trim())); } catch (err) {
        showError(err);
        return;
      }
    }
    if (!setupMode) {
      const ok = await confirmDialog({
        title: 'Replace this server’s library?',
        message: `Your library, playlists, history, profiles and settings here are replaced by the ones in the package${inspected?.source?.hostname ? ` from ${inspected.source.hostname}` : ''}. The current ones are saved in server/backups first. Vault restarts when it’s done.`,
        confirmText: 'Import',
        danger: true,
      });
      if (!ok) return;
    }
    importBtn.disabled = true;
    try {
      if (mode() === 'upload') {
        const chosen = file.files[0];
        card.update({ kind: 'import', status: 'running', phase: 'upload', bytesDone: 0, bytesTotal: chosen.size });
        upload = api.uploadTransfer(chosen, dir, (loaded, total) => card.update({ kind: 'import', status: 'running', phase: 'upload', bytesDone: loaded, bytesTotal: total }));
        await upload;
        upload = null;
      } else {
        await api.importTransfer({ source: pathInput.value.trim(), mediaDir: dir, copyMedia: copyWrap.hidden || form.querySelector('#tr-copy').checked });
      }
      await watch();
    } catch (err) {
      upload = null;
      card.update(err.code === 'CANCELLED' ? { kind: 'import', status: 'cancelled' } : null);
      if (err.code !== 'CANCELLED') showError(err);
      importBtn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export function mountExport(container) {
  container.innerHTML = `
    <div class="transfer-form">
      <fieldset class="transfer-field">
        <legend class="setting-label" id="tx-what-label">What to take</legend>
        <div class="segmented" role="radiogroup" aria-labelledby="tx-what-label">
          <label class="segmented-option"><input type="radio" name="tx-what" value="all" checked><span>Everything</span></label>
          <label class="segmented-option"><input type="radio" name="tx-what" value="data"><span>Library &amp; settings only</span></label>
        </div>
        <p class="setting-help" id="tx-what-help">Your media files in their folders, plus playlists, favourites, watch history and progress, profiles, collections, artwork, sign-in and settings.</p>
      </fieldset>
      <div class="transfer-preview" id="tx-summary"><p class="setting-help">${icon('loader', { size: 14, className: 'icon spin' })} Measuring your library…</p></div>

      <div class="transfer-option">
        <div class="transfer-option-text">
          <p class="setting-label">Download as a .zip</p>
          <p class="setting-help">Saves one file to the device you’re using. To put it straight onto the new computer, open Vault there and press Download — or copy the link and open it on that device (works for 2 hours).</p>
        </div>
        <div class="settings-actions is-inline">
          <button type="button" class="btn btn-primary btn-sm" id="tx-download">${icon('download', { size: 14 })}<span>Download</span></button>
          <button type="button" class="btn btn-secondary btn-sm" id="tx-copy-link">${icon('link', { size: 14 })}<span>Copy link</span></button>
        </div>
      </div>

      <div class="transfer-option">
        <div class="transfer-option-text">
          <label class="setting-label" for="tx-dir">Save to a drive on the server computer</label>
          <p class="setting-help" id="tx-dir-help">Fastest for big libraries. Writes a normal folder (you can browse it) to e.g. a USB drive: <code>/Volumes/MyDrive</code> on a Mac, <code>E:\\</code> on Windows.</p>
        </div>
        <div class="input-with-actions">
          <input class="form-input" id="tx-dir" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="tx-dir-help" placeholder="/Volumes/MyDrive">
          <button type="button" class="btn btn-secondary" id="tx-save">${icon('hard-drive', { size: 15 })}<span>Save copy</span></button>
        </div>
      </div>
      <div class="transfer-report" id="tx-report" aria-live="polite"></div>
    </div>`;

  const summary = container.querySelector('#tx-summary');
  const report = container.querySelector('#tx-report');
  const help = container.querySelector('#tx-what-help');
  const media = () => container.querySelector('input[name="tx-what"]:checked').value === 'all';
  const card = jobCard({ onCancel: () => api.cancelTransfer().catch(() => {}) });
  report.before(card);
  let measured = 0;

  async function measure() {
    const ticket = ++measured;
    summary.innerHTML = `<p class="setting-help">${icon('loader', { size: 14, className: 'icon spin' })} Measuring your library…</p>`;
    try {
      const s = await api.transferSummary(media());
      if (ticket !== measured) return;
      summary.innerHTML = `<div class="transfer-summary">
          <span class="transfer-summary-icon" aria-hidden="true">${icon('package', { size: 20 })}</span>
          <div>
            <p class="transfer-summary-title">${formatBytes(s.zipBytes)} · ${n(s.counts.libraryItems)} library items${s.includesMedia ? ` · ${n(s.counts.mediaFiles)} files` : ''}</p>
            <p class="setting-help">${s.includesMedia ? s.roots.filter(r => r.files).map(r => `${escapeHtml(r.label)} (${n(r.files)} files, ${formatBytes(r.bytes)})`).join(' · ') || 'Your library folders are empty.' : 'No media files — copy those yourself and point the new server at them.'}</p>
          </div>
        </div>`;
    } catch (err) {
      if (ticket !== measured) return;
      summary.innerHTML = `<p class="settings-callout is-error">${icon('alert-circle', { size: 15 })}<span>${escapeHtml(err.status === 404 ? 'This Vault server is too old for transfers. Update it (git pull, npm install), restart it, then reload this page.' : err.message)}</span></p>`;
      if (err.code === 'ADMIN_REQUIRED' || err.status === 404) container.querySelectorAll('button, input').forEach(c => { c.disabled = true; });
    }
  }
  container.querySelectorAll('input[name="tx-what"]').forEach(r => r.addEventListener('change', () => {
    help.textContent = media()
      ? 'Your media files in their folders, plus playlists, favourites, watch history and progress, profiles, collections, artwork, sign-in and settings.'
      : 'Everything except the media files themselves — for when you move those separately (e.g. an external drive you plug into the new computer).';
    measure();
  }));

  container.querySelector('#tx-download').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const link = await api.createTransferLink(media());
      const a = document.createElement('a');
      a.href = link.url;
      a.download = link.fileName;
      a.rel = 'noopener';
      document.body.append(a);
      a.click();
      a.remove();
      report.innerHTML = `<p class="settings-callout is-info">${icon('download', { size: 15 })}<span>Your download has started (<strong>${escapeHtml(link.fileName)}</strong>). Keep Vault running until it finishes — your browser shows the progress.</span></p>`;
    } catch (err) {
      report.innerHTML = `<p class="settings-callout is-error">${icon('alert-circle', { size: 15 })}<span>${escapeHtml(err.message)}</span></p>`;
    } finally {
      btn.disabled = false;
    }
  });

  container.querySelector('#tx-copy-link').addEventListener('click', async () => {
    try {
      const link = await api.createTransferLink(media());
      let copied = false;
      try { await navigator.clipboard.writeText(link.url); copied = true; } catch { /* insecure context */ }
      report.innerHTML = `<div class="settings-callout is-info">${icon('link', { size: 15 })}<div>
          <p>${copied ? 'Link copied.' : 'Copy this link:'} Open it on the new computer to download the package there. It works for 2 hours, and only while this server is running.</p>
          <p><input class="form-input" readonly value="${escapeHtml(link.url)}" aria-label="Download link"></p>
        </div></div>`;
      const field = report.querySelector('input');
      field.addEventListener('focus', () => field.select());
    } catch (err) {
      report.innerHTML = `<p class="settings-callout is-error">${icon('alert-circle', { size: 15 })}<span>${escapeHtml(err.message)}</span></p>`;
    }
  });

  container.querySelector('#tx-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const dir = container.querySelector('#tx-dir').value.trim();
    report.innerHTML = '';
    if (!dir) { container.querySelector('#tx-dir').focus(); return; }
    btn.disabled = true;
    try {
      await api.exportTransferToFolder(dir, media());
      const job = await followJob(card, { title: 'Saving a transfer copy' });
      if (job?.status === 'done') {
        card.hidden = true;
        report.innerHTML = `<div class="settings-callout is-ok">${icon('check-circle', { size: 15 })}<div>
            <p><strong>Saved.</strong> ${n(job.result?.files)} files, ${formatBytes(job.result?.bytes || 0)} in:</p>
            <p><code>${escapeHtml(job.result?.folder || '')}</code></p>
            <p>On the new computer, install Vault and choose <em>Import from another Vault</em> in the setup wizard (or here, under Import), pointing it at that folder.</p>
          </div></div>`;
      }
    } catch (err) {
      report.innerHTML = `<p class="settings-callout is-error">${icon('alert-circle', { size: 15 })}<span>${escapeHtml(err.message)}</span></p>`;
    } finally {
      btn.disabled = false;
    }
  });

  // Resume showing a copy that was started earlier (e.g. before a reload).
  api.transferStatus().then((state) => {
    if (state.job?.status === 'running' && state.job.kind === 'export') followJob(card, { title: 'Saving a transfer copy' });
  }).catch(() => {});

  measure();
  return { measure };
}

export default { mountImport, mountExport, jobCard, followJob };
