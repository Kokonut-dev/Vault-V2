/**
 * Settings UI kit (SETTINGS_REVAMP_PLAN.md SR-4).
 *
 *  - section(): a panel with title, scope chip and a polite "Saved" status
 *  - group():   a tonal block with an h3 inside a section
 *  - row():     label + help on the left, control on the right (stacks on mobile)
 *  - switchRow(): role="switch" checkbox; use ONLY for changes that apply
 *                 immediately (NN/g: switches never sit behind a Save button)
 *  - fieldError()/clearFieldError(): aria-invalid + aria-describedby errors
 *  - secretField(): write-only saved value with a redacted hint (blank keeps,
 *                   Remove is explicit) — saved secrets never enter the DOM
 */
import { icon } from '../../utils/icons.js';
import { escapeHtml } from '../../utils/format.js';

export const SCOPES = {
  device: { label: 'Saved in this browser', icon: 'monitor' },
  server: { label: 'Applies to the whole server', icon: 'hard-drive' },
  account: { label: 'Your account', icon: 'user' },
  info: { label: 'About this install', icon: 'info' },
};

let uid = 0;
export const nextId = (prefix = 'set') => `${prefix}-${++uid}`;

export function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

export function section({ id, title, iconName, scope, intro = '' }) {
  const s = SCOPES[scope] || SCOPES.device;
  const node = el(`
    <section class="settings-section" id="panel-${id}" data-section="${id}" aria-labelledby="heading-${id}" tabindex="-1">
      <header class="settings-section-head">
        <span class="settings-section-icon" aria-hidden="true">${icon(iconName, { size: 20 })}</span>
        <div class="settings-section-titles">
          <h2 class="settings-section-title" id="heading-${id}">${title}</h2>
          ${intro ? `<p class="settings-section-intro">${intro}</p>` : ''}
        </div>
        <div class="settings-section-meta">
          <span class="scope-chip scope-${scope}">${icon(s.icon, { size: 13 })}<span>${s.label}</span></span>
          <span class="save-status" role="status" aria-live="polite"></span>
        </div>
      </header>
      <div class="settings-section-body"></div>
    </section>`);
  node.body = node.querySelector('.settings-section-body');
  return node;
}

export function group(title, { description = '', className = '' } = {}) {
  const node = el(`
    <div class="settings-group ${className}">
      ${title ? `<h3 class="settings-group-title">${title}</h3>` : ''}
      ${description ? `<p class="settings-group-desc">${description}</p>` : ''}
    </div>`);
  return node;
}

/**
 * @param {object} o
 * @param {string} o.label     visible label text
 * @param {string} [o.help]    help text (linked via aria-describedby)
 * @param {string} o.control   control HTML; must contain an element with id=o.id
 * @param {string} [o.id]      id of the labelled control (omit for non-form rows)
 * @param {string} [o.keywords] extra search terms
 * @param {boolean} [o.stack]  put the control under the text (wide controls)
 */
export function row({ label, help = '', control = '', id = '', keywords = '', stack = false, labelTag = 'label' }) {
  const helpId = help && id ? `${id}-help` : '';
  const labelHtml = id && labelTag === 'label'
    ? `<label class="setting-label" for="${id}">${label}</label>`
    : `<span class="setting-label"${id ? ` id="${id}-label"` : ''}>${label}</span>`;
  const node = el(`
    <div class="setting-row${stack ? ' is-stacked' : ''}" data-keywords="${escapeHtml(keywords)}">
      <div class="setting-text">
        ${labelHtml}
        ${help ? `<p class="setting-help"${helpId ? ` id="${helpId}"` : ''}>${help}</p>` : ''}
      </div>
      <div class="setting-control">${control}</div>
    </div>`);
  if (helpId) {
    const target = node.querySelector(`#${CSS.escape(id)}`);
    if (target && !target.hasAttribute('aria-describedby')) target.setAttribute('aria-describedby', helpId);
  }
  return node;
}

