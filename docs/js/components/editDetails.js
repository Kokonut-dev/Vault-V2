/**
 * "Edit details" — type in the right title, artist, album, year… when the
 * automatic ones (file tags, file name, online match) are wrong.
 *
 * Every media type gets the fields that matter for it (songs: artist, album
 * artist, album, track/disc; episodes: show, season, episode; comics: series,
 * issue…). Saved fields are kept over later rescans; a field typed in by hand
 * shows "Edited" with a Revert button that reads the file's own value again.
 */
import { api } from '../api.js';
import { store } from '../store.js';
import { toast } from './toast.js';
import { createModal } from './modal.js';
import { confirmDialog } from './confirmDialog.js';
import { icon } from '../utils/icons.js';
import { escapeHtml } from '../utils/format.js';
import { uploadAlbumCover } from '../utils/coverUpload.js';
import { fieldError, clearFieldError } from '../views/settings/ui.js';

/** Fields the server can put back to the file's value (see metadataEdit.js). */
export const RESETTABLE_FIELDS = new Set([
  'title', 'artist', 'albumArtist', 'album', 'year', 'genre', 'track', 'disc',
  'composer', 'season', 'episode', 'seriesTitle', 'author', 'narrator', 'series',
  'issue', 'coverArtPath',
]);

const text = (key, label, extra = {}) => ({ key, label, kind: 'text', max: 500, ...extra });
const number = (key, label, min, max, extra = {}) => ({ key, label, kind: 'number', min, max, ...extra });

const TITLE = text('title', 'Title', { wide: true, required: true });
const YEAR = number('year', 'Year', 1800, 2100);
const GENRE = text('genre', 'Genre', { max: 200 });
const DESCRIPTION = { key: 'description', label: 'Description', kind: 'textarea', max: 5000, wide: true };
const TAGS = { key: 'tags', label: 'Tags', kind: 'tags', wide: true, help: 'Separate tags with commas.' };
const RATING = { key: 'rating', label: 'Your rating (0–5)', kind: 'rating' };

/** The fields the dialog shows for an item, by media type. */
export function fieldsFor(item) {
  switch (item?.type) {
    case 'music':
      return [
        TITLE,
        text('artist', 'Artist'),
        text('albumArtist', 'Album artist', { placeholder: 'Same as the artist' }),
        text('album', 'Album', { wide: true }),
        number('track', 'Track number', 0, 10000),
        number('disc', 'Disc number', 0, 1000),
        YEAR,
        GENRE,
        text('composer', 'Composer', { wide: true }),
      ];
    case 'movie':
      // Films and TV episodes are both "movie" items; a season or episode
      // number is what files one under Shows.
      return [
        TITLE, YEAR, GENRE, DESCRIPTION, TAGS, RATING,
        {
          section: 'TV episode',
          help: 'For an episode, fill in the show, season and episode. Leave season and episode empty for a film.',
        },
        text('seriesTitle', 'Show', { wide: true, placeholder: item.seriesKey ? `Detected: ${item.seriesKey}` : 'Not part of a show' }),
        number('season', 'Season', 0, 1000),
        number('episode', 'Episode', 0, 100000),
      ];
    case 'audiobook':
      return [
        TITLE,
        text('artist', 'Author'),
        text('narrator', 'Narrator'),
        text('album', 'Book series', { wide: true }),
        number('track', 'Part', 0, 10000),
        YEAR, GENRE, DESCRIPTION,
      ];
    case 'podcast':
      return [
        TITLE,
        text('album', 'Show'),
        text('artist', 'Host'),
        YEAR, GENRE, DESCRIPTION,
      ];
    case 'comic':
      return [
        TITLE,
        text('series', 'Series'),
        text('issue', 'Issue', { max: 20 }),
        text('author', 'Author'),
        YEAR, GENRE, DESCRIPTION,
      ];
    default:
      return [TITLE, YEAR, GENRE, DESCRIPTION, TAGS, RATING];
  }
}

