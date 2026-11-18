/**
 * Torrents — paste a magnet link (or drop a .torrent), pick the files, and
 * Vault downloads them straight into the right library.
 *
 * Admin-only and off until an admin turns it on here and acknowledges the
 * notice. While a torrent downloads, the server pushes `torrents:changed`
 * (no names) over SSE; the page refetches. A slow poll covers a dropped SSE.
 */
import { api } from '../api.js';
import { icon } from '../utils/icons.js';
import { escapeHtml } from '../utils/format.js';
import { toast } from '../components/toast.js';
import { confirmDialog } from '../components/confirmDialog.js';
import { onUnmount } from '../utils/lifecycle.js';

const LIBRARIES = {
  movie: { label: 'Movies & Series', route: '/movies' },
  music: { label: 'Music', route: '/music' },
  video: { label: 'Videos', route: '/videos' },
};
const ACTIVE = new Set(['metadata', 'downloading', 'moving', 'seeding', 'queued', 'waiting-vpn']);

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x >= 100 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return 'less than a minute left';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min left`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min left`;
}

/** One status line per job, in plain words. */
export function describeJob(job) {
  const pct = `${Math.floor((job.progress || 0) * 100)}%`;
  switch (job.status) {
    case 'metadata': return 'Fetching the file list from peers…';
    case 'ready': return 'Choose what to download';
    case 'queued': return 'Queued — starts when another download finishes';
    case 'downloading': {
      const bits = [pct, `${formatBytes(job.downloadedBytes)} of ${formatBytes(job.selectedBytes)}`];
      if (job.downloadSpeed) bits.push(`${formatBytes(job.downloadSpeed)}/s`);
      bits.push(job.peers ? `${job.peers} peer${job.peers === 1 ? '' : 's'}` : 'looking for peers');
      const eta = formatEta(job.eta);
      if (eta) bits.push(eta);
      return bits.join(' · ');
    }
    case 'moving': return 'Moving into your library…';
    case 'seeding': return `In your library · sharing back (ratio ${(job.ratio || 0).toFixed(2)}${job.uploadSpeed ? ` · ${formatBytes(job.uploadSpeed)}/s up` : ''})`;
    case 'paused': return `Paused at ${pct}`;
    case 'waiting-vpn': return 'Paused — waiting for the VPN to connect';
    case 'done': return `Done · ${job.placed ?? job.files?.filter(f => f.selected).length ?? 0} file${job.placed === 1 ? '' : 's'} added to ${LIBRARIES[job.type]?.label || 'your library'}`;
    case 'error': return job.error || 'Something went wrong';
    default: return job.status;
  }
}

function librarySelect(id, value, { auto = false } = {}) {
  return `<select class="form-select" id="${id}">
    ${auto ? `<option value="auto"${value === 'auto' ? ' selected' : ''}>Sort automatically</option>` : ''}
    ${Object.entries(LIBRARIES).map(([k, v]) => `<option value="${k}"${value === k ? ' selected' : ''}>${v.label}</option>`).join('')}
  </select>`;
}

