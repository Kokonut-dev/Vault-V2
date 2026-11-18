/**
 * Profiles — Netflix-style "who's watching" picker plus management
 * (create / rename / delete / pin / per-profile summary).
 * Backed by /api/profiles (server keeps per-profile libraries & history).
 */
import { api } from '../api.js';
import { store } from '../store.js';
import { icon } from '../utils/icons.js';
import { escapeHtml } from '../utils/format.js';
import { toast } from '../components/toast.js';
import { promptModal, createModal } from '../components/modal.js';
import { confirmDialog } from '../components/confirmDialog.js';

const AVATARS = ['🍿', '🎬', '🎵', '🎧', '📺', '🕹️', '📚', '🌙'];

export async function renderProfiles(container) {
  container.className = 'page';
  let profiles = [];
  try {
    const data = await api.getProfiles();
    profiles = data.profiles || data.items || [];
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-title">Could not load profiles</div>
      <div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
    return;
  }
  const current = profiles.find(p => p.id === (store.get('profileId') || 'default'));
  const isAdmin = Boolean(current?.isAdmin);
  const admins = profiles.filter(p => p.isAdmin);
  const metaFor = (profile) => [
    `${profile.itemCount ?? 0} items`,
    profile.isAdmin ? 'Admin' : '',
    profile.kids ? 'Kids' : '',
    profile.hasPin ? 'PIN' : '',
  ].filter(Boolean).join(' · ');

  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${icon('user', { size: 26 })}<span>Who's watching?</span></h1>
      <p class="page-subtitle">Each profile keeps its own watchlist, history, playlists and resume positions</p>
    </div>
    <div class="profile-picker">
      ${profiles.map(profile => `
        <button type="button" class="profile-card${profile.id === current?.id ? ' current' : ''}" data-profile="${profile.id}">
          <span class="profile-avatar">${(() => {
            if (profile.avatar && profile.avatar.startsWith('http')) return `<img src="${escapeHtml(profile.avatar)}" alt="">`;
            return escapeHtml(profile.avatar || AVATARS[(profile.name || '?').charCodeAt(0) % AVATARS.length]);
          })()}</span>
          <span class="profile-name">${escapeHtml(profile.name)}</span>
          <span class="profile-meta">${metaFor(profile)}</span>
          ${profile.id === current?.id ? '<span class="profile-badge">Current</span>' : ''}
        </button>`).join('')}
      ${isAdmin ? `<button type="button" class="profile-card" id="profile-new">
        <span class="profile-avatar" aria-hidden="true">${icon('user-plus', { size: 30 })}</span>
        <span class="profile-name">Add profile</span>
        <span class="profile-meta">A separate space for someone else</span>
      </button>` : ''}
    </div>
    ${isAdmin ? manageSection(profiles, current) : `
    <p class="profile-note">${icon('lock', { size: 15 })}<span>Only an admin profile can add or remove profiles, change rating limits, or change server settings.
      ${admins.length ? `Admin ${admins.length === 1 ? 'profile' : 'profiles'}: ${admins.map(a => `<strong>${escapeHtml(a.name)}</strong>`).join(', ')}.` : ''}</span></p>`}
  `;

  container.querySelectorAll('[data-profile]').forEach(card => {
    card.addEventListener('click', async () => {
      const id = card.dataset.profile;
      const profile = profiles.find(p => p.id === id);
      let pin = null;
      if (profile?.hasPin) {
        pin = await promptModal({ title: `PIN for ${profile.name}`, label: 'PIN', confirmLabel: 'Continue' });
        if (pin === null) return;
      }
      try {
        const result = await api.switchProfile(id, pin);
        if (result?.token) localStorage.setItem('vault_token', result.token);
        store.set('profileId', id, true);
        toast.success(`Now watching as ${profile.name}`);
        window.dispatchEvent(new CustomEvent('vault:profile-switched', { detail: { id } }));
        if (id === 'default') location.hash = '#/home';
        else location.hash = '#/home';
        location.reload();
      } catch (err) {
        toast.error(`Could not switch profile: ${err.message}`);
      }
    });
  });

  if (isAdmin) wireManage(container, profiles, current);

  container.querySelector('#profile-new')?.addEventListener('click', async () => {
    const name = await promptModal({ title: 'New profile', label: 'Name', placeholder: 'e.g. Kids', confirmLabel: 'Create' });
    if (!name) return;
    try {
      await api.createProfile({ name });
      toast.success(`Profile "${name}" created`);
      renderProfiles(container);
    } catch (err) {
      toast.error(`Could not create profile: ${err.message}`);
    }
  });
}

/** Admin-only list: grant/remove admin rights and delete profiles. */
function manageSection(profiles, current) {
  return `
    <section class="profile-manage" aria-labelledby="profile-manage-title">
      <h2 class="profile-manage-title" id="profile-manage-title">Manage profiles</h2>
      <p class="setting-help">Admins can change server settings (Live TV, links, notifications) and manage profiles. Vault always keeps at least one admin.</p>
      <div class="profile-manage-list">
        ${profiles.map(profile => {
          const name = escapeHtml(profile.name);
          const isCurrent = profile.id === current?.id;
          return `<div class="setting-row" data-manage-row="${profile.id}">
            <div class="setting-text">
              <span class="setting-label">${name}</span>
              <p class="setting-help">${isCurrent ? 'This profile (the one you’re using)' : profile.kids ? 'Kids profile' : 'Profile'}</p>
            </div>
            <div class="setting-control profile-manage-actions">
              <label class="profile-admin-toggle">
                <input type="checkbox" role="switch" class="switch" data-admin="${profile.id}" aria-label="Admin rights for ${name}"${profile.isAdmin ? ' checked' : ''}>
                <span aria-hidden="true">Admin</span>
              </label>
              <button type="button" class="btn btn-ghost btn-sm" data-delete="${profile.id}" aria-label="Delete profile ${name}"${isCurrent ? ' disabled title="Switch to another profile to delete this one"' : ''}>${icon('trash', { size: 14 })}<span>Delete</span></button>
            </div>
          </div>`;
        }).join('')}
      </div>
    </section>`;
}

function wireManage(container, profiles, current) {
  container.querySelectorAll('[data-admin]').forEach(input => {
    input.addEventListener('change', async () => {
      const profile = profiles.find(p => p.id === input.dataset.admin);
      const want = input.checked;
      input.disabled = true;
      try {
        await api.updateProfile(profile.id, { isAdmin: want });
        toast.success(want ? `${profile.name} is now an admin` : `${profile.name} is no longer an admin`);
        renderProfiles(container);
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
      if (await deleteProfile(profile)) renderProfiles(container);
    });
  });
}

export async function openProfileMenu() {
  let profiles = [];
  try {
    profiles = (await api.getProfiles()).profiles || [];
  } catch { /* offline: fall back to the picker page */ }
  const currentId = store.get('profileId') || 'default';

  const { backdrop } = createModal({
    title: 'Profiles',
    content: `
      <div class="profile-picker" style="padding:0">
        ${profiles.map(profile => `<button type="button" class="profile-card${profile.id === currentId ? ' current' : ''}" data-switch="${profile.id}">
          <span class="profile-avatar">${escapeHtml(profile.avatar || AVATARS[(profile.name || '?').charCodeAt(0) % AVATARS.length])}</span>
          <span class="profile-name">${escapeHtml(profile.name)}</span>
        </button>`).join('')}
        <button type="button" class="profile-card" data-manage>
          <span class="profile-avatar">${icon('settings', { size: 26 })}</span>
          <span class="profile-name">Manage</span>
        </button>
      </div>
    `,
  });

  backdrop.querySelectorAll('[data-switch]').forEach(button => {
    button.addEventListener('click', async () => {
      const id = button.dataset.switch;
      const profile = profiles.find(p => p.id === id);
      let pin = null;
      if (profile?.hasPin) {
        pin = await promptModal({ title: `PIN for ${profile.name}`, label: 'PIN' });
        if (pin === null) return;
      }
      try {
        const result = await api.switchProfile(id, pin);
        if (result?.token) localStorage.setItem('vault_token', result.token);
        store.set('profileId', id, true);
        location.reload();
      } catch (err) {
        toast.error(err.message);
      }
    });
  });
  backdrop.querySelector('[data-manage]')?.addEventListener('click', () => {
    backdrop.remove();
    location.hash = '#/profiles';
  });
}

export async function deleteProfile(profile) {
  // confirmDialog resolves { confirmed, checked }; the object is always truthy.
  const { confirmed } = await confirmDialog({
    title: `Delete profile "${profile.name}"?`,
    message: 'Its watchlist, history and playlists are removed. Files in the library are never touched.',
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

export default { renderProfiles, openProfileMenu };
