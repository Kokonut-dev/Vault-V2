// Landing page: theme preview and install tabs. External (not inline) so the
// Content-Security-Policy can forbid inline scripts.
(function () {
  // Theme preview — the same six themes as the app; the choice carries over.
  var THEMES = [
    ['dark', 'Graphite', 'Dark', ['#161719', '#26282A', '#93BFF0']],
    ['cold', 'Dusk', 'Dark', ['#11181F', '#222A31', '#8ECED1']],
    ['midnight', 'Ember', 'OLED', ['#000000', '#1B1917', '#EAC07F']],
    ['white', 'Daylight', 'Light', ['#FFFFFF', '#F1F3F5', '#175098']],
    ['light', 'Stone', 'Light', ['#F4F2EF', '#FDFBF9', '#005360']],
    ['warm', 'Sepia', 'Light', ['#F6EBDA', '#FCF3E4', '#294875']]
  ];
  var root = document.documentElement;
  var picker = document.getElementById('theme-picker');
  function sync() {
    var current = root.getAttribute('data-theme');
    picker.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.theme === current)); });
    var meta = document.querySelector('meta[name="theme-color"]');
    var t = THEMES.find(function (x) { return x[0] === current; });
    if (meta && t) meta.setAttribute('content', t[3][0]);
  }
  THEMES.forEach(function (t) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme-btn';
    b.dataset.theme = t[0];
    b.innerHTML = '<span class="theme-swatch" aria-hidden="true"><i style="background:' + t[3][0] + '"></i><i style="background:' + t[3][1] + '"></i><i style="background:' + t[3][2] + '"></i></span><span>' + t[1] + ' <span class="theme-mode">' + t[2] + '</span></span>';
    b.addEventListener('click', function () {
      root.setAttribute('data-theme', t[0]);
      try { localStorage.setItem('vault_theme', t[0]); } catch (e) {}
      sync();
    });
    picker.appendChild(b);
  });
  sync();

  // Install tabs (arrow keys move between them).
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  function select(tab) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
  }
  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { select(tab); });
    tab.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      select(next);
      next.focus();
    });
  });

  // Copy buttons.
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy');
      var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { btn.textContent = 'Select and copy'; });
      else btn.textContent = 'Select and copy';
    });
  });
})();
