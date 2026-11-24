/**
 * Edge fades for horizontally scrolling strips (tab bars, chip rows).
 *
 * On a phone the last tab of a strip like Stats' "This week · This month ·
 * This year · All time" is simply cut off, with no hint that the row
 * scrolls. This marks each strip with data-scroll-hint="start|end|both"
 * (styled in css/responsive.css as a mask fade) whenever there is more
 * content in that direction, and clears it when everything fits.
 */
const SELECTOR = '.settings-tabs, .season-tabs, [data-scroll-strip]';

const tracked = new WeakSet();
let resizeObserver = null;

export function updateHint(el) {
  const max = el.scrollWidth - el.clientWidth;
  let hint = '';
  if (max > 2) {
    const atStart = el.scrollLeft <= 2;
    const atEnd = el.scrollLeft >= max - 2;
    hint = atStart ? 'end' : atEnd ? 'start' : 'both';
  }
  if (hint) el.dataset.scrollHint = hint;
  else delete el.dataset.scrollHint;
  return hint;
}

function track(el) {
  if (tracked.has(el)) return;
  tracked.add(el);
  el.addEventListener('scroll', () => updateHint(el), { passive: true });
  // The observer's first callback (after the next layout) sets the initial
  // hint. Measuring here, inside the MutationObserver, forced a synchronous
  // style + layout of the whole freshly rendered view on every navigation.
  if (resizeObserver) resizeObserver.observe(el);
  else updateHint(el);
}

function scan(root = document) {
  if (root.matches?.(SELECTOR)) track(root);
  root.querySelectorAll?.(SELECTOR).forEach(track);
}

export function initScrollHints() {
  if (typeof window === 'undefined' || initScrollHints.done) return;
  initScrollHints.done = true;
  if ('ResizeObserver' in window) {
    resizeObserver = new ResizeObserver(entries => entries.forEach(entry => updateHint(entry.target)));
  } else {
    window.addEventListener('resize', () => document.querySelectorAll(SELECTOR).forEach(updateHint));
  }
  scan();
  // Views render their strips after navigation.
  new MutationObserver((mutations) => {
    for (const m of mutations) m.addedNodes.forEach(node => { if (node.nodeType === 1) scan(node); });
  }).observe(document.body, { childList: true, subtree: true });
  // Keep the active tab visible when a strip is first shown or changes.
  document.addEventListener('click', (event) => {
    const tab = event.target.closest?.(`${SELECTOR} > *`);
    if (tab) tab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  });
}
