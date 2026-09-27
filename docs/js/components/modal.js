/**
 * Generic modal helper
 */
import { createFocusTrap } from '../utils/focusTrap.js';

export function createModal({ title, content, onClose }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop active';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="modal-header">
        <div class="modal-title">${title}</div>
        <button class="modal-close" aria-label="Close dialog">✕</button>
      </div>
      <div class="modal-body">${content}</div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const trap = createFocusTrap(backdrop, {
    initialFocus: () => backdrop.querySelector('.modal-close'),
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('vault:escape', close);
    document.removeEventListener('keydown', onKeydown);
    trap.release();
    backdrop.remove();
    onClose?.();
  };

  // Escape: app-wide channel (keyboard.js) + raw keydown as fallback when
  // the shortcut layer is not initialized (e.g. inside dialogs/inputs).
  const onKeydown = (e) => {
    if (e.key === 'Escape') close();
  };
  window.addEventListener('vault:escape', close);
  document.addEventListener('keydown', onKeydown);

  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  trap.activate();

  return { backdrop, close };
}
