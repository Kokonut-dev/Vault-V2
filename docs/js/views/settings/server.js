/**
 * Settings → Server: Live TV, Links & imports, Notifications, Connection.
 *
 * These change the whole server, so they use explicit Save buttons with
 * inline, field-level errors (WCAG 3.3.1/3.3.3) and one polite status line.
 * Saved links/tokens are write-only: the browser only ever sees whether a
 * value is set plus a redacted hint (SR-5, SR-8, SR-9).
 */
import { api } from '../../api.js';
import { store } from '../../store.js';
import { toast } from '../../components/toast.js';
import { getApiBaseUrl, setApiBaseUrl } from '../../config.js';
import { copyText } from '../../utils/clipboard.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { escapeHtml } from '../../utils/format.js';
import { icon } from '../../utils/icons.js';
import { onUnmount } from '../../utils/lifecycle.js';
import { serverIsOnThisDevice, waitForServer, waitForServerDown, probeLauncher, startServer, START_COMMAND } from '../../utils/serverLauncher.js';
import {
  section, group, row, el, flashStatus, secretField, fieldError, clearFieldError,
  applyFieldErrors, liveValidate, validateLink, setReadOnly, busy,
} from './ui.js';

const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;
const ADMIN_ONLY = 'Only an admin profile can change this. You can see what’s set up.';
const OUTDATED = 'Your Vault server is running an older version that can’t do this yet. Update the server, restart it, then reload this page.';

/**
 * Why this section is read-only, written so the person can act on it. A 404
 * from the new endpoints means the website was updated but the server
 * wasn't; it doesn't mean "you aren't an admin".
 */
export async function readOnlyNotice(err) {
  if (err?.status === 404) return OUTDATED;
  try {
    const { profiles = [], activeProfileId } = await api.getProfiles();
    const me = profiles.find(p => p.id === (activeProfileId || 'default'));
    const admins = profiles.filter(p => p.isAdmin && p.id !== me?.id).map(p => `“${escapeHtml(p.name)}”`);
    if (!me) return ADMIN_ONLY;
    const who = admins.length
      ? `Switch to ${admins.length === 1 ? admins[0] : `${admins.slice(0, -1).join(', ')} or ${admins.at(-1)}`} to change it, or have that profile make yours an admin`
      : 'An admin profile can make yours an admin';
    return `You’re using the “${escapeHtml(me.name)}” profile, which isn’t an admin. ${who} on the <a href="profiles" data-route="/profiles">Profiles page</a>.`;
  } catch {
    return ADMIN_ONLY;
  }
}

// ---------------------------------------------------------------------------
// Live TV (SR-5)
// ---------------------------------------------------------------------------
export function liveTvSection(ctx) {
  const s = section({
    id: 'live-tv',
    title: 'Live TV',
    iconName: 'tv',
    scope: 'server',
    intro: 'Add an IPTV channel list (M3U) and a TV guide (XMLTV). Vault fetches them on the server.',
  });
  s.body.innerHTML = '<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line"></div>';

  ctx.onLiveTvRerender((state) => renderLiveTv(s, ctx, state));
  ctx.liveTv().then(state => renderLiveTv(s, ctx, state)).catch(err => {
    s.body.innerHTML = err?.status === 404
      ? `<p class="settings-callout is-info">${icon('info', { size: 15 })}<span>${OUTDATED}</span></p>`
      : `<p class="settings-callout is-error">${icon('alert-circle', { size: 15 })}<span>Couldn’t load Live TV settings: ${escapeHtml(err.message)}</span></p>`;
  });
  return s;
}

