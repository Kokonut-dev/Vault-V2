/**
 * Server console — health, jobs, logs, disk, index, backups, services.
 * (Tier 4 items 42/45/47: Tautulli-style operations page, in the app.)
 */
import { api } from '../api.js';
import { icon } from '../utils/icons.js';
import { escapeHtml, formatBytes, formatRelativeTime, formatTime } from '../utils/format.js';
import { toast } from '../components/toast.js';
import { confirmDialog } from '../components/confirmDialog.js';

const TABS = [
  ['health', 'Health', 'shield-check'],
  ['jobs', 'Jobs', 'activity'],
  ['logs', 'Logs', 'list'],
  ['backups', 'Backups', 'archive'],
  ['services', 'Services', 'zap'],
];

function healthClass(status) {
  if (status === 'ok' || status === true) return 'ok';
  if (status === 'warn' || status === 'warning') return 'warn';
  return 'error';
}

export async function renderSystem(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${icon('hard-drive', { size: 26 })}<span>Server</span></h1>
      <p class="page-subtitle">Health, background jobs, logs, backups and integrations</p>
      <div class="settings-tabs" role="tablist" style="margin-top:12px">
        ${TABS.map(([key, label, iconName], index) => `<button type="button" class="settings-tab${index === 0 ? ' active' : ''}" role="tab" data-tab="${key}">${icon(iconName, { size: 14 })} ${label}</button>`).join('')}
      </div>
    </div>
    <div id="system-body"></div>
  `;

  const body = container.querySelector('#system-body');
  let activeTab = 'health';

  const loaders = {
    health: loadHealth,
    jobs: loadJobs,
    logs: loadLogs,
    backups: loadBackups,
    services: loadServices,
  };

  async function show(tab) {
    activeTab = tab;
    container.querySelectorAll('.settings-tab').forEach(node => node.classList.toggle('active', node.dataset.tab === tab));
    body.innerHTML = '<div class="skeleton skeleton-block"></div>';
    await loaders[tab](body);
  }

  container.querySelectorAll('.settings-tab').forEach(node => {
    node.addEventListener('click', () => show(node.dataset.tab));
  });
  window.addEventListener('vault:job-finished', () => { if (activeTab === 'jobs') loaders.jobs(body); });
  window.addEventListener('vault:job-progress', () => { if (activeTab === 'jobs') loaders.jobs(body); });

  await show('health');
}

async function loadHealth(body) {
  let health;
  let disk;
  try {
    [health, disk] = await Promise.all([api.getLibraryHealth(), api.getDisk().catch(() => null)]);
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
    return;
  }

  const checks = health.checks || health.items || [];
  body.innerHTML = `
    <div class="stat-grid" style="margin-bottom:20px">
      <div class="stat-card"><div class="stat-label">Library</div><div class="stat-value">${health.totalItems ?? health.total ?? 0}</div>
        <div class="row-meta">${health.missingFiles ?? 0} missing file(s)</div></div>
      <div class="stat-card"><div class="stat-label">Disk free</div><div class="stat-value">${disk ? formatBytes(disk.free ?? 0) : '—'}</div>
        <div class="row-meta">${disk ? `${formatBytes(disk.used ?? 0)} used of ${formatBytes(disk.total ?? 0)}` : ''}</div></div>
      <div class="stat-card"><div class="stat-label">Last scan</div><div class="stat-value" style="font-size:1.1rem">${health.lastScan ? formatRelativeTime(health.lastScan) : 'never'}</div></div>
      <div class="stat-card"><div class="stat-label">Database</div><div class="stat-value" style="font-size:1.1rem">${health.index?.enabled ? 'SQLite index' : 'JSON files'}</div>
        <div class="row-meta">${health.index ? `${health.index.count ?? 0} rows` : ''}</div></div>
    </div>

    ${disk && disk.total ? `<div class="meter ${disk.used / disk.total > 0.9 ? 'danger' : disk.used / disk.total > 0.75 ? 'warn' : ''}" style="margin-bottom:20px">
      <span style="width:${Math.round((disk.used / disk.total) * 100)}%"></span></div>` : ''}

    <div class="health-list">
      ${checks.length ? checks.map(check => `
        <div class="health-item ${healthClass(check.status)}">
          ${icon(check.status === 'ok' ? 'shield-check' : 'alert-triangle', { size: 16 })}
          <div class="row-main">
            <div class="row-title">${escapeHtml(check.name || check.label)}</div>
            <div class="row-meta">${escapeHtml(check.message || '')}</div>
          </div>
        </div>`).join('') : '<div class="row-meta">No health checks reported.</div>'}
    </div>

    <div class="page-actions" style="margin-top:20px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-secondary" id="health-deep">Run deep check</button>
      <button class="btn btn-secondary" id="health-prune">Remove missing files</button>
      <button class="btn btn-ghost" id="health-rebuild">Rebuild search index</button>
      <button class="btn btn-ghost" id="health-cache">Clear caches</button>
    </div>
  `;

  body.querySelector('#health-deep').addEventListener('click', async () => {
    body.querySelector('#health-deep').disabled = true;
    try {
      const deep = await api.getLibraryHealth(true);
      toast.success(`Deep check done — ${(deep.checks || []).filter(c => c.status !== 'ok').length} issue(s)`);
      loadHealth(body);
    } catch (err) {
      toast.error(err.message);
    } finally {
      body.querySelector('#health-deep')?.removeAttribute('disabled');
    }
  });
  body.querySelector('#health-prune').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Remove missing files?',
      message: 'Entries whose files no longer exist are removed from the library database. Playlists keep their other entries.',
      confirmLabel: 'Remove entries',
      danger: true,
    });
    if (!ok) return;
    const result = await api.pruneMissing();
    toast.success(`Removed ${result.removed ?? 0} stale entr${(result.removed ?? 0) === 1 ? 'y' : 'ies'}`);
    loadHealth(body);
  });
  body.querySelector('#health-rebuild').addEventListener('click', async () => {
    await api.rebuildIndex();
    toast.success('Search index rebuilt');
  });
  body.querySelector('#health-cache').addEventListener('click', async () => {
    await api.clearCaches();
    toast.success('Caches cleared');
  });
}

async function loadJobs(body) {
  let jobs = [];
  try {
    jobs = (await api.getJobs()).jobs || [];
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
    return;
  }
  body.innerHTML = jobs.length ? jobs.map(job => `
    <div class="download-row">
      <div class="row-main">
        <div class="row-title">${escapeHtml(job.name || job.type || 'Job')}</div>
        <div class="row-meta">${job.status}${job.detail ? ` · ${escapeHtml(job.detail)}` : ''}${job.startedAt ? ` · started ${formatRelativeTime(job.startedAt)}` : ''}</div>
      </div>
      ${job.progress !== undefined ? `<div class="meter" style="width:140px"><span style="width:${Math.round((job.progress || 0) * (job.progress <= 1 ? 100 : 1))}%"></span></div>` : ''}
    </div>`).join('') : '<div class="row-meta">No jobs running.</div>';
}

async function loadLogs(body) {
  let entries = [];
  try {
    entries = (await api.getLogs(300)).entries || (await api.getLogs(300)).logs || [];
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
    return;
  }
  body.innerHTML = `
    <div class="page-actions" style="display:flex;gap:8px;margin-bottom:12px">
      <button class="btn btn-secondary btn-sm" id="logs-refresh">${icon('refresh', { size: 14 })}<span>Refresh</span></button>
      <button class="btn btn-ghost btn-sm" id="logs-export">${icon('download', { size: 14 })}<span>Export</span></button>
    </div>
    <div id="log-list">${entries.map(entry => `
      <div class="log-row">
        <span class="log-level ${escapeHtml(String(entry.level || 'info').toLowerCase())}">${escapeHtml(entry.level || 'info')}</span>
        <span class="log-time">${entry.time ? new Date(entry.time).toLocaleTimeString() : ''}</span>
        <span class="log-message">${escapeHtml(entry.message || '')}</span>
      </div>`).join('') || '<div class="row-meta">No log entries.</div>'}</div>
  `;
  body.querySelector('#logs-refresh').addEventListener('click', () => loadLogs(body));
  body.querySelector('#logs-export').addEventListener('click', async () => {
    try {
      const result = await api.exportLogs();
      const blob = new Blob([JSON.stringify(result.entries || result.logs || [], null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `vault-logs-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (err) {
      toast.error(err.message);
    }
  });
}

