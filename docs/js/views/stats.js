/**
 * Stats / "Wrapped" page — Spotify-Wrapped style recap backed by
 * /api/extras/stats/recap (server aggregates library + history + listens).
 */
import { api } from '../api.js';
import { icon } from '../utils/icons.js';
import { escapeHtml, formatTime, formatBytes } from '../utils/format.js';

const PERIODS = [
  ['week', 'This week'],
  ['month', 'This month'],
  ['year', 'This year'],
  ['all', 'All time'],
];

function statCard(label, value, hint = '') {
  return `<div class="stat-card">
    <div class="stat-label">${escapeHtml(label)}</div>
    <div class="stat-value">${escapeHtml(String(value))}</div>
    ${hint ? `<div class="row-meta">${escapeHtml(hint)}</div>` : ''}
  </div>`;
}

function bars(days) {
  if (!days?.length) return '';
  const max = Math.max(...days.map(d => d.seconds || d.count || 0), 1);
  return `<div class="bar-chart" role="img" aria-label="Daily activity for the last ${days.length} days">
    ${days.map(day => {
      const value = day.seconds || day.count || 0;
      const height = Math.max(2, Math.round((value / max) * 100));
      return `<span style="height:${height}%" title="${escapeHtml(day.date)}: ${day.count || Math.round(value / 60)}"></span>`;
    }).join('')}
  </div>`;
}

function topList(entries, labelKey = 'title') {
  if (!entries?.length) return '<div class="row-meta">Nothing yet</div>';
  return `<ol class="top-list">${entries.slice(0, 10).map(entry => `
    <li>
      <span class="top-title">${escapeHtml(entry[labelKey] || entry.name || '—')}</span>
      <span class="top-value">${entry.count ? `${entry.count}×` : formatTime(entry.seconds || 0)}</span>
    </li>`).join('')}</ol>`;
}

export async function renderStats(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${icon('bar-chart', { size: 26 })}<span>Your stats</span></h1>
      <p class="page-subtitle">What you watched and listened to — per profile</p>
      <div class="settings-tabs" id="period-tabs" role="tablist" style="margin-top:12px">
        ${PERIODS.map(([key, label], index) => `<button type="button" class="settings-tab${index === 0 ? ' active' : ''}" role="tab" data-period="${key}">${label}</button>`).join('')}
      </div>
    </div>
    <div id="stats-body"></div>
  `;

  const body = container.querySelector('#stats-body');

  async function load(period) {
    body.innerHTML = `<div class="skeleton skeleton-block"></div>`;
    let data;
    try {
      data = await api.getRecap(period);
    } catch (err) {
      body.innerHTML = `<div class="empty-state"><div class="empty-state-title">Stats unavailable</div>
        <div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
      return;
    }

    const library = data.library || {};
    const watching = data.watching || {};
    const audio = data.audio || data.listening || {};
    const totalSeconds = watching.sessionSeconds || watching.seconds || 0;
    const days = Math.round(totalSeconds / 86400 * 10) / 10;

    body.innerHTML = `
      <div class="wrapped-hero">
        <div class="stat-label">${escapeHtml(PERIODS.find(p => p[0] === period)?.[1] || '')}</div>
        <div class="stat-value">${days} day${days === 1 ? '' : 's'} watched</div>
        <div class="row-meta">${watching.sessions || 0} sessions · ${watching.items || 0} titles touched</div>
      </div>

      <div class="stat-grid" style="margin-bottom:24px">
        ${statCard('Titles', library.total ?? 0, `${library.movies ?? 0} movies · ${library.episodes ?? 0} episodes`)}
        ${statCard('Hours watched', (totalSeconds / 3600).toFixed(1))}
        ${statCard('Tracks played', audio.plays ?? 0, audio.seconds ? formatTime(audio.seconds) : '')}
        ${statCard('Library size', formatBytes(library.bytes || 0), `${library.artists ?? 0} artists`)}
      </div>

      <section class="section">
        <h2 class="section-title">Last 90 days</h2>
        ${bars(watching.daily || watching.buckets)}
      </section>

      <div class="two-col">
        <section class="section">
          <h2 class="section-title">Most watched</h2>
          ${topList(watching.mostWatched)}
        </section>
        <section class="section">
          <h2 class="section-title">Top artists</h2>
          ${topList(audio.topArtists || audio.artists, 'name')}
        </section>
      </div>

      <section class="section">
        <h2 class="section-title">Genres</h2>
        ${topList((library.genres || []).map(g => ({ title: g.name || g.genre, count: g.count, seconds: g.seconds })))}
      </section>
    `;
  }

  container.querySelectorAll('#period-tabs .settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      container.querySelectorAll('#period-tabs .settings-tab').forEach(t => t.classList.toggle('active', t === tab));
      load(tab.dataset.period);
    });
  });

  await load('week');
}

export default { renderStats };
