/**
 * Outgoing email (recovery links, "your password was changed").
 *
 * Vault is self-hosted, so it sends through a mail account the owner sets up
 * in Settings → Accounts & email: any SMTP server (Gmail or Outlook with an
 * app password, Fastmail, a provider such as Brevo or Mailgun, …).
 *
 * The SMTP password is stored AES-256-GCM encrypted in config.json
 * (`mail.passEnc`) with a random key kept in data/mail.key, so config.json on
 * its own (a screenshot, a pasted support log) doesn't reveal it.
 *
 * Until mail is set up, `send()` returns { delivered: false } and the caller
 * shows the link in the server window instead (services/recovery.js).
 */
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { getConfig, saveConfig } = require('../config');
const { DATA_DIR } = require('../utils/dataDir');
const logger = require('../utils/logger');

const KEY_FILE = 'mail.key';
let transportFactory = (options) => require('nodemailer').createTransport(options);

function keyPath() {
  return path.join(DATA_DIR, KEY_FILE);
}

function encryptionKey() {
  const file = keyPath();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return Buffer.from(existing, 'hex');
  } catch { /* created below */ }
  const key = crypto.randomBytes(32);
  fs.ensureDirSync(path.dirname(file));
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  return key;
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

function decrypt(value) {
  if (!value) return '';
  try {
    const [iv, tag, data] = String(value).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function settings() {
  return getConfig().mail || {};
}

/** Is outgoing mail set up (and switched on)? */
function configured() {
  const m = settings();
  return Boolean(m.enabled && m.host && m.from);
}

/** For Settings: everything except the password. */
function status() {
  const m = settings();
  return {
    enabled: !!m.enabled,
    configured: configured(),
    host: m.host || '',
    port: Number(m.port) || 587,
    secure: !!m.secure,
    user: m.user || '',
    from: m.from || '',
    hasPassword: Boolean(m.passEnc),
  };
}

class MailError extends Error {
  constructor(message, code = 'MAIL_INVALID', field = null) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

const HOST_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * Save mail settings. `password`: a string sets it, '' or null clears it,
 * undefined keeps the stored one.
 */
function save(input = {}) {
  const config = getConfig();
  const current = config.mail || {};
  const next = { ...current };

  if (input.enabled !== undefined) next.enabled = !!input.enabled;
  if (input.host !== undefined) {
    const host = String(input.host || '').trim();
    if (host && !HOST_RE.test(host)) throw new MailError('Enter the mail server’s name, like smtp.gmail.com', 'MAIL_INVALID', 'host');
    next.host = host;
  }
  if (input.port !== undefined) {
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MailError('The port is a number like 587 or 465', 'MAIL_INVALID', 'port');
    next.port = port;
  }
  if (input.secure !== undefined) next.secure = !!input.secure;
  if (input.user !== undefined) next.user = String(input.user || '').trim().slice(0, 254);
  if (input.from !== undefined) {
    const from = String(input.from || '').trim();
    if (from && !isValidFrom(from)) throw new MailError('Enter the sender address, like vault@example.com or "Vault <vault@example.com>"', 'MAIL_INVALID', 'from');
    next.from = from;
  }
  if (input.password !== undefined) {
    next.passEnc = input.password ? encrypt(String(input.password).slice(0, 512)) : null;
  }
  if (next.enabled && (!next.host || !next.from)) {
    throw new MailError('Fill in the mail server and the sender address to turn email on', 'MAIL_INCOMPLETE', next.host ? 'from' : 'host');
  }
  config.mail = next;
  saveConfig(config);
  return status();
}

function isValidFrom(from) {
  const validator = require('validator');
  const m = /^(?:"?([^"<>]{0,100})"?\s*)?<([^<>\s]+)>$/.exec(from);
  const address = m ? m[2] : from;
  return validator.isEmail(address);
}

function createTransport() {
  const m = settings();
  const options = {
    host: m.host,
    port: Number(m.port) || 587,
    secure: !!m.secure,
    // Never fall back to sending the password in clear text.
    requireTLS: !m.secure,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  };
  if (m.user) options.auth = { user: m.user, pass: decrypt(m.passEnc) };
  return transportFactory(options);
}

/** Plain-text lines → a small, safe HTML version. */
function toHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const body = String(text).split('\n').map((line) => {
    const safe = esc(line);
    return safe.replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}">${url}</a>`);
  }).join('<br>\n');
  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#1c1c1c">${body}</body></html>`;
}

/**
 * Send a message. Never throws: returns { delivered: true } or
 * { delivered: false, reason, error? }.
 */
async function send({ to, subject, text }) {
  if (!configured()) return { delivered: false, reason: 'NOT_CONFIGURED' };
  try {
    const transport = createTransport();
    await transport.sendMail({ from: settings().from, to, subject, text, html: toHtml(text) });
    return { delivered: true };
  } catch (err) {
    logger.warn(`[Mail] Could not send "${subject}" to ${to}: ${err.message}`);
    return { delivered: false, reason: 'SEND_FAILED', error: friendlyError(err) };
  }
}

function friendlyError(err) {
  const msg = String(err?.message || err || '');
  if (err?.code === 'EAUTH' || /auth|credentials|535|534/i.test(msg)) return 'The mail server refused the username or password. For Gmail and Outlook, use an app password.';
  if (err?.code === 'ECONNECTION' || err?.code === 'ETIMEDOUT' || /ENOTFOUND|ECONNREFUSED|timeout/i.test(msg)) return 'Vault could not reach the mail server. Check the server name and port.';
  if (/certificate|self.signed|TLS|SSL/i.test(msg)) return 'The secure connection to the mail server failed. Try port 465 with "secure connection" on, or 587 with it off.';
  return msg.slice(0, 200) || 'Sending failed';
}

/** For tests. */
function _setTransportFactory(fn) {
  transportFactory = fn || ((options) => require('nodemailer').createTransport(options));
}

module.exports = { configured, status, save, send, encrypt, decrypt, friendlyError, MailError, _setTransportFactory, KEY_FILE };
