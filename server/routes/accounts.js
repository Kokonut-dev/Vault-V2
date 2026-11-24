/**
 * /api/accounts — accounts made with "Create a new account", sign-up, and
 * the email used for "Forgot password?".
 *
 *   Your own account (any signed-in device):
 *     GET    /me               who am I, my email, can I recover by email
 *     PUT    /me/email         { email, currentPassword }
 *     PUT    /me/credentials   { currentPassword, newPassword?, newGridPattern?, gridOrderMatters? }
 *     DELETE /me               { currentPassword } — delete your account
 *
 *   The server owner (admin profiles of the owner's account only):
 *     GET    /                 sign-up switch, owner email, accounts, mail
 *     PUT    /signup           { enabled }
 *     PUT    /owner-email      { email }
 *     DELETE /:id              delete an account with its profile and data
 *     GET    /mail             mail (SMTP) settings, without the password
 *     PUT    /mail             save them
 *     POST   /mail/test        { to? } send a test email
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const accounts = require('../services/accounts');
const mailer = require('../services/mailer');
const sessions = require('../services/sessions');
const authService = require('../services/authService');
const { getConfig } = require('../config');
const { removeProfileCompletely } = require('../services/profileRemoval');
const { requireAdmin } = require('../middleware/requireAdmin');
const logger = require('../utils/logger');

function fail(res, err, fallback) {
  if (err instanceof accounts.AccountError || err instanceof mailer.MailError) {
    const body = { error: err.message, code: err.code };
    if (err.field) body.fields = { [err.field]: err.message };
    return res.status(err.status || 400).json(body);
  }
  if (err?.name === 'ProfileError') return res.status(400).json({ error: err.message, code: err.code });
  logger.error(`[Accounts] ${fallback}: ${err.message}`);
  return res.status(500).json({ error: fallback });
}

// 400, not 401: the client treats any 401 as signed out, and a typo must not.
const WRONG_PASSWORD = {
  error: 'Current password is incorrect',
  code: 'WRONG_PASSWORD',
  fields: { currentPassword: 'Current password is incorrect' },
};

function ownerPasswordOk(password) {
  try {
    return typeof password === 'string' && !!password && bcrypt.compareSync(password, getConfig().auth.passwordHash);
  } catch {
    return false;
  }
}

/** Current password check for whoever is signed in. Sends the error itself. */
function currentPasswordOk(req, res) {
  const password = req.body?.currentPassword;
  if (!password) {
    res.status(400).json({ error: 'Enter your current password', code: 'PASSWORD_REQUIRED', fields: { currentPassword: 'Enter your current password' } });
    return false;
  }
  const ip = authService.getClientIp(req);
  if (authService.isLocked(ip, 'password')) {
    res.status(429).json({ error: 'Too many wrong passwords. Try again later.', code: 'LOCKED_OUT' });
    return false;
  }
  const ok = req.accountId
    ? accounts.verifyPassword(accounts.get(req.accountId), password)
    : ownerPasswordOk(password);
  if (!ok) {
    authService.recordFailedAttempt(ip, 'password');
    res.status(400).json(WRONG_PASSWORD);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Your own account
// ---------------------------------------------------------------------------
router.get('/me', (req, res) => {
  const mailReady = mailer.configured();
  if (req.accountId) {
    const account = accounts.get(req.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found', code: 'NOT_FOUND' });
    return res.json({ owner: false, username: account.username, email: account.email, createdAt: account.createdAt, mailReady });
  }
  const config = getConfig();
  res.json({ owner: true, username: config.auth.username, email: config.auth.email || null, mailReady });
});

router.put('/me/email', (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email : '';
  if (!currentPasswordOk(req, res)) return undefined;
  try {
    if (req.accountId) {
      if (!email.trim()) return res.status(400).json({ error: 'Your account needs an email address', code: 'INVALID_EMAIL', fields: { email: 'Your account needs an email address' } });
      const account = accounts.setEmail(req.accountId, email);
      return res.json({ email: account.email });
    }
    // The owner's account: admin profiles only, like its other sign-in details.
    if (!require('../middleware/requireAdmin').isAdminProfile(req.profileId)) {
      return res.status(403).json({ error: 'Only an admin profile can change server settings', code: 'ADMIN_REQUIRED' });
    }
    return res.json({ email: accounts.setOwnerEmail(email.trim() || null) });
  } catch (err) {
    return fail(res, err, 'Could not save the email address');
  }
});

router.put('/me/credentials', async (req, res) => {
  if (!req.accountId) {
    return res.status(400).json({ error: 'Change the owner’s sign-in in Settings → Account', code: 'OWNER_ACCOUNT' });
  }
  if (!currentPasswordOk(req, res)) return undefined;
  const { newPassword, newGridPattern, gridOrderMatters, confirmPassword } = req.body || {};
  if (newPassword && confirmPassword !== undefined && confirmPassword !== newPassword) {
    return res.status(400).json({ error: 'The two passwords don’t match', code: 'PASSWORD_MISMATCH', fields: { confirmPassword: 'The two passwords don’t match' } });
  }
  try {
    accounts.setCredentials(req.accountId, {
      password: newPassword || undefined,
      gridPattern: newGridPattern || undefined,
      gridOrderMatters: gridOrderMatters === undefined ? undefined : !!gridOrderMatters,
    });
    await accounts.flush();
  } catch (err) {
    return fail(res, err, 'Could not change your sign-in');
  }
  // A new password or grid signs out your other devices.
  let signedOut = 0;
  if (newPassword || newGridPattern) {
    signedOut = sessions.revokeOthers(req.user?.sid, req.accountId);
    require('../services/recovery').forget(req.accountId);
  }
  res.json({ message: 'Sign-in details updated', signedOut });
});

router.delete('/me', async (req, res) => {
  if (!req.accountId) {
    return res.status(400).json({ error: 'The server owner’s account can’t be deleted', code: 'OWNER_ACCOUNT' });
  }
  if (!currentPasswordOk(req, res)) return undefined;
  const account = accounts.get(req.accountId);
  try {
    const result = await removeProfileCompletely(account.profileId);
    if (!result) accounts.remove(req.accountId);
    await accounts.flush();
  } catch (err) {
    return fail(res, err, 'Could not delete the account');
  }
  logger.info(`[Accounts] "${account.username}" deleted their own account`);
  res.json({ message: 'Account deleted' });
});

// ---------------------------------------------------------------------------
// The owner's controls
// ---------------------------------------------------------------------------
router.get('/', requireAdmin, (req, res) => {
  const list = accounts.list()
    .map(a => accounts.toPublic(a, { fullEmail: true }))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  res.json({
    signupEnabled: accounts.signupEnabled(),
    ownerEmail: getConfig().auth.email || null,
    accounts: list,
    max: accounts.MAX_ACCOUNTS,
    mail: mailer.status(),
  });
});

router.put('/signup', requireAdmin, (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false', code: 'INVALID' });
  const enabled = accounts.setSignupEnabled(req.body.enabled);
  logger.info(`[Accounts] Sign-up turned ${enabled ? 'on' : 'off'}`);
  res.json({ signupEnabled: enabled });
});

router.put('/owner-email', requireAdmin, (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  try {
    res.json({ email: accounts.setOwnerEmail(email || null) });
  } catch (err) {
    fail(res, err, 'Could not save the email address');
  }
});

router.get('/mail', requireAdmin, (req, res) => res.json(mailer.status()));

router.put('/mail', requireAdmin, (req, res) => {
  try {
    const status = mailer.save(req.body || {});
    logger.info(`[Mail] Settings saved (${status.enabled ? `on, via ${status.host}` : 'off'})`);
    res.json(status);
  } catch (err) {
    fail(res, err, 'Could not save the mail settings');
  }
});

router.post('/mail/test', requireAdmin, async (req, res) => {
  const to = typeof req.body?.to === 'string' && req.body.to.trim() ? req.body.to.trim() : getConfig().auth.email;
  if (!to || !accounts.isValidEmail(to)) {
    return res.status(400).json({ error: 'Enter an address to send the test to (or set your own email first)', code: 'INVALID_EMAIL', fields: { to: 'Enter a valid email address' } });
  }
  if (!mailer.configured()) {
    return res.status(400).json({ error: 'Turn email on and save the settings first', code: 'MAIL_NOT_CONFIGURED' });
  }
  const result = await mailer.send({
    to,
    subject: 'Vault test email',
    text: 'If you can read this, Vault can send email: "Forgot password?" links will arrive by email.',
  });
  if (!result.delivered) return res.status(502).json({ error: result.error || 'Sending failed', code: 'MAIL_FAILED' });
  res.json({ message: `Test email sent to ${to}` });
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const account = accounts.get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found', code: 'NOT_FOUND' });
  let result;
  try {
    result = await removeProfileCompletely(account.profileId);
    // Its profile already gone (hand-edited files): still forget the account.
    if (!result) {
      accounts.remove(account.id);
      sessions.revokeAccount(account.id);
      require('../services/recovery').forget(account.id);
    }
    await accounts.flush();
  } catch (err) {
    return fail(res, err, 'Could not delete the account');
  }
  logger.info(`[Accounts] Account "${account.username}" deleted by ${req.user?.username || 'an admin'}`);
  res.json({ message: 'Account deleted', id: account.id, signedOut: result?.signedOut || 0 });
});

module.exports = router;
