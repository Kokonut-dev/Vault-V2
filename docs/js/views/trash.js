/**
 * Trash (soft-delete + undo) and Offline Downloads.
 * Server: /api/extras/trash (retention window, restore, purge).
 */
import { api } from '../api.js';
import { icon } from '../utils/icons.js';
import { escapeHtml, formatBytes, formatRelativeTime } from '../utils/format.js';
import { toast } from '../components/toast.js';
import { confirmDialog } from '../components/confirmDialog.js';
import { listOfflineItems, removeOfflineItem } from '../app-extras.js';

export async function renderTrash(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${icon('trash', { size: 26 })}<span>Trash</span></h1>
      <p class="page-subtitle">Deleted files stay here until the retention window passes, so mistakes are undoable</p>
      <div class="page-actions" style="margin-top:10px;display:flex;gap:8px">
        <button class="btn btn-danger btn-sm" id="trash-empty">${icon('trash', { size: 14 })}<span>Empty trash</span></button>
      </div>
    </div>
    <div id="trash-body"></div>
  `;

  const body = container.querySelector('#trash-body');

  async function load() {
    let entries = [];
    let totalSize = 0;
    try {
      const data = await api.getTrash();
      entries = data.entries || data.items || [];
      totalSize = data.totalSize ?? entries.reduce((sum, entry) => sum + (entry.size || 0), 0);
    } catch (err) {
      body.innerHTML = `<div class="empty-state"><div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
      return;
    }

    body.innerHTML = entries.length ? `
      <div class="row-meta" style="margin-bottom:10px">${entries.length} item(s) · ${formatBytes(totalSize)}</div>
      ${entries.map(entry => `
        <div class="trash-row">
          <span class="row-icon">${icon('archive', { size: 18 })}</span>
          <div class="row-main">
            <div class="row-title">${escapeHtml(entry.title || entry.name || 'Untitled')}</div>
            <div class="row-meta">${formatBytes(entry.size || 0)} · deleted ${entry.deletedAt ? formatRelativeTime(entry.deletedAt) : 'recently'}${entry.retentionDays ? ` · purged in ${entry.retentionDays} day(s)` : ''}</div>
          </div>
          <button class="btn btn-primary btn-sm" data-restore="${entry.id}">Restore</button>
          <button class="btn btn-ghost btn-sm" data-purge="${entry.id}" aria-label="Delete permanently">${icon('trash', { size: 14 })}</button>
        </div>`).join('')}
    ` : `<div class="empty-state">${icon('trash', { size: 30 })}
        <div class="empty-state-title">Trash is empty</div>
        <div class="empty-state-message">Deleted media lands here first and can be restored with one click.</div></div>`;

    body.querySelectorAll('[data-restore]').forEach(button => {
      button.addEventListener('click', async () => {
        try {
          await api.restoreFromTrash(button.dataset.restore);
          toast.success('Restored — a library scan will pick it up');
          load();
        } catch (err) {
          toast.error(`Restore failed: ${err.message}`);
        }
      });
    });
    body.querySelectorAll('[data-purge]').forEach(button => {
      button.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Delete permanently?',
          message: 'This cannot be undone.',
          confirmLabel: 'Delete forever',
          danger: true,
        });
        if (!ok) return;
        await api.purgeTrashEntry(button.dataset.purge);
        toast.success('Deleted permanently');
        load();
      });
    });
  }

  container.querySelector('#trash-empty').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Empty the trash?',
      message: 'Every file in the trash is deleted permanently. This cannot be undone.',
      confirmLabel: 'Empty trash',
      danger: true,
    });
    if (!ok) return;
    const result = await api.emptyTrash();
    toast.success(`Permanently deleted ${result.removed ?? 0} item(s)`);
    load();
  });

  await load();
}

export async function renderDownloads(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${icon('download', { size: 26 })}<span>Downloads</span></h1>
      <p class="page-subtitle">Media cached on this device — playable without a connection</p>
    </div>
    <div id="downloads-body"></div>
  `;
  const body = container.querySelector('#downloads-body');

  async function load() {
    const items = await listOfflineItems();
    if (!items.length) {
      body.innerHTML = `<div class="empty-state">${icon('download', { size: 30 })}
        <div class="empty-state-title">Nothing downloaded yet</div>
        <div class="empty-state-message">Right-click (or long-press) any item and choose “Save offline”.</div></div>`;
      return;
    }
    body.innerHTML = items.map(item => `
      <div class="download-row">
        <span class="row-icon">${icon('download', { size: 18 })}</span>
        <div class="row-main">
          <div class="row-title">${escapeHtml(item.title)}</div>
          <div class="row-meta">${item.size ? formatBytes(item.size) : ''}${item.addedAt ? ` · saved ${formatRelativeTime(new Date(item.addedAt).toISOString())}` : ''}</div>
        </div>
        <button class="btn btn-secondary btn-sm" data-open="${item.id}">Play</button>
        <button class="btn btn-ghost btn-sm" data-remove="${item.id}" aria-label="Remove download">${icon('trash', { size: 14 })}</button>
      </div>`).join('');

    body.querySelectorAll('[data-remove]').forEach(button => {
      button.addEventListener('click', async () => {
        await removeOfflineItem(button.dataset.remove);
        toast.success('Removed from this device');
        load();
      });
    });
    body.querySelectorAll('[data-open]').forEach(button => {
      button.addEventListener('click', () => {
        const item = items.find(entry => entry.id === button.dataset.open);
        if (item) window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } }));
      });
    });
  }

  window.addEventListener('vault:offline-changed', load);
  await load();
}

export default { renderTrash, renderDownloads };
