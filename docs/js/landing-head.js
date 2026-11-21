// Landing page, runs in <head> before first paint: apply the saved theme and
// remember that the landing page was seen. External (not inline) so the
// Content-Security-Policy can forbid inline scripts.
(function () {
  try {
    var t = localStorage.getItem('vault_theme')
      || (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    if (/^(dark|light|warm|cold|midnight|white)$/.test(t)) document.documentElement.setAttribute('data-theme', t);
    // Seen once: the app on GitHub Pages stops sending first-time visitors here.
    localStorage.setItem('vault_seen_landing', '1');
  } catch (e) { /* storage blocked */ }
})();
