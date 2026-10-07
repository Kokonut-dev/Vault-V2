/**
 * Live TV & DVR — channel list, EPG grid, record now / schedule, recordings.
 * Server: /api/livetv (M3U + HDHomeRun discovery, XMLTV EPG, DVR to Recordings).
 */
import { api } from '../api.js';
import { icon } from '../utils/icons.js';
import { escapeHtml, formatTime } from '../utils/format.js';
import { toast } from '../components/toast.js';

export async function renderLiveTV(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${icon('tv', { size: 26 })}<span>Live TV</span></h1>
      <p class="page-subtitle">Channels from your M3U playlist or HDHomeRun tuner, with DVR</p>
      <div class="settings-tabs" role="tablist" style="margin-top:12px">
        <button class="settings-tab active" role="tab" data-tab="guide">Guide</button>
        <button class="settings-tab" role="tab" data-tab="recordings">Recordings</button>
      </div>
    </div>
    <div id="livetv-body"></div>
  `;
  const body = container.querySelector('#livetv-body');

  container.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      container.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t === tab));
      if (tab.dataset.tab === 'guide') loadGuide();
      else loadRecordings();
    });
  });

  async function loadGuide() {
    body.innerHTML = '<div class="skeleton skeleton-block"></div>';
    let channels = [];
    let epg = {};
    try {
      const data = await api.getChannels(true);
      channels = data.channels || [];
      epg = data.epg || {};
    } catch (err) {
      body.innerHTML = `<div class="empty-state">${icon('tv', { size: 30 })}
        <div class="empty-state-title">Live TV is not configured</div>
        <div class="empty-state-message">${escapeHtml(err.message)}</div>
        <div class="empty-state-message">Add an M3U URL or an HDHomeRun address in Settings → Live TV.</div></div>`;
      return;
    }

    if (!channels.length) {
      body.innerHTML = `<div class="empty-state"><div class="empty-state-title">No channels found</div>
        <div class="empty-state-message">Add an M3U playlist URL in Settings, or let Vault discover an HDHomeRun on your network.</div></div>`;
      return;
    }

    body.innerHTML = `<div class="channel-grid">${channels.map(channel => `
      <button type="button" class="media-card channel-card" data-channel="${channel.id}">
        <div class="media-card-cover">
          ${channel.logo ? `<img loading="lazy" src="${escapeHtml(channel.logo)}" alt="">` : `<div class="media-card-placeholder">${icon('tv', { size: 30 })}</div>`}
        </div>
        <div class="media-card-info">
          <div class="media-card-title">${escapeHtml(channel.name)}</div>
          <div class="media-card-meta">${channel.group ? escapeHtml(channel.group) : 'Live'}</div>
        </div>
      </button>`).join('')}</div>`;

    body.querySelectorAll('[data-channel]').forEach(card => {
      card.addEventListener('click', () => {
        const channel = channels.find(c => c.id === card.dataset.channel);
        window.dispatchEvent(new CustomEvent('vault:open-video', {
          detail: { item: { id: `live:${channel.id}`, title: channel.name, type: 'video', streamUrl: channel.url, live: true } },
        }));
      });
      card.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const channel = channels.find(c => c.id === card.dataset.channel);
        window.dispatchEvent(new CustomEvent('vault:record-channel', { detail: { channel } }));
      });
    });
  }

  async function loadRecordings() {
    body.innerHTML = '<div class="skeleton skeleton-block"></div>';
    let recordings = [];
    try {
      recordings = (await api.getRecordings()).recordings || [];
    } catch (err) {
      body.innerHTML = `<div class="empty-state"><div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
      return;
    }
    body.innerHTML = recordings.length ? recordings.map(recording => `
      <div class="download-row">
        <span class="row-icon">${icon('radio', { size: 18 })}</span>
        <div class="row-main">
          <div class="row-title">${escapeHtml(recording.title || recording.channel || 'Recording')}</div>
          <div class="row-meta">${recording.status || ''}${recording.duration ? ` · ${formatTime(recording.duration)}` : ''}${recording.startedAt ? ` · ${new Date(recording.startedAt).toLocaleString()}` : ''}</div>
          ${recording.status === 'recording' ? '<div class="row-meta">Recording this channel from your tuner</div>' : ''}
        </div>
        ${recording.status === 'recording'
          ? `<button class="btn btn-danger btn-sm" data-stop-rec="${recording.id}">Stop</button>`
          : `<button class="btn btn-secondary btn-sm" data-play-rec="${recording.id}">Play</button>`}
        <button class="btn btn-ghost btn-sm" data-del-rec="${recording.id}" aria-label="Delete recording">${icon('trash', { size: 14 })}</button>
      </div>`).join('') : '<div class="row-meta">No recordings yet — right-click a channel and start one.</div>';

    body.querySelectorAll('[data-stop-rec]').forEach(button => button.addEventListener('click', async () => {
      await api.stopRecording(button.dataset.stopRec);
      toast.success('Recording stopped');
      loadRecordings();
    }));
    body.querySelectorAll('[data-del-rec]').forEach(button => button.addEventListener('click', async () => {
      await api.deleteRecording(button.dataset.delRec);
      toast.success('Recording deleted');
      loadRecordings();
    }));
    body.querySelectorAll('[data-play-rec]').forEach(button => button.addEventListener('click', () => {
      const recording = recordings.find(r => r.id === button.dataset.playRec);
      if (recording) window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item: recording } }));
    }));
  }

  await loadGuide();
}

export default { renderLiveTV };
