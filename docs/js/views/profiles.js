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

  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${icon('users', { size: 26 })}<span>Who's watching?</span></h1>
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
          <span class="profile-meta">${profile.itemCount ?? 0} items${profile.pin ? ' · PIN' : ''}</span>
          ${profile.id === current?.id ? '<span class="profile-badge">Current</span>' : ''}
        </button>`).join('')}
      <button type="button" class="profile-card" id="profile-new">
        <span class="profile-avatar" aria-hidden="true">${icon('user-plus', { size: 30 })}</span>
        <span class="profile-name">Add profile</span>
        <span class="profile-meta">A separate space for someone else</span>
      </button>
    </div>
  `;

  container.querySelectorAll('[data-profile]').forEach(card => {
    card.addEventListener('click', async () => {
      const id = card.dataset.profile;
      const profile = profiles.find(p => p.id === id);
      let pin = null;
      if (profile?.pin) {
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

  container.querySelector('#profile-new').addEventListener('click', async () => {
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
      if (profile?.pin) {
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

export async function manageProfile(profile) {
  const name = await promptModal({ title: `Rename ${profile.name}`, label: 'Name', value: profile.name });
  if (!name || name === profile.name) return;
  try {
    await api.updateProfile(profile.id, { name });
    toast.success('Profile renamed');
  } catch (err) {
    toast.error(err.message);
  }
}

export async function deleteProfile(profile) {
  const ok = await confirmDialog({
    title: `Delete profile "${profile.name}"?`,
    message: 'Its watchlist, history and playlists are removed. Files in the library are never touched.',
    confirmLabel: 'Delete profile',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteProfile(profile.id);
    toast.success('Profile deleted');
  } catch (err) {
    toast.error(err.message);
  }
}

export default { renderProfiles, openProfileMenu };
