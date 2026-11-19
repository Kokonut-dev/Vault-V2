/**
 * "How this is protected" — plain-language security details shown wherever
 * Vault hands out access: the same-Wi-Fi address, the remote (Cloudflare)
 * address, sign-in QR codes, approving a waiting device, transfer download
 * links and Subsonic.
 *
 * Every line describes a protection the server really enforces (see
 * README → Security). Keep them in sync when the server changes.
 *
 *   securityNotes('remote', { security, autoStopHours, open: true })
 */
import { icon } from '../utils/icons.js';
import { escapeHtml } from '../utils/format.js';

const ok = (iconName, html) => ({ icon: iconName, html, tone: 'ok' });
const warn = (html) => ({ icon: 'alert-triangle', html, tone: 'warn' });

function lockoutLine(security) {
  const max = security?.lockout?.maxAttempts || 5;
  const minutes = security?.lockout?.minutes || 15;
  return ok('clock', `After ${max} wrong tries, that device is locked out for ${minutes} minutes — guessing doesn’t work.`);
}

function signInLine(security) {
  return security?.totpEnabled
    ? ok('key', 'Every new device has to sign in with your password <strong>and</strong> a code from your authenticator app.')
    : ok('key', 'Every new device has to sign in with your password <strong>and</strong> your secret grid pattern.');
}

const devicesLine = ok('smartphone', 'You can see every signed-in device and sign any of them out in <a href="settings#devices" data-route="/settings#devices">Settings → Devices</a>.');

export function hoursLabel(hours) {
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/** The list of points for one place access is shared. */
export function securityPoints(kind, info = {}) {
  const { security = null } = info;
  switch (kind) {
    case 'lan':
      return [
        ok('home', 'This address only works inside your home network. Vault never opens ports on your router, so it can’t be reached from the internet this way.'),
        signInLine(security),
        ok('link', 'A sign-in QR code works <strong>once</strong>, for <strong>5 minutes</strong>, and only for your profile — a photo of it is useless afterwards.'),
        lockoutLine(security),
        devicesLine,
        warn('On the home network the connection is plain <code>http://</code>. That’s fine at home; don’t open Vault this way on public Wi-Fi — use the Anywhere address instead, which is encrypted.'),
      ];
    case 'remote': {
      const hours = info.autoStopHours;
      const points = [
        ok('lock', 'The address uses <strong>https</strong>, so the connection is encrypted between the other device and Cloudflare.'),
        ok('home', 'Nothing on your router changes and no ports are opened. This computer connects <em>out</em> to Cloudflare, your home IP address stays hidden, and only Vault is reachable — not your other devices or files.'),
        ok('eye-off', 'The address is random, changes every time and isn’t listed anywhere. Still, treat it as public: anyone who has it reaches your sign-in page — and no further.'),
        signInLine(security),
        lockoutLine(security),
        hours
          ? ok('clock', `Remote access turns itself off after <strong>${hoursLabel(hours)}</strong>. Turn it off sooner when you’re done.`)
          : warn('Remote access stays on until you turn it off. Choose an automatic switch-off below unless you really need it on all the time.'),
        devicesLine,
      ];
      // `nudged`: the dialog already shows its own authenticator callout.
      if (security && !security.totpEnabled && !info.nudged) {
        points.push(warn('Recommended: turn on an <strong>authenticator app</strong> in <a href="settings#security" data-route="/settings#security">Settings → Security</a> before you use remote access.'));
      }
      points.push(ok('info', 'Cloudflare carries the traffic and could technically read it. For a link only your own devices can open, use Tailscale instead (see README → Security).'));
      return points;
    }
    case 'pair':
      return [
        ok('link', 'The code and QR work <strong>once</strong> and expire after <strong>5 minutes</strong>.'),
        ok('users', 'The new device gets <strong>your</strong> profile and its limits — never more.'),
        ok('eye', 'Only show it to a device in front of you: whoever scans it in those 5 minutes is signed in.'),
        devicesLine,
      ];
    case 'approve':
      return [
        warn('Only approve a code you can see on a screen you own, right now. If someone sent you this code or link, don’t approve it — it would sign <em>their</em> device in as you.'),
        ok('users', 'The device gets your profile and its limits, and appears in Settings → Devices, where you can sign it out.'),
      ];
    case 'transfer':
      return [
        warn('The package holds your library <strong>and your settings</strong>, including your sign-in details (scrambled) — only open the link on your own computer.'),
        ok('link', 'The link works for <strong>one download</strong> and expires after <strong>2 hours</strong>, or when this server stops.'),
        ok('lock', 'Only an admin can create it, and the link is a long random code that can’t be guessed.'),
      ];
    case 'subsonic':
      return [
        ok('key', 'Subsonic apps use their <strong>own password</strong>. Your Vault password is never accepted here, because Subsonic can’t ask for your grid or authenticator code.'),
        ok('users', 'Apps only see the music the chosen profile may see.'),
        lockoutLine(security),
        ok('power', 'Remove the password to turn Subsonic access off completely.'),
      ];
    default:
      return [];
  }
}

/** Collapsible "How this is protected" block (open by default when asked). */
export function securityNotes(kind, info = {}) {
  const points = securityPoints(kind, info);
  if (!points.length) return '';
  const title = info.title || 'How this is protected';
  return `
    <details class="security-notes" data-security="${escapeHtml(kind)}"${info.open ? ' open' : ''}>
      <summary>${icon('shield-check', { size: 15 })}<span>${escapeHtml(title)}</span></summary>
      <ul class="security-points">
        ${points.map(p => `<li class="is-${p.tone}">${icon(p.icon, { size: 15 })}<span>${p.html}</span></li>`).join('')}
      </ul>
    </details>`;
}

export default { securityNotes, securityPoints, hoursLabel };
