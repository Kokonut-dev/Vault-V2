/**
 * Sidebar navigation
 */
import { store } from '../store.js';
import { router } from '../router.js';
import { icon, setIcon } from '../utils/icons.js';
import { brandMark } from '../utils/brand.js';

// `icon` values are keys into docs/js/utils/icons.js — never glyphs.
const NAV_ITEMS = [
  { id: 'library', section: 'Library', items: [
    { id: 'home', label: 'Home', icon: 'home', route: '/' },
    { id: 'movies', label: 'Movies & Series', icon: 'film', route: '/movies' },
    { id: 'music', label: 'Music', icon: 'music', route: '/music' },
    { id: 'artists', label: 'Artists', icon: 'mic', route: '/artists' },
    { id: 'audiobooks', label: 'Audiobooks', icon: 'headphones', route: '/audiobooks' },
    { id: 'videos', label: 'Videos', icon: 'video', route: '/videos' },
  ]},
  { id: 'tv-live', section: 'TV & Live', items: [
    { id: 'shows', label: 'TV Shows', icon: 'tv', route: '/shows' },
    { id: 'livetv', label: 'Live TV & DVR', icon: 'radio', route: '/livetv' },
    { id: 'syncplay', label: 'SyncPlay', icon: 'users', route: '/syncplay' },
  ]},
  { id: 'collection', section: 'Your Collection', items: [
    { id: 'watchlist', label: 'My List', icon: 'bookmark', route: '/watchlist' },
    { id: 'continue', label: 'Continue Watching', icon: 'activity', route: '/continue' },
    { id: 'playlists', label: 'Playlists', icon: 'list', route: '/playlists' },
    { id: 'favourites', label: 'Favourites', icon: 'heart', route: '/favourites' },
    { id: 'history', label: 'History', icon: 'history', route: '/history' },
    { id: 'downloads', label: 'Downloads', icon: 'download', route: '/downloads' },
  ]},
  { id: 'audio-reading', section: 'Audio & Reading', items: [
    { id: 'podcasts', label: 'Podcasts', icon: 'rss', route: '/podcasts' },
    { id: 'comics', label: 'Comics', icon: 'book', route: '/comics' },
    { id: 'stats', label: 'Your Stats', icon: 'bar-chart', route: '/stats' },
  ]},
  { id: 'manage', section: 'Manage', items: [
    { id: 'upload', label: 'Upload', icon: 'upload', route: '/upload' },
    { id: 'torrents', label: 'Torrents', icon: 'magnet', route: '/torrents' },
    { id: 'profiles', label: 'Profiles', icon: 'user', route: '/profiles' },
    { id: 'system', label: 'Server', icon: 'hard-drive', route: '/system' },
    { id: 'trash', label: 'Trash', icon: 'trash', route: '/trash' },
    { id: 'settings', label: 'Settings', icon: 'settings', route: '/settings' },
  ]},
];

function isActivePath(currentPath, route) {
  if (route === '/') return currentPath === '/' || currentPath === '/home';
  return currentPath === route || currentPath.startsWith(route + '/');
}

