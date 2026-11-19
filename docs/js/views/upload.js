/**
 * Upload view.
 *
 * Two flows share one drop zone:
 *  - A few loose files → the original form (title/artist/cover/subtitles
 *    apply to what you picked), one request.
 *  - Folders (dropped, or "Choose folder") → a review of what was found,
 *    grouped per folder with a library type each, then a queue that uploads
 *    in batches of up to 50 files, keeps the folder structure on the server,
 *    skips files already there, survives the upload rate limit, and can be
 *    paused, resumed, cancelled and retried. See utils/folderUpload.js.
 */
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { store } from '../store.js';
import { escapeHtml, escapeAttr } from '../utils/format.js';
import { icon } from '../utils/icons.js';
import { renderDriveImport } from '../components/driveImport.js';
import { onUnmount } from '../utils/lifecycle.js';
import {
  entriesFromDataTransfer, entriesFromFileList, hasFolders, planUpload, batchesFor,
  formatBytes, TYPE_LABELS,
} from '../utils/folderUpload.js';

const TYPE_TITLES = { movie: 'Movie / Series', music: 'Music', video: 'Video', auto: 'Folders (auto-sort)' };

export function renderUpload(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Upload Media</h1>
      <p class="page-subtitle">Add movies, music, or videos from this device or Google Drive — single files or whole folders</p>
    </div>

    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:16px; margin-bottom:32px;">
      <button class="upload-type-card" data-type="movie">
        <div>${icon('film', { size: 32 })}</div>
        <div style="font-weight:700; margin-top:8px;">Movie / Series</div>
        <div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">MP4, MKV, AVI, etc.</div>
      </button>
      <button class="upload-type-card" data-type="music">
        <div>${icon('music', { size: 32 })}</div>
        <div style="font-weight:700; margin-top:8px;">Music</div>
        <div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">MP3, FLAC, WAV, etc.</div>
      </button>
      <button class="upload-type-card" data-type="video">
        <div>${icon('video', { size: 32 })}</div>
        <div style="font-weight:700; margin-top:8px;">Video</div>
        <div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">General videos</div>
      </button>
      <button class="upload-type-card" data-type="auto">
        <div>${icon('folder', { size: 32 })}</div>
        <div style="font-weight:700; margin-top:8px;">Folders (auto-sort)</div>
        <div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">Mixed folders — Vault sorts them</div>
      </button>
    </div>

    <div id="upload-form-container" style="display:none;">
      <div style="background:rgba(var(--glass-tint),0.05); border:1px solid rgba(var(--glass-tint),0.1); border-radius:16px; padding:24px;">
        <h3 id="upload-type-title" style="font-size:18px; font-weight:700; margin-bottom:16px;"></h3>

        <div id="drop-zone" role="button" tabindex="0" aria-describedby="drop-zone-help">
          <div id="drop-zone-arrow" style="margin-bottom:8px;">${icon('upload-cloud', { size: 28 })}</div>
          <div style="font-weight:600;">Drop files or folders here</div>
          <div id="drop-zone-help" style="font-size:12px; color:var(--text-secondary); margin-top:4px;">Folders keep their structure — Artist / Album, Show / Season</div>
          <div class="drop-zone-buttons">
            <button type="button" class="btn btn-secondary btn-sm" id="pick-files">${icon('plus', { size: 14 })}<span>Choose files</span></button>
            <button type="button" class="btn btn-secondary btn-sm" id="pick-folder">${icon('folder', { size: 14 })}<span>Choose folder</span></button>
          </div>
          <input type="file" id="file-input" multiple style="display:none;">
          <input type="file" id="folder-input" webkitdirectory directory multiple style="display:none;">
        </div>

        <div id="file-list" style="margin-top:16px;"></div>
        <div id="folder-review" style="margin-top:16px;" hidden></div>

        <div id="metadata-form" style="margin-top:24px;"></div>

        <div style="margin-top:24px; display:flex; gap:12px; flex-wrap:wrap;">
          <button class="btn btn-secondary" id="cancel-upload">Cancel</button>
          <button class="btn btn-primary" id="start-upload" disabled>Upload</button>
        </div>

        <div id="upload-progress" style="display:none; margin-top:16px;">
          <div class="progress"><div class="progress-bar" id="progress-bar" style="width:0%"></div></div>
          <div id="progress-text" style="font-size:12px; color:var(--text-secondary); margin-top:8px;" aria-live="polite">0%</div>
          <div id="queue-controls" style="display:none; margin-top:10px; gap:8px; flex-wrap:wrap;">
            <button type="button" class="btn btn-secondary btn-sm" id="queue-pause">${icon('pause', { size: 14 })}<span>Pause</span></button>
            <button type="button" class="btn btn-ghost btn-sm" id="queue-cancel">${icon('x', { size: 14 })}<span>Cancel upload</span></button>
          </div>
          <div id="queue-failures" style="margin-top:10px;"></div>
        </div>
      </div>
    </div>

    <div id="drive-import-host" class="drive-import-host"></div>

    <style>
      .upload-type-card {
        background:rgba(var(--glass-tint),0.05);
        border:1px solid rgba(var(--glass-tint),0.1);
        border-radius: 16px;
        padding: 24px;
        text-align: center;
        cursor: pointer;
        transition: all 0.2s;
      }
      .upload-type-card:hover {
        border-color: var(--accent);
        background:rgba(var(--glass-tint),0.12);
        transform: translateY(-2px);
      }
      .upload-type-card.active {
        border-color: var(--accent);
        background: var(--accent-muted);
      }
      #drop-zone {
        border: 2px dashed var(--border-strong);
        border-radius: 14px;
        padding: 36px 24px;
        text-align: center;
        cursor: pointer;
        background: rgba(var(--glass-tint), 0.03);
        transition: border-color 0.2s ease-out, background 0.2s ease-out,
                    box-shadow 0.2s ease-out;
      }
      #drop-zone:hover, #drop-zone:focus-visible {
        border-color: var(--accent);
        background: rgba(var(--glass-tint), 0.06);
      }
      #drop-zone.dragover {
        border-color: var(--accent);
        background: var(--accent-muted);
        box-shadow: 0 0 0 4px var(--accent-muted);
      }
      #drop-zone-arrow {
        transition: transform 0.25s var(--ease-out);
      }
      #drop-zone.dragover #drop-zone-arrow {
        transform: translateY(-6px);
      }
      .drop-zone-buttons { display:flex; gap:8px; justify-content:center; margin-top:14px; flex-wrap:wrap; }
      .folder-summary { font-size:13px; color:var(--text-secondary); margin-bottom:10px; }
      .folder-group {
        display:flex; align-items:center; gap:12px; background:rgba(var(--glass-tint),0.09);
        padding:10px 12px; border-radius:10px; margin-bottom:8px;
      }
      .folder-group .row-main { flex:1; min-width:0; }
      .folder-group .row-title { font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .folder-group .row-meta { font-size:11px; color:var(--text-secondary); }
      .folder-group select { max-width:180px; }
      .folder-skipped { font-size:12px; color:var(--text-secondary); margin-top:8px; }
      .folder-skipped summary { cursor:pointer; }
      .queue-failure { font-size:12px; color:var(--danger, #e5484d); margin-top:4px; }
    </style>
  `;

  renderDriveImport(container.querySelector('#drive-import-host'));

  const typeCards = container.querySelectorAll('.upload-type-card');
  const formContainer = container.querySelector('#upload-form-container');
  const typeTitle = container.querySelector('#upload-type-title');
  const dropZone = container.querySelector('#drop-zone');
  const fileInput = container.querySelector('#file-input');
  const folderInput = container.querySelector('#folder-input');
  const fileList = container.querySelector('#file-list');
  const folderReview = container.querySelector('#folder-review');
  const metadataForm = container.querySelector('#metadata-form');
  const cancelBtn = container.querySelector('#cancel-upload');
  const uploadBtn = container.querySelector('#start-upload');
  const progressContainer = container.querySelector('#upload-progress');
  const progressBar = container.querySelector('#progress-bar');
  const progressText = container.querySelector('#progress-text');
  const queueControls = container.querySelector('#queue-controls');
  const pauseBtn = container.querySelector('#queue-pause');
  const queueCancelBtn = container.querySelector('#queue-cancel');
  const failuresEl = container.querySelector('#queue-failures');

  let selectedType = null;
  let selectedFiles = [];
  /** Folder mode state: { groups, skipped, ignored, existing:Set<path> } */
  let folderPlan = null;
  let queue = null; // running folder upload

  // Leaving the page mid-upload would orphan the XHR; stop cleanly.
  onUnmount(() => queue?.cancel());

  typeCards.forEach(card => {
    card.addEventListener('click', () => {
      if (queue?.running) return;
      selectedType = card.dataset.type;
      typeCards.forEach(c => c.classList.remove('active'));
      card.classList.add('active');

      formContainer.style.display = 'block';
      typeTitle.textContent = `Upload ${TYPE_TITLES[selectedType]}`;
      if (folderPlan) replan();
      renderMetadataForm();
      formContainer.scrollIntoView({ behavior: 'smooth' });
    });
  });

  function renderMetadataForm() {
    // Per-file details only make sense for a few loose files of one type.
    if (folderPlan || selectedType === 'auto') {
      metadataForm.innerHTML = '';
      return;
    }
    if (selectedType === 'movie') {
      metadataForm.innerHTML = `
        <div class="form-row">
          <div class="form-group"><label class="form-label">Title</label><input type="text" class="form-input" id="meta-title" placeholder="Movie title"></div>
          <div class="form-group"><label class="form-label">Year</label><input type="number" class="form-input" id="meta-year" placeholder="2024"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label class="form-label">Genre</label><input type="text" class="form-input" id="meta-genre" placeholder="Action, Drama"></div>
          <div class="form-group"><label class="form-label">Description</label><input type="text" class="form-input" id="meta-desc" placeholder="Optional"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label class="form-label">Season (if series)</label><input type="number" class="form-input" id="meta-season" placeholder="1"></div>
          <div class="form-group"><label class="form-label">Episode (if series)</label><input type="number" class="form-input" id="meta-episode" placeholder="1"></div>
        </div>
        <div class="form-group"><label class="form-label">Cover Image (optional)</label><input type="file" class="form-input" id="meta-cover" accept="image/*"></div>
        <div class="form-group"><label class="form-label">Subtitles (optional)</label><input type="file" class="form-input" id="meta-subtitle" accept=".srt,.vtt,.ass" multiple></div>
      `;
    } else if (selectedType === 'music') {
      metadataForm.innerHTML = `
        <div class="form-row">
          <div class="form-group"><label class="form-label">Title</label><input type="text" class="form-input" id="meta-title" placeholder="Track title"></div>
          <div class="form-group"><label class="form-label">Artist</label><input type="text" class="form-input" id="meta-artist" placeholder="Artist name"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label class="form-label">Album</label><input type="text" class="form-input" id="meta-album" placeholder="Album name"></div>
          <div class="form-group"><label class="form-label">Genre</label><input type="text" class="form-input" id="meta-genre" placeholder="Rock, Pop"></div>
        </div>
        <div class="form-group"><label class="form-label">Cover Art (optional)</label><input type="file" class="form-input" id="meta-cover" accept="image/*"></div>
      `;
    } else {
      metadataForm.innerHTML = `
        <div class="form-group"><label class="form-label">Title</label><input type="text" class="form-input" id="meta-title" placeholder="Video title"></div>
        <div class="form-group"><label class="form-label">Description</label><textarea class="form-textarea" id="meta-desc" placeholder="Optional description"></textarea></div>
        <div class="form-group"><label class="form-label">Tags (comma separated)</label><input type="text" class="form-input" id="meta-tags" placeholder="fun, tutorial, etc."></div>
        <div class="form-group"><label class="form-label">Thumbnail (optional)</label><input type="file" class="form-input" id="meta-cover" accept="image/*"></div>
      `;
    }
  }

  // --- Picking -------------------------------------------------------------
  dropZone.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    fileInput.click();
  });
  dropZone.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === dropZone) {
      e.preventDefault();
      fileInput.click();
    }
  });
  container.querySelector('#pick-files').addEventListener('click', () => fileInput.click());
  container.querySelector('#pick-folder').addEventListener('click', () => folderInput.click());

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (queue?.running) return;
    progressText.textContent = '';
    try {
      handleEntries(await entriesFromDataTransfer(e.dataTransfer));
    } catch (err) {
      toast.error(`Couldn’t read what was dropped: ${err.message || err}`);
    }
  });

  fileInput.addEventListener('change', (e) => {
    handleEntries(entriesFromFileList(e.target.files));
    fileInput.value = '';
  });
  folderInput.addEventListener('change', (e) => {
    handleEntries(entriesFromFileList(e.target.files));
    folderInput.value = '';
  });

  function handleEntries(entries) {
    if (queue?.running) return;
    if (hasFolders(entries) || selectedType === 'auto') {
      selectedFiles = [];
      fileList.innerHTML = '';
      folderPlan = { entries, existing: new Set() };
      replan();
      renderMetadataForm();
      checkExisting();
    } else {
      folderPlan = null;
      folderReview.hidden = true;
      folderReview.innerHTML = '';
      selectedFiles = entries.map(e => e.file);
      renderFileList();
      renderMetadataForm();
    }
    updateUploadButton();
  }

  function replan() {
    const overrides = new Map((folderPlan.groups || []).filter(g => g.userType).map(g => [g.key, g.userType]));
    const plan = planUpload(folderPlan.entries, selectedType === 'auto' || !selectedType ? 'auto' : selectedType);
    for (const g of plan.groups) {
      if (overrides.has(g.key)) { g.type = overrides.get(g.key); g.userType = g.type; }
    }
    Object.assign(folderPlan, plan);
    renderFolderReview();
  }

  async function checkExisting() {
    const plan = folderPlan;
    if (!plan?.groups?.length) return;
    // Ask per library type which relative paths are already there.
    const byType = new Map();
    for (const g of plan.groups) {
      for (const f of g.files) {
        if (!byType.has(g.type)) byType.set(g.type, []);
        byType.get(g.type).push(f);
      }
    }
    const existing = new Set();
    for (const [type, files] of byType) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await api.checkUploads(type, files.map(f => ({ path: f.path, size: f.file?.size })));
        for (const i of res.existing || []) existing.add(files[i].path);
      } catch { /* older server without /check — upload everything */ }
    }
    if (folderPlan !== plan) return; // replaced meanwhile
    plan.existing = existing;
    renderFolderReview();
    updateUploadButton();
  }

  function remainingFiles(group) {
    return group.files.filter(f => !folderPlan.existing.has(f.path));
  }

  function renderFolderReview() {
    const { groups = [], skipped = [], existing } = folderPlan;
    folderReview.hidden = false;
    const all = groups.flatMap(g => g.files);
    const toSend = groups.flatMap(remainingFiles);
    const bytes = toSend.reduce((n, f) => n + (f.file?.size || 0), 0);
    const media = all.filter(f => f.kind === 'audio' || f.kind === 'video').length;
    const already = all.filter(f => existing.has(f.path)).length;

    const summary = [
      `<strong>${all.length.toLocaleString()} file${all.length === 1 ? '' : 's'}</strong> in ${groups.length} folder${groups.length === 1 ? '' : 's'}`,
      `${media.toLocaleString()} media, ${(all.length - media).toLocaleString()} covers/subtitles`,
      already ? `${already.toLocaleString()} already in your library (skipped)` : '',
      `${formatBytes(bytes)} to upload`,
    ].filter(Boolean).join(' · ');

    folderReview.innerHTML = `
      <p class="folder-summary">${summary}</p>
      ${groups.map((g, idx) => {
        const left = remainingFiles(g);
        return `<div class="folder-group" data-group="${idx}">
          <span>${icon(g.type === 'music' ? 'music' : g.type === 'movie' ? 'film' : 'video', { size: 18 })}</span>
          <div class="row-main">
            <div class="row-title">${escapeHtml(g.label)}</div>
            <div class="row-meta">${g.media} media${g.sidecars ? ` + ${g.sidecars} cover/subtitle` : ''} · ${formatBytes(g.bytes)}${left.length < g.files.length ? ` · ${g.files.length - left.length} already uploaded` : ''}</div>
          </div>
          <label class="sr-only" for="group-type-${idx}">Library for ${escapeAttr(g.label)}</label>
          <select class="form-select" id="group-type-${idx}" data-group-type="${idx}">
            ${Object.entries(TYPE_LABELS).map(([value, label]) => `<option value="${value}"${g.type === value ? ' selected' : ''}>${label}</option>`).join('')}
          </select>
          <button class="btn btn-ghost btn-sm" data-group-remove="${idx}" aria-label="Don’t upload ${escapeAttr(g.label)}">${icon('x', { size: 14 })}</button>
        </div>`;
      }).join('') || '<p class="folder-summary">No media files found in what you picked.</p>'}
      ${skipped.length ? `<details class="folder-skipped"><summary>${skipped.length.toLocaleString()} file${skipped.length === 1 ? '' : 's'} Vault can’t use will be left out</summary>
        <div>${skipped.slice(0, 50).map(s => escapeHtml(s.path)).join('<br>')}${skipped.length > 50 ? `<br>…and ${skipped.length - 50} more` : ''}</div></details>` : ''}
    `;
    folderReview.querySelectorAll('[data-group-type]').forEach(sel => sel.addEventListener('change', () => {
      const g = folderPlan.groups[Number(sel.dataset.groupType)];
      g.type = sel.value;
      g.userType = sel.value;
      folderPlan.existing = new Set();
      renderFolderReview();
      checkExisting();
    }));
    folderReview.querySelectorAll('[data-group-remove]').forEach(btn => btn.addEventListener('click', () => {
      const g = folderPlan.groups[Number(btn.dataset.groupRemove)];
      folderPlan.entries = folderPlan.entries.filter(e => !g.files.some(f => f.file === e.file));
      replan();
      updateUploadButton();
    }));
  }

  function renderFileList() {
    fileList.innerHTML = selectedFiles.map((file, idx) => `
      <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(var(--glass-tint),0.09); padding:8px 12px; border-radius:8px; margin-bottom:8px;">
        <div style="flex:1; min-width:0;">
          <div style="font-weight:500; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(file.name)}</div>
          <div style="font-size:11px; color:var(--text-secondary);">${(file.size / 1024 / 1024).toFixed(2)} MB</div>
        </div>
        <button class="btn btn-ghost btn-sm" data-idx="${idx}" aria-label="Remove ${escapeAttr(file.name)}">${icon('x', { size: 14 })}</button>
      </div>
    `).join('');

    fileList.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        selectedFiles.splice(idx, 1);
        renderFileList();
        updateUploadButton();
      });
    });
  }

  function updateUploadButton() {
    if (queue?.running) return;
    if (folderPlan) {
      const n = (folderPlan.groups || []).flatMap(remainingFiles).length;
      uploadBtn.disabled = n === 0;
      uploadBtn.textContent = n ? `Upload ${n.toLocaleString()} file${n === 1 ? '' : 's'}` : 'Nothing new to upload';
    } else {
      uploadBtn.disabled = selectedFiles.length === 0 || selectedType === 'auto';
      uploadBtn.textContent = 'Upload';
    }
  }

  function resetAll() {
    selectedFiles = [];
    folderPlan = null;
    fileList.innerHTML = '';
    folderReview.innerHTML = '';
    folderReview.hidden = true;
    failuresEl.innerHTML = '';
    renderMetadataForm();
    updateUploadButton();
  }

  cancelBtn.addEventListener('click', () => {
    if (queue?.running) queue.cancel();
    formContainer.style.display = 'none';
    selectedType = null;
    typeCards.forEach(c => c.classList.remove('active'));
    resetAll();
  });

  async function refreshLibrary() {
    try {
      const data = await api.getLibrary({ limit: 1000 });
      store.setLibrary(data.items || []);
    } catch {}
  }

  uploadBtn.addEventListener('click', () => {
    if (folderPlan) startFolderUpload();
    else startSingleUpload();
  });

  // --- Folder upload queue --------------------------------------------------
  function startFolderUpload() {
    const skip = new Set(folderPlan.existing);
    const batches = batchesFor(folderPlan.groups, { skip });
    if (!batches.length) return;
    const totalBytes = batches.reduce((n, b) => n + b.bytes, 0) || 1;
    const totalFiles = batches.reduce((n, b) => n + b.files.length, 0);

    const state = {
      running: true,
      paused: false,
      cancelled: false,
      controller: null,
      doneBytes: 0,
      doneFiles: 0,
      added: 0,
      failed: [], // { batch, error }
      startedAt: Date.now(),
      cancel() {
        this.cancelled = true;
        this.controller?.abort();
        this.wake?.();
      },
    };
    queue = state;

    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Uploading…';
    progressContainer.style.display = 'block';
    queueControls.style.display = 'flex';
    failuresEl.innerHTML = '';
    pauseBtn.querySelector('span').textContent = 'Pause';

    const paint = (inFlight = 0, note = '') => {
      const sent = state.doneBytes + inFlight;
      const pct = Math.min(100, Math.round((sent / totalBytes) * 100));
      progressBar.style.width = `${pct}%`;
      const secs = Math.max(1, (Date.now() - state.startedAt) / 1000);
      const speed = sent / secs;
      progressText.textContent = note || `${pct}% · ${state.doneFiles.toLocaleString()} of ${totalFiles.toLocaleString()} files · ${formatBytes(sent)} of ${formatBytes(totalBytes)} · ${formatBytes(speed)}/s`;
    };

    const sleep = (ms) => new Promise(resolve => {
      const t = setTimeout(resolve, ms);
      state.wake = () => { clearTimeout(t); resolve(); };
    });

    const run = async (list) => {
      for (const batch of list) {
        while (state.paused && !state.cancelled) {
          paint(0, `Paused · ${state.doneFiles.toLocaleString()} of ${totalFiles.toLocaleString()} files uploaded`);
          // eslint-disable-next-line no-await-in-loop
          await sleep(60 * 60 * 1000);
        }
        if (state.cancelled) return;
        let attempts = 0;
        for (;;) {
          state.controller = new AbortController();
          try {
            // eslint-disable-next-line no-await-in-loop
            const res = await api.uploadBatch(batch.type, batch.files, {
              signal: state.controller.signal,
              onProgress: (loaded, total) => paint(Math.min(batch.bytes, (loaded / (total || 1)) * batch.bytes)),
            });
            state.added += (res.items || []).length;
            break;
          } catch (err) {
            if (state.cancelled || err.code === 'ABORTED') return;
            if (err.status === 429 && attempts < 20) {
              // The server's upload limit — wait it out instead of failing.
              attempts++;
              const wait = Math.min(err.retryAfter || 60, 15 * 60);
              const until = Date.now() + wait * 1000;
              const say = () => paint(0, `Waiting for the server’s upload limit · continuing in ${Math.max(0, Math.ceil((until - Date.now()) / 1000))} s`);
              say();
              const tick = setInterval(say, 1000);
              // eslint-disable-next-line no-await-in-loop
              await sleep(wait * 1000);
              clearInterval(tick);
              if (state.cancelled) return;
              continue;
            }
            if ((err.code === 'NETWORK' || err.status >= 500) && attempts < 2) {
              attempts++;
              // eslint-disable-next-line no-await-in-loop
              await sleep(3000 * attempts);
              continue;
            }
            state.failed.push({ batch, error: err });
            break;
          }
        }
        state.doneBytes += batch.bytes;
        state.doneFiles += batch.files.length;
        paint();
      }
    };

    (async () => {
      paint();
      await run(batches);
      state.running = false;
      queueControls.style.display = 'none';
      await refreshLibrary();
      if (state.cancelled) {
        toast.info(`Upload cancelled · ${state.added.toLocaleString()} item${state.added === 1 ? '' : 's'} added`);
        progressContainer.style.display = 'none';
        queue = null;
        if (folderPlan) { folderPlan.existing = new Set(); checkExisting(); }
        updateUploadButton();
        return;
      }
      const failedFiles = state.failed.reduce((n, f) => n + f.batch.files.length, 0);
      if (failedFiles) {
        paint(0, `${state.added.toLocaleString()} item${state.added === 1 ? '' : 's'} added · ${failedFiles.toLocaleString()} file${failedFiles === 1 ? '' : 's'} failed`);
        failuresEl.innerHTML = `${state.failed.slice(0, 5).map(f => `<div class="queue-failure">${escapeHtml(f.batch.files[0].path)}${f.batch.files.length > 1 ? ` and ${f.batch.files.length - 1} more` : ''}: ${escapeHtml(f.error.message || 'failed')}</div>`).join('')}
          <button type="button" class="btn btn-secondary btn-sm" id="queue-retry" style="margin-top:8px">${icon('refresh', { size: 14 })}<span>Retry failed files</span></button>`;
        failuresEl.querySelector('#queue-retry').addEventListener('click', () => {
          // Re-check what's there now and upload the rest.
          queue = null;
          folderPlan.existing = new Set();
          checkExisting().then(() => startFolderUpload());
        });
        toast.error(`${failedFiles.toLocaleString()} file${failedFiles === 1 ? '' : 's'} didn’t upload`);
        queue = null;
        updateUploadButton();
        return;
      }
      toast.success(`Uploaded ${totalFiles.toLocaleString()} file${totalFiles === 1 ? '' : 's'} · ${state.added.toLocaleString()} added to your library`);
      progressContainer.style.display = 'none';
      queue = null;
      resetAll();
    })();
  }

  pauseBtn.addEventListener('click', () => {
    if (!queue?.running) return;
    queue.paused = !queue.paused;
    pauseBtn.querySelector('span').textContent = queue.paused ? 'Resume' : 'Pause';
    // Pausing lets the current batch finish (no half-written files);
    // resuming wakes the waiting loop.
    if (!queue.paused) queue.wake?.();
  });
  queueCancelBtn.addEventListener('click', () => queue?.cancel());

  // --- Single upload (original flow) ------------------------------------------
  async function startSingleUpload() {
    if (!selectedType || selectedType === 'auto' || selectedFiles.length === 0) return;

    const metadata = {};
    const titleEl = metadataForm.querySelector('#meta-title');
    if (titleEl) metadata.title = titleEl.value.trim();
    const yearEl = metadataForm.querySelector('#meta-year');
    if (yearEl) metadata.year = yearEl.value.trim();
    const genreEl = metadataForm.querySelector('#meta-genre');
    if (genreEl) metadata.genre = genreEl.value.trim();
    const descEl = metadataForm.querySelector('#meta-desc');
    if (descEl) metadata.description = descEl.value.trim();
    const artistEl = metadataForm.querySelector('#meta-artist');
    if (artistEl) metadata.artist = artistEl.value.trim();
    const albumEl = metadataForm.querySelector('#meta-album');
    if (albumEl) metadata.album = albumEl.value.trim();
    const seasonEl = metadataForm.querySelector('#meta-season');
    if (seasonEl) metadata.season = seasonEl.value.trim();
    const episodeEl = metadataForm.querySelector('#meta-episode');
    if (episodeEl) metadata.episode = episodeEl.value.trim();
    const tagsEl = metadataForm.querySelector('#meta-tags');
    if (tagsEl) metadata.tags = tagsEl.value.split(',').map(t => t.trim()).filter(Boolean);

    const coverInput = metadataForm.querySelector('#meta-cover');
    if (coverInput && coverInput.files[0]) {
      metadata.cover = coverInput.files[0];
    }

    const subtitleInput = metadataForm.querySelector('#meta-subtitle');
    if (subtitleInput && subtitleInput.files.length > 0) {
      metadata.subtitle = Array.from(subtitleInput.files);
    }

    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Uploading...';
    progressContainer.style.display = 'block';
    queueControls.style.display = 'none';

    const uploadingCover = Boolean(metadata.cover);
    try {
      const result = await api.upload(selectedType, selectedFiles, metadata, (progress) => {
        progressBar.style.width = `${progress}%`;
        progressText.textContent = `${progress}%`;
      });

      toast.success(result.message || `Uploaded ${selectedFiles.length} file(s)`);
      await refreshLibrary();

      // Reset
      selectedFiles = [];
      fileList.innerHTML = '';
      progressContainer.style.display = 'none';
      uploadBtn.textContent = 'Upload';
      uploadBtn.disabled = true;

    } catch (err) {
      const missingEndpoint = err?.status === 404
        || /^not found$/i.test(err?.message || '')
        || /^request failed:\s*404$/i.test(err?.message || '');
      if (missingEndpoint && !['UPLOAD_UNAVAILABLE', 'COVER_UPLOAD_UNAVAILABLE'].includes(err?.code)) {
        const endpoint = `${api.baseUrl || ''}/api/upload/${selectedType}`;
        toast.error(`${uploadingCover ? 'Media and cover upload' : 'Media upload'} endpoint was not found (${endpoint}). Check that the Server URL points to your Vault backend; if it does, update and restart the server, then try again.`);
      } else {
        toast.error(err.message || 'Upload failed');
      }
      progressContainer.style.display = 'none';
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Upload';
    }
  }
}