function renderLiveTv(s, ctx, state) {
  s.body.replaceChildren();
  const form = el('<form class="settings-form" novalidate></form>');

  const sources = group('Sources', { description: 'Paste the links your provider gave you. A full path to a local file on the server works too.' });
  sources.append(
    el(`<div class="setting-row" data-keywords="live tv enable iptv on off">
      <div class="setting-text"><label class="setting-label" for="ltv-enabled">Turn on Live TV</label>
      <p class="setting-help" id="ltv-enabled-help">Shows the Live TV page with these channels.</p></div>
      <div class="setting-control"><input type="checkbox" class="checkbox" id="ltv-enabled" aria-describedby="ltv-enabled-help"${state.enabled ? ' checked' : ''}></div>
    </div>`),
  );
  const m3u = secretField({
    id: 'ltv-m3u',
    label: 'Channel list (M3U link)',
    help: 'Usually ends in .m3u or .m3u8, or contains get.php?…type=m3u_plus.',
    state: state.m3u,
    type: 'text',
    placeholder: 'https://provider.example/get.php?username=…&type=m3u_plus',
    keywords: 'm3u m3u8 iptv playlist channel list url link provider xtream',
  });
  const epg = secretField({
    id: 'ltv-epg',
    label: 'TV guide (XMLTV link)',
    help: 'Optional. Ends in .xml or .xml.gz. Many channel lists name their own guide — Test will spot it.',
    state: state.epg,
    type: 'text',
    placeholder: 'https://provider.example/xmltv.php or guide.xml.gz',
    keywords: 'epg xmltv guide tv guide programme schedule',
  });
  sources.append(m3u, epg);

  const tuners = group('Tuners');
  tuners.append(el(`<div class="setting-row" data-keywords="hdhomerun tuner antenna discovery network">
      <div class="setting-text"><label class="setting-label" for="ltv-hdhr">Find HDHomeRun tuners</label>
      <p class="setting-help" id="ltv-hdhr-help">Looks for SiliconDust tuners on the server’s network.</p></div>
      <div class="setting-control"><input type="checkbox" class="checkbox" id="ltv-hdhr" aria-describedby="ltv-hdhr-help"${state.hdhrDiscover ? ' checked' : ''}></div>
    </div>`));

  const actions = el(`<div class="settings-actions">
      <button type="button" class="btn btn-secondary" id="ltv-test">${icon('activity', { size: 16 })}<span>Test links</span></button>
      <button type="submit" class="btn btn-primary" id="ltv-save">Save</button>
      <a class="btn btn-ghost" href="livetv" data-route="/livetv">${icon('tv', { size: 16 })}<span>Open Live TV</span></a>
    </div>`);
  const report = el('<div class="test-report" id="ltv-report" role="region" aria-label="Test results" aria-live="polite" hidden></div>');

  // Most IPTV streams (MPEG-TS, MKV, HEVC, AC-3) only play in a browser after
  // the server converts them, which needs ffmpeg. Say so before anyone
  // presses play and gets a black screen.
  if (state.playback && state.playback.ffmpeg === false) {
    form.append(el(`<p class="settings-callout is-warn" data-ffmpeg-missing>${icon('alert-triangle', { size: 15 })}<span><strong>ffmpeg isn’t installed on the server.</strong> Most IPTV channels and movies use formats browsers can’t play on their own, so they won’t play until ffmpeg is installed (or <code>FFMPEG_PATH</code> points at it) and Vault is restarted.</span></p>`));
  }
  form.append(sources, tuners, actions, report);
  s.body.append(form);

  if (!state.canEdit) {
    setReadOnly(form);
    readOnlyNotice().then(message => setReadOnly(form, message));
    form.querySelector('[data-route]')?.removeAttribute('disabled');
    return;
  }

  const fieldMap = { m3uUrl: m3u.input, epgUrl: epg.input };
  const checkM3u = liveValidate(m3u.input, v => validateLink(v, { allowLocalPath: true }));
  const checkEpg = liveValidate(epg.input, v => validateLink(v, { allowLocalPath: true }));

  const payload = () => {
    const body = {
      enabled: form.querySelector('#ltv-enabled').checked,
      hdhrDiscover: form.querySelector('#ltv-hdhr').checked,
    };
    const m = m3u.value();
    const g = epg.value();
    if (m !== undefined) body.m3uUrl = m;
    if (g !== undefined) body.epgUrl = g;
    return body;
  };

  const testBtn = form.querySelector('#ltv-test');
  async function runTest(extra = {}) {
    const okM = checkM3u();
    const okE = checkEpg();
    if (!okM || !okE) return;
    const body = {};
    const m = m3u.value();
    const g = epg.value();
    if (m !== undefined) body.m3uUrl = m;
    if (g !== undefined) body.epgUrl = g;
    Object.assign(body, extra);
    if (!body.m3uUrl && !m3u.isConfigured() && !body.epgUrl && !epg.isConfigured()) {
      fieldError(m3u.input, 'Add a channel list link to test');
      m3u.input.focus();
      return;
    }
    busy(testBtn, true, 'Testing…');
    report.hidden = false;
    report.innerHTML = `<p class="test-report-pending">${icon('loader', { size: 15, className: 'icon spin' })}<span>Fetching on the server — big lists can take a few seconds…</span></p>`;
    try {
      const result = await api.testLiveTv(body);
      paintReport(report, result, {
        onAdoptGuide: async (btn) => {
          busy(btn, true, 'Saving…');
          try {
            const next = await api.adoptLiveTvGuide(m3u.value() ? { m3uUrl: m3u.value() } : {});
            epg.reset(next.epg);
            ctx.setLiveTv({ ...next, canEdit: true });
            flashStatus(s, 'Guide from the channel list saved');
            runTest();
          } catch (err) {
            busy(btn, false);
            flashStatus(s, err.message, 'error');
          }
        },
      });
    } catch (err) {
      report.innerHTML = `<p class="settings-callout is-error">${icon('alert-circle', { size: 15 })}<span>${escapeHtml(err.message)}</span></p>`;
    } finally {
      busy(testBtn, false);
    }
  }
  testBtn.addEventListener('click', () => runTest());
  s.runTest = runTest;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldError(m3u.input);
    clearFieldError(epg.input);
    if (!checkM3u() || !checkEpg()) {
      (m3u.input.getAttribute('aria-invalid') ? m3u.input : epg.input).focus();
      return;
    }
    const body = payload();
    if (body.enabled && body.m3uUrl === '' ) {
      fieldError(m3u.input, 'Live TV needs a channel list. Add one, or turn Live TV off.');
      m3u.input.focus();
      return;
    }
    if (body.enabled && body.m3uUrl === undefined && !m3u.isConfigured() && !body.hdhrDiscover) {
      fieldError(m3u.input, 'Add a channel list link (or turn on HDHomeRun discovery) before turning Live TV on.');
      m3u.input.focus();
      return;
    }
    const saveBtn = form.querySelector('#ltv-save');
    busy(saveBtn, true, 'Saving…');
    try {
      const next = await api.updateLiveTvSettings(body);
      m3u.reset(next.m3u);
      epg.reset(next.epg);
      ctx.setLiveTv({ ...next, canEdit: true });
      flashStatus(s, 'Live TV settings saved');
      window.dispatchEvent(new CustomEvent('vault:livetv-settings-changed'));
    } catch (err) {
      if (!applyFieldErrors(fieldMap, err.fields)) flashStatus(s, err.message, 'error');
      else flashStatus(s, 'Check the highlighted field', 'error');
    } finally {
      busy(saveBtn, false);
    }
  });
}

function paintReport(report, result, { onAdoptGuide }) {
  const parts = [];
  const m = result.m3u;
  const g = result.epg;
  const match = result.match;

  if (m) {
    if (m.ok) {
      const groups = (m.groups || []).slice(0, 6).map(gr => `<span class="chip">${escapeHtml(gr.name || gr)}${gr.count ? ` · ${gr.count}` : ''}</span>`).join('');
      parts.push(`<div class="test-item is-ok">
        ${icon('check-circle', { size: 18 })}
        <div class="test-body">
          <p class="test-title">Channel list: ${plural(m.channels, 'channel')}</p>
          <p class="test-meta">${plural(m.withGuideIds, 'channel')} carry a guide ID${m.sample?.length ? ` · e.g. ${m.sample.slice(0, 3).map(escapeHtml).join(', ')}` : ''}</p>
          ${groups ? `<div class="chip-row" aria-label="Groups">${groups}</div>` : ''}
          ${m.hasPlaylistGuide ? `<div class="test-suggest">
              <p>This list names its own guide: <code>${escapeHtml(m.playlistGuide)}</code></p>
              <button type="button" class="btn btn-secondary btn-sm" data-adopt-guide>${icon('calendar', { size: 14 })}<span>Use this guide</span></button>
            </div>` : ''}
        </div>
      </div>`);
      if (m.streams) parts.push(streamCheck(m.streams, m));
    } else {
      parts.push(testError('Channel list', m.error));
    }
  }

  if (g) {
    parts.push(g.ok
      ? `<div class="test-item is-ok">${icon('check-circle', { size: 18 })}<div class="test-body">
          <p class="test-title">TV guide: ${plural(g.channels, 'channel')}, ${plural(g.programmes, 'programme')}</p></div></div>`
      : testError('TV guide', g.error));
  } else if (m?.ok && !m.hasPlaylistGuide) {
    parts.push(`<div class="test-item is-info">${icon('info', { size: 18 })}<div class="test-body">
      <p class="test-title">No TV guide yet</p><p class="test-meta">Channels will play, but without “now / next”. Add an XMLTV link to fill the guide.</p></div></div>`);
  }

  if (match) {
    const total = match.channels || 0;
    const ratio = total ? Math.round((match.matched / total) * 100) : 0;
    const tone = ratio >= 80 ? 'is-ok' : ratio >= 30 ? 'is-warn' : 'is-error';
    parts.push(`<div class="test-item ${tone}">
      ${icon(ratio >= 80 ? 'check-circle' : 'alert-triangle', { size: 18 })}
      <div class="test-body">
        <p class="test-title">Guide matches ${match.matched} of ${plural(total, 'channel')} (${ratio}%)</p>
        <div class="meter" role="img" aria-label="${ratio}% of channels have guide data"><span style="width:${ratio}%"></span></div>
        ${match.unmatchedSample?.length ? `<p class="test-meta">No guide data for: ${match.unmatchedSample.slice(0, 5).map(escapeHtml).join(', ')}. Their <code>tvg-id</code> doesn’t appear in the guide (IDs are case-sensitive).</p>` : ''}
      </div>
    </div>`);
  }

  report.innerHTML = parts.join('') || '<p class="test-meta">Nothing to test yet.</p>';
  report.querySelector('[data-adopt-guide]')?.addEventListener('click', (e) => onAdoptGuide(e.currentTarget));
}