export function renderSidebar(container) {
  if (!container) return;
  container.innerHTML = '';

  const isCollapsed = store.get('sidebarCollapsed');
  const collapsedSections = store.get('sidebarSectionsCollapsed') || {};
  const currentPath = router.getCurrentPath();
  const appEl = document.getElementById('app');
  if (appEl) appEl.classList.toggle('sidebar-collapsed', !!isCollapsed);

  const sidebar = document.createElement('aside');
  sidebar.className = `sidebar glass ${isCollapsed ? 'collapsed' : ''}`;
  sidebar.id = 'sidebar';
  sidebar.setAttribute('role', 'navigation');
  sidebar.setAttribute('aria-label', 'Main navigation');

  sidebar.innerHTML = `
    <div class="sidebar-header">
      <div class="sidebar-logo" title="Vault">${brandMark({ size: 32 })}</div>
      <div class="sidebar-brand">Vault</div>
      <!-- Single collapse control lives in the footer (C-15: the header
           chevron duplicated it). -->
    </div>
    <nav class="sidebar-nav">
      ${NAV_ITEMS.map(section => {
        const sectionId = section.id || section.section.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const isSectionCollapsed = !!collapsedSections[sectionId];
        const hasActiveItem = section.items.some(item => isActivePath(currentPath, item.route));
        return `
        <div class="nav-section ${isSectionCollapsed ? 'collapsed' : ''} ${hasActiveItem ? 'has-active' : ''}" data-section="${sectionId}">
          <button class="nav-section-header"
                  type="button"
                  data-section="${sectionId}"
                  aria-expanded="${!isSectionCollapsed}"
                  aria-controls="nav-section-items-${sectionId}"
                  title="${isSectionCollapsed ? 'Expand ' + section.section : 'Collapse ' + section.section}">
            <span class="nav-section-title">${section.section}</span>
            <span class="nav-section-has-active" title="Active item inside"></span>
            <span class="nav-section-chevron">
              ${icon(isSectionCollapsed ? 'chevron-right' : 'chevron-down', { size: 14 })}
            </span>
          </button>
          <div class="nav-section-items" id="nav-section-items-${sectionId}">
            ${section.items.map(item => `
              <a class="nav-item ${isActivePath(currentPath, item.route) ? 'active' : ''}"
                 href="${router.hrefFor(item.route)}"
                 data-route="${item.route}"
                 data-id="${item.id}"
                 role="link"
                 tabindex="0"
                 title="${item.label}"
                 aria-label="${item.label}"
                 aria-current="${isActivePath(currentPath, item.route) ? 'page' : 'false'}">
                <span class="nav-icon">${icon(item.icon, { size: 18 })}</span>
                <span class="nav-label">${item.label}</span>
              </a>
            `).join('')}
          </div>
        </div>
      `;
      }).join('')}
    </nav>
    <div class="sidebar-footer">
      <button class="sidebar-toggle" id="sidebar-toggle" type="button"
              aria-label="${isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}"
              title="${isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}"
              aria-expanded="${!isCollapsed}">
        <span class="sidebar-toggle-icon">${icon(isCollapsed ? 'chevron-right' : 'chevron-left', { size: 16 })}</span>
        <span class="nav-label" style="margin-left:8px;">${isCollapsed ? 'Expand' : 'Collapse'}</span>
      </button>
      <button class="btn btn-ghost btn-sm sidebar-logout" id="logout-btn" type="button" aria-label="Logout" title="Logout" style="width:100%;">
        <span class="nav-icon">${icon('log-out', { size: 16 })}</span>
        <span class="nav-label" style="margin-left:6px;">Logout</span>
      </button>
    </div>
  `;

  container.appendChild(sidebar);

  let overlay = document.getElementById('sidebar-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    overlay.id = 'sidebar-overlay';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
      overlay.classList.remove('active');
    });
  }

  function toggleSidebarCollapse() {
    const collapsed = !store.get('sidebarCollapsed');
    store.set('sidebarCollapsed', collapsed, true);
    sidebar.classList.toggle('collapsed', collapsed);
    if (appEl) appEl.classList.toggle('sidebar-collapsed', collapsed);

    const footerLabel = sidebar.querySelector('#sidebar-toggle .nav-label');
    const footerArrow = sidebar.querySelector('#sidebar-toggle .sidebar-toggle-icon');
    if (footerArrow) setIcon(footerArrow, collapsed ? 'chevron-right' : 'chevron-left', { size: 16 });
    if (footerLabel) footerLabel.textContent = collapsed ? 'Expand' : 'Collapse';

    const headerArrow = sidebar.querySelector('#sidebar-header-toggle .sidebar-collapse-icon');
    if (headerArrow) setIcon(headerArrow, collapsed ? 'chevron-right' : 'chevron-left', { size: 16 });

    const toggleBtn = sidebar.querySelector('#sidebar-toggle');
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-expanded', String(!collapsed));
      toggleBtn.setAttribute('title', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
      toggleBtn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    }
    const headerToggleBtn = sidebar.querySelector('#sidebar-header-toggle');
    if (headerToggleBtn) {
      headerToggleBtn.setAttribute('aria-expanded', String(!collapsed));
      headerToggleBtn.setAttribute('title', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
      headerToggleBtn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    }

    window.dispatchEvent(new CustomEvent('vault:sidebar-collapsed', { detail: { collapsed } }));
  }

  sidebar.querySelector('#sidebar-toggle').addEventListener('click', toggleSidebarCollapse);
  const headerToggle = sidebar.querySelector('#sidebar-header-toggle');
  if (headerToggle) headerToggle.addEventListener('click', toggleSidebarCollapse);

  const headerEl = sidebar.querySelector('.sidebar-header');
  if (headerEl) {
    headerEl.addEventListener('click', (e) => {
      if (sidebar.classList.contains('collapsed')) {
        toggleSidebarCollapse();
      }
    });
  }

  // Category collapsible section handlers
  sidebar.querySelectorAll('.nav-section-header').forEach(headerBtn => {
    headerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sectionId = headerBtn.dataset.section;
      if (!sectionId) return;

      const navSection = headerBtn.closest('.nav-section');
      const chevron = headerBtn.querySelector('.nav-section-chevron');

      const currentCollapsed = { ...(store.get('sidebarSectionsCollapsed') || {}) };
      const nextCollapsed = !currentCollapsed[sectionId];
      currentCollapsed[sectionId] = nextCollapsed;
      store.set('sidebarSectionsCollapsed', currentCollapsed, true);

      if (navSection) {
        navSection.classList.toggle('collapsed', nextCollapsed);
      }
      headerBtn.setAttribute('aria-expanded', String(!nextCollapsed));
      const sectionTitle = headerBtn.querySelector('.nav-section-title')?.textContent || 'section';
      headerBtn.setAttribute('title', nextCollapsed ? `Expand ${sectionTitle}` : `Collapse ${sectionTitle}`);

      if (chevron) {
        setIcon(chevron, nextCollapsed ? 'chevron-right' : 'chevron-down', { size: 14 });
      }
    });
  });

  sidebar.querySelector('#logout-btn').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:logout'));
  });

  window.addEventListener('vault:route-changed', (e) => {
    const path = e.detail.path;
    sidebar.querySelectorAll('.nav-item').forEach(el => {
      const route = el.getAttribute('data-route');
      const active = isActivePath(path, route);
      el.classList.toggle('active', active);
      el.setAttribute('aria-current', active ? 'page' : 'false');
    });

    sidebar.querySelectorAll('.nav-section').forEach(sectionEl => {
      const hasActive = !!sectionEl.querySelector('.nav-item.active');
      sectionEl.classList.toggle('has-active', hasActive);
    });

    sidebar.classList.remove('open');
    overlay.classList.remove('active');
  });

  window.addEventListener('vault:toggle-sidebar', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('active', sidebar.classList.contains('open'));
  });

  window.addEventListener('vault:toggle-sidebar-collapse', toggleSidebarCollapse);

  return sidebar;
}
