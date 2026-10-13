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
  const max = Math.max(...days.map(d => d.seconds || 0), 1);
  return `<div class="bar-chart" role="img" aria-label="Daily activity for the last ${days.length} days">
    ${days.map(day => {
      const value = day.seconds || 0;
      const height = Math.max(2, Math.round((value / max) * 100));
      return `<span style="height:${height}%" title="${escapeHtml(day.date)}: ${Math.round(value / 60)} min"></span>`;
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
  // Guards against an older (slower) response overwriting a newer period.
  let requestId = 0;

  async function load(period) {
    const id = ++requestId;
    body.innerHTML = `<div class="skeleton skeleton-block"></div>`;
    let data;
    try {
      data = await api.getRecap(period);
    } catch (err) {
      if (id !== requestId) return;
      body.innerHTML = `<div class="empty-state"><div class="empty-state-title">Stats unavailable</div>
        <div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
      return;
    }
    if (id !== requestId) return;

    const library = data.library || {};
    const watching = data.watching || {};
    const listening = data.listening || {};
    const byType = library.byType || {};
    const watchedHours = ((watching.seconds || 0) / 3600).toFixed(1);

    body.innerHTML = `
      <div class="wrapped-hero">
        <div class="stat-label">${escapeHtml(PERIODS.find(p => p[0] === period)?.[1] || '')}</div>
        <div class="stat-value">${watchedHours} hour${watchedHours === '1.0' ? '' : 's'} watched</div>
        <div class="row-meta">${watching.sessions || 0} sessions · ${watching.items || 0} titles touched · ${listening.tracks || 0} tracks played</div>
      </div>

      <div class="stat-grid" style="margin-bottom:24px">
        ${statCard('Titles', library.items ?? 0, `${byType.movie ?? 0} movies · ${byType.video ?? 0} videos`)}
        ${statCard('Hours watched', watchedHours, watching.items ? `${watching.items} titles` : '')}
        ${statCard('Tracks played', listening.tracks ?? 0, listening.seconds ? formatTime(listening.seconds) : '')}
        ${statCard('Library size', formatBytes(library.storage || 0), `${library.artists ?? 0} artists`)}
      </div>

      <section class="section">
        <h2 class="section-title">Last 90 days</h2>
        ${bars(watching.daily)}
      </section>

      <div class="two-col">
        <section class="section">
          <h2 class="section-title">Most watched</h2>
          ${topList(watching.mostWatched)}
        </section>
        <section class="section">
          <h2 class="section-title">Top artists</h2>
          ${topList(listening.topArtists, 'name')}
        </section>
      </div>

      <section class="section">
        <h2 class="section-title">Genres</h2>
        ${topList((library.topGenres || []).map(g => ({ title: g.key, count: g.value })))}
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
