/**
 * Age ratings ("content ratings" / certifications) for profile limits.
 *
 * An item's `contentRating` is the label printed on the box — "PG-13",
 * "TV-MA", "12", "FSK 16", "NL:9" — taken from an .nfo sidecar, a TMDb match
 * or typed in by an admin. Profiles store their limit as an age
 * (`maxRating`: 0–18). `ageFor()` turns a label into the minimum viewing age
 * so the two can be compared, whatever country the label comes from.
 *
 * Unknown labels ("NR", "Unrated", typos) return null and count as unrated.
 */

// US film (MPA) and TV parental guidelines.
const US = {
  G: 0,
  PG: 8,
  'PG-13': 13,
  R: 17,
  'NC-17': 18,
  X: 18,
  'TV-Y': 0,
  'TV-Y7': 7,
  'TV-Y7-FV': 7,
  'TV-G': 0,
  'TV-PG': 8,
  'TV-14': 14,
  'TV-MA': 17,
};

// UK (BBFC), Dutch (Kijkwijzer "AL"), Irish and Australian letter ratings.
const LETTERS = {
  U: 0,
  UC: 0,
  AL: 0,
  E: 0,
  '12A': 12,
  R18: 18,
  M: 15,
  MA: 15,
  'MA15+': 15,
  'R18+': 18,
};

const UNRATED = new Set(['NR', 'UR', 'NOTRATED', 'UNRATED', 'NONE', 'N/A', 'NA', '-']);

/** Trim and bound a label for storage; '' / null mean "no rating". */
function normalise(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
  return text || null;
}

/**
 * Minimum age for a rating label, or null when it isn't recognised.
 * Accepts prefixes like "Rated", "US:", "NL/", "FSK", "PEGI" and suffixes like
 * "+" or "Jahre", so Kodi/Jellyfin .nfo values work as-is.
 */
function ageFor(value) {
  const label = normalise(value);
  if (!label) return null;
  let s = label.toUpperCase()
    .replace(/^RATED\s+/, '')
    .replace(/^[A-Z]{2}\s*[:/]\s*/, '') // "US:PG-13", "NL/12", "de:16"
    .replace(/^(FSK|PEGI|KIJKWIJZER|BBFC|MPAA|MPA)\s*[-:]?\s*/, '')
    .replace(/\s*(\+|JAHRE|YEARS?|JAAR)$/, '')
    .replace(/^AB\s+/, '')
    .trim();
  if (UNRATED.has(s.replace(/\s+/g, ''))) return null;
  s = s.replace(/\s+/g, '-');
  if (Object.prototype.hasOwnProperty.call(US, s)) return US[s];
  if (Object.prototype.hasOwnProperty.call(LETTERS, s)) return LETTERS[s];
  // Plain ages: "12", "16", "6", "18+" (the "+" was stripped above).
  if (/^\d{1,2}$/.test(s)) {
    const age = Number(s);
    return age <= 21 ? age : null;
  }
  return null;
}

/** The limits offered in the profile editor (age → label). */
const AGE_LIMITS = [
  { age: 0, label: 'All ages (G, U, AL)' },
  { age: 6, label: 'Up to 6' },
  { age: 9, label: 'Up to 9 (PG)' },
  { age: 12, label: 'Up to 12' },
  { age: 14, label: 'Up to 14 (PG-13, TV-14)' },
  { age: 16, label: 'Up to 16' },
];

/** Age limit a new Kids profile starts with when none was chosen. */
const KIDS_DEFAULT_AGE = 9;

module.exports = { ageFor, normalise, AGE_LIMITS, KIDS_DEFAULT_AGE };
