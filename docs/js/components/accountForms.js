/**
 * Sign-in screen extras: "Create a new account", "Forgot password?" and the
 * page a reset link opens (#reset=<token>).
 *
 * Each is an .auth-step inside #auth-gate, next to the password and grid
 * steps that main.js owns. main.js passes in how to show a step and what to
 * do once someone is signed in (a new account is signed in straight away).
 *
 * Server side: POST /api/auth/register, /api/auth/recover,
 * /api/auth/recover/check and /api/auth/recover/reset.
 */
import { api } from '../api.js';
import { store } from '../store.js';
import { getApiBaseUrl, setApiBaseUrl } from '../config.js';
import { rememberProfile } from '../profileSession.js';
import { createGridPicker } from './gridPicker.js';
import { fieldError, clearFieldError, applyFieldErrors } from '../views/settings/ui.js';
import { icon } from '../utils/icons.js';
import { escapeHtml } from '../utils/format.js';

const MIN_PASSWORD = 8;

/** This page's address, without query or fragment: where a reset link should open. */
export function appUrl() {
  return `${location.origin}${location.pathname}`;
}

/**
 * Read a reset link from the address bar (#reset=…&server=…) and remove it
 * from the address bar and history straight away, so it isn't left in
 * either. Returns { token, server } or null.
 */
