/**
 * Terms of Use: which version is current, who has accepted it, and what a
 * profile that hasn't may still do.
 *
 * The binding text is the <article id="terms-document"> in docs/terms.html:
 * the same file is the public page (GitHub Pages and every server), the text
 * the app shows before anyone can continue, and the source of the version
 * number checked here. Its data-version / data-effective attributes name the
 * version, and a SHA-256 of the article fingerprints the exact wording.
 * server/legal/terms-versions.json records the fingerprint of every published
 * version, and a test fails if the text changes without a new version.
 *
 * Acceptance is per profile (each person agrees for themselves; a parent or
 * guardian agrees for a kids' profile). It is stored on the profile, plus an
 * append-only evidence record (who, which version and wording, when, from
 * which device and address) in data/terms-acceptances.json, on this server
 * only. A new version makes everyone accept again.
 *
 * Fails closed: if the terms file is missing or unreadable, nobody can pass
 * the gate (the server can't show what would be agreed to).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const paths = require('../utils/paths');
const { createJsonStore } = require('../utils/jsonStore');

const TERMS_FILE_NAME = 'terms.html';
const VERSIONS_FILE = path.join(__dirname, '..', 'legal', 'terms-versions.json');
const MAX_RECORDS = 5000;

const evidence = createJsonStore('terms-acceptances.json', { records: [] });

class TermsError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function termsFile() {
  return path.join(paths.DOCS_DIR, TERMS_FILE_NAME);
}

/** Same text, same fingerprint, whatever the checkout's line endings. */
function normalize(html) {
  return String(html).replace(/\r\n?/g, '\n').trim();
}

function fingerprint(html) {
  return crypto.createHash('sha256').update(normalize(html), 'utf8').digest('hex');
}

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return m ? m[1] : null;
}

/** Parse terms.html → { version, effective, sha256, html } (null if unusable). */
function parse(source) {
  const open = /<article\b[^>]*\bid\s*=\s*"terms-document"[^>]*>/i.exec(source);
  if (!open) return null;
  const start = open.index + open[0].length;
  const end = source.indexOf('</article>', start);
  if (end === -1) return null;
  const version = attr(open[0], 'data-version');
  const effective = attr(open[0], 'data-effective');
  if (!version || !/^[0-9A-Za-z.\-]{1,20}$/.test(version)) return null;
  const html = normalize(source.slice(start, end));
  if (!html) return null;
  return { version, effective: effective || null, sha256: fingerprint(html), html };
}

// The gate runs on every signed-in request: re-read the file only when it
// changes, and stat it at most once a second.
let cache = { file: null, mtimeMs: -1, size: -1, checkedAt: 0, terms: null };

/** The current terms, or null when the file is missing or malformed. */
function current() {
  const file = termsFile();
  const now = Date.now();
  if (cache.file === file && now - cache.checkedAt < 1000) return cache.terms;
  try {
    const stat = fs.statSync(file);
    if (cache.file !== file || stat.mtimeMs !== cache.mtimeMs || stat.size !== cache.size) {
      cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now, terms: parse(fs.readFileSync(file, 'utf8')) };
    } else {
      cache.checkedAt = now;
    }
  } catch {
    cache = { file, mtimeMs: -1, size: -1, checkedAt: now, terms: null };
  }
  return cache.terms;
}

/** Published versions and their fingerprints (server/legal/terms-versions.json). */
function publishedVersions() {
  try {
    return JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf8')).versions || {};
  } catch {
    return {};
  }
}

function profilesService() {
  // Lazy: services/profiles pulls in config and the JSON store.
  return require('./profiles');
}

/** Has this profile accepted the current version? (false when unknown: fail closed) */
function isAccepted(profileId) {
  const terms = current();
  if (!terms) return false;
  const profile = profilesService().get(profileId || 'default');
  return !!(profile && profile.terms && profile.terms.version === terms.version);
}

/** What the app needs to show the gate (no HTML: GET /api/legal/terms has it). */
function status(profileId) {
  const terms = current();
  const profile = profilesService().get(profileId || 'default');
  const accepted = profile?.terms || null;
  return {
    available: !!terms,
    version: terms?.version || null,
    effective: terms?.effective || null,
    sha256: terms?.sha256 || null,
    accepted: !!(terms && accepted && accepted.version === terms.version),
    acceptedVersion: accepted?.version || null,
    acceptedAt: accepted?.acceptedAt || null,
    // A kids' profile is accepted by a parent or legal guardian.
    guardianRequired: !!profile?.kids,
    profile: profile ? { id: profile.id, name: profile.name, kids: !!profile.kids } : null,
  };
}

