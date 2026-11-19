/**
 * Profiles — "Who's watching?" picker plus management.
 *
 * Everyone can switch profile and edit their own name, avatar, colour and
 * PIN. Admin profiles can also add and delete profiles, grant admin rights
 * and set age limits (Kids profiles). Backed by /api/profiles; the server
 * keeps favourites, history, playlists and resume points per profile and
 * enforces the age limits.
 */
import { api } from '../api.js';
import { store } from '../store.js';
import { icon } from '../utils/icons.js';
import { escapeHtml } from '../utils/format.js';
import { toast } from '../components/toast.js';
import { promptModal, createModal } from '../components/modal.js';
import { confirmDialog } from '../components/confirmDialog.js';
import { router } from '../router.js';
import { prepareProfileSwitch, rememberProfile } from '../profileSession.js';

export const AVATARS = ['🍿', '🎬', '🎵', '🎧', '📺', '🕹️', '📚', '🌙', '🦊', '🐻', '🐼', '🦁', '🐙', '🚀', '⚽', '🎨'];
// Fallbacks for an older server that doesn't send them.
const DEFAULT_COLORS = ['#5B87C9', '#4D9A8C', '#C48A3F', '#B5636F', '#6D9656', '#8574AE', '#BF6B4C', '#5E8A9B'];
const DEFAULT_AGE_LIMITS = [
  { age: 0, label: 'All ages (G, U, AL)' },
  { age: 6, label: 'Up to 6' },
  { age: 9, label: 'Up to 9 (PG)' },
  { age: 12, label: 'Up to 12' },
  { age: 14, label: 'Up to 14 (PG-13, TV-14)' },
  { age: 16, label: 'Up to 16' },
];
const PIN_PATTERN = /^\d{4,8}$/;

/** The avatar a profile shows: its own pick, or a stable default. */
export function avatarFor(profile) {
  if (profile?.avatar) return profile.avatar;
  const name = profile?.name || '?';
  return AVATARS[name.codePointAt(0) % 8];
}

function avatarHtml(profile, size = '') {
  const color = /^#[0-9a-f]{3,6}$/i.test(profile?.color || '') ? profile.color : 'var(--border-strong)';
  const inner = profile?.avatar && /^https:\/\//.test(profile.avatar)
    ? `<img src="${escapeHtml(profile.avatar)}" alt="">`
    : escapeHtml(avatarFor(profile));
  return `<span class="profile-avatar${size}" style="--profile-color:${color}" aria-hidden="true">${inner}</span>`;
}

function ageLabel(age) {
  if (age === null || age === undefined || age === '') return '';
  return Number(age) === 0 ? 'All ages' : `Up to ${Number(age)}`;
}

function metaFor(profile) {
  return [
    profile.isAdmin ? 'Admin' : '',
    profile.kids ? 'Kids' : '',
    ageLabel(profile.maxRating),
    profile.hasPin ? 'PIN' : '',
  ].filter(Boolean).join(' · ');
}

async function askPin(profile, message = '') {
  return promptModal({
    title: `PIN for ${profile.name}`,
    message,
    label: 'PIN',
    inputType: 'password',
    inputMode: 'numeric',
    confirmLabel: 'Continue',
  });
}

/** Switch this device to another profile, asking for its PIN if it has one. */
export async function switchToProfile(profile) {
  let pin = null;
  let message = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    if (profile.hasPin) {
      pin = await askPin(profile, message);
      if (pin === null) return false;
    }
    try {
      const result = await api.switchProfile(profile.id, pin);
      prepareProfileSwitch(result?.profile || profile, result?.token);
      toast.success(`Now watching as ${profile.name}`);
      window.dispatchEvent(new CustomEvent('vault:profile-switched', { detail: { id: profile.id } }));
      // A full reload: the library, favourites, history and queue all
      // belong to the new profile now.
      const base = (window.VAULT_CONFIG && window.VAULT_CONFIG.basePath) || '';
      window.location.assign(`${base}/`);
      return true;
    } catch (err) {
      if (err.code === 'PROFILE_PIN_REQUIRED' && profile.hasPin) {
        message = 'That PIN isn’t right. Try again.';
        continue;
      }
      toast.error(`Could not switch profile: ${err.message}`);
      return false;
    }
  }
  return false;
}

