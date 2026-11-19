/**
 * Subtitle conversion to WebVTT — the only text track format browsers play.
 *
 * - SRT: comma → dot in timestamps, header added, BOM/CRLF handled.
 * - ASS/SSA (common for anime and fansubs): the [Events] Dialogue lines are
 *   turned into cues. Italic/bold/underline override tags become <i>/<b>/<u>,
 *   \N line breaks are kept, \an / style alignment top/middle/left/right
 *   becomes cue settings, and everything else (karaoke, colours, fonts,
 *   motion, vector drawings) is dropped — styled rendering would need a
 *   full libass renderer; the words are what matter.
 *
 * Previously ASS/SSA files were sent as text/plain, which no browser can use,
 * so those subtitles silently never showed.
 */

function stripBom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

function escapeVtt(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** SRT → WebVTT. */
function srtToVtt(input) {
  const text = stripBom(input).replace(/\r\n?/g, '\n').trim();
  if (/^WEBVTT/.test(text)) return `${text}\n`;
  const body = text.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, (_, hms, ms) => `${hms.padStart(8, '0')}.${ms.padEnd(3, '0')}`);
  return `WEBVTT\n\n${body}\n`;
}

/** "0:01:02.34" (ASS centiseconds) → seconds, or NaN. */
function parseAssTime(value) {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(value || '');
  if (!m) return NaN;
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

function vttTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rest = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(rest).padStart(3, '0')}`;
}

/** Split `line` into `count` comma-separated fields; the last keeps its commas. */
function splitFields(line, count) {
  const out = [];
  let rest = line;
  for (let i = 0; i < count - 1; i++) {
    const idx = rest.indexOf(',');
    if (idx === -1) { out.push(rest); rest = ''; continue; }
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  out.push(rest);
  return out.map(f => f.trim());
}

/** Numpad alignment (1–9, \an / V4+ styles) → WebVTT cue settings. */
function alignmentSettings(an) {
  const n = Number(an);
  if (!n || n < 1 || n > 9 || n === 2) return '';
  const settings = [];
  if (n >= 7) settings.push('line:5%');
  else if (n >= 4) settings.push('line:50%');
  const col = (n - 1) % 3;
  if (col === 0) settings.push('position:10%', 'align:start');
  else if (col === 2) settings.push('position:90%', 'align:end');
  return settings.join(' ');
}

/** Legacy SSA alignment (1–3 bottom, +4 top, +8 middle) → numpad. */
function ssaToNumpad(a) {
  const n = Number(a);
  if (!n) return 0;
  const col = n & 3;
  if (!col) return 0;
  if (n & 4) return 6 + col; // top
  if (n & 8) return 3 + col; // middle
  return col;
}

/**
 * The text of one Dialogue line → { text, an, drawing }.
 * Override blocks `{...}` are interpreted for i/b/u/an and otherwise dropped.
 */
function convertAssText(raw) {
  const open = { i: false, b: false, u: false };
  let out = '';
  let an = 0;
  let drawing = false;
  const tagRe = /\{([^}]*)\}/g;
  let last = 0;
  let m;
  const pushText = (chunk) => {
    if (drawing || !chunk) return;
    out += escapeVtt(chunk.replace(/\\[Nn]/g, '\n').replace(/\\h/g, '\u00a0'));
  };
  const setStyle = (key, on) => {
    if (on === open[key]) return;
    out += on ? `<${key}>` : `</${key}>`;
    open[key] = on;
  };
  while ((m = tagRe.exec(raw))) {
    pushText(raw.slice(last, m.index));
    last = tagRe.lastIndex;
    for (const tag of m[1].split('\\').slice(1)) {
      let t;
      if ((t = /^([ibu])(\d+)?$/.exec(tag))) setStyle(t[1], t[2] === undefined || t[2] !== '0');
      else if ((t = /^an([1-9])$/.exec(tag))) an = an || Number(t[1]);
      else if ((t = /^a(\d+)$/.exec(tag))) an = an || ssaToNumpad(t[1]);
      else if ((t = /^p(\d+)$/.exec(tag))) drawing = t[1] !== '0';
      else if (tag === 'r') { setStyle('i', false); setStyle('b', false); setStyle('u', false); }
    }
  }
  pushText(raw.slice(last));
  for (const key of ['u', 'b', 'i']) if (open[key]) out += `</${key}>`;
  // Tidy: no empty tags, no blank lines (a blank line ends a VTT cue).
  out = out.replace(/<([ibu])><\/\1>/g, '').split('\n').map(l => l.trim()).filter(Boolean).join('\n');
  return { text: out, an, drawing: drawing && !out };
}

/** ASS/SSA → WebVTT. */
function assToVtt(input) {
  const lines = stripBom(input).split(/\r\n?|\n/);
  let section = '';
  let legacy = false;
  let styleFormat = null;
  let eventFormat = null;
  const styleAlign = new Map();
  const cues = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1].trim().toLowerCase();
      if (section === 'v4 styles') legacy = true;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (section.endsWith('styles')) {
      if (key === 'format') styleFormat = value.split(',').map(f => f.trim().toLowerCase());
      else if (key === 'style' && styleFormat) {
        const fields = splitFields(value, styleFormat.length);
        const name = fields[styleFormat.indexOf('name')];
        const align = fields[styleFormat.indexOf('alignment')];
        if (name !== undefined && align !== undefined) styleAlign.set(name.toLowerCase(), legacy ? ssaToNumpad(align) : Number(align));
      }
    } else if (section === 'events') {
      if (key === 'format') eventFormat = value.split(',').map(f => f.trim().toLowerCase());
      else if (key === 'dialogue') {
        const format = eventFormat || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
        const fields = splitFields(value, format.length);
        const get = name => fields[format.indexOf(name)];
        const start = parseAssTime(get('start'));
        const end = parseAssTime(get('end'));
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const { text, an, drawing } = convertAssText(get('text') || '');
        if (drawing || !text) continue;
        const align = an || styleAlign.get(String(get('style') || '').replace(/^\*/, '').toLowerCase()) || 0;
        cues.push({ start, end, text, settings: alignmentSettings(align), order: cues.length });
      }
    }
  }

  cues.sort((a, b) => a.start - b.start || a.order - b.order);
  const body = cues.map(c => `${vttTime(c.start)} --> ${vttTime(c.end)}${c.settings ? ` ${c.settings}` : ''}\n${c.text}`).join('\n\n');
  return `WEBVTT\n\n${body}${body ? '\n' : ''}`;
}

module.exports = { srtToVtt, assToVtt, convertAssText, parseAssTime, vttTime };
