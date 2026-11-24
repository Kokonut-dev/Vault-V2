/**
 * Accounts made with "Create a new account" on the sign-in screen.
 *
 * Vault has always had one account: the server owner's, kept in config.json
 * (`config.auth`). Accounts made here are for other people (family, friends).
 * Each one has:
 *   - its own username, email (for "Forgot password?"), password and 8-square
 *     grid;
 *   - its own profile (`profile.accountId`), and signing in always lands on
 *     it: an account can't see or switch to anyone else's profile;
 *   - no admin rights, ever (services/profiles.js refuses to promote it).
 *
 * The owner can switch sign-up off and delete accounts in
 * Settings → Accounts & email (routes/accounts.js).
 *
 * Stored in data/accounts.json; passwords as bcrypt hashes. Grids are stored
 * like the owner's (config.auth.gridPattern) so that "order matters" works.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const validator = require('validator');
const { createJsonStore } = require('../utils/jsonStore');
const { getConfig } = require('../config');
const { isValidUsername, isValidGridPattern } = require('../utils/validators');
const profiles = require('./profiles');

const store = createJsonStore('accounts.json', { accounts: [] });

const MAX_ACCOUNTS = 50;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
const BCRYPT_ROUNDS = 10;

class AccountError extends Error {
  constructor(message, code, status = 400, field = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

function data() {
  const d = store.get();
  if (!Array.isArray(d.accounts)) d.accounts = [];
  return d;
}

function save(d) {
  store.set(d);
}

const lower = (v) => String(v || '').trim().toLowerCase();

function list() {
  return data().accounts;
}

function get(id) {
  if (!id) return null;
  return list().find(a => a.id === id) || null;
}

function findByUsername(username) {
  const key = lower(username);
  if (!key) return null;
  return list().find(a => a.usernameLower === key) || null;
}

function findByEmail(email) {
  const key = normalizeEmail(email);
  if (!key) return null;
  return list().find(a => a.emailLower === key) || null;
}

function findByProfile(profileId) {
  if (!profileId) return null;
  return list().find(a => a.profileId === profileId) || null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && validator.isEmail(email.trim(), { allow_display_name: false, require_tld: true });
}

function ownerEmail() {
  return normalizeEmail(getConfig().auth.email || '');
}

/** Is this username free (the owner's name and every account's, any case)? */
function usernameTaken(username, exceptId = null) {
  const key = lower(username);
  if (key === lower(getConfig().auth.username)) return true;
  return list().some(a => a.usernameLower === key && a.id !== exceptId);
}

function emailTaken(email, exceptId = null) {
  const key = normalizeEmail(email);
  if (!key) return false;
  if (exceptId !== 'owner' && key === ownerEmail()) return true;
  return list().some(a => a.emailLower === key && a.id !== exceptId);
}

function checkUsername(username, exceptId = null) {
  const clean = typeof username === 'string' ? username.trim() : '';
  if (!isValidUsername(clean)) {
    throw new AccountError('Usernames are 3–50 characters: letters, numbers, _ and -', 'INVALID_USERNAME', 400, 'username');
  }
  if (usernameTaken(clean, exceptId)) {
    throw new AccountError('That username is already taken', 'USERNAME_TAKEN', 409, 'username');
  }
  return clean;
}

function checkEmail(email, exceptId = null) {
  if (!isValidEmail(email)) {
    throw new AccountError('Enter a valid email address', 'INVALID_EMAIL', 400, 'email');
  }
  if (emailTaken(email, exceptId)) {
    throw new AccountError('That email address is already used by another account', 'EMAIL_TAKEN', 409, 'email');
  }
  return email.trim();
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new AccountError(`Use a password of at least ${MIN_PASSWORD} characters`, 'WEAK_PASSWORD', 400, 'password');
  }
  if (password.length > MAX_PASSWORD) {
    throw new AccountError(`Passwords can be at most ${MAX_PASSWORD} characters`, 'INVALID_PASSWORD', 400, 'password');
  }
  return password;
}

function checkGrid(gridPattern) {
  if (!isValidGridPattern(gridPattern)) {
    throw new AccountError('Choose 8 different squares for your grid', 'INVALID_GRID', 400, 'gridPattern');
  }
  return gridPattern.slice();
}

// ---------------------------------------------------------------------------
// Sign-up
// ---------------------------------------------------------------------------
function signupEnabled() {
  return getConfig().auth.signup?.enabled !== false;
}

function setSignupEnabled(enabled) {
  const { saveConfig } = require('../config');
  const config = getConfig();
  config.auth.signup = { ...(config.auth.signup || {}), enabled: !!enabled };
  saveConfig(config);
  return signupEnabled();
}

/**
 * Create an account and its profile. Throws AccountError (with `field`) on
 * any problem. Returns the stored account.
 */
