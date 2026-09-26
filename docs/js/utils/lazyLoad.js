/**
 * Lazy loading via IntersectionObserver
 */

let observer = null;

function getObserver() {
  if (observer) return observer;
  
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
  const elements = document.querySelectorAll(selector);
  const obs = getObserver();
  elements.forEach(el => obs.observe(el));
}

export function lazyLoadElement(el) {
  if (!el) return;
  const obs = getObserver();
  obs.observe(el);
}

export function preloadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