/** "Do the streams actually play?" — the server opened a few sample entries. */
function streamCheck(streams, m) {
  const mix = m.vod ? ` (${plural(m.live || 0, 'live channel')}, ${plural(m.vod, 'movie or episode', 'movies or episodes')})` : '';
  if (!streams.ffmpeg) {
    return `<div class="test-item is-warn">${icon('alert-triangle', { size: 18 })}<div class="test-body">
      <p class="test-title">Streams: couldn’t check playback</p>
      <p class="test-meta">ffmpeg isn’t installed on the server, so formats browsers can’t play natively (MPEG-TS, MKV, HEVC, AC-3 — most IPTV) won’t play. Install ffmpeg and restart Vault.</p></div></div>`;
  }
  const checked = streams.checked || [];
  const failed = checked.filter(c => !c.ok);
  const tone = !checked.length ? 'is-info' : failed.length === checked.length ? 'is-error' : failed.length ? 'is-warn' : 'is-ok';
  const title = !checked.length
    ? 'Streams: nothing to check'
    : failed.length === checked.length
      ? `Streams: none of the ${plural(checked.length, 'sample')} played`
      : failed.length
        ? `Streams: ${checked.length - failed.length} of ${checked.length} samples play`
        : `Streams: all ${plural(checked.length, 'sample')} play`;
  const rows = checked.map(c => `<li><strong>${escapeHtml(c.name || 'Untitled')}</strong>${c.kind === 'vod' ? ' (movie)' : ''} — ${c.ok
    ? `${escapeHtml(c.format || 'plays')}${c.converted ? ' · converted on the server' : ' · plays as-is'}`
    : escapeHtml(c.error || 'couldn’t open it')}</li>`).join('');
  const auth = failed.some(c => c.code === 'AUTH');
  return `<div class="test-item ${tone}">${icon(tone === 'is-ok' ? 'check-circle' : tone === 'is-info' ? 'info' : 'alert-triangle', { size: 18 })}<div class="test-body">
    <p class="test-title">${title}</p>
    <p class="test-meta">Vault opened a few entries${mix} to see what happens when someone presses play.</p>
    ${rows ? `<ul class="test-list">${rows}</ul>` : ''}
    ${auth ? '<p class="test-meta">“Access denied” on every stream usually means the subscription expired or the link’s password changed.</p>' : ''}
    ${streams.unsupported ? `<p class="test-meta">${plural(streams.unsupported, 'entry', 'entries')} ${streams.unsupported === 1 ? 'uses' : 'use'} a link type Vault can’t play (only http:// and https:// work).</p>` : ''}
  </div></div>`;
}

const testError = (what, message) => `<div class="test-item is-error">${icon('alert-circle', { size: 18 })}<div class="test-body">
  <p class="test-title">${what}: couldn’t use it</p><p class="test-meta">${escapeHtml(message || 'Unknown error')}</p></div></div>`;

// ---------------------------------------------------------------------------
// Links & imports (SR-6)
// ---------------------------------------------------------------------------
const ACTION_LABELS = {
  'livetv-source': { label: 'Use for Live TV', icon: 'tv' },
  'livetv-guide-from-playlist': { label: 'Use its TV guide too', icon: 'calendar' },
  'livetv-guide': { label: 'Use as TV guide', icon: 'calendar' },
  'import-playlist': { label: 'Import as playlist', icon: 'list' },
  'podcast-subscribe': { label: 'Subscribe', icon: 'rss' },
};

export function linksSection(ctx) {
  const s = section({
    id: 'links',
    title: 'Links & imports',
    iconName: 'link',
    scope: 'server',
    intro: 'Paste any link — Vault works out what it is and offers the right next step.',
  });

  const paste = group('Paste a link', { description: 'Channel lists (M3U), TV guides (XMLTV), music playlists and podcast feeds.' });
  const form = el(`<form class="link-inspector" novalidate>
      <div class="link-inspector-field setting-control">
        <label class="sr-only" for="link-url">Link to check</label>
        <input class="form-input" id="link-url" type="url" inputmode="url" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="https://…">
        <button type="submit" class="btn btn-primary" id="link-check">${icon('search', { size: 16 })}<span>Check link</span></button>
      </div>
    </form>`);
  const result = el('<div class="link-result" role="region" aria-label="Link details" aria-live="polite" hidden></div>');
  paste.append(form, result);
  paste.dataset.keywords = 'paste link url m3u xmltv podcast rss playlist import inspect check';

  const where = group('Where links are used');
  where.append(
    row({ label: 'Live TV channel list & guide', help: 'Set up, test and match channels.', keywords: 'live tv m3u epg', control: '<button type="button" class="btn btn-ghost btn-sm" data-go="live-tv">Open Live TV settings</button>' }),
    row({ label: 'Music playlists', help: 'Import a playlist file or link from the Playlists page too.', keywords: 'playlist import m3u', control: '<a class="btn btn-ghost btn-sm" href="playlists" data-route="/playlists">Open Playlists</a>' }),
    row({ label: 'Podcasts', help: 'Feeds you subscribe to refresh on the server.', keywords: 'podcast rss feed', control: '<a class="btn btn-ghost btn-sm" href="podcasts" data-route="/podcasts">Open Podcasts</a>' }),
    row({ label: 'Notifications', help: 'Webhook, ntfy, Discord and Telegram.', keywords: 'notifications webhook', control: '<button type="button" class="btn btn-ghost btn-sm" data-go="notifications">Open notification settings</button>' }),
  );
  const drive = driveGroup(s);
  s.body.append(paste, drive, where);
  s.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => ctx.select(b.dataset.go, { focus: true })));

  const input = form.querySelector('#link-url');
  const check = liveValidate(input, v => validateLink(v));

  ctx.liveTv().then(
    state => (state.canEdit ? null : readOnlyNotice()),
    err => readOnlyNotice(err),
  ).then(message => { if (message) setReadOnly(paste, message); });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const url = input.value.trim();
    const problem = validateLink(url, { required: true });
    if (problem) { fieldError(input, problem); input.focus(); return; }
    check();
    const btn = form.querySelector('#link-check');
    busy(btn, true, 'Checking…');
    result.hidden = false;
    result.innerHTML = `<p class="test-report-pending">${icon('loader', { size: 15, className: 'icon spin' })}<span>Looking at the link on the server…</span></p>`;
    try {
      const info = await api.inspectLink(url);
      paintLinkResult(result, info, url, ctx, s);
    } catch (err) {
      result.hidden = true;
      if (err.fields?.url) fieldError(input, err.fields.url);
      else fieldError(input, err.message);
      input.focus();
    } finally {
      busy(btn, false);
    }
  });
  return s;
}

/**
 * Google Drive: shared links work with nothing set up. An API key makes big
 * public folders reliable; an OAuth client ID adds "Connect Google account"
 * (private files, browsing My Drive) on the Upload page.
 */
function driveGroup(s) {
  const node = group('Google Drive', { description: 'Import from Drive on the <a href="upload" data-route="/upload">Upload page</a>. Shared links work without any setup.' });
  node.dataset.keywords = 'google drive import gdrive api key oauth client id';
  const form = el('<form class="drive-config" novalidate></form>');
  const apiKey = secretField({
    id: 'gd-api-key',
    label: 'API key (optional)',
    help: 'Lists big shared folders faster, with file sizes. Google Cloud Console → APIs & Services → enable the Drive API → Credentials → Create API key.',
    type: 'password',
    placeholder: 'AIza…',
    keywords: 'google api key drive folder',
  });
  const origin = window.location.origin;
  const clientId = el(`<div class="setting-row is-stacked" data-keywords="google oauth client id account private files">
      <div class="setting-text"><label class="setting-label" for="gd-client">OAuth client ID (optional)</label>
        <p class="setting-help" id="gd-client-help">Adds <strong>Connect Google account</strong> for private files. Create an OAuth client ID of type <em>Web application</em> and add <code>${escapeHtml(origin)}</code> as an authorised JavaScript origin.</p></div>
      <div class="setting-control"><input class="form-input" id="gd-client" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="1234567890-abc.apps.googleusercontent.com" aria-describedby="gd-client-help"></div>
    </div>`);
  const actions = el('<div class="settings-actions"><button type="submit" class="btn btn-primary" id="gd-save">Save Google Drive settings</button></div>');
  form.append(apiKey, clientId, actions);
  node.append(form);

  const clientInput = clientId.querySelector('#gd-client');
  api.driveConfig().then((cfg) => {
    apiKey.reset({ configured: cfg.apiKeyConfigured, hint: cfg.apiKeyHint });
    clientInput.value = cfg.clientId || '';
  }, async (err) => setReadOnly(node, await readOnlyNotice(err)));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('#gd-save');
    clearFieldError(apiKey.input);
    clearFieldError(clientInput);
    busy(btn, true, 'Saving…');
    try {
      const body = { clientId: clientInput.value.trim() };
      const key = apiKey.value();
      if (key !== undefined) body.apiKey = key;
      const cfg = await api.saveDriveConfig(body);
      apiKey.reset({ configured: cfg.apiKeyConfigured, hint: cfg.apiKeyHint });
      flashStatus(s, 'Google Drive settings saved');
    } catch (err) {
      if (err.fields?.apiKey) fieldError(apiKey.input, err.fields.apiKey);
      else if (err.fields?.clientId) fieldError(clientInput, err.fields.clientId);
      else flashStatus(s, err.message, 'error');
    } finally {
      busy(btn, false);
    }
  });
  return node;
}

function summaryLines(info) {
  const sm = info.summary || {};
  const approx = sm.approximate ? 'at least ' : '';
  switch (info.kind) {
    case 'm3u-live': return [
      `${approx}${plural(sm.channels, 'channel')}${sm.groups?.length ? ` in ${plural(sm.groups.length, 'group')}` : ''}`,
      sm.withGuideIds !== undefined ? `${plural(sm.withGuideIds, 'channel')} with a guide ID` : '',
      sm.hasEpgUrl ? `Names a TV guide: ${sm.epgUrl}` : '',
      sm.sample?.length ? `e.g. ${sm.sample.slice(0, 3).join(', ')}` : '',
    ];
    case 'm3u-audio': return [
      `${approx}${plural(sm.entries, 'entry', 'entries')}${sm.remote ? ` (${sm.remote} web ${sm.remote === 1 ? 'link' : 'links'})` : ''}`,
      sm.sample?.length ? `e.g. ${sm.sample.slice(0, 3).join(', ')}` : '',
    ];
    case 'xmltv': return [`${approx}${plural(sm.channels, 'channel')}, ${plural(sm.programmes, 'programme')}`];
    case 'podcast': return [sm.title ? `“${sm.title}”` : '', `${plural(sm.episodes || 0, 'episode')}`];
    default: return [];
  }
}

function paintLinkResult(host, info, url, ctx, sectionNode) {
  const lines = summaryLines(info).filter(Boolean);
  const kindIcon = { 'm3u-live': 'tv', 'm3u-audio': 'music', xmltv: 'calendar', podcast: 'rss', html: 'globe', 'hls-stream': 'video' }[info.kind] || 'file-question';
  const ok = info.actions?.length > 0;
  const fileName = (() => {
    try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || '').replace(/\.(m3u8?|pls)$/i, ''); } catch { return ''; }
  })();
  host.innerHTML = `
    <div class="link-card ${ok ? 'is-ok' : 'is-warn'}">
      <span class="link-card-icon" aria-hidden="true">${icon(kindIcon, { size: 22 })}</span>
      <div class="link-card-body">
        <p class="link-card-kind">${escapeHtml(info.label)}</p>
        <p class="link-card-url"><code>${escapeHtml(info.displayUrl || '')}</code>${info.redirected ? ' <span class="chip">redirected</span>' : ''}</p>
        ${lines.length ? `<ul class="link-card-facts">${lines.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : ''}
        ${info.hint ? `<p class="settings-callout ${ok ? 'is-info' : 'is-warn'}">${icon(ok ? 'info' : 'alert-triangle', { size: 15 })}<span>${escapeHtml(info.hint)}</span></p>` : ''}
        ${info.actions?.includes('import-playlist') ? `
          <div class="link-card-name">
            <label class="form-label" for="link-pl-name">Playlist name</label>
            <input class="form-input" id="link-pl-name" maxlength="100" value="${escapeHtml(fileName)}">
          </div>` : ''}
        ${ok ? `<div class="link-card-actions">${info.actions.map((a, i) => {
          const spec = ACTION_LABELS[a] || { label: a, icon: 'check' };
          return `<button type="button" class="btn ${i === 0 ? 'btn-primary' : 'btn-secondary'} btn-sm" data-action="${a}">${icon(spec.icon, { size: 14 })}<span>${spec.label}</span></button>`;
        }).join('')}</div>` : ''}
        <p class="link-card-outcome" role="status"></p>
      </div>
    </div>`;

  const outcome = host.querySelector('.link-card-outcome');
  const say = (html, tone = 'ok') => {
    outcome.dataset.tone = tone;
    outcome.innerHTML = `${icon(tone === 'ok' ? 'check-circle' : 'alert-circle', { size: 15 })}<span>${html}</span>`;
  };

  host.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', async () => {
    const action = btn.dataset.action;
    busy(btn, true, 'Working…');
    try {
      if (action === 'livetv-source') {
        const next = await api.updateLiveTvSettings({ m3uUrl: url, enabled: true });
        ctx.setLiveTv({ ...next, canEdit: true }, { rerender: true });
        say('Saved as the Live TV channel list. <button type="button" class="link-button" data-go-ltv>Test it in Live TV settings</button>');
        host.querySelector('[data-go-ltv]')?.addEventListener('click', () => ctx.select('live-tv', { focus: true, test: true }));
      } else if (action === 'livetv-guide-from-playlist') {
        const next = await api.adoptLiveTvGuide({ m3uUrl: url });
        ctx.setLiveTv({ ...next, canEdit: true }, { rerender: true });
        say('The guide named in this list is now the Live TV guide.');
      } else if (action === 'livetv-guide') {
        const next = await api.updateLiveTvSettings({ epgUrl: url });
        ctx.setLiveTv({ ...next, canEdit: true }, { rerender: true });
        say('Saved as the Live TV guide.');
      } else if (action === 'import-playlist') {
        const name = host.querySelector('#link-pl-name')?.value.trim() || '';
        const res = await api.importPlaylistFromUrl(url, name);
        const remote = res.remote ? ` ${res.remote} ${res.remote === 1 ? 'was a web link' : 'were web links'} and can’t be matched.` : '';
        say(`Created “${escapeHtml(res.playlist?.name || name)}” with ${res.matched} of ${plural(res.considered, 'song')} found in your library.${remote} <a href="playlists" data-route="/playlists">Open Playlists</a>`, res.matched ? 'ok' : 'warn');
        window.dispatchEvent(new CustomEvent('vault:playlists-changed'));
      } else if (action === 'podcast-subscribe') {
        await api.subscribeFeed(url);
        say('Subscribed. New episodes appear on the Podcasts page.');
      }
      btn.disabled = true;
      btn.removeAttribute('aria-busy');
      btn.innerHTML = `${icon('check', { size: 14 })}<span>Done</span>`;
      flashStatus(sectionNode);
    } catch (err) {
      busy(btn, false);
      say(escapeHtml(err.message), 'error');
    }
  }));
}

