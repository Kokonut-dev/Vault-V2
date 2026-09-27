/**
 * Simple SPA router — history API with correct basePath detection.
 * Fixes: GitHub Pages vs local server basePath, async handler races,
 * unhandled promise rejections, missing /home alias.
 */
import { getBasePath } from './config.js';

export class Router {
  constructor() {
    this.routes = new Map();
    this.currentRoute = null;
    this.basePath = getBasePath();
    this.useHash = false;
    this.navId = 0;
    this._inited = false;
    this._onClick = this._onClick.bind(this);
    this._onPopState = () => this.handleRoute();
    this._onHashChange = () => { if (this.useHash) this.handleRoute(); };
    this._onNavigate = (e) => {
      const page = e.detail?.page || '';
      if (page === 'home' || page === '') this.navigate('/');
      else this.navigate(`/${String(page).replace(/^\//, '')}`);
    };
  }

  addRoute(path, handler) {
    const normalized = this.normalizePath(path);
    this.routes.set(normalized, handler);
  }

  normalizePath(path) {
    let p = path || '/';
    if (this.basePath && p.startsWith(this.basePath)) {
      p = p.substring(this.basePath.length);
    }
    if (!p.startsWith('/')) p = '/' + p;
    // Strip index.html leftovers
    if (p.endsWith('/index.html')) p = p.slice(0, -'/index.html'.length) || '/';
    if (p !== '/' && p.endsWith('/')) p = p.slice(0, -1);
    return p || '/';
  }

  getCurrentPath() {
    if (this.useHash) {
      const hash = window.location.hash.substring(1) || '/';
      return this.normalizePath(hash);
    }
    let path = window.location.pathname || '/';
    if (this.basePath && path.startsWith(this.basePath)) {
      path = path.substring(this.basePath.length);
    }
    if (!path) path = '/';
    return this.normalizePath(path);
  }

  hrefFor(path) {
    const normalized = this.normalizePath(path);
    if (this.useHash) return `#${normalized}`;
    return `${this.basePath}${normalized}` || '/';
  }

  navigate(path, replace = false) {
    const normalized = this.normalizePath(path);
    const fullPath = this.basePath + normalized;

    if (this.useHash) {
      if (replace) window.location.replace(`#${normalized}`);
      else window.location.hash = normalized;
      return;
    }

    const url = fullPath || '/';
    if (replace) window.history.replaceState({ path: normalized }, '', url);
    else window.history.pushState({ path: normalized }, '', url);
    this.handleRoute();
  }

  async handleRoute() {
    const gen = ++this.navId;
    const path = this.getCurrentPath();
    const nav = {
      gen,
      path,
      isCurrent: () => this.navId === gen,
    };

    let handler = this.routes.get(path);
    let params = {};

    if (!handler) {
      for (const [routePath, routeHandler] of this.routes.entries()) {
        const match = this.matchDynamicRoute(routePath, path);
        if (match) {
          handler = routeHandler;
          params = match;
          break;
        }
      }
    }

    // Alias /home → /
    if (!handler && (path === '/home' || path === '/index.html')) {
      handler = this.routes.get('/');
    }

    if (!handler) {
      this.currentRoute = path;
      this.render404(path);
      window.dispatchEvent(new CustomEvent('vault:route-changed', { detail: { path, params } }));
      return;
    }

    this.currentRoute = path;
    try {
      await handler(params, nav);
    } catch (err) {
      if (!nav.isCurrent()) return;
      console.error('[Router] Handler error for', path, err);
      const viewContainer = document.getElementById('view-container');
      if (viewContainer) {
        viewContainer.innerHTML = `
          <div class="empty-state" style="padding:40px;">
            <div class="empty-state-title">Error loading page</div>
            <div class="empty-state-message">${this.escapeHtml(err.message || String(err))}</div>
            <button class="btn btn-primary" type="button" data-route="/">Go Home</button>
          </div>
        `;
      }
    }

    if (!nav.isCurrent()) return;
    window.dispatchEvent(new CustomEvent('vault:route-changed', { detail: { path, params } }));
  }

  render404(path) {
    const viewContainer = document.getElementById('view-container');
    if (!viewContainer) return;
    viewContainer.innerHTML = `
      <div class="empty-state" style="padding:60px 20px; text-align:center;">
        <div class="empty-state-icon" style="font-size:48px;">∅</div>
        <div class="empty-state-title" style="font-size:20px; font-weight:700; margin:12px 0;">Page not found</div>
        <div class="empty-state-message" style="color:var(--text-secondary); margin-bottom:20px;">The page <code>${this.escapeHtml(path)}</code> doesn't exist.</div>
        <div style="display:flex; gap:10px; justify-content:center; flex-wrap:wrap; margin-bottom:16px;">
          <button class="btn btn-primary" type="button" data-route="/">Go Home</button>
          <button class="btn btn-secondary" type="button" id="not-found-search">⌕ Search library</button>
        </div>
        <div style="font-size:13px; color:var(--text-tertiary);">
          Quick links:
          <a href="/movies" data-route="/movies" style="color:var(--accent-text);">Movies</a> •
          <a href="/music" data-route="/music" style="color:var(--accent-text);">Music</a> •
          <a href="/videos" data-route="/videos" style="color:var(--accent-text);">Videos</a> •
          <a href="/playlists" data-route="/playlists" style="color:var(--accent-text);">Playlists</a>
        </div>
      </div>
    `;
    viewContainer.querySelector('#not-found-search')?.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('vault:open-search'));
    });
  }

  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  matchDynamicRoute(routePattern, actualPath) {
    const patternParts = routePattern.split('/').filter(Boolean);
    const pathParts = actualPath.split('/').filter(Boolean);
    if (patternParts.length !== pathParts.length) return null;

    const params = {};
    for (let i = 0; i < patternParts.length; i++) {
      const patternPart = patternParts[i];
      const pathPart = pathParts[i];
      if (patternPart.startsWith(':')) {
        params[patternPart.substring(1)] = decodeURIComponent(pathPart);
      } else if (patternPart !== pathPart) {
        return null;
      }
    }
    return params;
  }

  _onClick(e) {
    if (e.defaultPrevented) return;
    if (e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = e.target.closest('[data-route]');
    if (!link) return;
    const path = link.getAttribute('data-route') || link.getAttribute('href');
    if (!path) return;
    e.preventDefault();
    this.navigate(path);
  }

  init() {
    this.basePath = getBasePath();
    // Hash routing only if the page was opened with a hash route
    this.useHash = window.location.hash.startsWith('#/');

    if (this._inited) {
      this.handleRoute();
      return;
    }
    this._inited = true;

    window.addEventListener('popstate', this._onPopState);
    window.addEventListener('hashchange', this._onHashChange);
    document.addEventListener('click', this._onClick);
    window.addEventListener('vault:navigate', this._onNavigate);

    const redirect = sessionStorage.getItem('vault_redirect');
    if (redirect) {
      sessionStorage.removeItem('vault_redirect');
      this.navigate(redirect, true);
    } else {
      this.handleRoute();
    }
  }
}

export const router = new Router();
export default router;
