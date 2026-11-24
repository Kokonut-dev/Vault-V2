/**
 * Terms of Use: the reader and the full-screen gate.
 *
 * Nobody uses Vault without accepting the current Terms of Use (docs/terms.html):
 *   - signing up: the setup wizard embeds the reader (onboarding.js);
 *   - signing in, or after the terms are updated: ensureTermsAccepted() shows
 *     the gate before the app opens, and again whenever the server answers
 *     403 TERMS_REQUIRED (e.g. after switching to another profile).
 *
 * The server enforces it either way (middleware/auth.js → services/terms.js):
 * this module only lets the person read and accept. "Agree" stays disabled
 * until the whole text has been scrolled through and every box is ticked.
 */
import { api } from '../api.js';
import { escapeHtml } from '../utils/format.js';

// ---------------------------------------------------------------------------
// The text comes from the server the user is signing in to (its version is the
// one that must be accepted). It is a static file of that server, and the CSP
// blocks scripts anyway, but it still goes through a strict allowlist before
// it is shown: plain structure and links only.
// ---------------------------------------------------------------------------
const ALLOWED_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'P', 'UL', 'OL', 'LI', 'STRONG', 'EM', 'B', 'I', 'A', 'BR', 'SECTION', 'DIV', 'SPAN']);
const ALLOWED_CLASSES = new Set(['legal-meta', 'legal-summary']);

function safeHref(href) {
  const value = String(href || '').trim();
  if (/^#[\w-]+$/.test(value)) return value;
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? url.href : null;
  } catch {
    return null;
  }
}

