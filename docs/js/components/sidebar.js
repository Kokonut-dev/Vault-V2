/**
 * Sidebar navigation
 */
import { store } from '../store.js';
import { router } from '../router.js';

const NAV_ITEMS = [
  { section: 'Library', items: [
    { id: 'home', label: 'Home', icon: '⌂', route: '/' },
    { id: 'movies', label: 'Movies & Series', icon: '🎬', route: '/movies' },
    { id: 'music', label: 'Music', icon: '♫', route: '/music' },
    { id: 'videos', label: 'Videos', icon: '▶', route: '/videos' },
  ]},
  { section: 'Your Collection', items: [
    { id: 'playlists', label: 'Playlists', icon: '≡', route: '/playlists' },
    { id: 'favourites', label: 'Favourites', icon: '♥', route: '/favourites' },
    { id: 'history', label: 'History', icon: '◷', route: '/history' },
  ]},
  { section: 'Manage', items: [
    { id: 'upload', label: 'Upload', icon: '↑', route: '/upload' },
    { id: 'settings', label: 'Settings', icon: '⚙', route: '/settings' },
  ]},
];

export function renderSidebar(container) {
  const isCollapsed = store.get('sidebarCollapsed');
  const currentPath = router.getCurrentPath();

  const sidebar = document.createElement('aside');
  sidebar.className = `sidebar ${isCollapsed ? 'collapsed' : ''}`;
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
            <a class="nav-item ${currentPath === item.route || (item.route !== '/' && currentPath.startsWith(item.route)) ? 'active' : ''}" 
               data-route="${item.route}" 
               data-id="${item.id}"
               role="link"
               tabindex="0"
               aria-current="${currentPath === item.route ? 'page' : 'false'}">
              <span class="nav-icon">${item.icon}</span>
              <span class="nav-label">${item.label}</span>
            </a>
          `).join('')}
        </div>
      `).join('')}
    </nav>
    <div class="sidebar-footer">
      <button class="sidebar-toggle" id="sidebar-toggle" aria-label="Toggle sidebar">
        <span>${isCollapsed ? '→' : '←'}</span>
        <span class="nav-label" style="margin-left:8px;">${isCollapsed ? 'Expand' : 'Collapse'}</span>
      </button>
      <button class="btn btn-ghost btn-sm" id="logout-btn" style="width:100%;">
        <span>Logout</span>
      </button>
    </div>
  `;

  container.appendChild(sidebar);

  // Overlay for mobile
  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  overlay.id = 'sidebar-overlay';
  document.body.appendChild(overlay);

  // Events
  sidebar.querySelector('#sidebar-toggle').addEventListener('click', () => {
    const collapsed = !store.get('sidebarCollapsed');
    store.set('sidebarCollapsed', collapsed, true);
    sidebar.classList.toggle('collapsed', collapsed);
  });

  sidebar.querySelector('#logout-btn').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:logout'));
  });

  overlay.addEventListener('click', () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
  });

  // Update active state on route change
  window.addEventListener('vault:route-changed', (e) => {
    const path = e.detail.path;
    sidebar.querySelectorAll('.nav-item').forEach(el => {
      const route = el.getAttribute('data-route');
      const isActive = path === route || (route !== '/' && path.startsWith(route));
      el.classList.toggle('active', isActive);
      el.setAttribute('aria-current', isActive ? 'page' : 'false');
    });
  });

  // Mobile toggle
  window.addEventListener('vault:toggle-sidebar', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('active', sidebar.classList.contains('open'));
  });

  return sidebar;
}

export function toggleSidebar() {
  window.dispatchEvent(new CustomEvent('vault:toggle-sidebar'));
}
