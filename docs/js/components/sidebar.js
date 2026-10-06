/**
 * Sidebar navigation
 */
import { store } from '../store.js';
import { router } from '../router.js';
import { icon, setIcon } from '../utils/icons.js';

// `icon` values are keys into docs/js/utils/icons.js — never glyphs.
const NAV_ITEMS = [
  { section: 'Library', items: [
    { id: 'home', label: 'Home', icon: 'home', route: '/' },
    { id: 'movies', label: 'Movies & Series', icon: 'film', route: '/movies' },
    { id: 'music', label: 'Music', icon: 'music', route: '/music' },
    { id: 'videos', label: 'Videos', icon: 'video', route: '/videos' },
  ]},
  { section: 'Your Collection', items: [
    { id: 'playlists', label: 'Playlists', icon: 'list', route: '/playlists' },
    { id: 'favourites', label: 'Favourites', icon: 'heart', route: '/favourites' },
    { id: 'history', label: 'History', icon: 'history', route: '/history' },
  ]},
  { section: 'Manage', items: [
    { id: 'upload', label: 'Upload', icon: 'upload', route: '/upload' },
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
      <div class="sidebar-logo">V</div>
      <div class="sidebar-brand">Vault</div>
    </div>
    <nav class="sidebar-nav">
      ${NAV_ITEMS.map(section => `
        <div class="nav-section">
          <div class="nav-section-title">${section.section}</div>
          ${section.items.map(item => `
            <a class="nav-item ${isActivePath(currentPath, item.route) ? 'active' : ''}"
               href="${router.hrefFor(item.route)}"
               data-route="${item.route}"
               data-id="${item.id}"
               role="link"
               tabindex="0"
               aria-current="${isActivePath(currentPath, item.route) ? 'page' : 'false'}">
              <span class="nav-icon">${icon(item.icon, { size: 18 })}</span>
              <span class="nav-label">${item.label}</span>
            </a>
          `).join('')}
        </div>
      `).join('')}
    </nav>
    <div class="sidebar-footer">
      <button class="sidebar-toggle" id="sidebar-toggle" type="button" aria-label="Toggle sidebar">
        <span>${icon(isCollapsed ? 'chevron-right' : 'chevron-left', { size: 16 })}</span>
        <span class="nav-label" style="margin-left:8px;">${isCollapsed ? 'Expand' : 'Collapse'}</span>
      </button>
      <button class="btn btn-ghost btn-sm" id="logout-btn" type="button" style="width:100%;">
        <span>Logout</span>
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

  sidebar.querySelector('#sidebar-toggle').addEventListener('click', () => {
    const collapsed = !store.get('sidebarCollapsed');
    store.set('sidebarCollapsed', collapsed, true);
    sidebar.classList.toggle('collapsed', collapsed);
    if (appEl) appEl.classList.toggle('sidebar-collapsed', collapsed);
    const label = sidebar.querySelector('#sidebar-toggle .nav-label');
    const arrow = sidebar.querySelector('#sidebar-toggle span');
    if (arrow) setIcon(arrow, collapsed ? 'chevron-right' : 'chevron-left', { size: 16 });
    if (label) label.textContent = collapsed ? 'Expand' : 'Collapse';
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
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
  });

  window.addEventListener('vault:toggle-sidebar', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('active', sidebar.classList.contains('open'));
  });

  return sidebar;
}

export function toggleSidebar() {
  window.dispatchEvent(new CustomEvent('vault:toggle-sidebar'));
}
