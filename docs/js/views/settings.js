/**
 * Settings (SETTINGS_REVAMP_PLAN.md SR-1 … SR-4).
 *
 * A shell with a sticky section rail (a chip bar on narrow screens), one
 * section visible at a time, `#hash` deep links (/settings#live-tv) and a
 * search box that filters every setting by label, help text and keywords.
 * Each section lives in views/settings/*.js.
 */
import { api } from '../api.js';
import { router } from '../router.js';
import { THEME_META } from '../themes.js';
import { icon } from '../utils/icons.js';
import { escapeHtml } from '../utils/format.js';
import { onUnmount } from '../utils/lifecycle.js';
import { section, el } from './settings/ui.js';
import { appearanceSection, playbackSection, subtitlesSection } from './settings/device.js';
import { liveTvSection, linksSection, notificationsSection, connectionSection } from './settings/server.js';
import { securitySection, devicesSection } from './settings/account.js';

const GROUPS = [
  {
    id: 'device',
    label: 'This device',
    items: [
      { id: 'appearance', label: 'Appearance', icon: 'palette', build: appearanceSection },
      { id: 'playback', label: 'Playback', icon: 'play', build: playbackSection },
      { id: 'subtitles', label: 'Subtitles', icon: 'captions', build: subtitlesSection },
    ],
  },
  {
    id: 'server',
    label: 'Server',
    items: [
      { id: 'live-tv', label: 'Live TV', icon: 'tv', build: liveTvSection },
      { id: 'links', label: 'Links & imports', icon: 'link', build: linksSection },
      { id: 'notifications', label: 'Notifications', icon: 'message', build: notificationsSection },
      { id: 'connection', label: 'Connection', icon: 'database', build: connectionSection },
    ],
  },
  {
    id: 'account',
    label: 'Account',
    items: [
      { id: 'security', label: 'Sign-in & security', icon: 'shield', build: securitySection },
      { id: 'devices', label: 'Devices', icon: 'monitor', build: devicesSection },
    ],
  },
  {
    id: 'info',
    label: '',
    items: [{ id: 'about', label: 'About Vault', icon: 'info', build: aboutSection }],
  },
];

const ALL = GROUPS.flatMap(g => g.items);
const ALIASES = {
  livetv: 'live-tv', 'live-tv': 'live-tv', iptv: 'live-tv', m3u: 'live-tv', epg: 'live-tv',
  theme: 'appearance', motion: 'appearance', server: 'connection', remote: 'connection',
  'two-factor': 'security', totp: 'security', pairing: 'devices', sessions: 'devices',
  import: 'links', imports: 'links',
};
const resolveId = (frag) => {
  const key = String(frag || '').toLowerCase().replace(/^panel-/, '');
  if (ALL.some(i => i.id === key)) return key;
  return ALIASES[key] || null;
};

