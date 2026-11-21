// GitHub Pages 404 page: hand the deep link to the app. External (not inline)
// so the Content-Security-Policy can forbid inline scripts. 404.html is served
// at any missing path, so it loads this file by absolute path.
// GitHub Pages SPA hack — https://github.com/rafgraph/spa-github-pages
// Stores the current path and redirects to index.html
(function() {
  var path = window.location.pathname;
  var base = '/Vault-V2';
  var redirectPath = path;
  if (path.startsWith(base)) {
    redirectPath = path.substring(base.length);
  }
  if (!redirectPath) redirectPath = '/';
  sessionStorage.setItem('vault_redirect', redirectPath + window.location.search + window.location.hash);
  window.location.replace(base + '/');
})();
