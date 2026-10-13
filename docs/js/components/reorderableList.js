/**
 * Reorderable track rows — enhances rows already rendered by renderMediaList
 * with drag & drop plus explicit up/down buttons (drag alone is unusable on
 * touch and keyboards). The caller owns persistence: onMove(from, to) should
 * save the new order and re-render; indices match the items order rendered.
 */
import { icon } from '../utils/icons.js';

export function makeReorderable(container, { onMove, onEdit } = {}) {
  const rows = [...container.querySelectorAll('.media-list-item')];
  if (!rows.length || typeof onMove !== 'function') return;
  let fromIndex = null;
  let busy = false;

  const move = async (from, to) => {
    if (busy || from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return;
    busy = true;
    try { await onMove(from, to); } finally { busy = false; }
  };

  rows.forEach((row, index) => {
    row.draggable = true;
    row.classList.add('playlist-item', 'reorderable-item');

    const main = row.querySelector('.media-list-item-main') || row;
    const controls = document.createElement('span');
    controls.className = 'track-controls';
    controls.innerHTML = `
      <span class="drag-handle" aria-hidden="true" title="Drag to reorder">${icon('grip', { size: 14 })}</span>
      <button type="button" class="track-move-btn" data-move="-1" aria-label="Move track up" ${index === 0 ? 'disabled' : ''}>${icon('chevron-up', { size: 14 })}</button>
      <button type="button" class="track-move-btn" data-move="1" aria-label="Move track down" ${index === rows.length - 1 ? 'disabled' : ''}>${icon('chevron-down', { size: 14 })}</button>
      ${onEdit ? '<button type="button" class="track-edit-btn">Edit</button>' : ''}
    `;
    main.prepend(controls);

    controls.querySelectorAll('[data-move]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); move(index, index + Number(btn.dataset.move)); });
    });
    controls.querySelector('.track-edit-btn')?.addEventListener('click', (e) => { e.stopPropagation(); onEdit(index); });
    // Buttons inside the row must not start a drag or trigger playback.
    controls.addEventListener('click', (e) => e.stopPropagation());
    controls.addEventListener('mousedown', (e) => e.stopPropagation());

    row.addEventListener('dragstart', (event) => {
      fromIndex = index;
      row.classList.add('dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        try { event.dataTransfer.setData('text/plain', String(index)); } catch {}
      }
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      rows.forEach(r => r.classList.remove('drop-target'));
    });
    row.addEventListener('dragover', (event) => { event.preventDefault(); row.classList.add('drop-target'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      row.classList.remove('drop-target');
      const from = fromIndex ?? Number(event.dataTransfer?.getData('text/plain'));
      move(from, index);
    });
  });
}
