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
  const config = getConfig();
  // For GitHub Pages, base path is /Vault-V2, for local dev it's ''
  const isGitHubPages = window.location.hostname.includes('github.io');
  if (isGitHubPages) return config.basePath || '/Vault-V2';
  return '';
}

export function isGitHubPages() {
  return window.location.hostname.includes('github.io');
}
