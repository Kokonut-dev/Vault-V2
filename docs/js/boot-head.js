// Runs synchronously in <head>, before the stylesheet paints. An external
// file (not an inline <script>) so the Content-Security-Policy can forbid
// inline scripts.

// First visit to the hosted app (GitHub Pages) with no server connected:
// show the project's landing page instead of a bare sign-in form. It has
// an "Open Vault" button back here (?app), and is only shown once. Never
// on a self-hosted server, a deep link, a pairing link or once signed in.
(function () {
  try {
    var q = location.search;
    if (/[?&]app\b/.test(q)) { localStorage.setItem('vault_seen_landing', '1'); return; }
    if (!/\.github\.io$/.test(location.hostname)) return;
    if (/[?&]pair=/.test(q) || sessionStorage.getItem('vault_redirect')) return;
    if (!/\/(index\.html)?$/.test(location.pathname)) return;
    if (localStorage.getItem('vault_token') || localStorage.getItem('vault_api_url') || localStorage.getItem('vault_seen_landing')) return;
    location.replace('landing.html');
  } catch (e) { /* storage blocked: stay on the app */ }
})();

// Apply the saved theme before the stylesheet paints: <html> defaults to
// "dark", so light-theme users saw a dark flash and every element ran the
// 300 ms theme fade on each load.
(function () {
  try {
    var t = localStorage.getItem('vault_theme')
      || (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    if (/^(dark|light|warm|cold|midnight|white)$/.test(t)) document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: keep the default */ }
})();