/**
 * Record that `profileId` accepted the current terms. The client sends back
 * the version and fingerprint it showed, so nobody agrees to a text that
 * changed while the dialog was open.
 */
function accept({ profileId, version, sha256, guardian = false, readToEnd = false, user = null, session = null, ip = null }) {
  const terms = current();
  if (!terms) throw new TermsError('The Terms of Use could not be loaded on this server, so they can’t be accepted.', 'TERMS_UNAVAILABLE', 503);
  if (version !== terms.version || sha256 !== terms.sha256) {
    throw new TermsError('The Terms of Use have changed. Please read the current version.', 'TERMS_OUTDATED', 409);
  }
  if (readToEnd !== true) {
    throw new TermsError('Please read the Terms of Use to the end first.', 'TERMS_NOT_READ');
  }
  const profiles = profilesService();
  const profile = profiles.get(profileId || 'default');
  if (!profile) throw new TermsError('This profile no longer exists.', 'PROFILE_REMOVED', 404);
  if (profile.kids && guardian !== true) {
    throw new TermsError('A parent or legal guardian must accept the Terms of Use for this profile.', 'GUARDIAN_REQUIRED');
  }

  const acceptedAt = new Date().toISOString();
  const acceptance = { version: terms.version, sha256: terms.sha256, acceptedAt, guardian: !!profile.kids };
  profiles.setTerms(profile.id, acceptance);

  evidence.update((data) => {
    const records = Array.isArray(data.records) ? data.records : [];
    records.push({
      id: crypto.randomUUID(),
      profileId: profile.id,
      profileName: profile.name,
      kidsProfile: !!profile.kids,
      acceptedByGuardian: !!profile.kids,
      // The app only enables "Agree" once the whole text has been scrolled through.
      readToEnd: true,
      version: terms.version,
      effective: terms.effective,
      sha256: terms.sha256,
      acceptedAt,
      username: user || null,
      sessionId: session?.id || null,
      device: session?.device || null,
      userAgent: session?.userAgent || null,
      ip: ip || session?.ip || null,
    });
    // Newest kept if it ever grows huge (thousands of re-acceptances).
    return { records: records.slice(-MAX_RECORDS) };
  });
  if (typeof evidence.saveNow === 'function') evidence.saveNow();
  return { ...acceptance, profileId: profile.id };
}

/** Evidence records (newest first), for an admin. */
function records() {
  const list = evidence.get().records;
  return Array.isArray(list) ? [...list].reverse() : [];
}

// ---------------------------------------------------------------------------
// The gate (middleware/auth.js)
// ---------------------------------------------------------------------------
// Until a profile has accepted the current terms, its sign-in only reaches
// what is needed to read and accept them, to switch to another profile on
// the same device, or to keep the session alive. Everything else, including
// media links, live events and every app or TV, gets 403 TERMS_REQUIRED.
const OPEN_PATHS = [
  { method: 'GET', pattern: /^\/api\/legal(\/.*)?$/ },
  { method: 'POST', pattern: /^\/api\/legal\/terms\/accept$/ },
  { method: 'POST', pattern: /^\/api\/auth\/refresh$/ },
  { method: 'GET', pattern: /^\/api\/profiles\/?$/ },
  { method: 'POST', pattern: /^\/api\/profiles\/[^/]+\/switch$/ },
  // Someone who doesn't agree can still delete the account they just made.
  { method: 'DELETE', pattern: /^\/api\/accounts\/me$/ },
];

function gateAllows(method, fullPath) {
  const m = method === 'HEAD' ? 'GET' : method;
  return OPEN_PATHS.some(rule => rule.method === m && rule.pattern.test(fullPath));
}

/** The 403 body sent while terms are pending. */
function requiredBody() {
  const terms = current();
  return {
    error: terms
      ? 'Please read and accept the Terms of Use to continue.'
      : 'The Terms of Use could not be loaded on this server. Vault can’t be used until they are restored.',
    code: terms ? 'TERMS_REQUIRED' : 'TERMS_UNAVAILABLE',
    terms: terms ? { version: terms.version, effective: terms.effective } : null,
  };
}

module.exports = {
  current,
  parse,
  fingerprint,
  normalize,
  publishedVersions,
  isAccepted,
  status,
  accept,
  records,
  gateAllows,
  requiredBody,
  termsFile,
  TermsError,
  VERSIONS_FILE,
  _resetCache: () => { cache = { file: null, mtimeMs: -1, size: -1, checkedAt: 0, terms: null }; },
};
