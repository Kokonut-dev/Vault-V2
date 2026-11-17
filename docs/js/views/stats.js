/**
 * Stats / "Wrapped" page — Spotify-Wrapped style recap backed by
 * /api/extras/stats/recap (server aggregates library + history + listens).
 */
import { api } from '../api.js';
import { icon } from '../utils/icons.js';
import { escapeHtml, formatBytes } from '../utils/format.js';

const PERIODS = [
  ['week', 'This week'],
  ['month', 'This month'],
  ['year', 'This year'],
  ['all', 'All time'],
];

function formatHumanDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s === 0) return '0 min';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return m > 0 ? `${h}h ${m}m` : `${h} hr${h === 1 ? '' : 's'}`;
  }
  if (m > 0) {
    return sec > 0 && m < 5 ? `${m}m ${sec < 10 ? '0' : ''}${sec}s` : `${m} min${m === 1 ? '' : 's'}`;
  }
  return `${sec}s`;
}

function formatStatTime(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s === 0) return '0m';
  if (s >= 3600) {
    const h = (s / 3600).toFixed(1);
    return `${h}h`;
  }
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m > 0) return sec > 0 && m < 5 ? `${m}m ${sec < 10 ? '0' : ''}${sec}s` : `${m}m`;
  return `${sec}s`;
}

function libraryTypeSummary(byType = {}, library = {}) {
  const parts = [];
  if (byType.movie) parts.push(`${byType.movie} movie${byType.movie === 1 ? '' : 's'}`);
  if (byType.video) parts.push(`${byType.video} video${byType.video === 1 ? '' : 's'}`);
  if (byType.music) parts.push(`${byType.music} track${byType.music === 1 ? '' : 's'}`);
  if (byType.audiobook) parts.push(`${byType.audiobook} audiobook${byType.audiobook === 1 ? '' : 's'}`);
  if (byType.podcast) parts.push(`${byType.podcast} podcast${byType.podcast === 1 ? '' : 's'}`);
  if (byType.comic) parts.push(`${byType.comic} comic${byType.comic === 1 ? '' : 's'}`);
  if (!parts.length) return `${library.items || 0} items`;
  if (parts.length === 1 && byType.music && library.artists) {
    return `${parts[0]} · ${library.artists} artist${library.artists === 1 ? '' : 's'}`;
  }
  return parts.slice(0, 2).join(' · ');
}

function statCard(label, value, hint = '', iconName = '') {
  return `<div class="stat-card">
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <div class="stat-label">${escapeHtml(label)}</div>
      ${iconName ? `<span style="color:var(--text-tertiary)">${icon(iconName, { size: 16 })}</span>` : ''}
    </div>
    <div class="stat-value">${escapeHtml(String(value))}</div>
    <div class="row-meta">${escapeHtml(hint || '—')}</div>
  </div>`;
}

function bars(days, period = 'week') {
  if (!days?.length) {
    return `<div class="empty-list-card">${icon('bar-chart', { size: 18 })}<span>No activity recorded yet for this period</span></div>`;
  }
  const max = Math.max(...days.map(d => d.seconds || 0), 1);
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return `<div class="bar-chart" role="img" aria-label="Activity chart for ${escapeHtml(period)}">
    ${days.map((day, idx) => {
      const value = day.seconds || 0;
      const height = value > 0 ? Math.max(8, Math.round((value / max) * 100)) : 0;
      const isToday = day.date === todayKey;
      let label = '';
      if (days.length <= 7) {
        const d = new Date(day.date + 'T12:00:00Z');
        label = dayNames[d.getUTCDay()] || day.date.slice(5);
      } else if (days.length <= 31) {
        const dayNum = parseInt(day.date.slice(8), 10);
        if (dayNum === 1 || dayNum % 5 === 0 || idx === days.length - 1) {
          label = day.date.slice(5);
        }
      } else {
        if (day.date.endsWith('-01') || idx === 0 || idx === days.length - 1) {
          label = day.date.slice(5, 7) + '/' + day.date.slice(8);
        }
      }

      const formattedVal = value > 0 ? formatHumanDuration(value) : 'No activity';
      const tooltipText = `${day.date}: ${formattedVal}`;

      return `
        <div class="bar-col${isToday ? ' is-today' : ''}">
          <div class="bar-tooltip">${escapeHtml(tooltipText)}</div>
          <div class="bar-track">
            ${height > 0 ? `<div class="bar-fill" style="height:${height}%"></div>` : ''}
          </div>
          ${label ? `<div class="bar-label">${escapeHtml(label)}</div>` : '<div class="bar-label">&nbsp;</div>'}
        </div>
      `;
    }).join('')}
  </div>`;
}

