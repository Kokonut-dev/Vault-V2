/**
 * Lazy loading via IntersectionObserver
 */

let observer = null;
let fallbackMode = false;

/** Load the image straight away — used when IntersectionObserver is missing
 *  (old browsers, some embedded webviews) so cards never render blank. */
function loadNow(el) {
  if (!el) return;
  const src = el.dataset ? el.dataset.src : null;
  if (src) {
    if (el.tagName === 'IMG') el.src = src;
    else el.style.backgroundImage = `url(${src})`;
    el.removeAttribute('data-src');
    el.classList.add('loaded');
  }
}

function getObserver() {
  if (observer) return observer;
  if (typeof IntersectionObserver === 'undefined') {
    fallbackMode = true;
    return null;
  }
  
  observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const el = entry.target;
        const src = el.dataset.src;
        if (src) {
          if (el.tagName === 'IMG') {
            el.src = src;
          } else {
            el.style.backgroundImage = `url(${src})`;
          }
          el.removeAttribute('data-src');
          el.classList.add('loaded');
        }
        observer.unobserve(el);
      }
    });
  }, {
    rootMargin: '100px',
    threshold: 0.01,
  });
  
  return observer;
}

export function lazyLoad(selector = '[data-src]') {
  const elements = [...document.querySelectorAll(selector)];
  const obs = getObserver();
  if (!obs) {
    elements.forEach(loadNow);
    return;
  }
  elements.forEach(el => obs.observe(el));
}

export function lazyLoadElement(el) {
  if (!el) return;
  const obs = getObserver();
  if (!obs) {
    loadNow(el);
    return;
  }
  obs.observe(el);
}