async function loadBackups(body) {
  let backups = [];
  try {
    backups = (await api.getBackups()).backups || [];
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
    return;
  }
  body.innerHTML = `
    <div class="page-actions" style="display:flex;gap:8px;margin-bottom:12px">
      <button class="btn btn-primary btn-sm" id="backup-create">${icon('package', { size: 14 })}<span>Create backup</span></button>
      <button class="btn btn-ghost btn-sm" id="backup-create-media">Create incl. artwork</button>
    </div>
    ${backups.map(backup => `
      <div class="backup-row">
        <div class="row-main">
          <div class="row-title">${escapeHtml(backup.name || backup.file)}</div>
          <div class="row-meta">${formatBytes(backup.size || 0)} · ${backup.createdAt ? formatRelativeTime(backup.createdAt) : ''}</div>
        </div>
        <button class="btn btn-secondary btn-sm" data-restore="${escapeHtml(backup.name || backup.file)}">Restore</button>
        <button class="btn btn-ghost btn-sm" data-delete="${escapeHtml(backup.name || backup.file)}" aria-label="Delete backup">${icon('trash', { size: 14 })}</button>
      </div>`).join('') || '<div class="row-meta">No backups yet — create one before your next big change.</div>'}
  `;
  body.querySelector('#backup-create').addEventListener('click', () => createBackup(body, false));
  body.querySelector('#backup-create-media').addEventListener('click', () => createBackup(body, true));
  body.querySelectorAll('[data-restore]').forEach(button => {
    button.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: `Restore ${button.dataset.restore}?`,
        message: 'Current settings, library index and playlists are replaced by the backup contents.',
        confirmLabel: 'Restore',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.restoreBackup(button.dataset.restore);
        toast.success('Backup restored — reloading');
        setTimeout(() => location.reload(), 900);
      } catch (err) {
        toast.error(`Restore failed: ${err.message}`);
      }
    });
  });
  body.querySelectorAll('[data-delete]').forEach(button => {
    button.addEventListener('click', async () => {
      await api.deleteBackup(button.dataset.delete);
      toast.success('Backup deleted');
      loadBackups(body);
    });
  });
}

