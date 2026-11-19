/**
 * Server console — health, jobs, logs, backups, services.
 *
 * Every number here comes from /api/system/*; the shapes are documented next
 * to each loader. (The page used to guess field names — `checks`, `totalItems`,
 * `entries`, `agents` — that the server never sent, so it showed zeros, "never"
 * and empty lists no matter what the server knew.)
 */
import { api } from '../api.js';
import { icon } from '../utils/icons.js';
import { escapeHtml, escapeAttr, formatBytes, formatRelativeTime, plural } from '../utils/format.js';
import { toast } from '../components/toast.js';
import { confirmDialog } from '../components/confirmDialog.js';
import { promptModal } from '../components/modal.js';
import { onUnmount } from '../utils/lifecycle.js';

const TABS = [
  ['health', 'Health', 'shield-check'],
  ['jobs', 'Jobs', 'activity'],
  ['logs', 'Logs', 'list'],
  ['backups', 'Backups', 'archive'],
  ['services', 'Services', 'zap'],
];

const JOB_EVENTS = ['vault:job-start', 'vault:job-progress', 'vault:job-finished'];

const ADMIN_NOTE = 'Only an admin profile can see and change this. Switch to an admin profile on the <a href="profiles" data-route="/profiles">Profiles page</a>.';

/** `formatBytes` breaks on negatives/NaN; the server can send either when a stat fails. */
function bytes(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? formatBytes(n) : '0 B';
}

function errorState(message, { html = false } = {}) {
  return `<div class="empty-state"><div class="empty-state-message">${html ? message : escapeHtml(message)}</div></div>`;
}

function isAdminError(err) {
  return err?.status === 403 || err?.code === 'ADMIN_REQUIRED';
}

/** Run a button's action with the button disabled and errors reported. */
async function busy(button, action) {
  if (!button || button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    await action();
  } catch (err) {
    toast.error(err?.message || 'Something went wrong');
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }
}

/** Whether the active profile can use the admin-only parts of the page. */
async function detectAdmin() {
  try {
    const { profiles = [], activeProfileId } = await api.getProfiles();
    const id = activeProfileId || 'default';
    const me = profiles.find(p => p.id === id);
    // Same rule as server/middleware/requireAdmin.js.
    return me ? Boolean(me.isAdmin) : id === 'default';
  } catch {
    // Unknown: show the controls; the server still enforces the rule.
    return true;
  }
}