export async function renderTorrents(container) {
  container.className = 'page torrents-page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${icon('magnet', { size: 26 })}<span>Torrents</span></h1>
      <p class="page-subtitle">Paste a magnet link, pick the files, and they land in your library.</p>
    </div>
    <div id="torrents-body"><div class="skeleton skeleton-block"></div></div>`;
  const body = container.querySelector('#torrents-body');

  let state = null;
  const picks = new Map(); // job id → Set of chosen file indexes (kept across refreshes)
  let refreshTimer = null;
  let pollTimer = null;
  let disposed = false;

  async function refresh() {
    try {
      const next = await api.getTorrents();
      if (disposed) return;
      const wasEnabled = state?.settings?.enabled;
      state = next;
      if (wasEnabled !== state.settings.enabled || !body.querySelector('.tj-list')) renderAll();
      else renderJobs();
      schedulePoll();
    } catch (err) {
      if (disposed) return;
      renderError(err);
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 150);
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!state?.settings?.enabled) return;
    const busy = state.jobs.some(j => ACTIVE.has(j.status));
    pollTimer = setTimeout(refresh, busy ? 4000 : 30000);
  }

  window.addEventListener('vault:torrents-changed', scheduleRefresh);
  onUnmount(() => {
    disposed = true;
    clearTimeout(refreshTimer);
    clearTimeout(pollTimer);
    window.removeEventListener('vault:torrents-changed', scheduleRefresh);
  });

  function renderError(err) {
    const msg = err?.status === 403
      ? 'Only an admin profile can use torrents. Switch to an admin profile to set this up.'
      : err?.status === 404
        ? 'Your Vault server is running an older version without torrents. Update the server, restart it, then reload this page.'
        : `Couldn’t load torrents: ${escapeHtml(err?.message || 'unknown error')}`;
    body.innerHTML = `<div class="empty-state">${icon(err?.status === 403 ? 'lock' : 'alert-circle', { size: 30 })}
      <div class="empty-state-message">${msg}</div></div>`;
  }

  function renderAll() {
    if (!state.settings.enabled) renderSetup();
    else renderMain();
  }

  // -------------------------------------------------------------------------
  // Off: the notice + turn on
  // -------------------------------------------------------------------------
  function renderSetup() {
    const engineMissing = !state.engine.installed;
    body.innerHTML = `
      <section class="tj-card tj-setup" aria-labelledby="tj-setup-title">
        <h2 id="tj-setup-title" class="tj-card-title">${icon('shield', { size: 18 })}<span>Before you turn this on</span></h2>
        <ul class="tj-notice">
          <li><strong>Only download what you have the right to</strong> — your own files, public-domain films, Creative Commons music, open-source software. In many countries downloading copyrighted films, shows or music without permission is illegal.</li>
          <li><strong>Torrenting shares as it downloads.</strong> Other people in the swarm can see the server’s IP address, and pieces are uploaded to them while you download.</li>
          <li><strong>Want privacy?</strong> Run a VPN on the server and tell Vault its network interface below — torrents then only run while the VPN is up.</li>
        </ul>
        ${engineMissing ? `<p class="settings-callout is-warn">${icon('alert-triangle', { size: 15 })}<span>The torrent engine isn’t installed on the server. Run <code>npm install</code> in the <code>server</code> folder and restart Vault.</span></p>` : ''}
        <div class="form-group">
          <label class="form-label" for="tj-vpn">VPN guard (optional)</label>
          <select class="form-select" id="tj-vpn"><option value="">No VPN guard</option></select>
          <p class="tj-help">Pick your VPN’s interface (e.g. wg0, tun0). Torrents pause the moment it disconnects.</p>
        </div>
        <label class="tj-ack"><input type="checkbox" class="checkbox" id="tj-ack"${state.settings.acknowledged ? ' checked' : ''}>
          <span>I understand, and I’ll only download things I have the right to.</span></label>
        <p class="field-error" id="tj-ack-error" hidden></p>
        <div class="tj-actions">
          <button type="button" class="btn btn-primary" id="tj-enable"${engineMissing ? ' disabled' : ''}>${icon('power', { size: 16 })}<span>Turn on torrents</span></button>
        </div>
      </section>`;
    fillInterfaces(body.querySelector('#tj-vpn'), state.settings.requireInterface);
    body.querySelector('#tj-enable').addEventListener('click', async (e) => {
      const ack = body.querySelector('#tj-ack');
      const err = body.querySelector('#tj-ack-error');
      if (!ack.checked) {
        err.hidden = false;
        err.textContent = 'Tick the box to confirm first.';
        ack.setAttribute('aria-invalid', 'true');
        ack.focus();
        return;
      }
      e.currentTarget.disabled = true;
      try {
        state = await api.updateTorrentSettings({ enabled: true, acknowledged: true, requireInterface: body.querySelector('#tj-vpn').value });
        toast.success('Torrents are on');
        renderAll();
        body.querySelector('#tj-magnet')?.focus();
      } catch (error) {
        e.currentTarget.disabled = false;
        toast.error(error.message);
      }
    });
  }

  async function fillInterfaces(select, current) {
    try {
      const { interfaces } = await api.getTorrentInterfaces();
      const names = new Set(interfaces.map(i => i.name));
      select.insertAdjacentHTML('beforeend', interfaces.map(i => `<option value="${escapeHtml(i.name)}"${i.name === current ? ' selected' : ''}>${escapeHtml(i.name)}${i.likelyVpn ? ' — looks like a VPN' : ''} (${escapeHtml(i.addresses[0] || '')})</option>`).join(''));
      // Saved interface that's down right now: keep it selectable.
      if (current && !names.has(current)) select.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (not connected)</option>`);
    } catch {
      if (current) select.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`);
    }
  }

  // -------------------------------------------------------------------------
  // On: add box, VPN status, list, settings
  // -------------------------------------------------------------------------
  function renderMain() {
    body.innerHTML = `
      <div id="tj-vpn-status"></div>
      <section class="tj-card tj-add" aria-labelledby="tj-add-title">
        <h2 id="tj-add-title" class="tj-card-title">${icon('plus', { size: 18 })}<span>Add a torrent</span></h2>
        <form id="tj-add-form" class="tj-add-form" novalidate>
          <label class="sr-only" for="tj-magnet">Magnet link</label>
          <input class="form-input" id="tj-magnet" type="text" autocomplete="off" spellcheck="false" placeholder="magnet:?xt=urn:btih:…  — or drop a .torrent file here">
          <label class="sr-only" for="tj-type">Library</label>
          ${librarySelect('tj-type', 'auto', { auto: true })}
          <button type="submit" class="btn btn-primary" id="tj-add-btn">${icon('magnet', { size: 16 })}<span>Add</span></button>
          <button type="button" class="btn btn-secondary" id="tj-file-btn">${icon('folder', { size: 16 })}<span>.torrent file</span></button>
          <input type="file" id="tj-file" accept=".torrent,application/x-bittorrent" hidden>
        </form>
        <p class="field-error" id="tj-add-error" role="alert" hidden></p>
      </section>
      <section aria-labelledby="tj-list-title">
        <h2 id="tj-list-title" class="section-title">Downloads</h2>
        <div class="tj-list" id="tj-list"></div>
      </section>
      <details class="tj-card tj-settings" id="tj-settings">
        <summary>${icon('settings', { size: 16 })}<span>Torrent settings</span></summary>
        <div class="tj-settings-body"></div>
      </details>`;
    wireAdd();
    renderSettingsPanel();
    renderJobs();
  }

  function wireAdd() {
    const form = body.querySelector('#tj-add-form');
    const input = body.querySelector('#tj-magnet');
    const error = body.querySelector('#tj-add-error');
    const fileInput = body.querySelector('#tj-file');
    const showError = (msg) => {
      error.hidden = !msg;
      error.textContent = msg || '';
      input.toggleAttribute('aria-invalid', Boolean(msg));
    };
    const submit = async (source) => {
      showError('');
      const btn = body.querySelector('#tj-add-btn');
      btn.disabled = true;
      try {
        const { job } = await api.addTorrent(source, body.querySelector('#tj-type').value);
        input.value = '';
        toast.success(job.name && job.name !== 'Fetching details…' ? `Added “${job.name}”` : 'Added — fetching the file list');
        await refresh();
      } catch (err) {
        showError(err.fields?.magnet || err.fields?.torrent || err.message);
        input.focus();
      } finally {
        btn.disabled = false;
      }
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const magnet = input.value.trim();
      if (!magnet) { showError('Paste a magnet link, or choose a .torrent file.'); input.focus(); return; }
      if (!/^magnet:\?/i.test(magnet)) { showError('Magnet links start with “magnet:?”.'); input.focus(); return; }
      submit(magnet);
    });
    body.querySelector('#tj-file-btn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) submit(file);
    });
    // Drop a .torrent anywhere on the add card.
    const card = body.querySelector('.tj-add');
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('is-dragover'); });
    card.addEventListener('dragleave', () => card.classList.remove('is-dragover'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('is-dragover');
      const file = [...(e.dataTransfer?.files || [])].find(f => /\.torrent$/i.test(f.name));
      const text = e.dataTransfer?.getData('text/plain')?.trim();
      if (file) submit(file);
      else if (text && /^magnet:\?/i.test(text)) submit(text);
      else showError('Drop a .torrent file or a magnet link.');
    });
  }

  function renderVpn() {
    const host = body.querySelector('#tj-vpn-status');
    if (!host) return;
    const { vpn } = state;
    host.innerHTML = vpn.required
      ? `<p class="settings-callout ${vpn.up ? 'is-info' : 'is-warn'} tj-vpn" role="status">${icon(vpn.up ? 'shield-check' : 'shield-off', { size: 15 })}<span>${vpn.up
        ? `VPN guard on: torrents only run while <strong>${escapeHtml(vpn.interface)}</strong> is connected.`
        : `<strong>${escapeHtml(vpn.interface)} isn’t connected</strong> — all torrents are paused until it is.`}</span></p>`
      : '';
  }

  function jobCard(job) {
    const lib = LIBRARIES[job.type];
    const progress = ['downloading', 'paused', 'moving'].includes(job.status);
    const actions = [];
    if (['downloading', 'queued', 'metadata', 'waiting-vpn'].includes(job.status)) actions.push(`<button type="button" class="btn btn-ghost btn-sm" data-act="pause">${icon('pause', { size: 14 })}<span>Pause</span></button>`);
    if (['paused', 'error'].includes(job.status) && job.files?.length) actions.push(`<button type="button" class="btn btn-secondary btn-sm" data-act="resume">${icon(job.status === 'error' ? 'refresh' : 'play', { size: 14 })}<span>${job.status === 'error' ? 'Try again' : 'Resume'}</span></button>`);
    if (job.status === 'seeding') actions.push('<button type="button" class="btn btn-ghost btn-sm" data-act="pause">Stop sharing</button>');
    if (['done', 'seeding'].includes(job.status) && lib) actions.push(`<a class="btn btn-ghost btn-sm" href="${lib.route.slice(1)}" data-route="${lib.route}">Open ${lib.label}</a>`);
    actions.push(`<button type="button" class="btn btn-ghost btn-sm" data-act="remove" aria-label="Remove ${escapeHtml(job.name)} from the list">${icon('trash', { size: 14 })}</button>`);

    return `<article class="tj-job is-${job.status}" data-job="${escapeHtml(job.id)}" data-status="${job.status}">
      <div class="tj-job-head">
        <div class="tj-job-main">
          <h3 class="tj-job-name">${escapeHtml(job.name)}</h3>
          <p class="tj-job-status" aria-live="polite">${escapeHtml(describeJob(job))}</p>
        </div>
        <div class="tj-job-actions">${actions.join('')}</div>
      </div>
      ${progress ? `<div class="progress tj-progress" role="progressbar" aria-label="Download progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.floor((job.progress || 0) * 100)}"><div class="progress-bar" style="width:${(job.progress || 0) * 100}%"></div></div>` : ''}
      ${job.status === 'ready' ? pickerHtml(job) : ''}
    </article>`;
  }

  function pickerHtml(job) {
    const chosen = picks.get(job.id) || new Set(job.files.filter(f => f.selected).map(f => f.index));
    picks.set(job.id, chosen);
    const rows = job.files.map(f => `<li><label class="tj-file${f.kind === 'other' ? ' is-other' : ''}">
        <input type="checkbox" class="checkbox" data-file="${f.index}"${chosen.has(f.index) ? ' checked' : ''}>
        <span class="tj-file-path">${escapeHtml(f.path)}</span><span class="tj-file-size">${formatBytes(f.length)}</span>
      </label></li>`).join('');
    return `<div class="tj-picker">
      <div class="tj-picker-bar">
        <label for="tj-lib-${escapeHtml(job.id)}">Save to</label>
        ${librarySelect(`tj-lib-${escapeHtml(job.id)}`, job.type || job.suggestedType)}
        <button type="button" class="btn btn-ghost btn-sm" data-act="all">Select all</button>
        <button type="button" class="btn btn-ghost btn-sm" data-act="none">Select none</button>
      </div>
      <ul class="tj-files" role="list">${rows}</ul>
      <div class="tj-actions"><button type="button" class="btn btn-primary" data-act="start"></button></div>
    </div>`;
  }

  function updateStartLabel(card, job) {
    const chosen = picks.get(job.id) || new Set();
    const bytes = job.files.filter(f => chosen.has(f.index)).reduce((n, f) => n + f.length, 0);
    const btn = card.querySelector('[data-act="start"]');
    if (!btn) return;
    btn.disabled = chosen.size === 0;
    btn.innerHTML = `${icon('download', { size: 16 })}<span>${chosen.size ? `Download ${chosen.size} file${chosen.size === 1 ? '' : 's'} (${formatBytes(bytes)})` : 'Pick at least one file'}</span>`;
  }

  /** Patch the list in place so ticking boxes isn't undone by a refresh. */
  function renderJobs() {
    renderVpn();
    const list = body.querySelector('#tj-list');
    if (!list) return;
    if (!state.jobs.length) {
      list.innerHTML = `<p class="row-meta tj-empty">Nothing yet. Paste a magnet link above — for example a public-domain film from the Internet Archive.</p>`;
      return;
    }
    list.querySelector('.tj-empty')?.remove();
    const ids = new Set(state.jobs.map(j => j.id));
    list.querySelectorAll('[data-job]').forEach(card => { if (!ids.has(card.dataset.job)) card.remove(); });
    let prev = null;
    for (const job of state.jobs) {
      let card = list.querySelector(`[data-job="${CSS.escape(job.id)}"]`);
      if (card && card.dataset.status === job.status && job.status !== 'done') {
        // Same state: only the moving parts.
        card.querySelector('.tj-job-status').textContent = describeJob(job);
        const bar = card.querySelector('.tj-progress');
        if (bar) {
          bar.setAttribute('aria-valuenow', String(Math.floor((job.progress || 0) * 100)));
          bar.firstElementChild.style.width = `${(job.progress || 0) * 100}%`;
        }
      } else if (!card || card.dataset.status !== job.status) {
        const fresh = document.createElement('div');
        fresh.innerHTML = jobCard(job);
        const node = fresh.firstElementChild;
        if (card) card.replaceWith(node);
        card = node;
        wireJob(card, job);
      }
      if (prev ? prev.nextElementSibling !== card : list.firstElementChild !== card) {
        if (prev) prev.after(card);
        else list.prepend(card);
      }
      prev = card;
    }
  }

  function wireJob(card, job) {
    const act = async (name, fn) => {
      const btn = card.querySelector(`[data-act="${name}"]`);
      if (btn) btn.disabled = true;
      try {
        await fn();
        await refresh();
      } catch (err) {
        toast.error(err.message);
        if (btn) btn.disabled = false;
      }
    };
    card.querySelector('[data-act="pause"]')?.addEventListener('click', () => act('pause', () => api.pauseTorrent(job.id)));
    card.querySelector('[data-act="resume"]')?.addEventListener('click', () => act('resume', () => api.resumeTorrent(job.id)));
    card.querySelector('[data-act="remove"]')?.addEventListener('click', async () => {
      const finished = job.status === 'done' || job.status === 'seeding';
      const ok = await confirmDialog({
        title: 'Remove from the list?',
        message: finished
          ? `“${job.name}” stays in your library; this only clears it from Downloads.`
          : `The download of “${job.name}” stops and what was downloaded so far is deleted.`,
        confirmText: finished ? 'Remove' : 'Stop and remove',
        danger: !finished,
      });
      if (!ok) return;
      picks.delete(job.id);
      act('remove', () => api.removeTorrent(job.id));
    });

    if (job.status !== 'ready') return;
    const chosen = picks.get(job.id);
    updateStartLabel(card, job);
    card.querySelectorAll('[data-file]').forEach(box => box.addEventListener('change', () => {
      const idx = Number(box.dataset.file);
      if (box.checked) chosen.add(idx);
      else chosen.delete(idx);
      updateStartLabel(card, job);
    }));
    const setAll = (on) => {
      card.querySelectorAll('[data-file]').forEach(box => {
        box.checked = on;
        const idx = Number(box.dataset.file);
        if (on) chosen.add(idx);
        else chosen.delete(idx);
      });
      updateStartLabel(card, job);
    };
    card.querySelector('[data-act="all"]').addEventListener('click', () => setAll(true));
    card.querySelector('[data-act="none"]').addEventListener('click', () => setAll(false));
    card.querySelector('[data-act="start"]').addEventListener('click', () => act('start', async () => {
      const type = card.querySelector('select').value;
      await api.startTorrent(job.id, { files: [...chosen], type });
      picks.delete(job.id);
    }));
  }

  function renderSettingsPanel() {
    const s = state.settings;
    const host = body.querySelector('.tj-settings-body');
    host.innerHTML = `
      <form id="tj-settings-form" class="tj-settings-form" novalidate>
        <div class="form-row">
          <div class="form-group"><label class="form-label" for="tj-max">Downloads at once</label>
            <input class="form-input" id="tj-max" type="number" min="1" max="10" value="${s.maxActive}"></div>
          <div class="form-group"><label class="form-label" for="tj-down">Download limit (KB/s)</label>
            <input class="form-input" id="tj-down" type="number" min="0" value="${s.downloadLimitKBs}" aria-describedby="tj-zero-help"></div>
          <div class="form-group"><label class="form-label" for="tj-up">Upload limit (KB/s)</label>
            <input class="form-input" id="tj-up" type="number" min="0" value="${s.uploadLimitKBs}" aria-describedby="tj-zero-help"></div>
        </div>
        <p class="tj-help" id="tj-zero-help">0 means no limit.</p>
        <div class="form-group"><label class="form-label" for="tj-ratio">Keep sharing after a download finishes</label>
          <select class="form-select" id="tj-ratio">
            ${[[0, 'No — stop as soon as it’s done'], [0.5, 'Until I’ve shared half as much'], [1, 'Until I’ve shared as much as I downloaded (ratio 1)'], [2, 'Until ratio 2']].map(([v, l]) => `<option value="${v}"${Number(s.seedRatio) === v ? ' selected' : ''}>${l}</option>`).join('')}
            ${[0, 0.5, 1, 2].includes(Number(s.seedRatio)) ? '' : `<option value="${s.seedRatio}" selected>Until ratio ${s.seedRatio}</option>`}
          </select>
          <p class="tj-help">Files reach your library straight away either way.</p></div>
        <div class="form-group"><label class="form-label" for="tj-vpn2">VPN guard</label>
          <select class="form-select" id="tj-vpn2"><option value="">No VPN guard</option></select>
          <p class="tj-help">Torrents only run while this network interface is connected.</p></div>
        <label class="tj-ack"><input type="checkbox" class="checkbox" id="tj-dht"${s.dht ? ' checked' : ''}><span>Find peers without trackers (DHT)</span></label>
        <label class="tj-ack"><input type="checkbox" class="checkbox" id="tj-upnp"${s.upnp ? ' checked' : ''}><span>Open a port on the router automatically (UPnP) — faster, but changes router settings</span></label>
        <div class="tj-actions">
          <button type="submit" class="btn btn-primary">Save</button>
          <button type="button" class="btn btn-ghost" id="tj-disable">${icon('power', { size: 16 })}<span>Turn off torrents</span></button>
        </div>
      </form>`;
    fillInterfaces(host.querySelector('#tj-vpn2'), s.requireInterface);
    host.querySelector('#tj-settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        state = await api.updateTorrentSettings({
          maxActive: Number(host.querySelector('#tj-max').value) || 1,
          downloadLimitKBs: Number(host.querySelector('#tj-down').value) || 0,
          uploadLimitKBs: Number(host.querySelector('#tj-up').value) || 0,
          seedRatio: Number(host.querySelector('#tj-ratio').value) || 0,
          requireInterface: host.querySelector('#tj-vpn2').value,
          dht: host.querySelector('#tj-dht').checked,
          upnp: host.querySelector('#tj-upnp').checked,
        });
        toast.success('Torrent settings saved');
        renderJobs();
      } catch (err) {
        toast.error(err.fields ? Object.values(err.fields)[0] : err.message);
      }
    });
    host.querySelector('#tj-disable').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Turn off torrents?',
        message: 'Running downloads pause and pick up again when you turn torrents back on.',
        confirmText: 'Turn off',
      });
      if (!ok) return;
      try {
        state = await api.updateTorrentSettings({ enabled: false });
        renderAll();
      } catch (err) {
        toast.error(err.message);
      }
    });
  }

  await refresh();
}

export default { renderTorrents };