// ---------------------------------------------------------------------------
// Notifications (SR-8)
// ---------------------------------------------------------------------------
export function notificationsSection(ctx) {
  const s = section({
    id: 'notifications',
    title: 'Notifications',
    iconName: 'message',
    scope: 'server',
    intro: 'Get a message when a scan finishes or uploads complete.',
  });
  s.body.innerHTML = '<div class="skeleton skeleton-line"></div>';
  api.getNotificationSettings()
    .then(data => renderNotifications(s, data))
    .catch(err => {
      s.body.innerHTML = err?.status === 404
        ? `<p class="settings-callout is-info">${icon('info', { size: 15 })}<span>${OUTDATED}</span></p>`
        : `<p class="settings-callout is-error">${icon('alert-circle', { size: 15 })}<span>Couldn’t load notification settings: ${escapeHtml(err.message)}</span></p>`;
    });
  return s;
}

const TARGET_NAMES = { webhook: 'Webhook', ntfy: 'ntfy', discord: 'Discord', telegram: 'Telegram' };

function renderNotifications(s, { targets, canEdit }) {
  s.body.replaceChildren();
  const form = el('<form class="settings-form" novalidate></form>');

  const push = group('Push services');
  const ntfy = secretField({ id: 'n-ntfy', label: 'ntfy topic', help: 'For example https://ntfy.sh/your-secret-topic — anyone who knows the topic can read it, so make it hard to guess.', state: targets.ntfyUrl, placeholder: 'https://ntfy.sh/…', keywords: 'ntfy push phone', inputMode: 'url' });
  const discord = secretField({ id: 'n-discord', label: 'Discord webhook', help: 'Server Settings → Integrations → Webhooks → Copy Webhook URL.', state: targets.discordWebhook, placeholder: 'https://discord.com/api/webhooks/…', keywords: 'discord webhook', inputMode: 'url' });
  push.append(ntfy, discord);

  const tg = group('Telegram', { description: 'Create a bot with @BotFather, add it to your chat, then paste both values.' });
  const tgToken = secretField({ id: 'n-tg-token', label: 'Bot token', state: targets.telegram?.botToken || { configured: false }, type: 'password', placeholder: '123456789:ABC…', keywords: 'telegram bot token', autocomplete: 'off' });
  const tgChat = secretField({ id: 'n-tg-chat', label: 'Chat ID', help: 'A number like -1001234567890, or @channelname.', state: targets.telegram?.chatId || { configured: false }, type: 'text', placeholder: '-1001234567890', keywords: 'telegram chat id' });
  tg.append(tgToken, tgChat);

  const hooks = group('Automation');
  const webhook = secretField({ id: 'n-webhook', label: 'Webhook (JSON POST)', help: 'Vault POSTs {source, level, title, message, timestamp} — handy for Home Assistant or n8n.', state: targets.webhookUrl, placeholder: 'https://…', keywords: 'webhook home assistant n8n json', inputMode: 'url' });
  hooks.append(webhook);

  const actions = el(`<div class="settings-actions">
      <button type="submit" class="btn btn-primary" id="n-save">Save</button>
      <button type="button" class="btn btn-secondary" id="n-test">${icon('send', { size: 16 })}<span>Send test notification</span></button>
    </div>`);
  const report = el('<div class="test-report" role="region" aria-label="Test notification results" aria-live="polite" hidden></div>');
  form.append(push, tg, hooks, actions, report);
  s.body.append(form);

  if (!canEdit) {
    setReadOnly(form);
    readOnlyNotice().then(message => setReadOnly(form, message));
    return;
  }

  const urlFields = [[ntfy, 'ntfyUrl'], [discord, 'discordWebhook'], [webhook, 'webhookUrl']];
  urlFields.filter(([f]) => f !== discord).forEach(([f]) => liveValidate(f.input, v => validateLink(v)));
  liveValidate(discord.input, v => {
    const basic = validateLink(v);
    if (basic || !v) return basic;
    return /^https:\/\/(canary\.|ptb\.)?(discord|discordapp)\.com\/api\/webhooks\/\d+\/.+/i.test(v) ? '' : 'Paste the full Discord webhook link (https://discord.com/api/webhooks/…)';
  });
  liveValidate(tgToken.input, v => (!v || /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(v) ? '' : 'A bot token looks like 123456789:ABC… — copy it from @BotFather'));
  liveValidate(tgChat.input, v => (!v || /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/.test(v) ? '' : 'A chat ID is a number (e.g. -1001234567890) or @channelname'));

  const fieldMap = {
    ntfyUrl: ntfy.input, discordWebhook: discord.input, webhookUrl: webhook.input,
    'telegram.botToken': tgToken.input, 'telegram.chatId': tgChat.input,
  };
  const all = [ntfy, discord, webhook, tgToken, tgChat];

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (form.querySelector('[aria-invalid="true"]')) {
      form.querySelector('[aria-invalid="true"]').focus();
      flashStatus(s, 'Check the highlighted field', 'error');
      return;
    }
    const body = {};
    for (const [f, key] of urlFields) {
      const v = f.value();
      if (v !== undefined) body[key] = v;
    }
    const token = tgToken.value();
    const chat = tgChat.value();
    if (token !== undefined || chat !== undefined) {
      body.telegram = {};
      if (token !== undefined) body.telegram.botToken = token;
      if (chat !== undefined) body.telegram.chatId = chat;
    }
    if (!Object.keys(body).length) { flashStatus(s, 'Nothing changed'); return; }
    const btn = form.querySelector('#n-save');
    busy(btn, true, 'Saving…');
    try {
      const next = await api.updateNotificationSettings(body);
      const t = next.targets;
      ntfy.reset(t.ntfyUrl); discord.reset(t.discordWebhook); webhook.reset(t.webhookUrl);
      tgToken.reset(t.telegram.botToken); tgChat.reset(t.telegram.chatId);
      flashStatus(s, 'Notification settings saved');
    } catch (err) {
      all.forEach(f => clearFieldError(f.input));
      if (applyFieldErrors(fieldMap, err.fields)) flashStatus(s, 'Check the highlighted field', 'error');
      else flashStatus(s, err.message, 'error');
    } finally {
      busy(btn, false);
    }
  });

  form.querySelector('#n-test').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (all.some(f => f.value())) {
      report.hidden = false;
      report.innerHTML = `<p class="settings-callout is-info">${icon('info', { size: 15 })}<span>Save your changes first — the test uses the saved settings.</span></p>`;
      return;
    }
    busy(btn, true, 'Sending…');
    report.hidden = false;
    report.innerHTML = `<p class="test-report-pending">${icon('loader', { size: 15, className: 'icon spin' })}<span>Sending…</span></p>`;
    try {
      const res = await api.testNotifications();
      const keys = Object.keys(res.results || {});
      report.innerHTML = keys.length
        ? keys.map(k => {
          const r = res.results[k];
          return r.ok
            ? `<div class="test-item is-ok">${icon('check-circle', { size: 18 })}<div class="test-body"><p class="test-title">${TARGET_NAMES[k] || k}: sent</p></div></div>`
            : testError(TARGET_NAMES[k] || k, r.error);
        }).join('')
        : `<p class="settings-callout is-info">${icon('info', { size: 15 })}<span>${escapeHtml(res.message || 'No notification targets are set up yet.')}</span></p>`;
    } catch (err) {
      report.innerHTML = `<p class="settings-callout is-error">${icon('alert-circle', { size: 15 })}<span>${escapeHtml(err.message)}</span></p>`;
    } finally {
      busy(btn, false);
    }
  });
}

