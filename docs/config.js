/**
 * Vault Frontend Configuration
 * User-editable: Set your local server URL here
 * 
 * For GitHub Pages HTTPS → local HTTP mixed content issue, use one of:
 * 1. mkcert: Generate trusted local cert and run server on HTTPS (https://localhost:4000)
 * 2. Cloudflare Tunnel: Get public HTTPS URL (https://your-tunnel.trycloudflare.com)
 * 3. Local dev: Run frontend locally via npx serve docs (http://localhost:3000)
 */

window.VAULT_CONFIG = {
  // API base URL — change this to your local server URL
  // Examples:
  // - Local HTTP (for local dev): 'http://localhost:4000'
  // - Local HTTPS (with mkcert): 'https://localhost:4000'
  // - Cloudflare Tunnel: 'https://your-tunnel.trycloudflare.com'
  // - ngrok: 'https://your-ngrok-id.ngrok.io'
  apiBaseUrl: localStorage.getItem('vault_api_url') || 'http://localhost:4000',

  // App info
  appName: 'Vault',
  version: '2.0.0',

  // Features
  enablePWA: true,
  enableAnalytics: false,

  // Defaults
  defaultTheme: localStorage.getItem('vault_theme') || 'dark',
  defaultGlassIntensity: parseInt(localStorage.getItem('vault_glass') || '20', 10),
  defaultGrainIntensity: parseInt(localStorage.getItem('vault_grain') || '15', 10),

  // GitHub Pages path (for routing). Empty when served from the local server.
  basePath: (typeof location !== 'undefined' && location.hostname && location.hostname.includes('github.io'))
    ? '/Vault-V2'
    : '',
};