export function switchRow({ id, label, help = '', checked = false, keywords = '' }) {
  return row({
    id,
    label,
    help,
    keywords,
    control: `<input type="checkbox" role="switch" class="switch" id="${id}"${checked ? ' checked' : ''}>`,
  });
}

export function rangeControl({ id, min, max, step = 1, value, unit = '', format }) {
  const shown = format ? format(value) : `${value}${unit}`;
  return `<div class="range-control">
    <input type="range" class="slider" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}" aria-valuetext="${escapeHtml(String(shown))}">
    <output class="range-value" for="${id}" id="${id}-value">${escapeHtml(String(shown))}</output>
  </div>`;
}

/** Wire a range so its <output> and aria-valuetext follow the value. */
export function bindRange(root, id, { format, onInput }) {
  const input = root.querySelector(`#${id}`);
  const out = root.querySelector(`#${id}-value`);
  if (!input) return;
  input.addEventListener('input', () => {
    const value = Number(input.value);
    const text = format ? format(value) : String(value);
    if (out) out.textContent = text;
    input.setAttribute('aria-valuetext', text);
    onInput?.(value);
  });
}

/** "Saved" (or other) status in the section header, announced politely. */
export function flashStatus(sectionNode, text = 'Saved', tone = 'ok') {
  const status = sectionNode?.querySelector?.('.save-status') || sectionNode?.closest?.('.settings-section')?.querySelector('.save-status');
  if (!status) return;
  status.dataset.tone = tone;
  status.innerHTML = `${icon(tone === 'error' ? 'alert-circle' : 'check', { size: 14 })}<span>${escapeHtml(text)}</span>`;
  status.classList.add('is-visible');
  clearTimeout(status._t);
  status._t = setTimeout(() => status.classList.remove('is-visible'), 2400);
}

