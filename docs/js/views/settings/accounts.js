/**
 * Settings → Server → Accounts & email.
 *
 *   - "Create a new account" on the sign-in screen: on or off;
 *   - the accounts people made that way (delete one with its profile and data);
 *   - email (SMTP) for "Forgot password?" links, with a test email.
 *
 * Server: routes/accounts.js (admin profiles of the owner's account only).
 */
import { api } from '../../api.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { escapeHtml, formatRelativeTime } from '../../utils/format.js';
import { icon } from '../../utils/icons.js';
import {
  section, group, row, switchRow, el, flashStatus, secretField, clearFieldError, applyFieldErrors, busy, setReadOnly,
} from './ui.js';

export function accountsSection(ctx = {}) {
  const s = section({
    id: 'accounts',
    title: 'Accounts & email',
    iconName: 'users',
    scope: 'server',
    intro: 'Who can make an account on this server, and the email used for “Forgot password?”.',
  });

  // --- sign-up
  const signup = group('New accounts');
  signup.dataset.keywords = 'sign up signup register create account new users open';
  signup.append(
    switchRow({ id: 'signup-enabled', label: 'Allow “Create a new account”', keywords: 'signup register',
      help: 'Anyone who can open this server’s sign-in page can make their own account and use it straight away. Each account gets one profile, never admin rights, and can’t see your profiles. Turn this off when you use remote access and don’t want strangers to sign up.' }),
  );
  const list = group('Accounts people created');
  list.dataset.keywords = 'accounts users delete remove members';
  list.append(el('<div class="accounts-list" id="accounts-list"><div class="skeleton skeleton-line"></div></div>'));

  // --- email
  const mail = group('Email for password resets', {
    description: 'Vault emails a one-time link when someone uses “Forgot password?”. Until this is set up, links are shown in the server window instead. For Gmail or Outlook, use an <em>app password</em>, not your normal password.',
  });
  mail.dataset.keywords = 'email smtp mail server forgot password reset link gmail outlook app password sender';
  const form = el('<form class="settings-form" id="mail-form" novalidate></form>');
  const password = secretField({ id: 'mail-pass', label: 'Password', type: 'password', autocomplete: 'new-password',
    help: 'Stored encrypted on the server; never shown again.', keywords: 'smtp password app password' });
  form.append(
    switchRow({ id: 'mail-enabled', label: 'Send reset links by email', keywords: 'email on off' }),
    row({ id: 'mail-host', label: 'Mail server', help: 'For example smtp.gmail.com or smtp.office365.com.', keywords: 'smtp host server',
      control: '<input class="form-input" id="mail-host" type="text" autocomplete="off" spellcheck="false" autocapitalize="off" maxlength="253" placeholder="smtp.example.com">' }),
    row({ id: 'mail-port', label: 'Port', help: '587 for most servers; 465 with a secure connection.', keywords: 'smtp port',
      control: '<input class="form-input " id="mail-port" type="number" min="1" max="65535" inputmode="numeric" value="587">' }),
    switchRow({ id: 'mail-secure', label: 'Secure connection from the start (port 465)', keywords: 'ssl tls secure',
      help: 'Off: Vault still requires an encrypted connection (STARTTLS) before it sends the password.' }),
    row({ id: 'mail-user', label: 'Username', help: 'Usually your full email address.', keywords: 'smtp user login',
      control: '<input class="form-input" id="mail-user" type="text" autocomplete="off" spellcheck="false" autocapitalize="off" maxlength="254">' }),
    password,
    row({ id: 'mail-from', label: 'Send from', help: 'The sender people see, like vault@example.com or “Vault &lt;you@gmail.com&gt;”.', keywords: 'from sender address',
      control: '<input class="form-input" id="mail-from" type="text" autocomplete="off" spellcheck="false" maxlength="300">' }),
    el(`<div class="settings-actions">
        <button type="submit" class="btn btn-primary" id="mail-save">Save email settings</button>
      </div>`),
  );
  const testRow = row({ id: 'mail-test-to', label: 'Send a test email', help: 'Check that the settings work.', keywords: 'test email send',
    control: `<div class="input-with-actions">
        <input class="form-input" id="mail-test-to" type="email" autocomplete="email" placeholder="you@example.com">
        <button type="button" class="btn btn-secondary btn-sm" id="mail-test">${icon('mail', { size: 14 })}<span>Send test</span></button>
      </div>` });
  form.append(testRow);
  mail.append(form);

  // --- your own address
  const own = group('Your recovery email');
  own.dataset.keywords = 'owner email recovery address';
  own.append(el('<p class="setting-help">Set it in <a href="#security" data-goto="security" class="link-button">Account → Sign-in &amp; security</a>, so “Forgot password?” can reach you too.</p>'));

  s.body.append(signup, list, mail, own);

  const f = {
    enabled: form.querySelector('#mail-enabled'),
    host: form.querySelector('#mail-host'),
    port: form.querySelector('#mail-port'),
    secure: form.querySelector('#mail-secure'),
    user: form.querySelector('#mail-user'),
    password: password.input,
    from: form.querySelector('#mail-from'),
    to: form.querySelector('#mail-test-to'),
  };
  Object.values(f).forEach(input => input.addEventListener('input', () => clearFieldError(input)));
  f.secure.addEventListener('change', () => {
    if (f.secure.checked && f.port.value === '587') f.port.value = '465';
    else if (!f.secure.checked && f.port.value === '465') f.port.value = '587';
  });

  let state = null;

  function renderMail(m) {
    f.enabled.checked = !!m.enabled;
    f.host.value = m.host || '';
    f.port.value = m.port || 587;
    f.secure.checked = !!m.secure;
    f.user.value = m.user || '';
    f.from.value = m.from || '';
    password.reset({ configured: !!m.hasPassword, hint: m.hasPassword ? '••••••••' : '' });
  }

  function renderAccounts() {
    const host = list.querySelector('#accounts-list');
    const accounts = state.accounts || [];
    if (!accounts.length) {
      host.innerHTML = `<p class="setting-help">No accounts yet.${state.signupEnabled ? ' People can make one with “Create a new account” on the sign-in screen.' : ''}</p>`;
      return;
    }
    host.innerHTML = `<p class="setting-help">${accounts.length} of ${state.max} accounts.</p>
      <ul class="session-items">${accounts.map(a => `
        <li class="session-item">
          <span class="session-icon" aria-hidden="true">${icon('user', { size: 18 })}</span>
          <div class="session-text">
            <p class="session-name">${escapeHtml(a.username)}</p>
            <p class="setting-help">${escapeHtml([a.email, a.lastLoginAt ? `last signed in ${formatRelativeTime(a.lastLoginAt)}` : `created ${formatRelativeTime(a.createdAt)}`].filter(Boolean).join(' · '))}</p>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" data-delete="${escapeHtml(a.id)}" data-name="${escapeHtml(a.username)}" aria-label="Delete the account ${escapeHtml(a.username)}">${icon('trash', { size: 14 })}<span>Delete</span></button>
        </li>`).join('')}</ul>`;
    host.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      const { confirmed } = await confirmDialog({
        title: `Delete ${name}’s account?`,
        message: 'Their profile, watch history, favourites and playlists are removed and every device they use is signed out. This can’t be undone.',
        confirmText: 'Delete account',
        danger: true,
      });
      if (!confirmed) return;
      busy(btn, true, 'Deleting…');
      try {
        await api.deleteAccount(btn.dataset.delete);
        state.accounts = state.accounts.filter(a => a.id !== btn.dataset.delete);
        renderAccounts();
        flashStatus(s, `${name}’s account was deleted`);
      } catch (err) {
        busy(btn, false);
        flashStatus(s, err.message, 'error');
      }
    }));
  }

  async function load() {
    try {
      state = await api.getAccounts();
    } catch (err) {
      list.querySelector('#accounts-list').innerHTML = '';
      setReadOnly(s.body, err.code === 'ADMIN_REQUIRED' || err.status === 403
        ? 'Only an admin profile of the server owner’s account can change these settings.'
        : `Couldn’t load: ${escapeHtml(err.message)}`);
      return;
    }
    s.querySelector('#signup-enabled').checked = !!state.signupEnabled;
    renderAccounts();
    renderMail(state.mail || {});
    if (!f.to.value && state.ownerEmail) f.to.value = state.ownerEmail;
  }

  s.querySelector('#signup-enabled').addEventListener('change', async (e) => {
    const input = e.currentTarget;
    input.disabled = true;
    try {
      const res = await api.setSignupEnabled(input.checked);
      state.signupEnabled = res.signupEnabled;
      flashStatus(s, res.signupEnabled ? 'New accounts allowed' : 'New accounts turned off');
    } catch (err) {
      input.checked = !input.checked;
      flashStatus(s, err.message, 'error');
    } finally {
      input.disabled = false;
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    Object.values(f).forEach(clearFieldError);
    const body = {
      enabled: f.enabled.checked,
      host: f.host.value.trim(),
      port: Number(f.port.value),
      secure: f.secure.checked,
      user: f.user.value.trim(),
      from: f.from.value.trim(),
    };
    const pass = password.value();
    if (pass !== undefined) body.password = pass;
    const btn = form.querySelector('#mail-save');
    busy(btn, true, 'Saving…');
    try {
      const saved = await api.saveMailSettings(body);
      renderMail(saved);
      if (state) state.mail = saved;
      flashStatus(s, saved.enabled ? 'Email settings saved: send a test to check them' : 'Email settings saved');
    } catch (err) {
      if (!applyFieldErrors(f, err.fields || {})) flashStatus(s, err.message, 'error');
    } finally {
      busy(btn, false);
    }
  });

  form.querySelector('#mail-test').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    clearFieldError(f.to);
    const to = f.to.value.trim();
    if (!to || !f.to.checkValidity()) { applyFieldErrors(f, { to: 'Enter the address to send the test to' }); return; }
    busy(btn, true, 'Sending…');
    try {
      const res = await api.sendTestEmail(to);
      flashStatus(s, res.message || 'Test email sent');
    } catch (err) {
      if (!applyFieldErrors(f, err.fields || {})) flashStatus(s, err.message, 'error');
    } finally {
      busy(btn, false);
    }
  });

  s.addEventListener('click', (e) => {
    const link = e.target.closest('[data-goto]');
    if (!link) return;
    e.preventDefault();
    ctx.select?.(link.dataset.goto, { focus: true });
  });

  load();
  return s;
}
