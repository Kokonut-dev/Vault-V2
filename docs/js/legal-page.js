// Terms of Use page (terms.html). External file: the page's
// Content-Security-Policy forbids inline scripts.
(function () {
  var button = document.querySelector('[data-legal-print]');
  if (!button || typeof window.print !== 'function') return;
  button.hidden = false;
  button.addEventListener('click', function () { window.print(); });
})();
