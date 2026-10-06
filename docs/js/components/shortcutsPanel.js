/**
 * Keyboard shortcuts panel — triggered by ? key
 */
import { KEYBOARD_SHORTCUTS } from '../utils/constants.js';
import { createFocusTrap } from '../utils/focusTrap.js';
import { icon } from '../utils/icons.js';

export function initShortcutsPanel() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.id = 'shortcuts-backdrop';
  backdrop.innerHTML = `
    <div class="modal" style="max-width:600px;">
      <div class="modal-header">
        <div class="modal-title">Keyboard Shortcuts</div>
        <button class="modal-close" id="shortcuts-close" aria-label="Close">${icon('x', { size: 16 })}</button>
      </div>
      <div class="modal-body">
        ${Object.entries(KEYBOARD_SHORTCUTS).map(([section, shortcuts]) => `
          <div style="margin-bottom:24px;">
            <h3 style="font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-tertiary); margin-bottom:12px;">${section}</h3>
            <div style="display:flex; flex-direction:column; gap:8px;">
              ${shortcuts.map(s => `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:rgba(var(--glass-tint),0.05); border-radius:8px;">
                  <span style="font-size:13px; color:var(--text-secondary);">${s.desc}</span>
                  <kbd style="background:rgba(var(--glass-tint),0.09); border:1px solid rgba(var(--glass-tint),0.1); border-bottom-width:2px; padding:2px 8px; border-radius:6px; font-size:11px; font-family:var(--font-mono);">${s.key}</kbd>
                </div>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="shortcuts-ok">Got it</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(backdrop);
  
  let trap = null;
  const close = () => {
    backdrop.classList.remove('active');
    if (trap) {
      trap.release();
      trap = null;
    }
  };
  
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  
  backdrop.querySelector('#shortcuts-close').addEventListener('click', close);
  backdrop.querySelector('#shortcuts-ok').addEventListener('click', close);
  
  window.addEventListener('vault:show-shortcuts', () => {
    backdrop.classList.add('active');
    trap = createFocusTrap(backdrop, {
      initialFocus: () => backdrop.querySelector('#shortcuts-close'),
    });
    trap.activate();
  });
  
  window.addEventListener('vault:escape', () => {
    if (backdrop.classList.contains('active')) close();
  });
}
