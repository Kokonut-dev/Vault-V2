/**
 * Dominant-colour extraction from artwork (Spotify/Apple Music style ambience).
 *
 * Reads the artwork through an <img> with crossOrigin so the canvas stays
 * untainted, downsamples to a tiny bitmap and buckets the pixels. Everything is
 * memoised per URL, and failures are silent — the ambient layer just keeps the
 * theme colours.
 */
const cache = new Map();
const MAX_ENTRIES = 120;

function quantize(r, g, b) {
  return `${(r >> 5) << 5},${(g >> 5) << 5},${(b >> 5) << 5}`;
}

function relativeLuminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

export function extractColors(url, { count = 3 } = {}) {
  if (!url) return Promise.resolve(null);
  if (cache.has(url)) return Promise.resolve(cache.get(url));

  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);

        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const alpha = data[i + 3];
          if (alpha < 200) continue;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          // Skip near-black and near-white pixels: they carry no identity.
          const lum = relativeLuminance(r, g, b);
          if (lum < 0.02 || lum > 0.94) continue;
          const key = quantize(r, g, b);
          const entry = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
          entry.r += r;
          entry.g += g;
          entry.b += b;
          entry.n += 1;
          buckets.set(key, entry);
        }

        const sorted = [...buckets.values()]
          .map(b => ({ r: Math.round(b.r / b.n), g: Math.round(b.g / b.n), b: Math.round(b.b / b.n), n: b.n }))
          .sort((a, b) => b.n - a.n);

        const picks = [];
        for (const pixel of sorted) {
          // Require a minimum distance from already-picked colours so the
          // palette is not three shades of the same blue.
          const distinct = picks.every(p => Math.abs(p.r - pixel.r) + Math.abs(p.g - pixel.g) + Math.abs(p.b - pixel.b) > 60);
          if (distinct) picks.push(pixel);
          if (picks.length >= count) break;
        }

        const result = picks.length
          ? {
            colors: picks.map(p => `rgb(${p.r}, ${p.g}, ${p.b})`),
            rgb: picks.map(p => [p.r, p.g, p.b]),
            dominant: `rgb(${picks[0].r}, ${picks[0].g}, ${picks[0].b})`,
            dominantRgb: [picks[0].r, picks[0].g, picks[0].b],
          }
          : null;

        if (result) {
          if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
          cache.set(url, result);
        }
        resolve(result);
      } catch {
        resolve(null); // tainted canvas / decode error
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map(c => c + c).join('') : value;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/**
 * Paint the app's ambient layer with the artwork palette, and optionally
 * recolour the accent. `element` defaults to #ambient.
 */
export async function applyArtworkAmbience(url, { element = null, alpha = 0.28, accent = false } = {}) {
  const target = element || document.getElementById('ambient');
  if (!target || !url) return null;
  const palette = await extractColors(url);
  if (!palette) return null;

  const [r1, g1, b1] = palette.rgb[0];
  const [r2, g2, b2] = palette.rgb[1] || palette.rgb[0];
  const [r3, g3, b3] = palette.rgb[2] || palette.rgb[0];

  target.style.setProperty('--ambient-art-1', `rgba(${r1}, ${g1}, ${b1}, ${alpha})`);
  target.style.setProperty('--ambient-art-2', `rgba(${r2}, ${g2}, ${b2}, ${alpha * 0.8})`);
  target.style.setProperty('--ambient-art-3', `rgba(${r3}, ${g3}, ${b3}, ${alpha * 0.6})`);
  document.documentElement.classList.add('has-artwork-ambience');

  if (accent) {
    const root = document.documentElement;
    root.style.setProperty('--accent-art', `rgb(${r1}, ${g1}, ${b1})`);
    root.style.setProperty('--accent-art-muted', `rgba(${r1}, ${g1}, ${b1}, 0.16)`);
  }
  return palette;
}

export function clearArtworkAmbience() {
  const target = document.getElementById('ambient');
  if (target) {
    target.style.removeProperty('--ambient-art-1');
    target.style.removeProperty('--ambient-art-2');
    target.style.removeProperty('--ambient-art-3');
  }
  document.documentElement.classList.remove('has-artwork-ambience');
}

export { hexToRgb, relativeLuminance };