async function createBackup(body, includeMedia) {
  const progress = toast.progress('Creating backup…', { title: 'Backup' });
  try {
    const result = await api.createBackup(includeMedia);
    progress.finish(`Backup created (${formatBytes(result.size || 0)})`);
    loadBackups(body);
  } catch (err) {
    progress.fail(`Backup failed: ${err.message}`);
  }
}

async function loadServices(body) {
  let capabilities = {};
  let scrobbles = [];
  let agents = [];
  let subsonic = {};
  try {
    [capabilities, scrobbles, agents, subsonic] = await Promise.all([
      api.getCapabilities().catch(() => ({})),
      api.getScrobbles(20).catch(() => ({ entries: [] })),
      api.getAgents().catch(() => ({ agents: [] })),
      api.getSubsonic().catch(() => ({})),
    ]);
  } catch { /* individual fallbacks above */ }

  const caps = capabilities.capabilities || capabilities;
  body.innerHTML = `
    <div class="health-list" style="margin-bottom:20px">
      <div class="health-item ${caps.ffmpeg ? 'ok' : 'warn'}">
        ${icon('video', { size: 16 })}<div class="row-main"><div class="row-title">Transcoding</div>
        <div class="row-meta">${caps.ffmpeg ? 'ffmpeg detected' : 'ffmpeg not found — direct play only'} ${caps.hardwareAcceleration ? `· ${caps.hardwareAcceleration.join(', ')}` : ''}</div></div>
      </div>
      <div class="health-item ${caps.ffprobe ? 'ok' : 'warn'}">
        ${icon('search', { size: 16 })}<div class="row-main"><div class="row-title">Media probing</div>
        <div class="row-meta">${caps.ffprobe ? 'ffprobe available' : 'ffprobe missing — metadata/scenes limited'}</div></div>
      </div>
      <div class="health-item ${subsonic.enabled ? 'ok' : ''}">
        ${icon('headphones', { size: 16 })}<div class="row-main"><div class="row-title">Subsonic API</div>
        <div class="row-meta">${subsonic.enabled ? 'Enabled — point your Subsonic app at /rest' : 'Disabled — set a password to enable'}</div></div>
        <button class="btn btn-secondary btn-sm" id="subsonic-set">${subsonic.enabled ? 'Change password' : 'Enable'}</button>
      </div>
      <div class="health-item">
        ${icon('zap', { size: 16 })}<div class="row-main"><div class="row-title">Notifications</div>
        <div class="row-meta">Webhook, ntfy, Discord, Telegram</div></div>
        <button class="btn btn-secondary btn-sm" id="notify-test">Send test</button>
      </div>
    </div>

    <section class="section">
      <h2 class="section-title">Scrobbling</h2>
      ${(scrobbles.entries || scrobbles.scrobbles || []).slice(0, 10).map(entry => `
        <div class="row-meta" style="padding:4px 0">${escapeHtml(entry.title || '')} — ${escapeHtml(entry.artist || entry.service || '')} ${entry.time ? `· ${formatTime((Date.now() - new Date(entry.time).getTime()) / 1000)} ago` : ''}</div>
      `).join('') || '<div class="row-meta">No scrobbles yet.</div>'}
    </section>

    <section class="section">
      <h2 class="section-title">Metadata agents</h2>
      ${(agents.agents || Object.keys(agents)).map(agent => `
        <div class="health-item ${agent.enabled ? 'ok' : ''}">
          <div class="row-main"><div class="row-title">${escapeHtml(agent.name || agent.id || agent)}</div>
          <div class="row-meta">${agent.configured ? 'API key set' : 'No API key — using public endpoints where possible'}</div></div>
          <button class="btn btn-secondary btn-sm" data-agent="${escapeHtml(agent.id || agent)}">${agent.configured ? 'Update key' : 'Add key'}</button>
        </div>`).join('') || '<div class="row-meta">No agents registered.</div>'}
    </section>
  `;

  body.querySelector('#subsonic-set').addEventListener('click', async () => {
    const password = window.prompt('Subsonic password for this account:');
    if (!password) return;
    try {
      await api.setSubsonicPassword(password);
      toast.success('Subsonic access enabled');
      loadServices(body);
    } catch (err) {
      toast.error(err.message);
    }
  });
  body.querySelector('#notify-test').addEventListener('click', async () => {
    try {
      await api.testNotifications();
      toast.success('Test notification sent');
    } catch (err) {
      toast.error(`Test failed: ${err.message}`);
    }
  });
  body.querySelectorAll('[data-agent]').forEach(button => {
    button.addEventListener('click', async () => {
      const key = window.prompt(`API key for ${button.dataset.agent}:`);
      if (!key) return;
      try {
        await api.setAgent(button.dataset.agent, { apiKey: key });
        toast.success('Agent updated');
        loadServices(body);
      } catch (err) {
        toast.error(err.message);
      }
    });
  });
}

export default { renderSystem };
