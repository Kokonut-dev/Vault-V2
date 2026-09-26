/**
 * Generic modal helper
 */
export function createModal({ title, content, onClose }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop active';
  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">${title}</div>
        <button class="modal-close">✕</button>
      </div>
      <div class="modal-body">${content}</div>
    </div>
  `;
  document.body.appendChild(backdrop);
  
  const close = () => {
    backdrop.remove();
    onClose?.();
  };
  
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  
  return { backdrop, close };
}