function create({ username, email, password, gridPattern, gridOrderMatters = false }) {
  if (!signupEnabled()) throw new AccountError('Creating new accounts is turned off on this server', 'SIGNUP_DISABLED', 403);
  if (list().length >= MAX_ACCOUNTS) {
    throw new AccountError('This server has reached its limit of accounts. Ask the owner to remove one.', 'ACCOUNT_LIMIT', 403);
  }
  const cleanUsername = checkUsername(username);
  const cleanEmail = checkEmail(email);
  checkPassword(password);
  const grid = checkGrid(gridPattern);

  const id = `a_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const profile = profiles.create({ name: cleanUsername, accountId: id });
  const account = {
    id,
    username: cleanUsername,
    usernameLower: lower(cleanUsername),
    email: cleanEmail,
    emailLower: normalizeEmail(cleanEmail),
    passwordHash: bcrypt.hashSync(password, BCRYPT_ROUNDS),
    gridPattern: grid,
    gridOrderMatters: !!gridOrderMatters,
    profileId: profile.id,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
    credentialsChangedAt: new Date().toISOString(),
  };
  const d = data();
  d.accounts.push(account);
  save(d);
  return account;
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------
// A real hash to compare against when the username doesn't exist, so a
// wrong username takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_ROUNDS);

/** The account for this username + password, or null. */
function verifyLogin(username, password) {
  const account = findByUsername(username);
  if (typeof password !== 'string' || !password) return null;
  try {
    const ok = bcrypt.compareSync(password.substring(0, MAX_PASSWORD), account ? account.passwordHash : DUMMY_HASH);
    return ok && account ? account : null;
  } catch {
    return null;
  }
}

function verifyGrid(account, pattern) {
  const expected = account?.gridPattern;
  if (!Array.isArray(pattern) || pattern.length !== 8) return false;
  if (!Array.isArray(expected) || expected.length !== 8) return false;
  if (account.gridOrderMatters) return pattern.every((v, i) => v === expected[i]);
  const a = [...pattern].sort((x, y) => x - y);
  const b = [...expected].sort((x, y) => x - y);
  return a.every((v, i) => v === b[i]);
}

function touchLogin(id) {
  const d = data();
  const account = d.accounts.find(a => a.id === id);
  if (!account) return;
  account.lastLoginAt = new Date().toISOString();
  save(d);
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------
function update(id, mutate) {
  const d = data();
  const account = d.accounts.find(a => a.id === id);
  if (!account) throw new AccountError('Account not found', 'NOT_FOUND', 404);
  mutate(account);
  save(d);
  return account;
}

/** New password and/or grid (recovery link or Settings). */
function setCredentials(id, { password, gridPattern, gridOrderMatters, username } = {}) {
  const changes = {};
  if (username !== undefined && username !== null && username !== '') changes.username = checkUsername(username, id);
  if (password !== undefined && password !== null && password !== '') changes.passwordHash = bcrypt.hashSync(checkPassword(password), BCRYPT_ROUNDS);
  if (gridPattern !== undefined && gridPattern !== null) changes.gridPattern = checkGrid(gridPattern);
  if (!Object.keys(changes).length && gridOrderMatters === undefined) {
    throw new AccountError('No changes provided', 'NO_CHANGES');
  }
  return update(id, (account) => {
    if (changes.username) {
      account.username = changes.username;
      account.usernameLower = lower(changes.username);
    }
    if (changes.passwordHash) account.passwordHash = changes.passwordHash;
    if (changes.gridPattern) account.gridPattern = changes.gridPattern;
    if (gridOrderMatters !== undefined) account.gridOrderMatters = !!gridOrderMatters;
    if (changes.passwordHash || changes.gridPattern) account.credentialsChangedAt = new Date().toISOString();
  });
}

function setEmail(id, email) {
  const clean = checkEmail(email, id);
  return update(id, (account) => {
    account.email = clean;
    account.emailLower = normalizeEmail(clean);
  });
}

function verifyPassword(account, password) {
  if (!account || typeof password !== 'string') return false;
  try {
    return bcrypt.compareSync(password.substring(0, MAX_PASSWORD), account.passwordHash);
  } catch {
    return false;
  }
}

/** Forget the account (its profile and data are removed by services/profileRemoval). */
function remove(id) {
  const d = data();
  const before = d.accounts.length;
  d.accounts = d.accounts.filter(a => a.id !== id);
  if (d.accounts.length === before) return false;
  save(d);
  return true;
}

// ---------------------------------------------------------------------------
// Owner's email (config.auth.email)
// ---------------------------------------------------------------------------
function setOwnerEmail(email) {
  const { saveConfig } = require('../config');
  const config = getConfig();
  if (email === null || email === '') {
    config.auth.email = null;
  } else {
    config.auth.email = checkEmail(email, 'owner');
  }
  saveConfig(config);
  return config.auth.email;
}

/** Hide most of an address for lists ("sa…@example.com"). */
function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${name.slice(0, 2)}…@${domain}`;
}

function toPublic(account, { fullEmail = false } = {}) {
  if (!account) return null;
  return {
    id: account.id,
    username: account.username,
    email: fullEmail ? account.email : maskEmail(account.email),
    profileId: account.profileId,
    createdAt: account.createdAt,
    lastLoginAt: account.lastLoginAt || null,
  };
}

async function flush() {
  if (typeof store.flush === 'function') await store.flush();
}

module.exports = {
  list,
  get,
  findByUsername,
  findByEmail,
  findByProfile,
  create,
  verifyLogin,
  verifyGrid,
  verifyPassword,
  touchLogin,
  setCredentials,
  setEmail,
  remove,
  signupEnabled,
  setSignupEnabled,
  setOwnerEmail,
  ownerEmail,
  usernameTaken,
  isValidEmail,
  normalizeEmail,
  maskEmail,
  toPublic,
  flush,
  AccountError,
  MAX_ACCOUNTS,
  MIN_PASSWORD,
  _store: store,
};