export async function renderSystem(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${icon('hard-drive', { size: 26 })}<span>Server</span></h1>
      <p class="page-subtitle">Health, background jobs, logs, backups and integrations</p>
      <div class="settings-tabs system-tabs" role="tablist" aria-label="Server sections" style="margin-top:12px">
        ${TABS.map(([key, label, iconName], index) => `<button type="button" class="settings-tab${index === 0 ? ' active' : ''}" role="tab" id="system-tab-${key}" aria-controls="system-body" aria-selected="${index === 0}" data-tab="${key}">${icon(iconName, { size: 14 })}<span>${label}</span></button>`).join('')}
      </div>
    </div>
    <div id="system-body" role="tabpanel" aria-labelledby="system-tab-health"></div>
  `;

  const body = container.querySelector('#system-body');
  const ctx = { body, isAdmin: true, activeTab: 'health' };
  let renderToken = 0;

  const loaders = {
    health: () => loadHealth(ctx),
    jobs: () => loadJobs(ctx),
    logs: () => loadLogs(ctx),
    backups: () => loadBackups(ctx),
    services: () => loadServices(ctx),
  };

  async function show(tab) {
    if (!loaders[tab]) tab = 'health';
    ctx.activeTab = tab;
    const token = ++renderToken;
    container.querySelectorAll('.settings-tab').forEach(node => {
      const active = node.dataset.tab === tab;
      node.classList.toggle('active', active);
      node.setAttribute('aria-selected', String(active));
    });
    body.setAttribute('aria-labelledby', `system-tab-${tab}`);
    body.innerHTML = '<div class="skeleton skeleton-block"></div>';
    // Guard against a slow tab finishing after the user already moved on.
    ctx.isCurrent = () => token === renderToken && ctx.activeTab === tab && body.isConnected;
    await loaders[tab]();
  }

  container.querySelectorAll('.settings-tab').forEach(node => {
    node.addEventListener('click', () => show(node.dataset.tab));
  });

  // Live job updates. Progress arrives up to once a second per job, so
  // coalesce refetches; listeners die with the view.
  let jobsTimer = null;
  const onJob = () => {
    if (ctx.activeTab !== 'jobs' || jobsTimer) return;
    jobsTimer = setTimeout(() => {
      jobsTimer = null;
      if (ctx.activeTab === 'jobs' && body.isConnected) loadJobs(ctx, { quiet: true });
    }, 500);
  };
  for (const name of JOB_EVENTS) window.addEventListener(name, onJob);
  onUnmount(() => {
    clearTimeout(jobsTimer);
    for (const name of JOB_EVENTS) window.removeEventListener(name, onJob);
  });

  ctx.isAdmin = await detectAdmin();
  await show('health');
}

// ---------------------------------------------------------------------------
// Health
//   GET /health → { totals, missing[], duplicates[], missingArtwork[],
//                   unplayable[], unknownCodecs[], orphanSidecars[], trash[],
//                   deep, lastScan, scanning, index }
//   GET /disk   → { cache, data, trash, media, host, volumes[] }
// ---------------------------------------------------------------------------
function lastScanCard(health) {
  const last = health.lastScan;
  if (health.scanning) {
    return { value: 'Scanning…', meta: last ? `Previous: ${formatRelativeTime(last.at)}` : '' };
  }
  if (!last) return { value: 'Never', meta: 'Scan from the Jobs tab' };
  if (last.status === 'error') return { value: formatRelativeTime(last.at), meta: `Failed: ${last.error || 'unknown error'}` };
  return {
    value: formatRelativeTime(last.at),
    meta: `${plural(last.scanned, 'file')} checked${last.removed ? `, ${last.removed} removed` : ''}${last.elapsed !== undefined ? ` in ${last.elapsed}s` : ''}`,
  };
}

function databaseCard(index) {
  if (!index) return { value: '—', meta: '' };
  const usingSqlite = index.storage === 'sqlite' && index.sqliteAvailable;
  let meta;
  if (!index.sqliteAvailable) meta = 'Search index needs Node 22 or newer';
  else meta = `${plural(index.sqliteRows, 'row')} in the search index${index.lastSync ? ` · synced ${formatRelativeTime(index.lastSync)}` : ''}`;
  return { value: usingSqlite ? 'SQLite' : 'JSON files', meta };
}

function meterClass(ratio) {
  if (ratio > 0.9) return 'danger';
  if (ratio > 0.75) return 'warn';
  return '';
}

function volumeMeter(volume) {
  const ratio = volume.total ? volume.used / volume.total : 0;
  return `<div class="meter ${meterClass(ratio)}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(ratio * 100)}" aria-label="Disk used"><span style="width:${Math.min(100, Math.round(ratio * 100))}%"></span></div>`;
}

const LIST_LIMIT = 25;

function detailList(rows, render) {
  if (!rows?.length) return '';
  const shown = rows.slice(0, LIST_LIMIT);
  return `
    <details class="health-details">
      <summary>Show ${rows.length > LIST_LIMIT ? `first ${LIST_LIMIT} of ${rows.length}` : rows.length}</summary>
      <ul>${shown.map(row => `<li>${render(row)}</li>`).join('')}</ul>
    </details>`;
}

function healthChecks(health) {
  const t = health.totals || {};
  const pathLine = row => `${escapeHtml(row.title || 'Untitled')}${row.path ? ` <span class="row-meta">${escapeHtml(row.path)}</span>` : ''}`;
  const checks = [
    {
      name: 'Missing files',
      status: t.missing ? 'error' : 'ok',
      message: t.missing
        ? `${plural(t.missing, 'library entry', 'library entries')} point at files that no longer exist`
        : 'Every library entry has its file',
      details: detailList(health.missing, pathLine),
    },
    {
      name: 'Duplicates',
      status: t.duplicates ? 'warn' : 'ok',
      message: t.duplicates
        ? `${plural(t.duplicates, 'group')} of files with the same size`
        : 'No duplicate files found',
      details: detailList(health.duplicates, group => `${escapeHtml(group.title || 'Untitled')} <span class="row-meta">${group.items?.length || 0} copies · ${bytes(group.size)}${group.likelyDuplicate ? ' · same title' : ''}</span>`),
    },
    {
      name: 'Artwork',
      status: t.missingArtwork ? 'warn' : 'ok',
      message: t.missingArtwork ? `${plural(t.missingArtwork, 'item')} without a poster or cover` : 'Everything has artwork',
      details: detailList(health.missingArtwork, row => `${escapeHtml(row.title || 'Untitled')} <span class="row-meta">${escapeHtml(row.type || '')}</span>`),
    },
    {
      name: 'Playback problems',
      status: t.unplayable ? 'warn' : 'ok',
      message: t.unplayable
        ? `${plural(t.unplayable, 'item')} may not play${health.unknownCodecs?.length ? ` (codecs: ${health.unknownCodecs.join(', ')})` : ''}`
        : 'No unreadable archives or unusual codecs',
      details: detailList(health.unplayable, row => `${escapeHtml(row.title || 'Untitled')} <span class="row-meta">${escapeHtml(row.reason || '')}</span>`),
    },
    health.deep
      ? {
        name: 'Leftover sidecar files',
        status: t.orphanSidecars ? 'warn' : 'ok',
        message: t.orphanSidecars ? `${plural(t.orphanSidecars, 'subtitle/artwork file')} with no matching media` : 'No leftover subtitle or artwork files',
        details: detailList(health.orphanSidecars, file => escapeHtml(file)),
      }
      : {
        name: 'Leftover sidecar files',
        status: 'info',
        message: 'Run a deep check to look for subtitle and artwork files whose media is gone',
        details: '',
      },
    {
      name: 'Trash',
      status: 'info',
      message: t.trash ? `${plural(t.trash, 'item')} waiting in the trash` : 'Trash is empty',
      details: t.trash ? '<a class="row-meta" href="trash" data-route="/trash">Open trash</a>' : '',
    },
  ];
  return checks;
}

function checkIcon(status) {
  if (status === 'ok') return 'check-circle';
  if (status === 'info') return 'activity';
  return 'alert-triangle';
}

async function loadHealth(ctx, { deep = false } = {}) {
  const { body } = ctx;
  let health;
  let disk;
  try {
    [health, disk] = await Promise.all([api.getLibraryHealth(deep), api.getDisk().catch(() => null)]);
  } catch (err) {
    if (ctx.isCurrent?.() === false) return;
    body.innerHTML = errorState(`Couldn’t load the health report: ${err.message}`);
    return;
  }
  if (ctx.isCurrent?.() === false) return;

  const totals = health.totals || {};
  const volumes = disk?.volumes || [];
  const primary = volumes[0];
  const scan = lastScanCard(health);
  const db = databaseCard(health.index);
  const checks = healthChecks(health);

  body.innerHTML = `
    <div class="stat-grid" style="margin-bottom:20px">
      <div class="stat-card" data-stat="library"><div class="stat-label">Library</div><div class="stat-value">${Number(totals.items || 0).toLocaleString()}</div>
        <div class="row-meta">${disk?.media ? `${bytes(disk.media.bytes)} of media · ` : ''}${plural(totals.missing, 'missing file')}</div></div>
      <div class="stat-card" data-stat="disk"><div class="stat-label">Disk free</div><div class="stat-value">${primary ? bytes(primary.free) : '—'}</div>
        <div class="row-meta">${primary ? `${bytes(primary.used)} used of ${bytes(primary.total)}` : 'Disk size unavailable on this system'}</div>
        ${primary ? volumeMeter(primary) : ''}</div>
      <div class="stat-card" data-stat="scan"><div class="stat-label">Last scan</div><div class="stat-value" style="font-size:1.1rem">${escapeHtml(scan.value)}</div>
        <div class="row-meta">${escapeHtml(scan.meta)}</div></div>
      <div class="stat-card" data-stat="database"><div class="stat-label">Database</div><div class="stat-value" style="font-size:1.1rem">${escapeHtml(db.value)}</div>
        <div class="row-meta">${escapeHtml(db.meta)}</div></div>
    </div>

    ${volumes.length > 1 ? `
      <section class="section">
        <h2 class="section-title">Storage</h2>
        <div class="health-list">${volumes.map(volume => `
          <div class="health-item system-volume">
            ${icon('hard-drive', { size: 16 })}
            <div class="row-main">
              <div class="row-title">${escapeHtml(volume.labels.join(', '))}</div>
              <div class="row-meta">${bytes(volume.free)} free of ${bytes(volume.total)} · ${escapeHtml(volume.path)}</div>
              ${volumeMeter(volume)}
            </div>
          </div>`).join('')}
        </div>
      </section>` : ''}

    <section class="section">
      <h2 class="section-title">Library checks${health.deep ? ' <span class="row-meta">(deep)</span>' : ''}</h2>
      <div class="health-list" id="health-checks">
        ${checks.map(check => `
          <div class="health-item ${check.status}" data-check="${escapeAttr(check.name)}">
            ${icon(checkIcon(check.status), { size: 16 })}
            <div class="row-main">
              <div class="row-title">${escapeHtml(check.name)}</div>
              <div class="row-meta">${escapeHtml(check.message)}</div>
              ${check.details}
            </div>
          </div>`).join('')}
      </div>
      ${health.generatedAt ? `<p class="row-meta" style="margin-top:8px">Checked ${escapeHtml(formatRelativeTime(health.generatedAt).toLowerCase())}${disk?.cache ? ` · caches use ${bytes(disk.cache.bytes)}` : ''}</p>` : ''}
    </section>

    ${ctx.isAdmin ? `
      <div class="page-actions" style="margin-top:20px;display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn btn-secondary" id="health-deep">${icon('search', { size: 14 })}<span>Run deep check</span></button>
        <button type="button" class="btn btn-secondary" id="health-prune"${totals.missing ? '' : ' disabled title="No missing files"'}>${icon('trash', { size: 14 })}<span>Remove missing files</span></button>
        <button type="button" class="btn btn-ghost" id="health-rebuild">${icon('refresh', { size: 14 })}<span>Rebuild search index</span></button>
        <button type="button" class="btn btn-ghost" id="health-cache">${icon('x', { size: 14 })}<span>Clear caches</span></button>
      </div>` : `<p class="row-meta" style="margin-top:20px">${ADMIN_NOTE}</p>`}
  `;

  if (!ctx.isAdmin) return;

  const deepButton = body.querySelector('#health-deep');
  deepButton.addEventListener('click', () => busy(deepButton, async () => {
    deepButton.querySelector('span').textContent = 'Checking…';
    // The deep report is rendered as-is: re-fetching the quick report
    // afterwards would throw away the sidecar results.
    await loadHealth(ctx, { deep: true });
    toast.success('Deep check finished');
  }));

  body.querySelector('#health-prune').addEventListener('click', event => busy(event.currentTarget, async () => {
    const { confirmed } = await confirmDialog({
      title: 'Remove missing files?',
      message: `${plural(totals.missing, 'library entry', 'library entries')} whose files no longer exist will be removed from the library. Nothing on disk is deleted.`,
      confirmText: 'Remove entries',
      danger: true,
    });
    if (!confirmed) return;
    const result = await api.pruneMissing();
    const removed = result.removed ?? 0;
    toast.success(`Removed ${plural(removed, 'stale entry', 'stale entries')}`);
    await loadHealth(ctx);
  }));

  body.querySelector('#health-rebuild').addEventListener('click', event => busy(event.currentTarget, async () => {
    const result = await api.rebuildIndex();
    if (result.available === false || result.sqliteAvailable === false) {
      toast.info('The search index needs Node 22 or newer. Vault is using the built-in in-memory index instead.');
      return;
    }
    toast.success(`Search index rebuilt (${plural(result.synced ?? result.sqliteRows ?? 0, 'item')})`);
    await loadHealth(ctx);
  }));

  body.querySelector('#health-cache').addEventListener('click', event => busy(event.currentTarget, async () => {
    const { confirmed } = await confirmDialog({
      title: 'Clear caches?',
      message: `Transcodes, thumbnails, covers and preview images${disk?.cache ? ` (${bytes(disk.cache.bytes)})` : ''} are deleted and rebuilt when needed. The first play or page load afterwards may be slower.`,
      confirmText: 'Clear caches',
    });
    if (!confirmed) return;
    const result = await api.clearCaches();
    const count = Object.values(result.cleared || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
    toast.success(count ? `Caches cleared (${plural(count, 'entry', 'entries')})` : 'Caches were already empty');
    await loadHealth(ctx);
  }));
}

// ---------------------------------------------------------------------------
// Jobs
//   GET /jobs → { jobs: [{ id, kind, label, total, done, status, startedAt, meta }], clients }
// ---------------------------------------------------------------------------
const JOB_KIND = { scan: 'Library scan', upload: 'Upload', download: 'Download', torrent: 'Torrent', import: 'Import', transcode: 'Transcode' };

function jobRow(job) {
  const total = Number(job.total) || 0;
  const done = Number(job.done) || 0;
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : null;
  const meta = [
    JOB_KIND[job.kind] || job.kind || 'Job',
    total > 0 ? `${done.toLocaleString()} of ${total.toLocaleString()}` : (job.status === 'running' ? 'working…' : job.status),
    job.startedAt ? `started ${formatRelativeTime(job.startedAt).toLowerCase()}` : '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="download-row" data-job="${escapeAttr(job.id)}">
      ${icon(job.kind === 'scan' ? 'search' : job.kind === 'upload' ? 'upload-cloud' : 'download', { size: 16 })}
      <div class="row-main">
        <div class="row-title">${escapeHtml(job.label || JOB_KIND[job.kind] || 'Job')}</div>
        <div class="row-meta">${escapeHtml(meta)}</div>
      </div>
      ${pct !== null
        ? `<div class="system-job-progress"><div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Progress"><span style="width:${pct}%"></span></div><span class="row-meta">${pct}%</span></div>`
        : '<span class="row-meta">…</span>'}
    </div>`;
}

async function loadJobs(ctx, { quiet = false } = {}) {
  const { body } = ctx;
  let data;
  try {
    data = await api.getJobs();
  } catch (err) {
    if (ctx.isCurrent?.() === false) return;
    if (!quiet) body.innerHTML = errorState(`Couldn’t load jobs: ${err.message}`);
    return;
  }
  if (ctx.isCurrent?.() === false || ctx.activeTab !== 'jobs') return;
  const jobs = data.jobs || [];
  const scanning = jobs.some(job => job.kind === 'scan');

  body.innerHTML = `
    <div class="page-actions" style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center">
      ${ctx.isAdmin ? `<button type="button" class="btn btn-secondary btn-sm" id="jobs-scan"${scanning ? ' disabled' : ''}>${icon('search', { size: 14 })}<span>${scanning ? 'Scan running…' : 'Scan library now'}</span></button>` : ''}
      <button type="button" class="btn btn-ghost btn-sm" id="jobs-refresh">${icon('refresh', { size: 14 })}<span>Refresh</span></button>
      <span class="row-meta">${plural(data.clients ?? 0, 'live connection')} · updates automatically</span>
    </div>
    <div id="job-list">${jobs.length ? jobs.map(jobRow).join('') : '<div class="row-meta">No jobs running. Scans, uploads and downloads show up here while they run.</div>'}</div>
  `;

  body.querySelector('#jobs-refresh').addEventListener('click', () => loadJobs(ctx));
  body.querySelector('#jobs-scan')?.addEventListener('click', event => busy(event.currentTarget, async () => {
    try {
      await api.startBackgroundScan();
      toast.success('Library scan started');
    } catch (err) {
      if (err.code === 'SCAN_RUNNING' || err.status === 409) toast.info('A scan is already running');
      else throw err;
    }
    await loadJobs(ctx, { quiet: true });
  }));
}

// ---------------------------------------------------------------------------
// Logs (admin)
//   GET /logs?limit= → { lines: [{ at, level, line }] }   (oldest first)
// ---------------------------------------------------------------------------
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };

function logFileText(lines) {
  return lines.map(l => `[${l.at}] [${String(l.level || 'info').toUpperCase()}] ${l.line ?? ''}`).join('\n') + '\n';
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'text/plain' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function loadLogs(ctx) {
  const { body } = ctx;
  if (!ctx.isAdmin) {
    body.innerHTML = errorState(ADMIN_NOTE, { html: true });
    return;
  }
  let lines = [];
  try {
    lines = (await api.getLogs(500)).lines || [];
  } catch (err) {
    if (ctx.isCurrent?.() === false) return;
    body.innerHTML = isAdminError(err) ? errorState(ADMIN_NOTE, { html: true }) : errorState(`Couldn’t load logs: ${err.message}`);
    return;
  }
  if (ctx.isCurrent?.() === false) return;

  const state = ctx.logFilter || (ctx.logFilter = { level: 'all', text: '' });
  body.innerHTML = `
    <div class="page-actions system-log-toolbar">
      <select class="form-select form-input" id="logs-level" aria-label="Minimum level">
        <option value="all">All levels</option>
        <option value="warn">Warnings and errors</option>
        <option value="error">Errors only</option>
      </select>
      <input type="search" class="form-input" id="logs-search" placeholder="Filter messages" aria-label="Filter log messages" autocomplete="off">
      <button type="button" class="btn btn-secondary btn-sm" id="logs-refresh">${icon('refresh', { size: 14 })}<span>Refresh</span></button>
      <button type="button" class="btn btn-ghost btn-sm" id="logs-export">${icon('download', { size: 14 })}<span>Download</span></button>
    </div>
    <p class="row-meta" id="logs-count" style="margin-bottom:8px"></p>
    <div id="log-list"></div>
  `;

  const levelSelect = body.querySelector('#logs-level');
  const search = body.querySelector('#logs-search');
  levelSelect.value = state.level;
  search.value = state.text;

  const visible = () => {
    const min = state.level === 'all' ? -1 : LEVEL_RANK[state.level];
    const needle = state.text.trim().toLowerCase();
    return lines.filter(l => (LEVEL_RANK[l.level] ?? 1) >= min && (!needle || String(l.line || '').toLowerCase().includes(needle)));
  };

  const paint = () => {
    const shown = visible().slice().reverse(); // newest first
    body.querySelector('#logs-count').textContent = lines.length
      ? `Showing ${shown.length.toLocaleString()} of the last ${plural(lines.length, 'line')} · newest first`
      : '';
    body.querySelector('#log-list').innerHTML = shown.map(entry => {
      const level = String(entry.level || 'info').toLowerCase();
      const at = entry.at ? new Date(entry.at) : null;
      return `
        <div class="log-row">
          <span class="log-level ${escapeAttr(level)}">${escapeHtml(level)}</span>
          <span class="log-time" title="${at ? escapeAttr(at.toLocaleString()) : ''}">${at ? escapeHtml(at.toLocaleTimeString()) : ''}</span>
          <span class="log-message">${escapeHtml(entry.line || '')}</span>
        </div>`;
    }).join('') || `<div class="row-meta">${lines.length ? 'No lines match the filter.' : 'No log lines since the server started.'}</div>`;
  };
  paint();

  levelSelect.addEventListener('change', () => { state.level = levelSelect.value; paint(); });
  search.addEventListener('input', () => { state.text = search.value; paint(); });
  body.querySelector('#logs-refresh').addEventListener('click', () => loadLogs(ctx));
  body.querySelector('#logs-export').addEventListener('click', event => busy(event.currentTarget, async () => {
    const all = (await api.getLogs(2000)).lines || [];
    if (!all.length) {
      toast.info('There are no log lines to download yet');
      return;
    }
    downloadText(logFileText(all), `vault-${new Date().toISOString().slice(0, 10)}.log`);
  }));
}

// ---------------------------------------------------------------------------
// Backups (admin)
//   GET /backups → { backups: [{ name, bytes, createdAt }] }  (newest first)
// ---------------------------------------------------------------------------
async function loadBackups(ctx) {
  const { body } = ctx;
  if (!ctx.isAdmin) {
    body.innerHTML = errorState(ADMIN_NOTE, { html: true });
    return;
  }
  let backups = [];
  try {
    backups = (await api.getBackups()).backups || [];
  } catch (err) {
    if (ctx.isCurrent?.() === false) return;
    body.innerHTML = isAdminError(err) ? errorState(ADMIN_NOTE, { html: true }) : errorState(`Couldn’t load backups: ${err.message}`);
    return;
  }
  if (ctx.isCurrent?.() === false) return;

  body.innerHTML = `
    <p class="row-meta" style="margin-bottom:12px">A backup holds settings, profiles, the library index, playlists and watch history (not the media files). Backups are stored in the server’s <code>data/backups</code> folder.</p>
    <div class="page-actions" style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <button type="button" class="btn btn-primary btn-sm" id="backup-create">${icon('package', { size: 14 })}<span>Create backup</span></button>
      <a class="btn btn-ghost btn-sm" href="settings#transfer" data-route="/settings#transfer">${icon('upload-cloud', { size: 14 })}<span>Move everything, including media…</span></a>
    </div>
    <div id="backup-list">
    ${backups.map(backup => `
      <div class="backup-row" data-backup="${escapeAttr(backup.name)}">
        ${icon('archive', { size: 16 })}
        <div class="row-main">
          <div class="row-title">${escapeHtml(backup.name)}</div>
          <div class="row-meta">${bytes(backup.bytes)}${backup.createdAt ? ` · ${escapeHtml(new Date(backup.createdAt).toLocaleString())} (${escapeHtml(formatRelativeTime(backup.createdAt).toLowerCase())})` : ''}</div>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" data-restore="${escapeAttr(backup.name)}">Restore</button>
        <button type="button" class="btn-icon" data-delete="${escapeAttr(backup.name)}" aria-label="Delete ${escapeAttr(backup.name)}" title="Delete">${icon('trash', { size: 14 })}</button>
      </div>`).join('') || '<div class="row-meta">No backups yet. Create one before your next big change.</div>'}
    </div>
  `;

  body.querySelector('#backup-create').addEventListener('click', event => busy(event.currentTarget, () => createBackup(ctx)));

  body.querySelectorAll('[data-restore]').forEach(button => {
    button.addEventListener('click', () => busy(button, async () => {
      const name = button.dataset.restore;
      const { confirmed } = await confirmDialog({
        title: 'Restore this backup?',
        message: `Settings, profiles, the library index and playlists are replaced with the contents of ${name}. Changes made since then are lost. The page reloads afterwards.`,
        confirmText: 'Restore',
        danger: true,
      });
      if (!confirmed) return;
      try {
        const result = await api.restoreBackup(name);
        toast.success(`${result.message || 'Backup restored'}. Reloading…`);
        setTimeout(() => location.reload(), 1200);
      } catch (err) {
        throw new Error(`Restore failed: ${err.message}`);
      }
    }));
  });

  body.querySelectorAll('[data-delete]').forEach(button => {
    button.addEventListener('click', () => busy(button, async () => {
      const name = button.dataset.delete;
      const { confirmed } = await confirmDialog({
        title: 'Delete this backup?',
        message: `${name} is deleted from the server for good.`,
        confirmText: 'Delete backup',
        danger: true,
      });
      if (!confirmed) return;
      await api.deleteBackup(name);
      toast.success('Backup deleted');
      await loadBackups(ctx);
    }));
  });
}

async function createBackup(ctx) {
  const progress = toast.progress('Creating backup…', { title: 'Backup' });
  try {
    const result = await api.createBackup(false);
    progress.finish(`Backup created (${bytes(result.bytes)})`);
    if (ctx.activeTab === 'backups' && ctx.body.isConnected) await loadBackups(ctx);
  } catch (err) {
    progress.fail(`Backup failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Services