// ---------------------------------------------------------------------------
// Inline validation (WCAG 3.3.1 / 3.3.3)
// ---------------------------------------------------------------------------
function describedBy(input, add, remove) {
  const ids = new Set((input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
  if (remove) ids.delete(remove);
  if (add) ids.add(add);
  if (ids.size) input.setAttribute('aria-describedby', [...ids].join(' '));
  else input.removeAttribute('aria-describedby');
}

export function fieldError(input, message) {
  if (!input) return;
  const errId = `${input.id}-error`;
  let node = document.getElementById(errId);
  if (!node) {
    node = document.createElement('p');
    node.id = errId;
    node.className = 'field-error';
    (input.closest('.setting-control') || input.parentElement).appendChild(node);
  }
  node.innerHTML = `${icon('alert-circle', { size: 14 })}<span>${escapeHtml(message)}</span>`;
  input.setAttribute('aria-invalid', 'true');
  describedBy(input, errId);
}

export function clearFieldError(input) {
  if (!input) return;
  const errId = `${input.id}-error`;
  document.getElementById(errId)?.remove();
  input.removeAttribute('aria-invalid');
  describedBy(input, null, errId);
}

/** Apply a server `fields` map ({ key: message }) using a key → input map. */
export function applyFieldErrors(map, fields = {}) {
  let first = null;
  for (const [key, message] of Object.entries(fields)) {
    const input = map[key];
    if (input) {
      fieldError(input, message);
      first = first || input;
    }
  }
  first?.focus();
  return Boolean(first);
}

/** Validate on blur, re-check while typing only once an error is showing. */
export function liveValidate(input, validate) {
  const check = () => {
    const problem = validate(input.value.trim());
    if (problem) fieldError(input, problem);
    else clearFieldError(input);
    return !problem;
  };
  input.addEventListener('blur', (event) => {
    // Moving to a button in the same form (Save / Test) validates anyway —
    // and an error appearing on mousedown would shift that button out from
    // under the pointer, swallowing the click.
    const next = event.relatedTarget;
    const scope = input.closest('form') || input.closest('.settings-section');
    if (next && next.tagName === 'BUTTON' && scope?.contains(next)) return;
    if (input.value.trim()) check();
  });
  input.addEventListener('input', () => { if (input.getAttribute('aria-invalid') === 'true') check(); });
  return check;
}

export function validateLink(value, { allowLocalPath = false, required = false } = {}) {
  if (!value) return required ? 'Paste a link first' : '';
  if (allowLocalPath && (value.startsWith('/') || /^[a-z]:\\/i.test(value))) {
    return /\.(m3u8?|xml|xmltv|gz)$/i.test(value) ? '' : 'Local files must end in .m3u, .m3u8, .xml or .xml.gz';
  }
  let url;
  try { url = new URL(value); } catch { return 'Enter a full link, starting with http:// or https://'; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Only http:// and https:// links are supported';
  return '';
}

// ---------------------------------------------------------------------------
// Write-only secret fields
// ---------------------------------------------------------------------------
/**
 * @returns {HTMLElement & { value(): (string|undefined), reset(state) }}
 *   value(): undefined = keep saved value, '' = remove, string = replace
 */
export function secretField({ id, label, help = '', state = { configured: false, hint: '' }, type = 'url', placeholder = '', keywords = '', disabled = false, autocomplete = 'off', inputMode = '' }) {
  const node = row({
    id,
    label,
    help,
    keywords,
    stack: true,
    control: `
      <div class="secret-field">
        <div class="secret-saved" hidden>
          <span class="secret-badge">${icon('check', { size: 13 })}<span>Saved</span></span>
          <code class="secret-hint"></code>
          <button type="button" class="btn btn-ghost btn-sm secret-remove"${disabled ? ' disabled' : ''}>Remove</button>
        </div>
        <div class="secret-removed" hidden>
          <span>Will be removed when you save.</span>
          <button type="button" class="btn btn-ghost btn-sm secret-undo">Undo</button>
        </div>
        <input class="form-input" id="${id}" type="${type}" spellcheck="false" autocapitalize="off" autocomplete="${autocomplete}"${inputMode ? ` inputmode="${inputMode}"` : ''}${disabled ? ' disabled' : ''}>
      </div>`,
  });
  const input = node.querySelector(`#${CSS.escape(id)}`);
  const saved = node.querySelector('.secret-saved');
  const removed = node.querySelector('.secret-removed');
  let removing = false;
  let current = state;

  function paint() {
    saved.hidden = !current.configured || removing;
    removed.hidden = !removing;
    node.querySelector('.secret-hint').textContent = current.hint || 'hidden';
    input.placeholder = current.configured && !removing ? 'Paste a new value to replace it' : placeholder;
  }
  node.querySelector('.secret-remove').addEventListener('click', () => {
    removing = true;
    input.value = '';
    clearFieldError(input);
    paint();
    node.querySelector('.secret-undo').focus();
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  node.querySelector('.secret-undo').addEventListener('click', () => {
    removing = false;
    paint();
    node.querySelector('.secret-remove').focus();
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  input.addEventListener('input', () => {
    if (removing && input.value) { removing = false; paint(); }
  });

  node.input = input;
  node.value = () => {
    const typed = input.value.trim();
    if (typed) return typed;
    if (removing) return '';
    return undefined;
  };
  node.isConfigured = () => Boolean(current.configured) && !removing;
  node.reset = (next) => {
    current = next || current;
    removing = false;
    input.value = '';
    clearFieldError(input);
    paint();
  };
  paint();
  return node;
}

/** Disable every control in a container (read-only for non-admin profiles). */
export function setReadOnly(container, message) {
  container.querySelectorAll('input, select, textarea, button').forEach(c => { c.disabled = true; });
  if (message) container.prepend(el(`<p class="settings-callout is-info">${icon('lock', { size: 15 })}<span>${message}</span></p>`));
}

export function busy(button, on, label) {
  if (!button) return;
  if (on) {
    button._label = button.innerHTML;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = `${icon('loader', { size: 15, className: 'icon spin' })}<span>${label || 'Working…'}</span>`;
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button._label) button.innerHTML = button._label;
  }
}