export function renderSettings(container) {
  container.className = 'page settings-page';
  container.innerHTML = `
    <header class="page-header settings-header">
      <div>
        <h1 class="page-title">Settings</h1>
        <p class="page-subtitle">Your home for how Vault looks, plays and connects.</p>
      </div>
    </header>
    <div class="settings-layout">
      <div class="settings-side">
      <div class="settings-search" role="search">
          <label class="sr-only" for="settings-search">Search settings</label>
          <span class="settings-search-icon" aria-hidden="true">${icon('search', { size: 16 })}</span>
          <input type="search" id="settings-search" class="form-input" placeholder="Search settings" autocomplete="off" spellcheck="false" aria-describedby="settings-search-status">
          <p class="sr-only" id="settings-search-status" role="status" aria-live="polite"></p>
        </div>
      <nav class="settings-rail" aria-label="Settings sections">
        ${GROUPS.map(g => `
          <div class="rail-group">
            ${g.label ? `<p class="rail-group-label" id="rail-group-${g.id}">${g.label}</p>` : ''}
            <ul class="rail-list"${g.label ? ` aria-labelledby="rail-group-${g.id}"` : ''}>
              ${g.items.map(i => `
                <li><a class="rail-link" href="#${i.id}" data-target="${i.id}" aria-controls="panel-${i.id}">
                  <span class="rail-icon" aria-hidden="true">${icon(i.icon, { size: 17 })}</span><span class="rail-label">${i.label}</span>
                  <span class="rail-count" aria-hidden="true"></span>
                </a></li>`).join('')}
            </ul>
          </div>`).join('')}
      </nav>
      </div>
      <div class="settings-panels" id="settings-panels"></div>
    </div>
    <p class="settings-empty" id="settings-empty" hidden></p>
  `;

  const panels = container.querySelector('#settings-panels');
  const rail = container.querySelector('.settings-rail');
  const links = [...rail.querySelectorAll('.rail-link')];
  const search = container.querySelector('#settings-search');
  const searchStatus = container.querySelector('#settings-search-status');
  const empty = container.querySelector('#settings-empty');

  // Shared context for sections (Live TV state is used by two sections).
  let liveTvPromise = null;
  const liveTvRerenders = [];
  const ctx = {
    liveTv: () => (liveTvPromise ||= api.getLiveTvSettings()),
    setLiveTv(state, { rerender = false } = {}) {
      liveTvPromise = Promise.resolve(state);
      if (rerender) liveTvRerenders.forEach(fn => fn(state));
    },
    onLiveTvRerender: fn => liveTvRerenders.push(fn),
    select: (id, opts) => select(id, opts),
  };

  const nodes = new Map();
  for (const item of ALL) {
    let node;
    try {
      node = item.build(ctx);
    } catch (err) {
      console.error('[Settings] section failed', item.id, err);
      node = section({ id: item.id, title: item.label, iconName: item.icon, scope: 'info' });
      node.body.innerHTML = `<p class="settings-callout is-error">${icon('alert-circle', { size: 15 })}<span>This section couldn’t load: ${escapeHtml(err.message)}</span></p>`;
    }
    node.hidden = true;
    nodes.set(item.id, node);
    panels.append(node);
  }

  let current = null;
  async function select(id, { focus = false, test = false, updateUrl = true } = {}) {
    const target = resolveId(id) || 'appearance';
    if (search.value) clearSearch({ silent: true });
    current = target;
    for (const [key, node] of nodes) node.hidden = key !== target;
    links.forEach(a => {
      const on = a.dataset.target === target;
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    if (updateUrl) router.setFragment(target);
    const active = links.find(a => a.dataset.target === target);
    // Keep the active chip visible in the narrow-screen chip bar.
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (focus) {
      const node = nodes.get(target);
      node.focus({ preventScroll: true });
      const top = container.querySelector('.settings-layout').getBoundingClientRect().top;
      if (top < 0) container.querySelector('.settings-layout').scrollIntoView({ block: 'start' });
    }
    if (test && target === 'live-tv') {
      await ctx.liveTv().catch(() => null);
      nodes.get('live-tv').runTest?.();
    }
  }

  links.forEach((a, index) => {
    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      select(a.dataset.target, { focus: true });
    });
    // Up/Down (and Left/Right in the chip bar) move between sections.
    a.addEventListener('keydown', (e) => {
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        links[e.key === 'Home' ? 0 : links.length - 1].focus();
        return;
      }
      if (!step) return;
      e.preventDefault();
      links[(index + step + links.length) % links.length].focus();
    });
  });

  // --- search (SR-3)
  let searchTimer = null;
  function clearSearch({ silent = false } = {}) {
    search.value = '';
    container.classList.remove('is-searching');
    panels.querySelectorAll('.is-search-hidden').forEach(n => n.classList.remove('is-search-hidden'));
    links.forEach(a => { a.classList.remove('has-no-match'); a.querySelector('.rail-count').textContent = ''; });
    empty.hidden = true;
    if (!silent) {
      searchStatus.textContent = '';
      for (const [key, node] of nodes) node.hidden = key !== current;
    }
  }

  function runSearch() {
    const q = search.value.trim().toLowerCase();
    if (!q) { clearSearch(); return; }
    container.classList.add('is-searching');
    const terms = q.split(/\s+/).filter(Boolean);
    const matches = (text) => terms.every(t => text.includes(t));
    let total = 0;
    let sectionsHit = 0;
    for (const [key, node] of nodes) {
      const label = ALL.find(i => i.id === key).label.toLowerCase();
      const sectionText = `${label} ${node.querySelector('.settings-section-intro')?.textContent.toLowerCase() || ''}`;
      const sectionMatch = matches(sectionText);
      let hits = 0;
      node.querySelectorAll('.settings-group').forEach(groupNode => {
        const extra = [...groupNode.querySelectorAll('[data-keywords]:not(.setting-row)')].map(n => n.dataset.keywords).join(' ');
        const groupKeywords = `${groupNode.dataset.keywords || ''} ${extra} ${groupNode.querySelector('.settings-group-title')?.textContent || ''}`.toLowerCase();
        const groupMatch = sectionMatch || matches(groupKeywords);
        let groupHits = 0;
        const rows = groupNode.querySelectorAll('.setting-row');
        rows.forEach(r => {
          const text = `${r.dataset.keywords || ''} ${r.textContent}`.toLowerCase();
          const hit = groupMatch || matches(text);
          r.classList.toggle('is-search-hidden', !hit);
          if (hit) groupHits += 1;
        });
        if (!rows.length && groupMatch) groupHits = 1;
        groupNode.classList.toggle('is-search-hidden', groupHits === 0);
        hits += groupHits;
      });
      node.hidden = hits === 0;
      const link = links.find(a => a.dataset.target === key);
      link.classList.toggle('has-no-match', hits === 0);
      link.querySelector('.rail-count').textContent = hits ? String(hits) : '';
      total += hits;
      if (hits) sectionsHit += 1;
    }
    empty.hidden = total > 0;
    if (!total) empty.innerHTML = `No settings match “${escapeHtml(search.value.trim())}”. Try a different word, such as <em>theme</em>, <em>M3U</em> or <em>password</em>.`;
    searchStatus.textContent = total
      ? `${total} matching setting${total === 1 ? '' : 's'} in ${sectionsHit} section${sectionsHit === 1 ? '' : 's'}`
      : 'No matching settings';
  }
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 120);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.preventDefault();
      e.stopPropagation();
      clearSearch();
    }
  });

  // --- deep links: /settings#live-tv (and back/forward between fragments)
  const onFragment = () => {
    const id = resolveId(router.getFragment());
    if (id && id !== current) select(id, { focus: true, updateUrl: false });
  };
  window.addEventListener('vault:fragment-changed', onFragment);
  onUnmount(() => {
    window.removeEventListener('vault:fragment-changed', onFragment);
    clearTimeout(searchTimer);
  });

  const initial = resolveId(router.getFragment());
  select(initial || 'appearance', { updateUrl: Boolean(initial) && initial !== router.getFragment() });
  if (initial) {
    // Arriving from a deep link (e.g. the Live TV page): move focus to it.
    requestAnimationFrame(() => nodes.get(initial)?.focus({ preventScroll: true }));
  }
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------
function aboutSection() {
  const s = section({ id: 'about', title: 'About Vault', iconName: 'info', scope: 'info' });
  const themeNames = THEME_META.map(m => m.name);
  s.body.append(el(`<div class="about">
      <div class="about-brand">
        <p class="about-name">Vault <span class="about-version" id="about-version"></span></p>
        <span class="chip">Self-hosted</span>
      </div>
      <p class="about-text">A personal media server for your films, shows, music, podcasts and live TV — vanilla JavaScript in the browser, Node.js on the server, with on-the-fly transcoding.</p>
      <ul class="about-facts">
        <li>${icon('palette', { size: 16 })}<span>${themeNames.length} themes: ${themeNames.map(escapeHtml).join(', ')}</span></li>
        <li>${icon('sliders', { size: 16 })}<span>10-band equaliser, gapless playback and crossfade</span></li>
        <li>${icon('tv', { size: 16 })}<span>Live TV from M3U channel lists with XMLTV guides</span></li>
      </ul>
      <div class="settings-actions">
        <button type="button" class="btn btn-secondary btn-sm" id="about-shortcuts">${icon('keyboard', { size: 15 })}<span>Keyboard shortcuts</span></button>
        <a class="btn btn-ghost btn-sm" href="https://github.com/Kokonut-dev/Vault-V2" target="_blank" rel="noopener">${icon('external-link', { size: 15 })}<span>Source on GitHub</span><span class="sr-only"> (opens in a new tab)</span></a>
      </div>
    </div>`));
  s.querySelector('#about-shortcuts').addEventListener('click', () => window.dispatchEvent(new CustomEvent('vault:show-shortcuts')));
  api.health().then(h => {
    const v = s.querySelector('#about-version');
    if (v && h.version) v.textContent = `v${h.version}`;
  }).catch(() => {});
  return s;
}

export default { renderSettings };
