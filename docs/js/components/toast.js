/**
 * Toast notifications
 */
import { icon } from '../utils/icons.js';

class ToastManager {
  constructor() {
    this.container = null;
    this.init();
  }

  init() {
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    this.container.id = 'toast-container';
    document.body.appendChild(this.container);
  }

  show(message, options = {}) {
    const {
      title = '',
      type = 'info', // success, error, info, warning
      duration = 4000,
    } = options;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    // Status icon per toast type — inline SVG, tinted by the .toast.<type> rule.
    const iconNames = {
      success: 'check',
      error: 'x',
      info: 'info',
      warning: 'alert-triangle',
    };

    toast.innerHTML = `
      <div class="toast-icon" aria-hidden="true">${icon(iconNames[type] || 'info', { size: 16, strokeWidth: 2 })}</div>
      <div class="toast-content">
        ${title ? `<div class="toast-title">${this.escape(title)}</div>` : ''}
        <div class="toast-message">${this.escape(message)}</div>
      </div>
      <button class="toast-close" aria-label="Close">${icon('x', { size: 14 })}</button>
    `;

    this.container.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    const close = () => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    };

    toast.querySelector('.toast-close').addEventListener('click', close);

    if (duration > 0) {
      setTimeout(close, duration);
    }

    return toast;
  }

  success(message, title = 'Success') {
    return this.show(message, { title, type: 'success' });
  }

  error(message, title = 'Error') {
    return this.show(message, { title, type: 'error', duration: 6000 });
  }

  info(message, title = '') {
    return this.show(message, { title, type: 'info' });
  }

  warning(message, title = 'Heads up') {
    return this.show(message, { title, type: 'warning', duration: 6000 });
  }

  /**
   * Sticky toast with an Undo action — used for deletes, playlist clear,
   * history clear and anything else that used to be irreversible.
   */
  undo(message, onUndo, { title = 'Done', label = 'Undo', duration = 9000 } = {}) {
    const el = this.show(message, { title, type: 'success', duration });
    el.classList.add('toast-actionable');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = label;
    el.querySelector('.toast-content').appendChild(button);

    let used = false;
    button.addEventListener('click', async () => {
      if (used) return;
      used = true;
      button.disabled = true;
      try {
        await onUndo();
      } finally {
        el.classList.remove('show');
        setTimeout(() => el.remove(), 300);
      }
    });
    return el;
  }

  /** Replaceable progress toast; returns a handle with update/finish. */
  progress(message, { title = '' } = {}) {
    const el = this.show(message, { title, type: 'info', duration: 0 });
    el.classList.add('toast-progress');
    const bar = document.createElement('div');
    bar.className = 'toast-progress-bar';
    bar.innerHTML = '<span style="width:0%"></span>';
    el.querySelector('.toast-content').appendChild(bar);
    const fill = bar.firstElementChild;
    return {
      element: el,
      update(percent, text) {
        fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        if (text) el.querySelector('.toast-message').textContent = text;
      },
      finish(text = 'Done', type = 'success') {
        el.className = `toast ${type} show`;
        if (text) el.querySelector('.toast-message').textContent = text;
        setTimeout(() => {
          el.classList.remove('show');
          setTimeout(() => el.remove(), 300);
        }, 2500);
      },
      fail(text = 'Failed') {
        this.finish(text, 'error');
      },
    };
  }

  escape(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

export const toast = new ToastManager();
export default toast;
