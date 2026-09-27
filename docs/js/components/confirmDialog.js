/**
 * confirmDialog / alertDialog — promise-based replacements for native
 * confirm()/alert(), so destructive flows share the app's modal design
 * language (focus trap, Escape, backdrop dismiss, typography).
 *
 * Both resolve when the dialog closes:
 *   confirmDialog → { confirmed: boolean, checked: boolean }
 *                   (checked only meaningful when options.checkbox is given;
 *                    backdrop/Escape resolve confirmed:false)
 *   alertDialog   → void
 */
import { createModal } from './modal.js';

const escapeText = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const uid = () => `cd-${Math.random().toString(36).slice(2, 8)}`;

export function confirmDialog({
  title = 'Are you sure?',
  message = '',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = false,
  checkbox = null, // { label, checked }
} = {}) {
  return new Promise((resolve) => {
    const id = uid();
    const cbId = `${id}-cb`;
    const content = `
      <p style="font-size:14px; line-height:1.6; color:var(--text-secondary); margin-bottom:${checkbox ? '14px' : '0'};">${escapeText(message)}</p>
      ${checkbox ? `
        <label style="display:flex; gap:8px; align-items:center; font-size:13px; color:var(--text-secondary); cursor:pointer;">
          <input type="checkbox" id="${cbId}" ${checkbox.checked ? 'checked' : ''}> ${escapeText(checkbox.label)}
        </label>` : ''}
      <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:20px;">
        <button type="button" class="btn btn-secondary" id="${id}-cancel">${escapeText(cancelText)}</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="${id}-ok">${escapeText(confirmText)}</button>
      </div>
    `;

    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const modal = createModal({
      title,
      content,
      onClose: () => settle({ confirmed: false, checked: false }),
    });

    modal.backdrop.querySelector(`#${id}-cancel`).addEventListener('click', () => {
      settle({ confirmed: false, checked: false });
      modal.close();
    });
    modal.backdrop.querySelector(`#${id}-ok`).addEventListener('click', () => {
      const cb = modal.backdrop.querySelector(`#${cbId}`);
      settle({ confirmed: true, checked: cb ? cb.checked : false });
      modal.close();
    });
  });
}

export function alertDialog({ title = 'Details', contentHtml = '' } = {}) {
  return new Promise((resolve) => {
    const id = uid();
    const content = `
      <div style="font-size:13px; color:var(--text-secondary); line-height:1.6;">${contentHtml}</div>
      <div style="display:flex; justify-content:flex-end; margin-top:20px;">
        <button type="button" class="btn btn-primary" id="${id}-ok">Done</button>
      </div>
    `;

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const modal = createModal({
      title,
      content,
      onClose: settle,
    });

    modal.backdrop.querySelector(`#${id}-ok`).addEventListener('click', () => {
      settle();
      modal.close();
    });
  });
}