export async function renderProfiles(container) {
  container.className = 'page';
  let data;
  try {
    data = await api.getProfiles();
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-title">Could not load profiles</div>
      <div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
    return;
  }
  const profiles = data.profiles || data.items || [];
  const options = {
    colors: Array.isArray(data.colors) && data.colors.length ? data.colors : DEFAULT_COLORS,
    ageLimits: Array.isArray(data.ageLimits) && data.ageLimits.length ? data.ageLimits : DEFAULT_AGE_LIMITS,
  };
  // The server knows which profile this session uses; the local value is
  // only a fallback for an older server.
  const currentId = data.activeProfileId || store.get('profileId') || 'default';
  const current = profiles.find(p => p.id === currentId) || null;
  if (current) rememberProfile(current);
  const isAdmin = Boolean(current?.isAdmin);
  const admins = profiles.filter(p => p.isAdmin);
  const rerender = () => renderProfiles(container);

  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${icon('user', { size: 26 })}<span>Who's watching?</span></h1>
      <p class="page-subtitle">Each profile keeps its own favourites, history, playlists and resume points</p>
    </div>
    <div class="profile-picker">
      ${profiles.map(profile => {
        const isCurrent = profile.id === current?.id;
        const meta = metaFor(profile);
        return `
        <button type="button" class="profile-card${isCurrent ? ' current' : ''}" data-profile="${escapeHtml(profile.id)}"
          aria-label="${escapeHtml(isCurrent ? `${profile.name} (current profile)` : `Switch to ${profile.name}`)}"${isCurrent ? ' aria-current="true"' : ''}>
          ${avatarHtml(profile)}
          <span class="profile-name">${escapeHtml(profile.name)}</span>
          <span class="profile-meta">${escapeHtml(meta) || '&nbsp;'}</span>
          ${isCurrent ? '<span class="profile-badge">Current</span>' : ''}
        </button>`;
      }).join('')}
      ${isAdmin && profiles.length < 12 ? `<button type="button" class="profile-card" id="profile-new">
        <span class="profile-avatar" aria-hidden="true">${icon('user-plus', { size: 30 })}</span>
        <span class="profile-name">Add profile</span>
        <span class="profile-meta">For someone else, or a Kids profile</span>
      </button>` : ''}
    </div>
    ${isAdmin ? manageSection(profiles, current) : `
    ${current ? selfSection(current) : ''}
    <p class="profile-note">${icon('lock', { size: 15 })}<span>Only an admin profile can add or remove profiles, change age limits, or change server settings.
      ${admins.length ? `Admin ${admins.length === 1 ? 'profile' : 'profiles'}: ${admins.map(a => `<strong>${escapeHtml(a.name)}</strong>`).join(', ')}.` : ''}</span></p>`}
  `;

  container.querySelectorAll('[data-profile]').forEach(card => {
    card.addEventListener('click', async () => {
      const profile = profiles.find(p => p.id === card.dataset.profile);
      if (!profile) return;
      if (profile.id === current?.id) {
        // Already this profile ("who's watching?" → me): carry on.
        router.navigate('/');
        return;
      }
      await switchToProfile(profile);
    });
  });

  container.querySelectorAll('[data-edit]').forEach(button => {
    button.addEventListener('click', async () => {
      const profile = profiles.find(p => p.id === button.dataset.edit);
      if (!profile) return;
      const saved = await openProfileEditor({ profile, isAdmin, isSelf: profile.id === current?.id, options });
      if (saved) rerender();
    });
  });

  if (isAdmin) wireManage(container, profiles, current, rerender);

  container.querySelector('#profile-new')?.addEventListener('click', async () => {
    const saved = await openProfileEditor({ profile: null, isAdmin: true, isSelf: false, options, count: profiles.length });
    if (saved) rerender();
  });
}

/** Everyone else: edit your own name, avatar, colour and PIN. */
function selfSection(current) {
  return `
    <section class="profile-self" aria-labelledby="profile-self-title">
      <div class="setting-row">
        <div class="setting-text">
          <span class="setting-label" id="profile-self-title">Your profile</span>
          <p class="setting-help">Change your name, picture, colour or PIN.</p>
        </div>
        <div class="setting-control">
          <button type="button" class="btn btn-secondary btn-sm" data-edit="${escapeHtml(current.id)}">${icon('pencil', { size: 14 })}<span>Edit</span></button>
        </div>
      </div>
    </section>`;
}

/** Admin-only list: edit, grant/remove admin rights and delete profiles. */
function manageSection(profiles, current) {
  return `
    <section class="profile-manage" aria-labelledby="profile-manage-title">
      <h2 class="profile-manage-title" id="profile-manage-title">Manage profiles</h2>
      <p class="setting-help">Admins can change server settings (Live TV, links, notifications) and manage profiles. Vault always keeps at least one admin.</p>
      <div class="profile-manage-list">
        ${profiles.map(profile => {
          const name = escapeHtml(profile.name);
          const id = escapeHtml(profile.id);
          const isCurrent = profile.id === current?.id;
          const description = [
            isCurrent ? 'This profile (the one you’re using)' : profile.kids ? 'Kids profile' : 'Profile',
            ageLabel(profile.maxRating) ? `age limit: ${ageLabel(profile.maxRating).toLowerCase()}` : '',
            profile.maxRating !== null && profile.maxRating !== undefined || profile.kids
              ? (profile.allowUnrated ? 'unrated films shown' : 'unrated films hidden') : '',
          ].filter(Boolean).join(' · ');
          return `<div class="setting-row" data-manage-row="${id}">
            <div class="setting-text profile-manage-who">
              ${avatarHtml(profile, ' profile-avatar-sm')}
              <span>
                <span class="setting-label">${name}</span>
                <span class="setting-help">${escapeHtml(description)}</span>
              </span>
            </div>
            <div class="setting-control profile-manage-actions">
              <button type="button" class="btn btn-ghost btn-sm" data-edit="${id}" aria-label="Edit profile ${name}">${icon('pencil', { size: 14 })}<span>Edit</span></button>
              <label class="profile-admin-toggle">
                <input type="checkbox" role="switch" class="switch" data-admin="${id}" aria-label="Admin rights for ${name}"${profile.isAdmin ? ' checked' : ''}>
                <span aria-hidden="true">Admin</span>
              </label>
              <button type="button" class="btn btn-ghost btn-sm" data-delete="${id}" aria-label="Delete profile ${name}"${isCurrent ? ' disabled title="Switch to another profile to delete this one"' : ''}>${icon('trash', { size: 14 })}<span>Delete</span></button>
            </div>
          </div>`;
        }).join('')}
      </div>
    </section>`;
}

function wireManage(container, profiles, current, rerender) {
  container.querySelectorAll('[data-admin]').forEach(input => {
    input.addEventListener('change', async () => {
      const profile = profiles.find(p => p.id === input.dataset.admin);
      const want = input.checked;
      input.disabled = true;
      try {
        await api.updateProfile(profile.id, { isAdmin: want });
        toast.success(want ? `${profile.name} is now an admin` : `${profile.name} is no longer an admin`);
        rerender();
      } catch (err) {
        input.checked = !want;
        input.disabled = false;
        toast.error(err.message);
      }
    });
  });
  container.querySelectorAll('[data-delete]').forEach(button => {
    button.addEventListener('click', async () => {
      const profile = profiles.find(p => p.id === button.dataset.delete);
      if (!profile || profile.id === current?.id) return;
      if (await deleteProfile(profile)) rerender();
    });
  });
}

/**
 * Create (profile = null) or edit a profile. Resolves true when saved.
 * Non-admins only get the fields they may change about themselves.
 */
export function openProfileEditor({ profile, isAdmin, isSelf, options = {}, count = 0 }) {
  const colors = options.colors || DEFAULT_COLORS;
  const ageLimits = options.ageLimits || DEFAULT_AGE_LIMITS;
  const creating = !profile;
  const draft = {
    name: profile?.name || '',
    avatar: profile?.avatar || null,
    color: profile?.color || colors[count % colors.length],
    kids: Boolean(profile?.kids),
    maxRating: profile?.maxRating ?? null,
    allowUnrated: profile ? profile.allowUnrated !== false : true,
  };
  const uid = `pe-${Math.random().toString(36).slice(2, 8)}`;
  const limitValues = ageLimits.map(l => Number(l.age));
  const limitOptions = [
    `<option value="">No age limit</option>`,
    ...ageLimits.map(l => `<option value="${Number(l.age)}">${escapeHtml(l.label)}</option>`),
    // Keep an unusual stored value selectable instead of silently changing it.
    ...(draft.maxRating !== null && !limitValues.includes(Number(draft.maxRating))
      ? [`<option value="${Number(draft.maxRating)}">Up to ${Number(draft.maxRating)}</option>`] : []),
  ].join('');
  const needsCurrentPin = !isAdmin && isSelf && profile?.hasPin;
  // Plain text: createModal escapes the title.
  const title = creating ? 'New profile' : `Edit ${profile.name}`;

  return new Promise(resolve => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const { backdrop, close } = createModal({
      title,
      onClose: () => finish(false),
      content: `
        <form class="profile-editor" novalidate>
          <div class="form-group">
            <label class="form-label" for="${uid}-name">Name</label>
            <input class="form-input" id="${uid}-name" name="name" maxlength="40" autocomplete="off" required value="${escapeHtml(draft.name)}" placeholder="e.g. Robin">
          </div>

          <fieldset class="form-group profile-editor-set">
            <legend class="form-label">Picture</legend>
            <div class="profile-avatar-choices" role="radiogroup" aria-label="Picture">
              ${AVATARS.map((emoji, i) => `<label class="profile-avatar-choice">
                <input type="radio" name="avatar" value="${escapeHtml(emoji)}"${(draft.avatar || (creating ? '' : avatarFor(profile))) === emoji ? ' checked' : ''} aria-label="Picture ${i + 1}">
                <span aria-hidden="true">${escapeHtml(emoji)}</span>
              </label>`).join('')}
            </div>
          </fieldset>

          <fieldset class="form-group profile-editor-set">
            <legend class="form-label">Colour</legend>
            <div class="swatch-group" role="radiogroup" aria-label="Colour">
              ${colors.map((c, i) => `<label class="swatch">
                <input type="radio" name="color" value="${escapeHtml(c)}"${String(draft.color).toLowerCase() === String(c).toLowerCase() ? ' checked' : ''} aria-label="Colour ${i + 1}">
                <span class="swatch-dot" style="--swatch:${escapeHtml(c)}"></span>
              </label>`).join('')}
            </div>
          </fieldset>

          <div class="form-group">
            <label class="form-label" for="${uid}-pin">${profile?.hasPin ? 'New PIN' : 'PIN'} <span class="profile-editor-optional">(optional, 4–8 digits)</span></label>
            <input class="form-input" id="${uid}-pin" name="pin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="8"
              placeholder="${profile?.hasPin ? 'Leave empty to keep the current PIN' : 'No PIN'}" aria-describedby="${uid}-pin-help">
            <p class="setting-help" id="${uid}-pin-help">A PIN is asked for when someone switches to this profile or signs in with it.</p>
            ${profile?.hasPin ? `<label class="profile-editor-check"><input type="checkbox" class="checkbox" name="clearPin"> Remove the PIN</label>` : ''}
          </div>
          ${needsCurrentPin ? `<div class="form-group">
            <label class="form-label" for="${uid}-current-pin">Current PIN</label>
            <input class="form-input" id="${uid}-current-pin" name="currentPin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="8">
            <p class="setting-help">Needed to change or remove your PIN.</p>
          </div>` : ''}

          ${isAdmin ? `
          <fieldset class="form-group profile-editor-set profile-editor-limits">
            <legend class="form-label">Age limit</legend>
            <label class="profile-editor-switch">
              <input type="checkbox" role="switch" class="switch" name="kids"${draft.kids ? ' checked' : ''}>
              <span>Kids profile</span>
            </label>
            <label class="form-label" for="${uid}-limit">Show films and shows rated</label>
            <select class="form-select" id="${uid}-limit" name="maxRating">${limitOptions}</select>
            <label class="profile-editor-switch">
              <input type="checkbox" role="switch" class="switch" name="allowUnrated"${draft.allowUnrated ? ' checked' : ''}>
              <span>Also show films and videos without an age rating</span>
            </label>
            <p class="setting-help">Ratings come from .nfo files, metadata matches, or the item’s Edit dialog (G, PG, PG-13, 12, 16…). Music and audiobooks are only limited when they have a rating. Age-limited profiles can’t edit the library.</p>
          </fieldset>` : ''}

          <p class="modal-error" role="alert" data-error></p>
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" data-cancel>Cancel</button>
            <button type="submit" class="btn btn-primary" data-save>${creating ? 'Create profile' : 'Save'}</button>
          </div>
        </form>`,
    });

    const form = backdrop.querySelector('form');
    const errorEl = backdrop.querySelector('[data-error]');
    const limit = form.elements.maxRating;
    if (limit) limit.value = draft.maxRating === null ? '' : String(draft.maxRating);

    // Turning Kids on picks a sensible limit and hides unrated films; the
    // admin can still change both before saving.
    form.elements.kids?.addEventListener('change', () => {
      if (form.elements.kids.checked) {
        if (limit && limit.value === '') limit.value = limitValues.includes(9) ? '9' : String(limitValues[0] ?? '');
        if (form.elements.allowUnrated) form.elements.allowUnrated.checked = false;
      }
    });
    form.elements.clearPin?.addEventListener('change', () => {
      form.elements.pin.disabled = form.elements.clearPin.checked;
      if (form.elements.clearPin.checked) form.elements.pin.value = '';
    });

    backdrop.querySelector('[data-cancel]').addEventListener('click', () => { finish(false); close(); });
    setTimeout(() => form.elements.name.focus(), 0);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorEl.textContent = '';
      const name = form.elements.name.value.trim();
      if (!name) {
        errorEl.textContent = 'A profile needs a name.';
        form.elements.name.focus();
        return;
      }
      const pin = form.elements.pin.value.trim();
      if (pin && !PIN_PATTERN.test(pin)) {
        errorEl.textContent = 'A PIN is 4 to 8 digits.';
        form.elements.pin.focus();
        return;
      }
      const body = { name };
      const avatar = form.querySelector('input[name="avatar"]:checked')?.value;
      const color = form.querySelector('input[name="color"]:checked')?.value;
      // The pre-selected default picture is only saved once it's changed.
      if (avatar && avatar !== (profile ? avatarFor(profile) : null)) body.avatar = avatar;
      if (color) body.color = color;
      if (pin) body.pin = pin;
      else if (form.elements.clearPin?.checked) body.pin = null;
      if (needsCurrentPin && body.pin !== undefined) body.currentPin = form.elements.currentPin.value.trim();
      if (isAdmin) {
        body.kids = form.elements.kids.checked;
        body.maxRating = limit.value === '' ? null : Number(limit.value);
        body.allowUnrated = form.elements.allowUnrated.checked;
      }

      const saveBtn = backdrop.querySelector('[data-save]');
      saveBtn.disabled = true;
      try {
        const saved = creating ? await api.createProfile(body) : await api.updateProfile(profile.id, body);
        if (isSelf && saved) rememberProfile(saved);
        toast.success(creating ? `Profile “${name}” created` : 'Profile saved');
        finish(true);
        close();
      } catch (err) {
        saveBtn.disabled = false;
        errorEl.textContent = err.message;
      }
    });
  });
}

export async function deleteProfile(profile) {
  // confirmDialog resolves { confirmed, checked }; the object is always truthy.
  const { confirmed } = await confirmDialog({
    title: `Delete profile "${profile.name}"?`,
    message: 'Its favourites, history, playlists, watchlist and resume points are deleted, and devices using it are signed out. Files in the library are never touched.',
    confirmLabel: 'Delete profile',
    danger: true,
  });
  if (!confirmed) return false;
  try {
    await api.deleteProfile(profile.id);
    toast.success('Profile deleted');
    return true;
  } catch (err) {
    toast.error(err.message);
    return false;
  }
}

export default { renderProfiles, openProfileEditor, switchToProfile };
