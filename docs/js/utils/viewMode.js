/**
 * Grid / List choice, remembered per page.
 *
 * Music, Movies & Series and Videos used to share one `viewMode`, so picking
 * List on Music silently flipped Movies too. Each page now keeps its own
 * choice (`vault_view_modes`); the old shared value is only the starting
 * point for a page that has never been switched.
 */
import { store } from '../store.js';

const MODES = ['grid', 'list'];

export function getViewMode(page) {
  const saved = (store.get('viewModes') || {})[page];
  if (MODES.includes(saved)) return saved;
  const legacy = store.get('viewMode');
  return MODES.includes(legacy) ? legacy : 'grid';
}

export function setViewMode(page, mode) {
  if (!MODES.includes(mode)) return;
  store.set('viewModes', { ...(store.get('viewModes') || {}), [page]: mode }, true);
}

/**
 * Wire a `.view-toggle` (buttons with data-view="grid|list") for `page`.
 * Calls onChange(mode) after a switch and returns the starting mode.
 */
export function wireViewToggle(root, page, onChange) {
  const buttons = [...root.querySelectorAll('.view-toggle [data-view]')];
  const group = root.querySelector('.view-toggle');
  if (group) {
    group.setAttribute('role', 'group');
    if (!group.hasAttribute('aria-label')) group.setAttribute('aria-label', 'Layout');
  }
  const paint = (mode) => buttons.forEach((btn) => {
    const on = btn.dataset.view === mode;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
  const start = getViewMode(page);
  buttons.forEach((btn) => {
    btn.type = 'button';
    btn.addEventListener('click', () => {
      const mode = btn.dataset.view;
      if (!MODES.includes(mode)) return;
      paint(mode);
      setViewMode(page, mode);
      onChange?.(mode);
    });
  });
  paint(start);
  return start;
}

export default { getViewMode, setViewMode, wireViewToggle };