//   GET /capabilities → { ffmpeg, version, hardware[{label}], unusable[], ffprobe, ffprobeVersion, preferred }
//   GET /scrobbles    → { scrobbles: [{ title, artist, playedAt, submitted{lastfm,listenbrainz} }] }
//   GET /agents       → { providers: { tmdb|musicbrainz|nfo: { enabled, switchedOn, hasKey, requiresKey } } }
//   GET /subsonic     → { enabled, username }   (admin)
// ---------------------------------------------------------------------------
const AGENTS = {
  tmdb: { name: 'TMDb', about: 'Movie and TV posters, plots and cast. Needs a free API key from themoviedb.org.' },
  musicbrainz: { name: 'MusicBrainz', about: 'Album and artist details for music. No key needed.' },
  nfo: { name: 'NFO files', about: 'Reads .nfo files next to your media (Kodi/Jellyfin style).' },
};

function agentStatus(info) {
  if (info.enabled) return 'Active';
  if (info.requiresKey && info.switchedOn && !info.hasKey) return 'On, but no API key';
  if (info.requiresKey && !info.hasKey) return 'Off · no API key';
  return 'Off';
}

function capabilityItems(caps) {
  const hw = (caps.hardware || []).map(h => h.label).filter(Boolean);
  return `
    <div class="health-item ${caps.ffmpeg ? 'ok' : 'warn'}" data-service="ffmpeg">
      ${icon('video', { size: 16 })}<div class="row-main"><div class="row-title">Transcoding</div>
      <div class="row-meta">${caps.ffmpeg
        ? `${escapeHtml(caps.version || 'ffmpeg found')} · ${hw.length ? `hardware: ${escapeHtml(hw.join(', '))}` : 'software encoding (no GPU encoder found)'}${caps.unusable?.length ? ` · not working: ${escapeHtml(caps.unusable.join(', '))}` : ''}`
        : 'ffmpeg not found. Only files the browser can play directly will work.'}</div></div>
    </div>
    <div class="health-item ${caps.ffprobe ? 'ok' : 'warn'}" data-service="ffprobe">
      ${icon('search', { size: 16 })}<div class="row-main"><div class="row-title">Media probing</div>
      <div class="row-meta">${caps.ffprobe
        ? escapeHtml(caps.ffprobeVersion || 'ffprobe found')
        : 'ffprobe not found. Durations, codecs and chapters can’t be read during scans.'}</div></div>
    </div>`;
}

