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

  escape(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

export const toast = new ToastManager();
export default toast;