export function takeResetLink() {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  const search = new URLSearchParams(location.search);
  let params = null;
  if (/^reset=/.test(hash) || hash.includes('&reset=')) params = new URLSearchParams(hash);
  else if (search.get('reset')) params = search;
  if (!params) return null;
  const token = params.get('reset');
  const server = params.get('server');
  search.delete('reset');
  search.delete('server');
  const keepHash = params === search ? location.hash : '';
  history.replaceState(history.state, '', `${location.pathname}${search.toString() ? `?${search}` : ''}${keepHash}`);
  return token ? { token, server } : null;
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function showError(box, message) {
  if (!box) return;
  box.textContent = message || '';
  box.hidden = !message;
}

function clearErrors(form) {
  form.querySelectorAll('[aria-invalid="true"]').forEach(clearFieldError);
}

function busy(button, label) {
  const before = button.textContent;
  button.disabled = true;
  button.textContent = label;
  return () => { button.disabled = false; button.textContent = before; };
}

/** A grid picker in a labelled box, with its own error slot. */
function gridField(id, label, help) {
  const wrap = el(`
    <div class="form-group auth-grid-field">
      <span class="form-label" id="${id}-label">${escapeHtml(label)}</span>
      <p class="auth-hint" id="${id}-help">${escapeHtml(help)}</p>
      <div class="auth-grid-host"></div>
      <label class="auth-check">
        <input type="checkbox" id="${id}-order"> The order of the squares matters
      </label>
      <input type="hidden" id="${id}" aria-labelledby="${id}-label">
    </div>`);
  const picker = createGridPicker({ length: 8, labelledBy: `${id}-label`, describedBy: `${id}-help` });
  wrap.querySelector('.auth-grid-host').append(picker.el);
  const anchor = wrap.querySelector(`#${id}`);
  // Errors appear under the grid, and focus goes to its first square.
  anchor.focus = () => picker.focus();
  return { wrap, picker, anchor, order: wrap.querySelector(`#${id}-order`) };
}

function passwordFields(prefix, { autocomplete = 'new-password' } = {}) {
  return `
    <div class="form-group">
      <label class="form-label" for="${prefix}-password">Password</label>
      <input type="password" id="${prefix}-password" class="form-input" required minlength="${MIN_PASSWORD}" maxlength="128" autocomplete="${autocomplete}" aria-describedby="${prefix}-password-help">
      <p class="auth-hint" id="${prefix}-password-help">At least ${MIN_PASSWORD} characters.</p>
    </div>
    <div class="form-group">
      <label class="form-label" for="${prefix}-confirm">Repeat the password</label>
      <input type="password" id="${prefix}-confirm" class="form-input" required maxlength="128" autocomplete="${autocomplete}">
    </div>`;
}

/** Checks done before asking the server (it checks everything again). */
function checkPasswords(password, confirm) {
  if (password.value.length < MIN_PASSWORD) {
    fieldError(password, `Use at least ${MIN_PASSWORD} characters`);
    return password;
  }
  if (confirm.value !== password.value) {
    fieldError(confirm, 'The two passwords don’t match');
    return confirm;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Create a new account
// ---------------------------------------------------------------------------
function buildRegister(host, { showStep, onSignedIn }) {
  const step = el(`
    <div id="register-step" class="auth-step" aria-labelledby="register-title">
      <h2 id="register-title" tabindex="-1">Create a new account</h2>
      <p class="auth-subtitle">Your own sign-in, profile and watch history on this Vault server.</p>
      <form id="register-form" class="auth-form" novalidate>
        <div class="form-group">
          <label class="form-label" for="register-username">Username</label>
          <input type="text" id="register-username" class="form-input" required minlength="3" maxlength="50" autocomplete="username" autocapitalize="none" spellcheck="false" aria-describedby="register-username-help">
          <p class="auth-hint" id="register-username-help">3–50 letters, numbers, _ or -.</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="register-email">Email</label>
          <input type="email" id="register-email" class="form-input" required maxlength="254" autocomplete="email" aria-describedby="register-email-help">
          <p class="auth-hint" id="register-email-help">Only used to send you a link if you forget your password.</p>
        </div>
        ${passwordFields('register')}
      </form>
      <div class="auth-error" id="register-error" role="alert" hidden></div>
      <div class="auth-actions">
        <button type="submit" form="register-form" class="btn btn-primary btn-lg auth-wide" id="register-submit">Create account</button>
        <button type="button" class="auth-link" data-back>Back to sign in</button>
      </div>
    </div>`);
  const form = step.querySelector('form');
  const grid = gridField('register-grid', 'Your 8-square grid', 'After your password you tap these 8 squares to sign in.');
  form.append(grid.wrap);
  host.append(step);

  const f = {
    username: step.querySelector('#register-username'),
    email: step.querySelector('#register-email'),
    password: step.querySelector('#register-password'),
    confirmPassword: step.querySelector('#register-confirm'),
    gridPattern: grid.anchor,
  };
  const errorBox = step.querySelector('#register-error');
  const submit = step.querySelector('#register-submit');

  step.querySelector('[data-back]').addEventListener('click', () => showStep('login'));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors(form);
    showError(errorBox, '');
    const username = f.username.value.trim();
    let first = null;
    if (!/^[A-Za-z0-9_-]{3,50}$/.test(username)) {
      fieldError(f.username, '3–50 letters, numbers, _ or -');
      first = first || f.username;
    }
    if (!f.email.value.trim() || !f.email.checkValidity()) {
      fieldError(f.email, 'Enter a valid email address');
      first = first || f.email;
    }
    first = first || checkPasswords(f.password, f.confirmPassword);
    if (!grid.picker.isComplete()) {
      fieldError(f.gridPattern, 'Tap 8 squares');
      first = first || f.gridPattern;
    }
    if (first) { first.focus(); return; }

    const done = busy(submit, 'Creating…');
    try {
      const res = await api.register({
        username,
        email: f.email.value.trim(),
        password: f.password.value,
        confirmPassword: f.confirmPassword.value,
        gridPattern: grid.picker.value(),
        gridOrderMatters: grid.order.checked,
      });
      store.setAuth(res.token, res.user);
      if (res.profile) rememberProfile(res.profile);
      form.reset();
      grid.picker.clear();
      await onSignedIn(res, { created: true });
    } catch (err) {
      if (!applyFieldErrors(f, err.fields)) showError(errorBox, err.message);
    } finally {
      done();
    }
  });

  return {
    step,
    open(prefill = {}) {
      if (prefill.username && !f.username.value) f.username.value = prefill.username;
      showError(errorBox, '');
      showStep('register');
      f.username.focus();
    },
  };
}

// ---------------------------------------------------------------------------
// Forgot password?
// ---------------------------------------------------------------------------
function buildForgot(host, { showStep }) {
  const step = el(`
    <div id="forgot-step" class="auth-step" aria-labelledby="forgot-title">
      <h2 id="forgot-title" tabindex="-1">Forgot your password?</h2>
      <p class="auth-subtitle">Enter your username or email address. We’ll send a link to choose a new password and a new grid.</p>
      <form id="forgot-form" class="auth-form" novalidate>
        <div class="form-group">
          <label class="form-label" for="forgot-identifier">Username or email</label>
          <input type="text" id="forgot-identifier" class="form-input" required maxlength="254" autocomplete="username" autocapitalize="none" spellcheck="false">
        </div>
        <div class="auth-error" id="forgot-error" role="alert" hidden></div>
        <button type="submit" class="btn btn-primary btn-lg auth-wide" id="forgot-submit">Send reset link</button>
      </form>
      <div class="auth-sent" id="forgot-sent" role="status" hidden>
        <span class="auth-sent-icon" aria-hidden="true">${icon('mail', { size: 22 })}</span>
        <p><strong>Check your email.</strong> <span id="forgot-sent-text"></span></p>
        <p class="auth-hint">The link works once, for 30 minutes. Nothing arrived? Look in your spam folder, or ask the person who runs this Vault server: they can see the link in the server window.</p>
      </div>
      <div class="auth-actions">
        <button type="button" class="auth-link" data-back>Back to sign in</button>
      </div>
    </div>`);
  host.append(step);
  const form = step.querySelector('form');
  const input = step.querySelector('#forgot-identifier');
  const errorBox = step.querySelector('#forgot-error');
  const sent = step.querySelector('#forgot-sent');
  const submit = step.querySelector('#forgot-submit');

  step.querySelector('[data-back]').addEventListener('click', () => showStep('login'));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors(form);
    showError(errorBox, '');
    const identifier = input.value.trim();
    if (!identifier) { fieldError(input, 'Enter your username or email address'); input.focus(); return; }
    const done = busy(submit, 'Sending…');
    try {
      const res = await api.requestPasswordReset(identifier, appUrl());
      step.querySelector('#forgot-sent-text').textContent = res?.message
        || 'If that matches an account, a reset link is on its way.';
      form.hidden = true;
      sent.hidden = false;
    } catch (err) {
      if (!applyFieldErrors({ identifier: input }, err.fields)) showError(errorBox, err.message);
    } finally {
      done();
    }
  });

  return {
    step,
    open(prefill = '') {
      form.hidden = false;
      sent.hidden = true;
      showError(errorBox, '');
      if (prefill && !input.value) input.value = prefill;
      showStep('forgot');
      input.focus();
    },
  };
}