function topList(entries, labelKey = 'title', valueKey = 'seconds', subKey = null, emptyMessage = 'No activity yet') {
  if (!entries?.length) {
    return `<div class="empty-list-card">${icon('info', { size: 16 })}<span>${escapeHtml(emptyMessage)}</span></div>`;
  }
  const topSlice = entries.slice(0, 10);
  const maxVal = Math.max(...topSlice.map(e => e[valueKey] || e.count || e.value || 0), 1);

  return `<ol class="top-list">${topSlice.map((entry, index) => {
    const rawVal = entry[valueKey] ?? entry.count ?? entry.value ?? 0;
    const pct = Math.max(4, Math.round((rawVal / maxVal) * 100));
    const title = entry[labelKey] || entry.name || entry.title || '—';
    const sub = subKey ? entry[subKey] : (entry.artist || entry.album || '');
    const valDisplay = entry.count ? `${entry.count}×` : (entry.seconds ? formatHumanDuration(entry.seconds) : (entry.value ? `${entry.value}` : '—'));

    return `
      <li class="top-item">
        <div class="top-item-bar" style="width:${pct}%"></div>
        <span class="top-rank${index < 3 ? ' top-3' : ''}">${index + 1}</span>
        <div class="top-main">
          <span class="top-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
          ${sub ? `<span class="top-subtitle" title="${escapeHtml(sub)}">${escapeHtml(sub)}</span>` : ''}
        </div>
        <span class="top-value">${escapeHtml(valDisplay)}</span>
      </li>
    `;
  }).join('')}</ol>`;
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
  let requestId = 0;

  async function load(period) {
    const id = ++requestId;
    body.innerHTML = `<div class="skeleton skeleton-block" style="height:200px;margin-bottom:24px;border-radius:var(--radius-xl)"></div>`;
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
    const summary = data.summary || {};
    const byType = library.byType || {};
    const periodDays = watching.daily || [];

    const totalSeconds = (watching.seconds || 0) + (listening.seconds || 0);
    let heroHeadline = '';
    if (totalSeconds === 0) {
      heroHeadline = 'No activity yet';
    } else if (watching.seconds > 0 && listening.seconds > 0) {
      heroHeadline = `${formatHumanDuration(totalSeconds)} played`;
    } else if (listening.seconds > 0) {
      heroHeadline = `${formatHumanDuration(listening.seconds)} listened`;
    } else {
      heroHeadline = `${formatHumanDuration(watching.seconds)} watched`;
    }

    const facts = [];
    if (watching.sessions) facts.push(`${watching.sessions} session${watching.sessions === 1 ? '' : 's'}`);
    if (watching.items) facts.push(`${watching.items} video${watching.items === 1 ? '' : 's'} watched`);
    if (listening.tracks) facts.push(`${listening.tracks} track${listening.tracks === 1 ? '' : 's'} played`);
    if (library.artists && listening.tracks) facts.push(`${library.artists} artist${library.artists === 1 ? '' : 's'}`);
    if (!facts.length) facts.push('Start watching or listening to build your recap');

    const chips = [];
    if (listening.topArtists?.[0]) {
      chips.push(`<span class="hero-chip">${icon('user', { size: 13 })}<span>Top artist: <strong>${escapeHtml(listening.topArtists[0].name)}</strong></span></span>`);
    }
    if (listening.topTracks?.[0]) {
      chips.push(`<span class="hero-chip">${icon('music', { size: 13 })}<span>Top track: <strong>${escapeHtml(listening.topTracks[0].title)}</strong></span></span>`);
    } else if (watching.mostWatched?.[0]) {
      chips.push(`<span class="hero-chip">${icon('film', { size: 13 })}<span>Top video: <strong>${escapeHtml(watching.mostWatched[0].title)}</strong></span></span>`);
    }
    const activeDays = summary.activeDays || periodDays.filter(d => (d.seconds || 0) > 0).length;
    if (activeDays > 0) {
      chips.push(`<span class="hero-chip">${icon('calendar', { size: 13 })}<span>${activeDays} active day${activeDays === 1 ? '' : 's'}</span></span>`);
    }

    const periodLabel = PERIODS.find(p => p[0] === period)?.[1] || 'This period';

    const watchSub = watching.items
      ? `${watching.items} title${watching.items === 1 ? '' : 's'}${watching.completed ? ` · ${watching.completed} done` : ''}`
      : `${watching.sessions || 0} sessions · 0 titles`;

    const listenSub = listening.tracks
      ? `${listening.tracks} track${listening.tracks === 1 ? '' : 's'}${listening.topArtists?.[0] ? ` · ${listening.topArtists[0].name}` : ''}`
      : '0 tracks played';

    const storageSub = library.hours?.human && library.hours.human !== '0m'
      ? `${library.hours.human} total media`
      : `${library.items || 0} total files`;

    const chartTitles = {
      week: 'Daily activity this week',
      month: 'Daily activity this month',
      year: 'Activity this year',
      all: 'Activity history (Last 90 days)',
    };
    const chartTitle = chartTitles[period] || 'Activity';

    const hasMusic = (listening.tracks > 0) || (listening.topArtists?.length > 0) || (byType.music > 0);
    const hasVideo = (watching.items > 0) || (watching.mostWatched?.length > 0) || (byType.movie > 0) || (byType.video > 0);

    body.innerHTML = `
      <div class="wrapped-hero">
        <div class="stat-label">${escapeHtml(periodLabel)}</div>
        <div class="stat-value">${escapeHtml(heroHeadline)}</div>
        <div class="row-meta">${escapeHtml(facts.join(' · '))}</div>
        ${chips.length ? `<div class="hero-chips">${chips.join('')}</div>` : ''}
      </div>

      <div class="stat-grid" style="margin-bottom:24px">
        ${statCard('Library', library.items ?? 0, libraryTypeSummary(byType, library), 'film')}
        ${statCard('Watch time', formatStatTime(watching.seconds), watchSub, 'video')}
        ${statCard('Listen time', formatStatTime(listening.seconds), listenSub, 'music')}
        ${statCard('Storage', formatBytes(library.storage || 0), storageSub, 'hard-drive')}
      </div>

      <section class="chart-card">
        <div class="chart-header">
          <div class="chart-title">${escapeHtml(chartTitle)}</div>
          <div class="chart-meta">${activeDays} active day${activeDays === 1 ? '' : 's'} · ${formatHumanDuration(totalSeconds)} total</div>
        </div>
        ${bars(periodDays, period)}
      </section>

      <div class="two-col">
        <section class="section">
          <h2 class="section-title" style="display:flex;align-items:center;gap:8px">${icon('user', { size: 18 })}<span>Top artists</span></h2>
          ${topList(listening.topArtists, 'name', 'seconds', null, `No artists played ${periodLabel.toLowerCase()}`)}
        </section>
        <section class="section">
          <h2 class="section-title" style="display:flex;align-items:center;gap:8px">${icon('music', { size: 18 })}<span>Top tracks</span></h2>
          ${topList(listening.topTracks, 'title', 'seconds', 'artist', `No tracks played ${periodLabel.toLowerCase()}`)}
        </section>
      </div>

      ${(watching.mostWatched?.length > 0 || hasVideo) ? `
        <section class="section" style="margin-bottom:var(--space-xl)">
          <h2 class="section-title" style="display:flex;align-items:center;gap:8px">${icon('film', { size: 18 })}<span>Most watched</span></h2>
          ${topList(watching.mostWatched, 'title', 'seconds', 'type', `No video watched ${periodLabel.toLowerCase()}`)}
        </section>
      ` : ''}

      ${(library.topGenres?.length > 0) ? `
        <section class="section">
          <h2 class="section-title" style="display:flex;align-items:center;gap:8px">${icon('folder', { size: 18 })}<span>Top genres</span></h2>
          <div class="genre-chips-wrap">
            ${library.topGenres.map(g => `
              <span class="genre-tag-chip">
                <span>${escapeHtml(g.key)}</span>
                <span class="badge">${g.value}</span>
              </span>
            `).join('')}
          </div>
        </section>
      ` : (listening.topAlbums?.length > 0 ? `
        <section class="section">
          <h2 class="section-title" style="display:flex;align-items:center;gap:8px">${icon('folder', { size: 18 })}<span>Top albums</span></h2>
          ${topList(listening.topAlbums, 'name', 'seconds', null, `No albums played ${periodLabel.toLowerCase()}`)}
        </section>
      ` : '')}
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
