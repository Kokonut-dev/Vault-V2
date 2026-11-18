/**
 * 4×4 grid pattern picker (SETTINGS_REVAMP_PLAN.md SR-10).
 *
 * Replaces "8 numbers 0-15 comma-separated" with the same tap grid people
 * use at sign-in. Each cell is a toggle button (aria-pressed) that shows its
 * position in the sequence; the live summary says how many are left. Order
 * is always recorded (it matters when the server has gridOrderMatters on).
 *
 *   const picker = createGridPicker({ length: 8, labelledBy: 'id' });
 *   host.append(picker.el); picker.value(); picker.clear();
 */
export function createGridPicker({ length = 8, labelledBy = '', describedBy = '', onChange = null } = {}) {
  const el = document.createElement('div');
  el.className = 'grid-picker';
  let order = [];

  el.innerHTML = `
    <div class="grid-picker-cells" role="group"${labelledBy ? ` aria-labelledby="${labelledBy}"` : ''}${describedBy ? ` aria-describedby="${describedBy}"` : ''}>
      ${Array.from({ length: 16 }, (_, i) => `
        <button type="button" class="grid-picker-cell" data-cell="${i}" aria-pressed="false"
                aria-label="Row ${Math.floor(i / 4) + 1}, column ${(i % 4) + 1}">
          <span class="grid-picker-step" aria-hidden="true"></span>
        </button>`).join('')}
    </div>
    <div class="grid-picker-foot">
      <p class="grid-picker-status" aria-live="polite"></p>
      <button type="button" class="btn btn-ghost btn-sm grid-picker-clear">Clear</button>
    </div>`;

  const cells = [...el.querySelectorAll('.grid-picker-cell')];
  const status = el.querySelector('.grid-picker-status');
  const clearBtn = el.querySelector('.grid-picker-clear');

  function paint() {
    cells.forEach((cell, i) => {
      const pos = order.indexOf(i);
      const on = pos >= 0;
      cell.setAttribute('aria-pressed', String(on));
      cell.querySelector('.grid-picker-step').textContent = on ? String(pos + 1) : '';
      const base = `Row ${Math.floor(i / 4) + 1}, column ${(i % 4) + 1}`;
      cell.setAttribute('aria-label', on ? `${base}, step ${pos + 1}` : base);
      cell.disabled = !on && order.length >= length;
    });
    const left = length - order.length;
    status.textContent = order.length === 0
      ? `Tap ${length} squares in the order you'll use at sign-in.`
      : left > 0 ? `${order.length} of ${length} chosen — ${left} to go.` : `All ${length} chosen. Tap a square to undo it.`;
    clearBtn.hidden = order.length === 0;
    el.classList.toggle('is-complete', left === 0);
  }

  cells.forEach((cell, i) => {
    cell.addEventListener('click', () => {
      const pos = order.indexOf(i);
      // Undo a square (and everything picked after it, so the sequence stays honest)
      if (pos >= 0) order = order.slice(0, pos);
      else if (order.length < length) order.push(i);
      paint();
      onChange?.(order.slice());
    });
  });

  // Arrow keys move around the grid
  el.querySelector('.grid-picker-cells').addEventListener('keydown', (event) => {
    const idx = cells.indexOf(document.activeElement);
    if (idx < 0) return;
    const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 4, ArrowUp: -4 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    let next = idx + moves[event.key];
    if (next < 0 || next > 15) return;
    if ((event.key === 'ArrowRight' && idx % 4 === 3) || (event.key === 'ArrowLeft' && idx % 4 === 0)) return;
    // Skip disabled cells in that direction
    while (cells[next]?.disabled) {
      next += moves[event.key];
      if (next < 0 || next > 15) return;
    }
    cells[next]?.focus();
  });

  clearBtn.addEventListener('click', () => {
    order = [];
    paint();
    cells[0].focus();
    onChange?.([]);
  });

  paint();
  return {
    el,
    value: () => order.slice(),
    isComplete: () => order.length === length,
    isEmpty: () => order.length === 0,
    clear() { order = []; paint(); },
    focus() { cells.find(c => !c.disabled)?.focus(); },
  };
}

export default createGridPicker;