// ---------------------------------------------------------------------------
// The page a reset link opens
// ---------------------------------------------------------------------------
function buildReset(host, { showStep, onReset }) {
  const step = el(`
    <div id="reset-step" class="auth-step" aria-labelledby="reset-title">
      <h2 id="reset-title" tabindex="-1">Choose a new password</h2>
      <p class="auth-subtitle" id="reset-subtitle">Checking your reset link…</p>
      <form id="reset-form" class="auth-form" novalidate hidden>
        <input type="text" id="reset-username" autocomplete="username" hidden>
        ${passwordFields('reset')}
        <div class="form-group" id="reset-totp-group" hidden>
          <label class="form-label" for="reset-totp">Code from your authenticator app</label>
          <input type="text" id="reset-totp" class="form-input" inputmode="numeric" autocomplete="one-time-code" maxlength="20" aria-describedby="reset-totp-help">
          <p class="auth-hint" id="reset-totp-help">Your account has two-factor sign-in, so the 6-digit code (or one of your recovery codes) is still needed.</p>
        </div>
      </form>
      <div class="auth-error" id="reset-error" role="alert" hidden></div>
      <div class="auth-actions">
        <button type="submit" form="reset-form" class="btn btn-primary btn-lg auth-wide" id="reset-submit" hidden>Save and sign in again</button>
        <button type="button" class="auth-link" data-forgot hidden>Ask for a new link</button>
        <button type="button" class="auth-link" data-back>Back to sign in</button>
      </div>
    </div>`);
  const form = step.querySelector('form');
  const grid = gridField('reset-grid', 'Your new 8-square grid', 'Tap the 8 squares you’ll use after your password.');
  form.insertBefore(grid.wrap, step.querySelector('#reset-totp-group'));
  host.append(step);

  const f = {
    password: step.querySelector('#reset-password'),
    confirmPassword: step.querySelector('#reset-confirm'),
    gridPattern: grid.anchor,
    totpCode: step.querySelector('#reset-totp'),
  };
  const subtitle = step.querySelector('#reset-subtitle');
  const errorBox = step.querySelector('#reset-error');
  const submit = step.querySelector('#reset-submit');
  const totpGroup = step.querySelector('#reset-totp-group');
  const askAgain = step.querySelector('[data-forgot]');
  let token = null;
  let info = null;

  step.querySelector('[data-back]').addEventListener('click', () => showStep('login'));
  askAgain.addEventListener('click', () => onReset({ askAgain: true }));

  function broken(message) {
    subtitle.textContent = message;
    form.hidden = true;
    submit.hidden = true;
    askAgain.hidden = false;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors(form);
    showError(errorBox, '');
    let first = checkPasswords(f.password, f.confirmPassword);
    if (!grid.picker.isComplete()) {
      fieldError(f.gridPattern, 'Tap 8 squares');
      first = first || f.gridPattern;
    }
    const code = f.totpCode.value.trim();
    if (info?.totpRequired && !code) {
      fieldError(f.totpCode, 'Enter the code from your authenticator app');
      first = first || f.totpCode;
    }
    if (first) { first.focus(); return; }

    const body = {
      token,
      password: f.password.value,
      confirmPassword: f.confirmPassword.value,
      gridPattern: grid.picker.value(),
      gridOrderMatters: grid.order.checked,
    };
    // Six digits: the app's code. Anything else: a recovery code.
    if (code) {
      if (/^\d{6}$/.test(code.replace(/\s/g, ''))) body.totpCode = code.replace(/\s/g, '');
      else body.recoveryCode = code;
    }
    const done = busy(submit, 'Saving…');
    try {
      await api.resetPassword(body);
      form.reset();
      grid.picker.clear();
      token = null;
      onReset({ done: true, username: info?.username || '' });
    } catch (err) {
      if (['RESET_USED', 'RESET_EXPIRED', 'RESET_INVALID'].includes(err.code)) broken(err.message);
      else if (!applyFieldErrors({ ...f, recoveryCode: f.totpCode }, err.fields)) showError(errorBox, err.message);
    } finally {
      done();
    }
  });

  return {
    step,
    async open(link) {
      token = link.token;
      info = null;
      form.hidden = true;
      submit.hidden = true;
      askAgain.hidden = true;
      showError(errorBox, '');
      subtitle.textContent = 'Checking your reset link…';
      showStep('reset');

      // A link from another Vault server: only switch when the person agrees,
      // so a forwarded link can't quietly point this app somewhere else.
      if (link.server && link.server.replace(/\/$/, '') !== getApiBaseUrl()) {
        const ok = window.confirm(`This reset link is for the Vault server at ${link.server}. Connect to that server?`);
        if (!ok) { broken('This reset link is for a different Vault server.'); return; }
        setApiBaseUrl(link.server);
        window.dispatchEvent(new CustomEvent('vault:server-changed'));
      }

      try {
        info = await api.checkPasswordReset(token);
      } catch (err) {
        broken(err.message || 'This reset link isn’t valid.');
        return;
      }
      subtitle.textContent = '';
      subtitle.append(
        document.createTextNode('For '),
        Object.assign(document.createElement('strong'), { textContent: info.username }),
        document.createTextNode('. Every device signed in to this account will be signed out.'),
      );
      step.querySelector('#reset-username').value = info.username;
      totpGroup.hidden = !info.totpRequired;
      form.hidden = false;
      submit.hidden = false;
      f.password.focus();
    },
  };
}

// ---------------------------------------------------------------------------
/**
 * Build the three steps into `host` (#auth-container) and return controls.
 * `showStep(name)`: 'login' | 'register' | 'forgot' | 'reset' (main.js).
 * `onSignedIn(result)`: after "Create account" signed someone in.
 */
export function mountAccountForms(host, { showStep, onSignedIn, onResetDone }) {
  const register = buildRegister(host, { showStep, onSignedIn });
  const forgot = buildForgot(host, { showStep });
  const reset = buildReset(host, {
    showStep,
    onReset: ({ done, askAgain, username }) => {
      if (askAgain) { forgot.open(); return; }
      if (done) onResetDone?.(username);
    },
  });
  return {
    openRegister: (prefill) => register.open(prefill),
    openForgot: (prefill) => forgot.open(prefill),
    openReset: (link) => reset.open(link),
    steps: { register: register.step, forgot: forgot.step, reset: reset.step },
  };
}
