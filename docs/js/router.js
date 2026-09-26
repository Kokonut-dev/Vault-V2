/**
 * Simple SPA router — history API with hash fallback for GitHub Pages
 */
import { store } from './store.js';

export class Router {
  constructor() {
    this.routes = new Map();
    this.currentRoute = null;
    this.basePath = window.VAULT_CONFIG?.basePath || '';
    // For GitHub Pages, use hash routing if needed, but try history first with 404.html fallback
    this.useHash = false;
  }

  addRoute(path, handler) {
    // Normalize path
    const normalized = this.normalizePath(path);
    this.routes.set(normalized, handler);
  }

  normalizePath(path) {
    let p = path;
    if (p.startsWith(this.basePath)) p = p.substring(this.basePath.length);
    if (!p.startsWith('/')) p = '/' + p;
    if (p !== '/' && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  }

  getCurrentPath() {
    if (this.useHash) {
      const hash = window.location.hash.substring(1) || '/';
      return this.normalizePath(hash);
    }
    let path = window.location.pathname;
    if (this.basePath && path.startsWith(this.basePath)) {
      path = path.substring(this.basePath.length);
    }
    if (!path) path = '/';
    return this.normalizePath(path);
  }

  navigate(path, replace = false) {
    const normalized = this.normalizePath(path);
    const fullPath = this.basePath + normalized;

    if (this.useHash) {
      if (replace) {
        window.location.replace(`#${normalized}`);
      } else {
        window.location.hash = normalized;
      }
    } else {
      if (replace) {
        window.history.replaceState(null, '', fullPath);
      } else {
        window.history.pushState(null, '', fullPath);
      }
      this.handleRoute();
    }
  }

  handleRoute() {
    const path = this.getCurrentPath();

    // Check for exact match
    let handler = this.routes.get(path);
    let params = {};

    // Check for dynamic routes like /movie/:id
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

    // Fallback to home with 404 handling
    if (!handler) {
      const isKnown404 = path !== '/' && path !== '';
      if (isKnown404) {
        console.warn(`[Router] Route not found: ${path}, falling back to home`);
        // Optionally render 404 UI in view-container
        const viewContainer = document.getElementById('view-container');
        if (viewContainer) {
          viewContainer.innerHTML = `
            <div class="empty-state" style="padding:60px 20px; text-align:center;">
              <div class="empty-state-icon" style="font-size:48px;">∅</div>
              <div class="empty-state-title" style="font-size:20px; font-weight:700; margin:12px 0;">Page not found</div>
              <div class="empty-state-message" style="color:var(--text-secondary); margin-bottom:20px;">The page <code>${this.escapeHtml(path)}</code> doesn't exist.</div>
              <button class="btn btn-primary" onclick="window.Vault.router.navigate('/', true)">Go Home</button>
            </div>
          `;
        }
      }
      handler = this.routes.get('/') || this.routes.get('/home');
    }

    if (handler) {
      this.currentRoute = path;
      try {
        handler(params);
      } catch (err) {
        console.error('[Router] Handler error for', path, err);
        const viewContainer = document.getElementById('view-container');
        if (viewContainer) {
          viewContainer.innerHTML = `
            <div class="empty-state" style="padding:40px;">
              <div class="empty-state-title">Error loading page</div>
              <div class="empty-state-message">${this.escapeHtml(err.message)}</div>
            </div>
          `;
        }
      }
      window.dispatchEvent(new CustomEvent('vault:route-changed', { detail: { path, params } }));
    }
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
        const paramName = patternPart.substring(1);
        params[paramName] = pathPart;
      } else if (patternPart !== pathPart) {
        return null;
      }
    }

    return params;
  }

  init() {
    // Handle popstate
    window.addEventListener('popstate', () => this.handleRoute());
    window.addEventListener('hashchange', () => {
      if (this.useHash) this.handleRoute();
    });

    // Handle initial route
    // Check if we're on GitHub Pages 404 redirect (sessionStorage)
    const redirect = sessionStorage.getItem('vault_redirect');
    if (redirect) {
      sessionStorage.removeItem('vault_redirect');
      this.navigate(redirect, true);
    } else {
      this.handleRoute();
    }

    // Intercept link clicks
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[data-route]');
      if (link) {
        e.preventDefault();
        const path = link.getAttribute('data-route') || link.getAttribute('href');
        if (path) this.navigate(path);
      }
    });

    // Handle custom navigate events
    window.addEventListener('vault:navigate', (e) => {
      const { page } = e.detail;
      this.navigate(`/${page}`);
    });
  }
}

export const router = new Router();
export default router;
