/**
 * Image load / error behaviour without inline event handlers.
 *
 * Templates used to write `onerror="this.remove()"` and friends. Inline
 * handlers need `'unsafe-inline'` in the Content-Security-Policy, which also
 * lets injected markup run script, so they're declared as data attributes
 * and handled here with one capturing listener (load/error don't bubble, but
 * they do pass through the capture phase):
 *
 *   data-img-fallback="hide"         hide the image when it fails
 *   data-img-fallback="remove"       remove it
 *   data-img-fallback="placeholder"  hide it and show the card's placeholder
 *   data-img-loaded="parent-art"     mark the parent `.has-art` once loaded
 */
const FALLBACKS = {
  hide(img) {
    img.style.display = 'none';
  },
  remove(img) {
    img.remove();
  },
  placeholder(img) {
    img.style.display = 'none';
    img.parentElement?.querySelector('.media-card-placeholder')?.classList.add('visible');
  },
};

const ON_LOAD = {
  'parent-art'(img) {
    img.parentElement?.classList.add('has-art');
  },
};

function isImage(target) {
  return target && target.tagName === 'IMG';
}

let installed = false;

/** Start handling data-img-* attributes for the whole document (idempotent). */
export function installImageFallbacks(root = document) {
  if (installed) return;
  installed = true;
  root.addEventListener('error', (event) => {
    const img = event.target;
    if (!isImage(img)) return;
    FALLBACKS[img.dataset.imgFallback]?.(img);
  }, true);
  root.addEventListener('load', (event) => {
    const img = event.target;
    if (!isImage(img)) return;
    ON_LOAD[img.dataset.imgLoaded]?.(img);
  }, true);
}

/**
 * Stylesheets marked `data-async-css` start as media="print" (not render
 * blocking) and switch to "all" once loaded. Replaces the inline
 * `onload="this.media='all'"` pattern.
 */
export function activateAsyncStylesheets(root = document) {
  for (const link of root.querySelectorAll('link[data-async-css]')) {
    const enable = () => { link.media = 'all'; };
    if (link.sheet) enable();
    else link.addEventListener('load', enable, { once: true });
  }
}
