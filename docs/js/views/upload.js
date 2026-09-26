/**
 * Upload view
 */
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { store } from '../store.js';

export function renderUpload(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Upload Media</h1>
      <p class="page-subtitle">Add movies, music, or videos to your vault</p>
    </div>
    
    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:16px; margin-bottom:32px;">
      <button class="upload-type-card" data-type="movie">
        <div style="font-size:32px;">🎬</div>
        <div style="font-weight:700; margin-top:8px;">Movie / Series</div>
        <div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">MP4, MKV, AVI, etc.</div>
      </button>
      <button class="upload-type-card" data-type="music">
        <div style="font-size:32px;">♫</div>
        <div style="font-weight:700; margin-top:8px;">Music</div>
        <div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">MP3, FLAC, WAV, etc.</div>
      </button>
      <button class="upload-type-card" data-type="video">
        <div style="font-size:32px;">▶</div>
        <div style="font-weight:700; margin-top:8px;">Video</div>
        <div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">General videos</div>
      </button>
    </div>
    
    <div id="upload-form-container" style="display:none;">
      <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:16px; padding:24px;">
        <h3 id="upload-type-title" style="font-size:18px; font-weight:700; margin-bottom:16px;"></h3>
        
        <div id="drop-zone" style="border:2px dashed var(--border); border-radius:12px; padding:40px; text-align:center; cursor:pointer; transition:all 0.2s;">
          <div style="font-size:24px; margin-bottom:8px;">↑</div>
          <div style="font-weight:600;">Drop files here or click to browse</div>
          <div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">Support for batch upload</div>
          <input type="file" id="file-input" multiple style="display:none;">
        </div>
        
        <div id="file-list" style="margin-top:16px;"></div>
        
        <div id="metadata-form" style="margin-top:24px;"></div>
        
        <div style="margin-top:24px; display:flex; gap:12px;">
          <button class="btn btn-secondary" id="cancel-upload">Cancel</button>
          <button class="btn btn-primary" id="start-upload" disabled>Upload</button>
        </div>
        
        <div id="upload-progress" style="display:none; margin-top:16px;">
          <div class="progress"><div class="progress-bar" id="progress-bar" style="width:0%"></div></div>
          <div id="progress-text" style="font-size:12px; color:var(--text-secondary); margin-top:8px;">0%</div>
        </div>
      </div>
    </div>
    
    <style>
      .upload-type-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 24px;
        text-align: center;
        cursor: pointer;
        transition: all 0.2s;
      }
      .upload-type-card:hover {
        border-color: var(--accent);
        background: var(--bg-hover);
        transform: translateY(-2px);
      }
      .upload-type-card.active {
        border-color: var(--accent);
        background: var(--accent-muted);
      }
      #drop-zone.dragover {
        border-color: var(--accent);
        background: var(--accent-muted);
      }
    </style>
  `;
  
  const typeCards = container.querySelectorAll('.upload-type-card');
  const formContainer = container.querySelector('#upload-form-container');
  const typeTitle = container.querySelector('#upload-type-title');
  const dropZone = container.querySelector('#drop-zone');
  const fileInput = container.querySelector('#file-input');
  const fileList = container.querySelector('#file-list');
  const metadataForm = container.querySelector('#metadata-form');
  const cancelBtn = container.querySelector('#cancel-upload');
  const uploadBtn = container.querySelector('#start-upload');
  const progressContainer = container.querySelector('#upload-progress');
  const progressBar = container.querySelector('#progress-bar');
  const progressText = container.querySelector('#progress-text');
  
  let selectedType = null;
  let selectedFiles = [];
  
  typeCards.forEach(card => {
    card.addEventListener('click', () => {
      selectedType = card.dataset.type;
      typeCards.forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      
      formContainer.style.display = 'block';
      typeTitle.textContent = `Upload ${selectedType === 'movie' ? 'Movie / Series' : selectedType === 'music' ? 'Music' : 'Video'}`;
      
      renderMetadataForm();
      formContainer.scrollIntoView({ behavior: 'smooth' });
    });
  });
  
  function renderMetadataForm() {
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
  
  dropZone.addEventListener('click', () => fileInput.click());
  
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });
  
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });
  
  fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
  });
  
  function handleFiles(files) {
    selectedFiles = Array.from(files);
    renderFileList();
    uploadBtn.disabled = selectedFiles.length === 0;
  }
  
  function renderFileList() {
    fileList.innerHTML = selectedFiles.map((file, idx) => `
      <div style="display:flex; align-items:center; justify-content:space-between; background:var(--bg-tertiary); padding:8px 12px; border-radius:8px; margin-bottom:8px;">
        <div style="flex:1; min-width:0;">
          <div style="font-weight:500; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(file.name)}</div>
          <div style="font-size:11px; color:var(--text-secondary);">${(file.size / 1024 / 1024).toFixed(2)} MB</div>
        </div>
        <button class="btn btn-ghost btn-sm" data-idx="${idx}">✕</button>
      </div>
    `).join('');
    
    fileList.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        selectedFiles.splice(idx, 1);
        renderFileList();
        uploadBtn.disabled = selectedFiles.length === 0;
      });
    });
  }
  
  cancelBtn.addEventListener('click', () => {
    formContainer.style.display = 'none';
    selectedType = null;
    selectedFiles = [];
    typeCards.forEach(c => c.classList.remove('active'));
  });
  
  uploadBtn.addEventListener('click', async () => {
    if (!selectedType || selectedFiles.length === 0) return;
    
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
    
    try {
      const result = await api.upload(selectedType, selectedFiles, metadata, (progress) => {
        progressBar.style.width = `${progress}%`;
        progressText.textContent = `${progress}%`;
      });
      
      toast.success(result.message || `Uploaded ${selectedFiles.length} file(s)`);
      
      // Refresh library
      try {
        const data = await api.getLibrary({ limit: 1000 });
        store.setLibrary(data.items || []);
      } catch {}
      
      // Reset
      selectedFiles = [];
      fileList.innerHTML = '';
      progressContainer.style.display = 'none';
      uploadBtn.textContent = 'Upload';
      uploadBtn.disabled = true;
      
    } catch (err) {
      toast.error(err.message || 'Upload failed');
      progressContainer.style.display = 'none';
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Upload';
    }
  });
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