function cleanNode(node, doc) {
  if (node.nodeType === Node.TEXT_NODE) return doc.createTextNode(node.textContent);
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const children = () => [...node.childNodes].map(child => cleanNode(child, doc)).filter(Boolean);
  if (!ALLOWED_TAGS.has(node.tagName)) {
    // Unknown wrapper: keep its text, drop the element (and anything scripted).
    if (['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'svg', 'SVG', 'MATH'].includes(node.tagName)) return null;
    const fragment = doc.createDocumentFragment();
    children().forEach(child => fragment.appendChild(child));
    return fragment;
  }
  const el = doc.createElement(node.tagName.toLowerCase());
  const classes = (node.getAttribute('class') || '').split(/\s+/).filter(c => ALLOWED_CLASSES.has(c));
  if (classes.length) el.className = classes.join(' ');
  if (node.id && /^[\w-]{1,40}$/.test(node.id)) el.id = `terms-${node.id}`;
  if (node.tagName === 'OL' && /^[1aAiI]$/.test(node.getAttribute('type') || '')) el.setAttribute('type', node.getAttribute('type'));
  if (node.tagName === 'A') {
    let href = safeHref(node.getAttribute('href'));
    if (href && href.startsWith('#')) href = `#terms-${href.slice(1)}`;
    if (href) {
      el.setAttribute('href', href);
      if (!href.startsWith('#')) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
  }
  children().forEach(child => el.appendChild(child));
  return el;
}

/** Sanitised DOM fragment for the terms HTML. */
export function sanitizeTermsHtml(html, doc = document) {
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${String(html || '')}`, 'text/html');
  const fragment = doc.createDocumentFragment();
  [...parsed.body.childNodes].forEach(node => {
    const clean = cleanNode(node, doc);
    if (clean) fragment.appendChild(clean);
  });
  return fragment;
}

/** Address of the printable page on the server whose terms are shown. */
export function termsPageUrl() {
  return api.baseUrl ? `${api.baseUrl.replace(/\/$/, '')}/terms.html` : 'terms.html';
}

function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(`${iso}T12:00:00`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Reader: scrollable text, read-to-the-end detection and the agreement boxes.
// ---------------------------------------------------------------------------
/**
 * @param {object} opts
 * @param {{version:string, effective:string, sha256:string, html:string}} opts.terms
 * @param {{name:string}|null} [opts.profile]  whose acceptance this is
 * @param {boolean} [opts.guardianRequired]    kids' profile: a parent/guardian accepts
 * @param {boolean} [opts.embedded]            inside the setup wizard (shorter box)
 * @param {object}  [opts.initial]             { read, agree, responsible, guardian } to restore
 * @param {(state) => void} [opts.onChange]
 */
export function createTermsReader({ terms, profile = null, guardianRequired = false, embedded = false, initial = {}, onChange = () => {} }) {
  const root = document.createElement('div');
  root.className = `terms-reader${embedded ? ' terms-reader-embedded' : ''}`;
  const version = escapeHtml(terms.version);
  const who = profile?.name ? escapeHtml(profile.name) : 'this profile';
  root.innerHTML = `
    <div class="terms-reader-scroll" tabindex="0" role="document" aria-label="Vault Terms of Use, version ${version}"></div>
    <p class="terms-reader-progress" aria-live="polite"></p>
    <div class="terms-reader-checks">
      <label class="terms-reader-check">
        <input type="checkbox" data-terms-check="agree" disabled>
        <span>I have read the Vault Terms of Use (version ${version}) in full and I agree to be bound by them.</span>
      </label>
      <label class="terms-reader-check">
        <input type="checkbox" data-terms-check="responsible" disabled>
        <span>I understand that I alone am responsible for all content I use with Vault, and that all piracy is my responsibility, not the website's, the creator's or any contributor's.</span>
      </label>
      ${guardianRequired ? `
      <label class="terms-reader-check">
        <input type="checkbox" data-terms-check="guardian" disabled>
        <span>I am the parent or legal guardian of the person who uses ${who}. I accept these Terms on their behalf and on my own, and I will supervise their use of Vault.</span>
      </label>` : ''}
    </div>
    <p class="terms-reader-links">
      <a href="${escapeHtml(termsPageUrl())}" target="_blank" rel="noopener noreferrer">Open the Terms as a page to save or print them</a>
    </p>
  `;
  const scroller = root.querySelector('.terms-reader-scroll');
  scroller.appendChild(sanitizeTermsHtml(terms.html));
  const end = document.createElement('div');
  end.className = 'terms-reader-end';
  end.setAttribute('aria-hidden', 'true');
  scroller.appendChild(end);

  const progress = root.querySelector('.terms-reader-progress');
  const boxes = [...root.querySelectorAll('[data-terms-check]')];
  let read = !!initial.read;

  for (const box of boxes) {
    if (initial[box.dataset.termsCheck]) box.checked = true;
    box.addEventListener('change', () => onChange(state()));
  }

  function state() {
    const values = Object.fromEntries(boxes.map(box => [box.dataset.termsCheck, box.checked]));
    return {
      read,
      ...values,
      complete: read && boxes.every(box => box.checked),
      version: terms.version,
      sha256: terms.sha256,
      guardian: !!values.guardian,
    };
  }

  function renderProgress() {
    if (read) {
      progress.textContent = 'You have reached the end. Tick the boxes below to accept.';
      progress.classList.add('is-done');
    } else {
      const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
      const pct = Math.min(99, Math.round((scroller.scrollTop / max) * 100));
      progress.textContent = `Please read to the end to continue (${pct}% read).`;
    }
    for (const box of boxes) box.disabled = !read;
  }

  function markRead() {
    if (read) return;
    read = true;
    renderProgress();
    onChange(state());
  }

  function checkEnd() {
    if (read) return;
    // A layout without height (hidden, or a test DOM) never counts as read.
    if (!scroller.scrollHeight || !scroller.clientHeight) return renderProgress();
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 24) markRead();
    else renderProgress();
  }

  scroller.addEventListener('scroll', checkEnd, { passive: true });
  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting) && scroller.clientHeight > 0) {
        // Only when the person has actually scrolled (or the text fits).
        if (scroller.scrollTop > 0 || scroller.scrollHeight <= scroller.clientHeight + 24) markRead();
      }
    }, { root: scroller, threshold: 1 });
    observer.observe(end);
  }
  renderProgress();
  requestAnimationFrame?.(() => checkEnd());

  return {
    element: root,
    scroller,
    state,
    /** For tests and keyboard users who reached the end without scrolling events. */
    checkEnd,
  };
}

// ---------------------------------------------------------------------------
// Gate: full screen, can't be dismissed. Resolves true (accepted) or false
// (declined, or the terms can't be loaded).
// ---------------------------------------------------------------------------
let pending = null;

function trapFocus(container, event) {
  if (event.key !== 'Tab') return;
  const focusable = [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]')]
    .filter(el => el.offsetParent !== null || el === document.activeElement);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function showGate(status, terms) {
  return new Promise((resolve) => {
    const updated = !!status.acceptedVersion && status.acceptedVersion !== terms.version;
    const previousFocus = document.activeElement;
    const gate = document.createElement('div');
    gate.className = 'terms-gate';
    gate.id = 'terms-gate';
    gate.setAttribute('role', 'dialog');
    gate.setAttribute('aria-modal', 'true');
    gate.setAttribute('aria-labelledby', 'terms-gate-title');
    gate.setAttribute('aria-describedby', 'terms-gate-intro');
    const profileLine = status.profile?.name
      ? ` You are accepting for the profile <strong>${escapeHtml(status.profile.name)}</strong>.`
      : '';
    gate.innerHTML = `
      <div class="terms-gate-card">
        <header class="terms-gate-header">
          <h1 id="terms-gate-title">${updated ? 'The Terms of Use have been updated' : 'Terms of Use'}</h1>
          <p id="terms-gate-intro">${updated
            ? 'Please read the new version to the end and accept it to keep using Vault.'
            : 'Before you can use Vault, please read the Terms of Use to the end and accept them.'}
            Version ${escapeHtml(terms.version)}${terms.effective ? `, effective ${escapeHtml(formatDate(terms.effective))}` : ''}.${profileLine}</p>
        </header>
        <div class="terms-gate-body terms-reader-host"></div>
        <form class="terms-gate-footer" novalidate>
          <div class="terms-reader-checks-host"></div>
          <div class="terms-gate-actions">
            <button type="button" class="btn btn-ghost" data-terms-decline>Decline and sign out</button>
            <button type="submit" class="btn btn-primary" data-terms-accept disabled>Agree and continue</button>
          </div>
          <p class="terms-gate-error" role="alert"></p>
        </form>
      </div>
    `;
    const card = gate.querySelector('.terms-gate-card');
    const form = gate.querySelector('form');
    const acceptBtn = gate.querySelector('[data-terms-accept]');
    const declineBtn = gate.querySelector('[data-terms-decline]');
    const errorEl = gate.querySelector('.terms-gate-error');

    const reader = createTermsReader({
      terms,
      profile: status.profile,
      guardianRequired: !!status.guardianRequired,
      onChange: (s) => { acceptBtn.disabled = !s.complete; },
    });
    // Text in the body, boxes and links in the footer (always visible).
    const host = gate.querySelector('.terms-reader-host');
    host.classList.add('terms-reader');
    host.appendChild(reader.scroller);
    const footerHost = gate.querySelector('.terms-reader-checks-host');
    for (const part of [...reader.element.children]) footerHost.appendChild(part);

    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); return; }
      trapFocus(gate, event);
    };

    function close(result) {
      document.removeEventListener('keydown', onKey, true);
      gate.remove();
      document.body.classList.remove('terms-gate-open');
      if (previousFocus && typeof previousFocus.focus === 'function' && document.contains(previousFocus)) previousFocus.focus();
      resolve(result);
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const s = reader.state();
      if (!s.complete) return;
      acceptBtn.disabled = true;
      declineBtn.disabled = true;
      errorEl.textContent = '';
      try {
        await api.acceptTerms({ version: s.version, sha256: s.sha256, readToEnd: true, guardian: s.guardian });
        close(true);
      } catch (err) {
        declineBtn.disabled = false;
        if (err.code === 'TERMS_OUTDATED') {
          // The text changed while it was open: show the new one from the top.
          close(null);
          return;
        }
        acceptBtn.disabled = false;
        errorEl.textContent = err.message || 'Your acceptance could not be saved. Please try again.';
      }
    });

    declineBtn.addEventListener('click', () => close(false));

    document.addEventListener('keydown', onKey, true);
    document.body.classList.add('terms-gate-open');
    document.body.appendChild(gate);
    reader.checkEnd();
    reader.scroller.focus({ preventScroll: true });
    card.scrollTop = 0;
  });
}

// A status request started early at start-up (main.js), while the server
// was still being asked whether it needs setup. Only used for the session
// (token) it was asked for, and only while it is fresh.
let prefetched = null;
const PREFETCH_TTL_MS = 30_000;

/** Ask for the terms status now; the next ensureTermsAccepted() uses the answer. */
export function prefetchTermsStatus() {
  const token = api.getToken();
  if (!token) return;
  const promise = api.getTermsStatus();
  promise.catch(() => { /* handled when (if) it is used */ });
  prefetched = { token, promise, at: Date.now() };
}

function takePrefetchedStatus() {
  const early = prefetched;
  prefetched = null;
  if (!early || early.token !== api.getToken() || Date.now() - early.at > PREFETCH_TTL_MS) return null;
  return early.promise;
}

/**
 * Make sure the signed-in profile has accepted the current terms, showing the
 * gate if not. Resolves true when accepted (or nothing needs accepting),
 * false when declined. Network failures resolve true: the server still
 * refuses everything until the terms are accepted, and the app's normal
 * "can't reach the server" handling takes over.
 */
export function ensureTermsAccepted() {
  if (pending) return pending;
  pending = (async () => {
    let early = takePrefetchedStatus();
    for (let round = 0; round < 3; round++) {
      let status;
      try {
        status = await (early || api.getTermsStatus());
        early = null;
      } catch (err) {
        if (err.status === 401) return false;
        if (err.status === 404) return true; // an older server without terms
        return true;
      }
      if (status.accepted) return true;
      if (!status.available) {
        const error = new Error('The Terms of Use could not be loaded on this server. Vault can’t be used until they are restored.');
        error.code = 'TERMS_UNAVAILABLE';
        throw error;
      }
      const terms = await api.getTerms();
      const result = await showGate(status, terms);
      if (result !== null) return result;
      // null: the terms changed while open; fetch and show them again.
    }
    return false;
  })().finally(() => { pending = null; });
  return pending;
}

/** Is the gate on screen right now? */
export function termsGateOpen() {
  return !!document.getElementById('terms-gate');
}