async function loadServices(ctx) {
  const { body } = ctx;
  const failed = [];
  const settle = (promise, fallback, label) => promise.catch(err => {
    if (!isAdminError(err)) failed.push(label);
    return { ...fallback, _error: err };
  });
  const [caps, scrobbleData, agentData, subsonic] = await Promise.all([
    settle(api.getCapabilities(), {}, 'transcoding'),
    settle(api.getScrobbles(20), { scrobbles: [] }, 'scrobbles'),
    settle(api.getAgents(), { providers: {} }, 'metadata agents'),
    ctx.isAdmin ? settle(api.getSubsonic(), {}, 'Subsonic') : Promise.resolve({ _error: { status: 403 } }),
  ]);
  if (ctx.isCurrent?.() === false) return;

  const scrobbles = scrobbleData.scrobbles || [];
  const providers = agentData.providers || {};
  const subsonicKnown = !subsonic._error;

  body.innerHTML = `
    ${failed.length ? `<p class="row-meta" role="alert" style="margin-bottom:12px">Couldn’t load: ${escapeHtml(failed.join(', '))}.</p>` : ''}
    <div class="health-list" style="margin-bottom:20px">
      ${caps._error ? '' : capabilityItems(caps)}
      <div class="health-item ${subsonic.enabled ? 'ok' : ''}" data-service="subsonic">
        ${icon('headphones', { size: 16 })}<div class="row-main"><div class="row-title">Subsonic API</div>
        <div class="row-meta">${!subsonicKnown
          ? 'Only an admin profile can see or change Subsonic access.'
          : subsonic.enabled
            ? `On for “${escapeHtml(subsonic.username || '')}”. Point your Subsonic app (DSub, Symfonium, Substreamer…) at this server’s address.`
            : 'Off. Set a password to use Subsonic music apps.'}</div></div>
        ${subsonicKnown ? `
          <button type="button" class="btn btn-secondary btn-sm" id="subsonic-set">${subsonic.enabled ? 'Change password' : 'Turn on'}</button>
          ${subsonic.enabled ? '<button type="button" class="btn btn-ghost btn-sm" id="subsonic-off">Turn off</button>' : ''}` : ''}
      </div>
      <div class="health-item" data-service="notifications">
        ${icon('zap', { size: 16 })}<div class="row-main"><div class="row-title">Notifications</div>
        <div class="row-meta">Webhook, ntfy, Discord and Telegram. <a href="settings#notifications" data-route="/settings#notifications">Set up targets</a></div></div>
        ${ctx.isAdmin ? '<button type="button" class="btn btn-secondary btn-sm" id="notify-test">Send test</button>' : ''}
      </div>
    </div>

    <section class="section">
      <h2 class="section-title">Metadata agents</h2>
      <div class="health-list">
      ${Object.keys(AGENTS).filter(key => providers[key]).map(key => {
        const info = providers[key];
        const meta = AGENTS[key];
        return `
          <div class="health-item ${info.enabled ? 'ok' : ''}" data-agent-row="${key}">
            <div class="row-main"><div class="row-title">${escapeHtml(meta.name)} <span class="row-meta">· ${escapeHtml(agentStatus(info))}</span></div>
            <div class="row-meta">${escapeHtml(meta.about)}</div></div>
            ${ctx.isAdmin && info.requiresKey ? `<button type="button" class="btn btn-secondary btn-sm" data-agent-key="${key}">${info.hasKey ? 'Change key' : 'Add key'}</button>` : ''}
            ${ctx.isAdmin ? `<input type="checkbox" role="switch" class="switch" data-agent-toggle="${key}" aria-label="Use ${escapeAttr(meta.name)}"${info.switchedOn ? ' checked' : ''}>` : ''}
          </div>`;
      }).join('') || '<div class="row-meta">No metadata agents reported.</div>'}
      </div>
    </section>

    <section class="section">
      <h2 class="section-title">Recent scrobbles</h2>
      ${scrobbles.slice(0, 10).map(entry => {
        const sent = Object.entries(entry.submitted || {}).filter(([, ok]) => ok).map(([service]) => (service === 'lastfm' ? 'Last.fm' : 'ListenBrainz'));
        return `<div class="row-meta" style="padding:4px 0">${escapeHtml(entry.title || 'Unknown track')}${entry.artist ? ` — ${escapeHtml(entry.artist)}` : ''}${entry.playedAt ? ` · ${escapeHtml(formatRelativeTime(entry.playedAt).toLowerCase())}` : ''}${sent.length ? ` · sent to ${escapeHtml(sent.join(' and '))}` : ' · not sent'}</div>`;
      }).join('') || '<div class="row-meta">No scrobbles yet. Connect Last.fm or ListenBrainz in Settings → Notifications.</div>'}
    </section>
  `;

  body.querySelector('#subsonic-set')?.addEventListener('click', event => busy(event.currentTarget, async () => {
    const password = await promptModal({
      title: subsonic.enabled ? 'Change Subsonic password' : 'Turn on Subsonic access',
      message: 'Subsonic apps sign in with your Vault username and this password. Use a different password from your Vault sign-in; Subsonic apps often send it with little protection.',
      label: 'Subsonic password',
      inputType: 'password',
      autocomplete: 'new-password',
      confirmLabel: 'Save',
      validate: value => (String(value || '').length < 6 ? 'Use at least 6 characters' : null),
    });
    if (!password) return;
    await api.setSubsonicPassword(password);
    toast.success('Subsonic password saved');
    await loadServices(ctx);
  }));

  body.querySelector('#subsonic-off')?.addEventListener('click', event => busy(event.currentTarget, async () => {
    const { confirmed } = await confirmDialog({
      title: 'Turn off Subsonic access?',
      message: 'Subsonic apps signed in with this password stop working until you set a new one.',
      confirmText: 'Turn off',
      danger: true,
    });
    if (!confirmed) return;
    await api.setSubsonicPassword('');
    toast.success('Subsonic access turned off');
    await loadServices(ctx);
  }));

  body.querySelector('#notify-test')?.addEventListener('click', event => busy(event.currentTarget, async () => {
    const result = await api.testNotifications();
    if (!result.sent) {
      toast.info(result.message || 'No notification targets are set up yet');
    } else if (result.ok === result.sent) {
      toast.success(`Test sent to ${plural(result.sent, 'target')}`);
    } else {
      const failedTargets = Object.entries(result.results || {}).filter(([, r]) => !r.ok).map(([k, r]) => `${k}${r.error ? ` (${r.error})` : ''}`);
      toast.error(`${result.ok} of ${result.sent} targets worked. Failed: ${failedTargets.join(', ')}`);
    }
  }));

  body.querySelectorAll('[data-agent-key]').forEach(button => {
    button.addEventListener('click', () => busy(button, async () => {
      const provider = button.dataset.agentKey;
      const name = AGENTS[provider]?.name || provider;
      const key = await promptModal({
        title: `${name} API key`,
        message: providers[provider]?.hasKey ? 'A key is already saved. Enter a new one to replace it.' : 'Paste the API key (v3 auth) from your themoviedb.org account settings.',
        label: 'API key',
        autocomplete: 'off',
        confirmLabel: 'Save key',
        validate: value => (String(value || '').trim().length < 10 ? 'That doesn’t look like an API key' : null),
      });
      if (!key) return;
      await api.setAgent(provider, { apiKey: key.trim(), enabled: true });
      toast.success(`${name} key saved and turned on`);
      await loadServices(ctx);
    }));
  });

  body.querySelectorAll('[data-agent-toggle]').forEach(input => {
    input.addEventListener('change', async () => {
      const provider = input.dataset.agentToggle;
      const name = AGENTS[provider]?.name || provider;
      const want = input.checked;
      input.disabled = true;
      try {
        await api.setAgent(provider, { enabled: want });
        toast.success(`${name} turned ${want ? 'on' : 'off'}`);
        await loadServices(ctx);
      } catch (err) {
        input.checked = !want;
        input.disabled = false;
        toast.error(err.message);
      }
    });
  });
}

export default { renderSystem };
