/**
 * Settings → This device: Appearance, Playback, Subtitles.
 * Everything here applies instantly and is stored in this browser
 * (switches / sliders / radios — no Save button, a polite "Saved" status).
 */
import { store } from '../../store.js';
import { themeManager, THEME_META, themeSwatch } from '../../themes.js';
import { getPrefs, setPrefs, resetPrefs } from '../../components/playbackPrefs.js';
import { getMotionPreference, setMotionPreference, resolveMotion } from '../../utils/pageTransition.js';
import { icon } from '../../utils/icons.js';
import { section, group, row, switchRow, rangeControl, bindRange, flashStatus, el } from './ui.js';

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------
const MOTION_OPTIONS = [
  { id: 'system', label: 'Match system', help: 'Follows your device’s “reduce motion” setting.' },
  { id: 'full', label: 'Full', help: 'Fade between pages, slide into details.' },
  { id: 'reduced', label: 'Reduced', help: 'A quick cross-fade only, no movement.' },
  { id: 'off', label: 'Off', help: 'Pages swap instantly.' },
];

export function appearanceSection() {
  const s = section({
    id: 'appearance',
    title: 'Appearance',
    iconName: 'palette',
    scope: 'device',
    intro: 'Theme, surfaces and motion.',
  });

  const theme = group('Theme');
  theme.append(el(`
    <div class="setting-row is-stacked" data-keywords="theme colour color dark light palette hearth linen parchment dusk ember daylight">
      <div class="setting-text"><span class="setting-label" id="theme-picker-label">Colour theme</span>
        <p class="setting-help">Six palettes, three dark and three light. All text meets WCAG AAA contrast.</p></div>
      <div class="setting-control">
        <div class="theme-picker" role="group" aria-labelledby="theme-picker-label">
          ${THEME_META.map(meta => `
            <button type="button" class="theme-option" data-theme-option="${meta.id}" aria-pressed="${store.get('theme') === meta.id}">
              ${themeSwatch(meta)}
              <span class="theme-option-text"><span class="theme-option-name">${meta.name}</span><span class="theme-option-mode">${meta.mode}</span></span>
            </button>`).join('')}
        </div>
      </div>
    </div>`));

  const surfaces = group('Surfaces');
  surfaces.append(
    row({
      id: 'glass-slider',
      label: 'Glass',
      help: 'How strongly panels blur what’s behind them.',
      keywords: 'glass blur transparency frosted',
      control: rangeControl({ id: 'glass-slider', min: 0, max: 100, value: store.get('glassIntensity'), unit: '%' }),
    }),
    row({
      id: 'grain-slider',
      label: 'Film grain',
      help: 'A faint texture over the background.',
      keywords: 'grain noise texture film',
      control: rangeControl({ id: 'grain-slider', min: 0, max: 100, value: store.get('grainIntensity'), unit: '%' }),
    }),
  );

  const pref = getMotionPreference();
  const motion = group('Motion');
  motion.append(el(`
    <div class="setting-row is-stacked" data-keywords="motion animation transitions reduce reduced page fade slide">
      <div class="setting-text">
        <span class="setting-label" id="motion-label">Page transitions</span>
        <p class="setting-help" id="motion-help">How pages change when you move around Vault.</p>
      </div>
      <div class="setting-control">
        <div class="segmented" role="radiogroup" aria-labelledby="motion-label" aria-describedby="motion-help">
          ${MOTION_OPTIONS.map(o => `
            <label class="segmented-option">
              <input type="radio" name="motion-pref" value="${o.id}"${pref === o.id ? ' checked' : ''}>
              <span>${o.label}</span>
            </label>`).join('')}
        </div>
        <p class="setting-help motion-detail" aria-live="polite"></p>
      </div>
    </div>`));

  s.body.append(theme, surfaces, motion);

  // --- wiring
  s.querySelectorAll('[data-theme-option]').forEach(btn => {
    // data-theme-option, NOT data-theme: a data-theme attribute re-scopes every
    // theme token onto the button itself.
    btn.addEventListener('click', () => {
      themeManager.setTheme(btn.dataset.themeOption);
      s.querySelectorAll('[data-theme-option]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      flashStatus(s, `Theme: ${THEME_META.find(m => m.id === btn.dataset.themeOption)?.name || 'saved'}`);
    });
  });
  bindRange(s, 'glass-slider', { format: v => `${v}%`, onInput: v => themeManager.setGlassIntensity(v) });
  bindRange(s, 'grain-slider', { format: v => `${v}%`, onInput: v => themeManager.setGrainIntensity(v) });
  ['glass-slider', 'grain-slider'].forEach(id => s.querySelector(`#${id}`).addEventListener('change', () => flashStatus(s)));

  const detail = s.querySelector('.motion-detail');
  const describe = () => {
    const chosen = getMotionPreference();
    const o = MOTION_OPTIONS.find(m => m.id === chosen);
    const resolved = resolveMotion(chosen);
    detail.textContent = chosen === 'system'
      ? `${o.help} Right now that means ${resolved === 'reduced' ? 'a gentle cross-fade' : 'full transitions'}.`
      : o.help;
  };
  describe();
  s.querySelectorAll('input[name="motion-pref"]').forEach(radio => {
    radio.addEventListener('change', () => {
      setMotionPreference(radio.value);
      describe();
      flashStatus(s);
    });
  });
  return s;
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------
const pct = v => `${v}%`;
const speedText = v => `${Number(v).toFixed(2).replace(/\.?0+$/, '')}×`;

export function playbackSection() {
  const prefs = getPrefs();
  const s = section({
    id: 'playback',
    title: 'Playback',
    iconName: 'play',
    scope: 'device',
    intro: 'How music, shows and films play on this device.',
  });

  const sound = group('Sound');
  sound.append(
    row({
      id: 'vol-slider',
      label: 'Starting volume',
      keywords: 'volume loudness',
      control: rangeControl({ id: 'vol-slider', min: 0, max: 100, value: Math.round(store.get('volume') * 100), format: pct }),
    }),
    switchRow({
      id: 'pref-normalize',
      label: 'Even out volume',
      help: 'Keeps quiet dialogue and loud scenes closer together.',
      checked: prefs.normalize,
      keywords: 'normalise normalize loudness dialogue',
    }),
    row({
      label: 'Equaliser',
      help: 'Ten bands with presets. Applies to music and video.',
      keywords: 'equalizer equaliser eq bass treble',
      control: `<button type="button" class="btn btn-secondary btn-sm" id="open-eq">${icon('sliders', { size: 15 })}<span>Open equaliser</span></button>`,
    }),
  );

  const flow = group('Between tracks');
  const crossfade = Number(store.get('crossfade')) || 0;
  flow.append(
    switchRow({
      id: 'gapless-toggle',
      label: 'Gapless playback',
      help: 'Loads the next track early so albums play without a pause.',
      checked: localStorage.getItem('vault_gapless') !== 'false',
      keywords: 'gapless gap album preload',
    }),
    switchRow({
      id: 'fade-toggle',
      label: 'Fade on pause and skip',
      help: 'Eases the sound out when you pause, stop or skip, and back in when you resume.',
      checked: store.get('fadePlayPause') !== false,
      keywords: 'fade pause stop soft smooth abrupt',
    }),
    row({
      id: 'crossfade-slider',
      label: 'Crossfade',
      help: 'Blend the end of one song into the next. 0 turns it off.',
      keywords: 'crossfade fade blend mix',
      control: rangeControl({ id: 'crossfade-slider', min: 0, max: 12, value: crossfade, format: v => (v ? `${v} s` : 'Off') }),
    }),
  );

  const video = group('Speed & silence');
  video.append(
    row({
      id: 'pref-speed',
      label: 'Default speed',
      help: 'Used for every new video, podcast and audiobook (music plays at 1×); change it per item from the player.',
      keywords: 'speed rate faster slower podcast audiobook',
      control: rangeControl({ id: 'pref-speed', min: 0.5, max: 2.5, step: 0.05, value: prefs.speed, format: speedText }),
    }),
    switchRow({
      id: 'pref-skip-silence',
      label: 'Skip silence',
      help: 'Audio only; trims long pauses (approximate).',
      checked: prefs.skipSilence,
      keywords: 'silence skip pauses podcast',
    }),
    row({
      label: 'Reset playback preferences',
      help: 'Speed, volume levelling and silence skipping go back to their defaults.',
      keywords: 'reset defaults',
      control: '<button type="button" class="btn btn-ghost btn-sm" id="pref-reset">Reset</button>',
    }),
  );

  s.body.append(sound, flow, video);

  // --- wiring
  bindRange(s, 'vol-slider', { format: pct, onInput: v => store.set('volume', v / 100, true) });
  bindRange(s, 'crossfade-slider', { format: v => (v ? `${v} s` : 'Off'), onInput: v => store.set('crossfade', v, true) });
  bindRange(s, 'pref-speed', { format: speedText, onInput: v => setPrefs({ speed: v }, { silent: true }) });
  ['vol-slider', 'crossfade-slider', 'pref-speed'].forEach(id => s.querySelector(`#${id}`).addEventListener('change', () => flashStatus(s)));

  s.querySelector('#fade-toggle').addEventListener('change', e => {
    store.set('fadePlayPause', e.target.checked, true);
    flashStatus(s, e.target.checked ? 'Fades on' : 'Fades off');
  });
  s.querySelector('#pref-normalize').addEventListener('change', e => {
    setPrefs({ normalize: e.target.checked });
    flashStatus(s, e.target.checked ? 'Volume levelling on' : 'Volume levelling off');
  });
  s.querySelector('#pref-skip-silence').addEventListener('change', e => {
    setPrefs({ skipSilence: e.target.checked });
    flashStatus(s);
  });
  s.querySelector('#gapless-toggle').addEventListener('change', e => {
    localStorage.setItem('vault_gapless', String(e.target.checked));
    flashStatus(s, e.target.checked ? 'Gapless on' : 'Gapless off');
  });
  s.querySelector('#open-eq').addEventListener('click', () => {
    import('../../components/eqPanel.js').then(m => m.showEQModal());
  });
  s.querySelector('#pref-reset').addEventListener('click', () => {
    const fresh = resetPrefs();
    const speed = s.querySelector('#pref-speed');
    speed.value = fresh.speed;
    speed.dispatchEvent(new Event('input'));
    s.querySelector('#pref-normalize').checked = fresh.normalize;
    s.querySelector('#pref-skip-silence').checked = fresh.skipSilence;
    flashStatus(s, 'Playback preferences reset');
  });
  return s;
}

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------
const LEGACY_TINT = 'rgba(124, 108, 255, 0.35)';
const WARM_TINT = 'rgba(242, 168, 119, 0.35)';
const BACKGROUNDS = [
  { value: 'rgba(0, 0, 0, 0.6)', label: 'Dark box' },
  { value: 'rgba(0, 0, 0, 0.85)', label: 'Solid black' },
  { value: WARM_TINT, label: 'Warm tint' },
  { value: 'transparent', label: 'None (outline only)' },
];
const COLOURS = [
  { value: '#ffffff', label: 'White' },
  { value: '#fff3c4', label: 'Cream' },
  { value: '#ffe14d', label: 'Yellow' },
  { value: '#9ff0ff', label: 'Cyan' },
];
const delayText = v => (v === 0 ? 'In sync' : `${v > 0 ? '+' : ''}${v} s`);

export function subtitlesSection() {
  let prefs = getPrefs();
  if (prefs.subtitleBackground === LEGACY_TINT) prefs = setPrefs({ subtitleBackground: WARM_TINT }, { silent: true }) || getPrefs();
  const s = section({
    id: 'subtitles',
    title: 'Subtitles',
    iconName: 'captions',
    scope: 'device',
    intro: 'Size, colour and timing. The preview updates as you go.',
  });

  const known = COLOURS.some(c => c.value === prefs.subtitleColor.toLowerCase());
  const look = group('Look');
  look.append(
    el(`<div class="subtitle-preview" aria-hidden="true"><div class="subtitle-preview-frame"><span class="subtitle-preview-cue">I’ll put the kettle on — fancy a cuppa?</span></div></div>`),
    row({
      id: 'sub-size',
      label: 'Text size',
      keywords: 'subtitle captions size bigger smaller',
      control: rangeControl({ id: 'sub-size', min: 80, max: 200, step: 5, value: prefs.subtitleSize, format: pct }),
    }),
    el(`<div class="setting-row" data-keywords="subtitle captions colour color text">
      <div class="setting-text"><span class="setting-label" id="sub-colour-label">Text colour</span></div>
      <div class="setting-control">
        <div class="swatch-group" role="radiogroup" aria-labelledby="sub-colour-label">
          ${COLOURS.map(c => `<label class="swatch" title="${c.label}"><input type="radio" name="sub-colour" value="${c.value}"${prefs.subtitleColor.toLowerCase() === c.value ? ' checked' : ''}><span class="swatch-dot" style="--swatch:${c.value}"></span><span class="sr-only">${c.label}</span></label>`).join('')}
          <label class="swatch swatch-custom" title="Custom colour"><input type="radio" name="sub-colour" value="custom"${known ? '' : ' checked'}><span class="swatch-dot" style="--swatch:${known ? '#cccccc' : prefs.subtitleColor}"></span><span class="sr-only">Custom</span></label>
          <input type="color" id="sub-color" value="${prefs.subtitleColor}" aria-label="Custom subtitle colour" class="swatch-picker">
        </div>
      </div>
    </div>`),
    row({
      id: 'sub-bg',
      label: 'Background',
      keywords: 'subtitle captions background box',
      control: `<select class="form-input form-select" id="sub-bg">${BACKGROUNDS.map(b => `<option value="${b.value}"${prefs.subtitleBackground === b.value ? ' selected' : ''}>${b.label}</option>`).join('')}</select>`,
    }),
  );

  const timing = group('Timing');
  timing.append(row({
    id: 'sub-delay',
    label: 'Timing offset',
    help: 'Positive values show subtitles later, for tracks that run ahead.',
    keywords: 'subtitle delay sync offset timing',
    control: rangeControl({ id: 'sub-delay', min: -10, max: 10, step: 0.25, value: prefs.subtitleDelay, format: delayText }),
  }));
  s.body.append(look, timing);

  // --- wiring
  const cue = s.querySelector('.subtitle-preview-cue');
  const paint = (p = getPrefs()) => {
    cue.style.fontSize = `${(p.subtitleSize / 100) * 1.15}rem`;
    cue.style.color = p.subtitleColor;
    cue.style.background = p.subtitleBackground;
    cue.classList.toggle('is-outlined', p.subtitleBackground === 'transparent');
  };
  paint(prefs);

  bindRange(s, 'sub-size', { format: pct, onInput: v => { setPrefs({ subtitleSize: v }, { silent: true }); paint(); } });
  bindRange(s, 'sub-delay', { format: delayText, onInput: v => setPrefs({ subtitleDelay: v }, { silent: true }) });
  ['sub-size', 'sub-delay'].forEach(id => s.querySelector(`#${id}`).addEventListener('change', () => {
    if (id === 'sub-delay') setPrefs({ subtitleDelay: Number(s.querySelector('#sub-delay').value) });
    flashStatus(s);
  }));

  const picker = s.querySelector('#sub-color');
  const customDot = s.querySelector('.swatch-custom .swatch-dot');
  s.querySelectorAll('input[name="sub-colour"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.value === 'custom') { picker.click(); return; }
      setPrefs({ subtitleColor: radio.value }, { silent: true });
      picker.value = radio.value;
      paint();
      flashStatus(s);
    });
  });
  picker.addEventListener('input', () => {
    s.querySelector('input[name="sub-colour"][value="custom"]').checked = true;
    customDot.style.setProperty('--swatch', picker.value);
    setPrefs({ subtitleColor: picker.value }, { silent: true });
    paint();
  });
  picker.addEventListener('change', () => flashStatus(s));
  s.querySelector('#sub-bg').addEventListener('change', e => {
    setPrefs({ subtitleBackground: e.target.value }, { silent: true });
    paint();
    flashStatus(s);
  });
  return s;
}
