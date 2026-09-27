/**
 * Focus containment for dialogs (WCAG 2.4.3 focus order / 2.1.2 no keyboard trap
 * — modals SHOULD trap; page content should not be Tab-reachable behind them).
 *
 * While active: Tab stays inside `container`, focus moves to `initialFocus`
 * (or the first focusable node) on activation, and the previously focused
 * element is restored on release. Only the container's keydown is intercepted,
 * so native form controls and delegated handlers keep working.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function createFocusTrap(container, { initialFocus } = {}) {
  let releaseFn = null;
  let previouslyFocused = null;

  const visibleFocusables = () =>
    [...container.querySelectorAll(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    );

  const onKeydown = (e) => {
    if (e.key !== 'Tab') return;
    const nodes = visibleFocusables();
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (!container.contains(active)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return {
    activate() {
      if (releaseFn) return;
      previouslyFocused = document.activeElement;
      container.addEventListener('keydown', onKeydown);
      const target = (typeof initialFocus === 'function' ? initialFocus() : null)
        || container.querySelector(FOCUSABLE)
        || container;
      if (typeof target.focus === 'function') target.focus();
      releaseFn = () => {
        container.removeEventListener('keydown', onKeydown);
        releaseFn = null;
        if (
          previouslyFocused &&
          typeof previouslyFocused.focus === 'function' &&
          document.contains(previouslyFocused)
        ) {
          previouslyFocused.focus();
        }
        previouslyFocused = null;
      };
    },
    release() {
      if (releaseFn) releaseFn();
    },
    get active() {
      return !!releaseFn;
    },
  };
}
