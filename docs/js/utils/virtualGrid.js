/**
 * Windowing for large grids/lists (audit F-12).
 *
 * Instead of putting 5 000 cards in the DOM, only the visible slice (plus a
 * buffer) is rendered, with two spacer elements keeping the scroll height
 * correct. It degrades to "render everything" below `threshold`, so small
 * libraries keep the simple code path (and the existing stagger animation).
 */

const DEFAULT_OPTIONS = {
  itemHeight: 300,
  columns: 0, // 0 = auto from measured width
  gap: 16,
  buffer: 3, // rows rendered above/below the viewport
  threshold: 120, // below this, render everything
};

export function createVirtualGrid(container, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let items = [];
  let renderRow = null;
  let scrollRoot = opts.scrollRoot || window;
  let rafId = null;

  const topSpacer = document.createElement('div');
  const bottomSpacer = document.createElement('div');
  const viewport = document.createElement('div');
  topSpacer.style.cssText = 'flex:0 0 auto;width:100%';
  bottomSpacer.style.cssText = 'flex:0 0 auto;width:100%';
  viewport.style.cssText = 'display:grid;width:100%;gap:var(--space-md,16px)';

  container.classList.add('virtual-grid');
  container.append(topSpacer, viewport, bottomSpacer);

  function measureColumns() {
    if (opts.columns) return opts.columns;
    const template = getComputedStyle(viewport).gridTemplateColumns;
    const count = template ? template.split(' ').filter(Boolean).length : 1;
    return Math.max(1, count);
  }

  function rowHeight() {
    return opts.itemHeight + opts.gap;
  }

  function render(chunk) {
    viewport.replaceChildren();
    for (const item of chunk) {
      const node = renderRow(item);
      if (node) viewport.appendChild(node);
    }
  }

  function update() {
    if (!items.length || !renderRow) return;
    const columns = measureColumns();
    const totalRows = Math.ceil(items.length / columns);
    const height = rowHeight();

    // Where is the container relative to the viewport?
    const rect = container.getBoundingClientRect();
    const scrolled = (scrollRoot === window ? window.scrollY : scrollRoot.scrollTop) - rect.top - (scrollRoot === window ? window.scrollY : 0);
    const offsetInContainer = Math.max(0, -rect.top + (scrollRoot === window ? 0 : 0));
    const viewportHeight = scrollRoot === window ? window.innerHeight : scrollRoot.clientHeight;

    const visibleTop = Math.max(0, offsetInContainer - viewportHeight);
    const firstRow = Math.max(0, Math.floor(visibleTop / height) - opts.buffer);
    const rowsVisible = Math.ceil(viewportHeight / height) + opts.buffer * 2;
    const lastRow = Math.min(totalRows, firstRow + rowsVisible);

    const start = firstRow * columns;
    const end = Math.min(items.length, lastRow * columns);

    topSpacer.style.height = `${firstRow * height}px`;
    bottomSpacer.style.height = `${Math.max(0, (totalRows - lastRow) * height)}px`;
    viewport.style.gridTemplateColumns = opts.columns ? '' : 'var(--grid-template, repeat(auto-fill, minmax(160px, 1fr)))';

    if (viewport.dataset.start === `${start}-${end}`) return;
    viewport.dataset.start = `${start}-${end}`;
    render(items.slice(start, end));
  }

  function onScroll() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      update();
    });
  }

  scrollRoot.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });

  return {
    setItems(nextItems, renderItemFn) {
      items = nextItems || [];
      renderRow = renderItemFn || renderRow;
      if (items.length <= opts.threshold) {
        // Small library: skip windowing entirely.
        topSpacer.style.height = '0px';
        bottomSpacer.style.height = '0px';
        viewport.dataset.start = '';
        render(items);
        return;
      }
      viewport.dataset.start = '';
      update();
    },
    refresh: update,
    destroy() {
      scrollRoot.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      items = [];
    },
    get virtualized() {
      return items.length > opts.threshold;
    },
  };
}
