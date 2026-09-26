/**
 * Config loader — reads window.VAULT_CONFIG and provides helpers
 */

export function getConfig() {
  return window.VAULT_CONFIG || {
    apiBaseUrl: 'http://localhost:4000',
    appName: 'Vault',
    version: '2.0.0',
    basePath: '',
    defaultTheme: 'dark',
  };
}

export function getApiBaseUrl() {
  const config = getConfig();
  // Allow override via localStorage
  const stored = localStorage.getItem('vault_api_url');
  if (stored) return stored.replace(/\/$/, '');
  return (config.apiBaseUrl || 'http://localhost:4000').replace(/\/$/, '');
}

export function setApiBaseUrl(url) {
  localStorage.setItem('vault_api_url', url.replace(/\/$/, ''));
  window.VAULT_CONFIG.apiBaseUrl = url.replace(/\/$/, '');
}

export function getBasePath() {
  // GitHub Pages project site lives under /Vault-V2. The local server serves at /.
  // Never use the config basePath when we are not on github.io — that was breaking
  // in-app navigation when the UI was served from the Node server.
  const hostname = window.location.hostname || '';
  if (hostname.includes('github.io')) {
    const config = getConfig();
    return config.basePath || '/Vault-V2';
  }
  const path = window.location.pathname || '';
  if (path.startsWith('/Vault-V2')) return '/Vault-V2';
  return '';
}

export function isGitHubPages() {
  return window.location.hostname.includes('github.io');
}