/** Age-limited (Kids) profiles can't change the library; the server says 403. */
export function canEditDetails() {
  const profile = store.get('profile');
  if (!profile) return true;
  return !(profile.kids || (profile.maxRating !== null && profile.maxRating !== undefined));
}

/** Age ratings decide what Kids profiles see, so only admins edit them. */
function canEditAgeRating() {
  return store.get('profile')?.isAdmin === true;
}

// Older servers stored edits HTML-escaped ("Rock &amp; Roll"); show those as
// the text they were meant to be, so a save fixes them.
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&#x2F;': '/', '&#x5C;': '\\', '&#96;': '`' };
export function decodeEntities(value) {
  return String(value ?? '').replace(/&(amp|lt|gt|quot|#x27|#39|#x2F|#x5C|#96);/g, m => ENTITIES[m] || m);
}

/** The value a field starts with, normalised the same way the form reads it. */
function initialValue(field, item) {
  const raw = item[field.key];
  switch (field.kind) {
    case 'number': return raw === null || raw === undefined || raw === '' ? '' : String(raw);
    case 'rating': return raw ? String(raw) : '0';
    case 'tags': return (Array.isArray(raw) ? raw : []).map(decodeEntities).join(', ');
    default: return decodeEntities(raw);
  }
}

const isManual = (item, key) => Array.isArray(item.manualFields) && item.manualFields.includes(key);

function fieldHtml(field, item) {
  if (field.section) {
    return `<div class="edit-details-section is-wide"><h3 class="edit-details-section-title">${escapeHtml(field.section)}</h3>${field.help ? `<p class="setting-help">${escapeHtml(field.help)}</p>` : ''}</div>`;
  }
  const id = `ed-${field.key}`;
  const value = escapeHtml(initialValue(field, item));
  const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : '';
  const helpId = field.help ? `${id}-help` : '';
  const describedBy = helpId ? ` aria-describedby="${helpId}"` : '';
  let control;
  if (field.kind === 'textarea') {
    control = `<textarea class="form-textarea" id="${id}" maxlength="${field.max}"${describedBy}>${value}</textarea>`;
  } else if (field.kind === 'number') {
    control = `<input type="number" class="form-input" id="${id}" inputmode="numeric" min="${field.min}" max="${field.max}" step="1" value="${value}"${placeholder}${describedBy}>`;
  } else if (field.kind === 'rating') {
    control = `<input type="number" class="form-input" id="${id}" min="0" max="5" step="0.5" value="${value}"${describedBy}>`;
  } else {
    control = `<input type="text" class="form-input" id="${id}" autocomplete="off" maxlength="${field.kind === 'tags' ? 2000 : field.max}" value="${value}"${placeholder}${describedBy}${field.required ? ' required aria-required="true"' : ''}>`;
  }
  return `
    <div class="form-group edit-field${field.wide ? ' is-wide' : ''}" data-field="${field.key}">
      <div class="edit-field-head">
        <label class="form-label" for="${id}">${escapeHtml(field.label)}</label>
        <span class="edit-field-status" data-status="${field.key}">${revertHtml(field, item)}</span>
      </div>
      ${control}
      ${field.help ? `<p class="setting-help" id="${helpId}">${escapeHtml(field.help)}</p>` : ''}
    </div>`;
}

function revertHtml(field, item) {
  if (!isManual(item, field.key)) return '';
  const badge = '<span class="edit-field-badge" title="Typed in by hand — kept when the library is rescanned">Edited</span>';
  if (!RESETTABLE_FIELDS.has(field.key)) return badge;
  return `${badge}<button type="button" class="btn btn-ghost btn-sm edit-field-revert" data-revert="${field.key}" aria-label="Revert ${escapeHtml(field.label.toLowerCase())} to the file’s value" title="Use the file’s own value again">${icon('refresh', { size: 13 })}<span>Revert</span></button>`;
}

/** Read one field. Returns `{ value }` or `{ error }`. */
function readField(field, input) {
  const raw = input.value;
  switch (field.kind) {
    case 'number': {
      const t = raw.trim();
      if (!t) return { value: null };
      if (!/^\d+$/.test(t)) return { error: `${field.label} must be a whole number` };
      const n = Number(t);
      if (n < field.min || n > field.max) return { error: `${field.label} must be from ${field.min} to ${field.max}` };
      return { value: n };
    }
    case 'rating': {
      const n = raw.trim() === '' ? 0 : Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 5) return { error: 'Rating must be between 0 and 5' };
      return { value: n };
    }
    case 'tags':
      return { value: [...new Set(raw.split(',').map(t => t.trim()).filter(Boolean))] };
    case 'textarea':
      return { value: raw.trim() };
    default: {
      const value = raw.replace(/\s+/g, ' ').trim();
      if (field.required && !value) return { error: `${field.label} can’t be empty` };
      return { value };
    }
  }
}

/** Has the field changed from what the dialog opened with? */
function changed(field, value, item) {
  const start = initialValue(field, item);
  switch (field.kind) {
    case 'number': return (start === '' ? null : Number(start)) !== value;
    case 'rating': return Number(start) !== value;
    case 'tags': return (Array.isArray(item.tags) ? item.tags : []).join(', ') !== value.join(', ');
    // Against the stored value, so an old HTML-escaped one is saved as text.
    case 'textarea': return String(item[field.key] ?? '').trim() !== value;
    default: return String(item[field.key] ?? '').replace(/\s+/g, ' ').trim() !== value;
  }
}

/** Keep the client copies (store library + the object the view holds) in step. */
function syncItem(item, updated) {
  if (!updated || typeof updated !== 'object') return;
  Object.assign(item, updated);
  const library = store.get('library') || [];
  const local = library.find(i => i.id === updated.id);
  if (local && local !== item) Object.assign(local, updated);
  store.set('library', [...library]);
}

/**
 * Open the dialog. `onSaved(updatedItem)` runs after a save or a revert so
 * the view behind it can re-render.
 */
export function openEditDetails(item, { onSaved } = {}) {
  if (!item) return null;
  const fields = fieldsFor(item);
  const inputs = {};
  const showAge = canEditAgeRating() && item.type !== 'music';
  const isTrack = item.type === 'music';
  const hasRevertable = () => fields.some(f => f.key && RESETTABLE_FIELDS.has(f.key) && isManual(item, f.key));

  const { backdrop, close } = createModal({
    title: 'Edit details',
    content: `
      <form class="edit-details-form" novalidate>
        <p class="setting-help edit-details-intro">Correct anything the automatic details got wrong. What you type here is kept when the library is rescanned.</p>
        <div class="edit-details-grid">
          ${fields.map(f => fieldHtml(f, item)).join('')}
          ${showAge ? `<div class="form-group edit-field" data-field="contentRating">
            <label class="form-label" for="ed-contentRating">Age rating</label>
            <input type="text" class="form-input" id="ed-contentRating" maxlength="24" autocomplete="off" placeholder="e.g. PG, 12, PG-13, 16" aria-describedby="ed-contentRating-help" value="${escapeHtml(item.contentRating || '')}">
            <p class="setting-help" id="ed-contentRating-help">Used by profiles with an age limit. Leave empty for unrated.</p>
          </div>` : ''}
          ${isTrack ? `<div class="form-group edit-field is-wide" data-field="cover">
            <label class="form-label" for="ed-cover">Cover art</label>
            <input type="file" class="form-input" id="ed-cover" accept="image/*">
          </div>` : ''}
        </div>
        <div class="modal-actions edit-details-actions">
          <button type="button" class="btn btn-ghost" data-revert-all ${hasRevertable() ? '' : 'hidden'}>${icon('refresh', { size: 14 })}<span>Revert all to file</span></button>
          <span class="edit-details-spacer"></span>
          <button type="button" class="btn btn-secondary" data-cancel>Cancel</button>
          <button type="submit" class="btn btn-primary" data-save>Save</button>
        </div>
      </form>`,
  });
  backdrop.querySelector('.modal')?.classList.add('edit-details-modal');

  for (const field of fields) {
    if (!field.key) continue;
    inputs[field.key] = backdrop.querySelector(`#ed-${field.key}`);
    inputs[field.key]?.addEventListener('input', () => clearFieldError(inputs[field.key]));
  }
  const ageInput = backdrop.querySelector('#ed-contentRating');
  const form = backdrop.querySelector('form');
  const saveBtn = backdrop.querySelector('[data-save]');
  const revertAllBtn = backdrop.querySelector('[data-revert-all]');
  backdrop.querySelector('[data-cancel]').addEventListener('click', close);
  // Put the cursor in the first field instead of on the close button.
  setTimeout(() => { inputs.title?.focus(); inputs.title?.select?.(); }, 0);

  /** Re-draw the Edited/Revert markers and refill reverted inputs. */
  const refresh = (resetKeys = []) => {
    for (const field of fields) {
      if (!field.key) continue;
      const status = backdrop.querySelector(`[data-status="${field.key}"]`);
      if (status) status.innerHTML = revertHtml(field, item);
      if (resetKeys.includes(field.key) && inputs[field.key]) {
        inputs[field.key].value = initialValue(field, item);
        clearFieldError(inputs[field.key]);
      }
    }
    revertAllBtn.hidden = !hasRevertable();
  };

  const revert = async (keys) => {
    try {
      const updated = await api.resetItemMetadata(item.id, keys);
      syncItem(item, updated);
      refresh(keys || fields.map(f => f.key).filter(k => k && RESETTABLE_FIELDS.has(k)));
      toast.success(keys?.length === 1 ? 'Reverted to the file’s value' : 'Reverted to the file’s details');
      await onSaved?.(item);
    } catch (err) {
      toast.error(`Could not revert: ${err.message}`);
    }
  };

  backdrop.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-revert]');
    if (button) revert([button.dataset.revert]);
  });

  revertAllBtn.addEventListener('click', async () => {
    const { confirmed } = await confirmDialog({
      title: 'Revert to the file’s details?',
      message: 'Every field you typed in by hand goes back to what the file says. Rating, description and tags stay as they are.',
      confirmLabel: 'Revert all',
    });
    if (confirmed) revert(undefined);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const updates = {};
    const errors = {};
    for (const field of fields) {
      if (!field.key || !inputs[field.key]) continue;
      const result = readField(field, inputs[field.key]);
      if (result.error) { errors[field.key] = result.error; continue; }
      if (changed(field, result.value, item)) updates[field.key] = result.value;
    }
    if (ageInput && ageInput.value.trim() !== (item.contentRating || '')) {
      updates.contentRating = ageInput.value.trim() || null;
    }
    if (showErrors(errors)) return;

    const cover = backdrop.querySelector('#ed-cover')?.files?.[0];
    if (!Object.keys(updates).length && !cover) {
      close();
      return;
    }

    saveBtn.disabled = true;
    try {
      if (cover) {
        const result = await uploadAlbumCover([item.id], cover);
        if (result?.items?.[0]) syncItem(item, result.items[0]);
      }
      if (Object.keys(updates).length) {
        const updated = await api.updateItem(item.id, updates);
        syncItem(item, updated);
      }
      toast.success('Details saved');
      close();
      await onSaved?.(item);
    } catch (err) {
      saveBtn.disabled = false;
      if (!showErrors(err.fields || {})) toast.error(err.message);
    }
  });

  function showErrors(errors) {
    let first = null;
    for (const [key, message] of Object.entries(errors)) {
      const input = inputs[key] || (key === 'contentRating' ? ageInput : null);
      if (!input) continue;
      fieldError(input, message);
      first = first || input;
    }
    first?.focus();
    return Boolean(first);
  }

  return { backdrop, close };
}