// ---------------------------------------------------------------------------
// Connection (SR-14)
// ---------------------------------------------------------------------------
function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

export function connectionSection() {
  const s = section({
    id: 'connection',
    title: 'Connection',
    iconName: 'database',
    scope: 'device',
    intro: 'Which server this browser talks to, and how to reach it from elsewhere.',
  });

  const server = group('Server address');
  server.append(el(`<form class="setting-row is-stacked" id="api-form" novalidate data-keywords="server url api address tunnel cloudflare base">
      <div class="setting-text"><label class="setting-label" for="api-url">Server URL</label>
        <p class="setting-help" id="api-url-help">Change this if Vault runs somewhere else, such as a Cloudflare Tunnel address.</p></div>
      <div class="setting-control">
        <div class="input-with-actions">
          <input type="url" inputmode="url" class="form-input" id="api-url" value="${escapeHtml(getApiBaseUrl())}" aria-describedby="api-url-help" spellcheck="false" autocapitalize="off">
          <button class="btn btn-secondary" id="copy-api-url" type="button">${icon('copy', { size: 16 })}<span>Copy</span></button>
          <button class="btn btn-primary" id="save-api-url" type="submit">Save</button>
        </div>
      </div>
    </form>`));

  const status = group('Status');
  status.append(el(`<div class="server-status" data-keywords="status health version uptime items connection test">
      <div class="server-status-line" id="server-status" role="status" aria-live="polite"><span class="status-dot"></span><span>Checking…</span></div>
      <dl class="server-facts" id="server-facts"></dl>
      <div class="settings-actions">
        <button type="button" class="btn btn-secondary btn-sm" id="test-connection">${icon('refresh', { size: 14 })}<span>Check again</span></button>
        <button type="button" class="btn btn-secondary btn-sm" id="trigger-scan">${icon('folder', { size: 14 })}<span>Scan library now</span></button>
      </div>
    </div>`));

  const base = window.location.origin;
  const remote = group('Use Vault on other devices', { description: 'Phones, tablets, TVs and other computers.' });
  remote.append(
    row({
      label: 'Same Wi-Fi',
      help: '<span id="lan-help">Checking…</span>',
      keywords: 'lan local network wifi phone tablet qr code address other device',
      control: `<button type="button" class="btn btn-secondary btn-sm" data-share="lan">${icon('smartphone', { size: 14 })}<span>Show QR code</span></button>`,
    }),
    row({
      label: 'From anywhere',
      help: '<span id="tunnel-help">A private https:// address through Cloudflare — no router settings.</span>',
      keywords: 'remote access tunnel cloudflare cloudflared away from home internet https',
      control: `<button type="button" class="btn btn-secondary btn-sm" data-share="remote" id="tunnel-btn">${icon('globe', { size: 14 })}<span>Set up</span></button>`,
    }),
  );
  remote.append(el(`<details class="remote-advanced" data-keywords="https certificate domain caddy nginx reverse proxy">
      <summary>Your own domain or HTTPS certificate</summary>
      <p class="setting-help">Run <code>npm run generate-cert</code> in <code>server/</code> and enable <code>server.https</code>, or put Vault behind Caddy or nginx. Browsers block plain HTTP from an HTTPS page (only <code>localhost</code> is exempt).</p>
      <div class="setting-row is-stacked">
        <div class="setting-text"><label class="setting-label" for="remote-url">This page’s address</label></div>
        <div class="setting-control"><div class="input-with-actions">
          <input class="form-input" id="remote-url" value="${escapeHtml(base)}" readonly>
          <button class="btn btn-secondary" id="remote-copy" type="button">${icon('copy', { size: 16 })}<span>Copy</span></button>
        </div></div>
      </div>
    </details>`));

  const program = group('Server program', { description: 'Start, restart or stop Vault without a terminal.' });
  program.append(
    row({
      label: 'Running',
      help: '<span id="program-help">Checking…</span>',
      keywords: 'restart stop start server program launcher process',
      control: `<div class="settings-actions is-inline">
          <button type="button" class="btn btn-secondary btn-sm" id="server-restart">${icon('refresh', { size: 14 })}<span>Restart</span></button>
          <button type="button" class="btn btn-ghost btn-sm" id="server-stop">${icon('power', { size: 14 })}<span>Stop</span></button>
          <button type="button" class="btn btn-primary btn-sm" id="server-start" hidden>${icon('power', { size: 14 })}<span>Start server</span></button>
        </div>`,
    }),
    row({
      label: 'Start Vault when this computer starts',
      help: '<span id="autostart-help">Runs quietly in the background after you sign in to the computer.</span>',
      keywords: 'autostart startup login boot launch automatically background',
      id: 'autostart-toggle',
      control: '<input type="checkbox" role="switch" class="switch" id="autostart-toggle" aria-describedby="autostart-toggle-help">',
    }),
  );
  s.body.append(server, status, remote, program);

  // --- wiring
  const apiInput = s.querySelector('#api-url');
  liveValidate(apiInput, v => validateLink(v));
  s.querySelector('#copy-api-url').addEventListener('click', async () => {
    if (await copyText(apiInput.value.trim())) flashStatus(s, 'Server URL copied');
    else toast.error('Couldn’t copy — select the URL and copy it manually');
  });
  s.querySelector('#api-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = apiInput.value.trim().replace(/\/+$/, '');
    const problem = validateLink(url, { required: true });
    if (problem) { fieldError(apiInput, problem); apiInput.focus(); return; }
    clearFieldError(apiInput);
    setApiBaseUrl(url);
    apiInput.value = url;
    flashStatus(s, 'Server URL saved');
    refresh();
  });
  s.querySelector('#remote-copy').addEventListener('click', async () => {
    if (await copyText(s.querySelector('#remote-url').value)) flashStatus(s, 'Address copied');
  });

  // --- other devices + server program
  s.querySelectorAll('[data-share]').forEach(btn => btn.addEventListener('click', async () => {
    const { openShareDevice } = await import('../../components/shareDevice.js');
    openShareDevice({ tab: btn.dataset.share });
  }));
  const programHelp = s.querySelector('#program-help');
  const autostartToggle = s.querySelector('#autostart-toggle');
  const autostartHelp = s.querySelector('#autostart-help');
  let serverInfo = null;
  async function refreshProgram() {
    try {
      serverInfo = await api.serverInfo();
    } catch (err) {
      programHelp.textContent = err.status === 404 ? OUTDATED : err.message;
      program.querySelectorAll('button, input').forEach(c => { c.disabled = true; });
      return;
    }
    let admin = true;
    try { refreshTunnel((await api.remoteStatus()).tunnel); } catch (err) {
      if (err.code === 'ADMIN_REQUIRED') {
        admin = false;
        const message = await readOnlyNotice(err);
        setReadOnly(remote, message);
        setReadOnly(program, message);
      }
    }
    const where = serverIsOnThisDevice() ? 'on this computer' : `on ${serverInfo.hostname}`;
    programHelp.textContent = serverInfo.supervised
      ? `Vault ${serverInfo.version} is running ${where}. Stopping it leaves a Start button here and on the sign-in page.`
      : `Vault ${serverInfo.version} is running ${where}, started from a terminal. Start it with “npm start” to restart or stop it from here.`;
    s.querySelector('#server-restart').disabled = !serverInfo.supervised || !admin;
    s.querySelector('#server-stop').disabled = !serverInfo.supervised || !admin;
    const auto = serverInfo.autostart || {};
    autostartToggle.checked = Boolean(auto.installed);
    autostartToggle.disabled = !auto.supported || !admin;
    autostartHelp.textContent = !auto.supported
      ? (auto.reason || 'Not available on this system.')
      : auto.installed ? `On — ${auto.method || 'starts at sign-in'}.` : `Runs quietly in the background after you sign in to ${serverIsOnThisDevice() ? 'this computer' : serverInfo.hostname}.`;
    const lanHelp = s.querySelector('#lan-help');
    lanHelp.textContent = serverInfo.network.lan
      ? 'Scan a QR code with your phone — it opens Vault and signs you in.'
      : 'Off: Vault only accepts connections from this computer. You can turn it on from here.';
  }
  async function refreshTunnel(tunnel) {
    const help = s.querySelector('#tunnel-help');
    const btn = s.querySelector('#tunnel-btn span');
    if (!tunnel) {
      try { tunnel = (await api.remoteStatus()).tunnel; } catch { return; }
    }
    if (tunnel.status === 'on') { help.innerHTML = `On: <a href="${escapeHtml(tunnel.url)}" target="_blank" rel="noopener">${escapeHtml(tunnel.url.replace(/^https:\/\//, ''))}</a>`; btn.textContent = 'Show'; }
    else if (tunnel.status === 'installing' || tunnel.status === 'starting') { help.textContent = 'Starting…'; btn.textContent = 'Show'; }
    else if (tunnel.status === 'error') { help.textContent = tunnel.error || 'Couldn’t start'; btn.textContent = 'Try again'; }
    else { help.textContent = 'A private https:// address through Cloudflare — no router settings.'; btn.textContent = 'Set up'; }
  }
  const onRemote = (e) => refreshTunnel(e.detail);
  window.addEventListener('vault:remote-changed', onRemote);
  onUnmount(() => window.removeEventListener('vault:remote-changed', onRemote));

  autostartToggle.addEventListener('change', async () => {
    autostartToggle.disabled = true;
    try {
      await api.setAutostart(autostartToggle.checked, true);
      flashStatus(s, autostartToggle.checked ? 'Vault will start with this computer' : 'Vault won’t start automatically');
    } catch (err) {
      autostartToggle.checked = !autostartToggle.checked;
      flashStatus(s, err.message, 'error');
    }
    refreshProgram();
  });
  s.querySelector('#server-restart').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Restarting…');
    try {
      await api.restartServer();
      await waitForServerDown({ timeoutMs: 15000 });
      const back = await waitForServer({ timeoutMs: 120000 });
      flashStatus(s, back ? 'Server restarted' : 'The server didn’t come back — check its window or log', back ? 'ok' : 'error');
    } catch (err) {
      flashStatus(s, err.message, 'error');
    } finally {
      busy(btn, false);
      refresh();
      refreshProgram();
    }
  });
  s.querySelector('#server-stop').addEventListener('click', async (e) => {
    const local = serverIsOnThisDevice();
    const message = local
      ? 'Playback stops on every device. You can start it again from this page or the sign-in screen.'
      : `Vault on ${serverInfo?.hostname || 'its computer'} stops, and playback stops on every device. It can only be started again on that computer.`;
    const btn = e.currentTarget;
    const ok = await confirmDialog({ title: 'Stop the server?', message, confirmText: 'Stop server', danger: true });
    if (!ok) return;
    busy(btn, true, 'Stopping…');
    try {
      await api.stopServer();
      await waitForServerDown({ timeoutMs: 15000 });
      busy(btn, false);
      await showStopped(local);
      // The app-wide banner (with its own Start button) — a deliberate stop
      // used to leave every page looking connected until the next request.
      window.dispatchEvent(new CustomEvent('vault:server-down', { detail: { message: 'The Vault server is stopped' } }));
    } catch (err) {
      flashStatus(s, err.message, 'error');
      busy(btn, false);
    }
  });

  // Stopped state for this row: Start (via the launcher on this computer) or
  // the terminal command when Vault runs elsewhere / without the launcher.
  const startBtn = s.querySelector('#server-start');
  const programLabel = programHelp.closest('.setting-row').querySelector('.setting-label');
  async function showStopped(local) {
    const launcher = local ? await probeLauncher() : null;
    programLabel.textContent = 'Stopped';
    s.querySelector('#server-restart').hidden = true;
    s.querySelector('#server-stop').hidden = true;
    startBtn.hidden = !launcher;
    refresh();
    programHelp.innerHTML = launcher
      ? 'Vault is stopped. Nothing plays until you start it again.'
      : `Vault is stopped. Start it on ${local ? 'this computer' : escapeHtml(serverInfo?.hostname || 'its computer')} with <code>${escapeHtml(START_COMMAND)}</code>.`;
  }
  function showRunning() {
    programLabel.textContent = 'Running';
    s.querySelector('#server-restart').hidden = false;
    s.querySelector('#server-stop').hidden = false;
    startBtn.hidden = true;
    refreshProgram();
    refresh();
  }
  startBtn.addEventListener('click', async () => {
    busy(startBtn, true, 'Starting…');
    try {
      await startServer();
      if (await waitForServer({ timeoutMs: 60000 })) {
        toast.success('The Vault server is running');
        window.dispatchEvent(new CustomEvent('vault:server-back'));
      } else {
        flashStatus(s, 'The server didn’t start. Run it from a terminal to see why.', 'error');
      }
    } catch (err) {
      flashStatus(s, `Couldn’t start the server: ${err.message}`, 'error');
    } finally {
      busy(startBtn, false);
    }
  });
  // Started from here, the banner or another tab.
  window.addEventListener('vault:server-up', showRunning);
  onUnmount(() => window.removeEventListener('vault:server-up', showRunning));

  const line = s.querySelector('#server-status');
  const facts = s.querySelector('#server-facts');
  async function refresh() {
    line.dataset.state = 'pending';
    line.innerHTML = '<span class="status-dot"></span><span>Checking…</span>';
    try {
      const h = await api.health();
      const lib = h.library || {};
      line.dataset.state = 'ok';
      line.innerHTML = `<span class="status-dot"></span><span>Connected to Vault ${escapeHtml(h.version || '')}</span>`;
      facts.innerHTML = `
        <div><dt>Up for</dt><dd>${formatUptime(h.uptime)}</dd></div>
        <div><dt>Items</dt><dd>${Number(lib.total || 0).toLocaleString()}</dd></div>
        <div><dt>Films</dt><dd>${Number(lib.movies || 0).toLocaleString()}</dd></div>
        <div><dt>Music</dt><dd>${Number(lib.music || 0).toLocaleString()}</dd></div>
        <div><dt>Videos</dt><dd>${Number(lib.videos || 0).toLocaleString()}</dd></div>`;
    } catch (err) {
      line.dataset.state = 'error';
      const unreachable = err.status == null || /failed to fetch|network|load failed|abort/i.test(err.message || '');
      line.innerHTML = `<span class="status-dot"></span><span>${unreachable ? 'Not connected — the server isn’t running or can’t be reached' : `Can’t reach the server: ${escapeHtml(err.message)}`}</span>`;
      facts.innerHTML = '';
    }
  }
  s.querySelector('#test-connection').addEventListener('click', refresh);
  s.querySelector('#trigger-scan').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Scanning…');
    try {
      const res = await api.triggerScan();
      flashStatus(s, `Scan finished: ${plural(res.scanned || 0, 'item')}`);
      const data = await api.getLibrary({ limit: 1000 });
      store.setLibrary(data.items || []);
      refresh();
    } catch (err) {
      flashStatus(s, err.message, 'error');
    } finally {
      busy(btn, false);
    }
  });
  refresh();
  refreshProgram();
  return s;
}
