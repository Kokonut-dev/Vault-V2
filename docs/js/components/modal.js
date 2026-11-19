/**
 * Generic modal helper
 */
import { createFocusTrap } from '../utils/focusTrap.js';
import { icon } from '../utils/icons.js';

// Titles, labels and messages are plain text: they often contain media titles
// and profile names (anything a file name or tag can hold), so they are
// always escaped here. Callers pass raw strings. `content` stays HTML.
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function createModal({ title, content, onClose }) {
  const safeTitle = esc(title);
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop active';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${safeTitle}">
      <div class="modal-header">
        <div class="modal-title">${safeTitle}</div>
        <button class="modal-close" aria-label="Close dialog">${icon('x', { size: 16 })}</button>
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


/**
 * Promise-based prompt used by the newer flows (save queue as playlist,
 * rename, add feed URL…). Resolves with the string, or null if cancelled.
 */
export function promptModal({ title, message = '', label = 'Value', value = '', placeholder = '', confirmLabel = 'Save', validate = null, inputType = 'text', autocomplete = 'off', inputMode = '' } = {}) {
  return new Promise(resolve => {
    const { backdrop, close } = createModal({
      title,
      content: `
        ${message ? `<p class="modal-text">${esc(message)}</p>` : ''}
        <label class="form-label" for="prompt-input">${esc(label)}</label>
        <input class="form-input" id="prompt-input" type="${inputType === 'password' ? 'password' : 'text'}" autocomplete="${esc(autocomplete)}"${inputMode ? ` inputmode="${esc(inputMode)}"` : ''} value="${esc(value)}" placeholder="${esc(placeholder)}">
        <div class="modal-error" id="prompt-error" role="alert"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" data-cancel>Cancel</button>
          <button type="button" class="btn btn-primary" data-confirm>${esc(confirmLabel)}</button>
        </div>
      `,
      onClose: () => resolve(null),
    });

    const input = backdrop.querySelector('#prompt-input');
    const error = backdrop.querySelector('#prompt-error');
    const submit = () => {
      const next = input.value.trim();
      if (validate) {
        const problem = validate(next);
        if (problem) {
          error.textContent = problem;
          input.focus();
          return;
        }
      }
      // Resolve before closing so onClose's null does not win the race.
      resolve(next || null);
      close();
      resolve.__done = true;
    };

    backdrop.querySelector('[data-confirm]').addEventListener('click', submit);
    backdrop.querySelector('[data-cancel]').addEventListener('click', () => {
      resolve(null);
      close();
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') submit();
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  });
}

export const modal = { create: createModal, prompt: promptModal };
export default modal;
