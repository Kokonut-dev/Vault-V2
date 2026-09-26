export const APP_NAME = 'Vault';
export const APP_VERSION = '2.0.0';

export const THEMES = ['dark', 'light', 'warm', 'cold'];

export const MEDIA_TYPES = ['movie', 'music', 'video'];

export const SORT_OPTIONS = [
  { value: 'addedAt', label: 'Date Added' },
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Year' },
  { value: 'rating', label: 'Rating' },
  { value: 'duration', label: 'Duration' },
  { value: 'fileSize', label: 'Size' },
];

export const EQ_PRESETS = {
  flat: { name: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bassBoost: { name: 'Bass Boost', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  trebleBoost: { name: 'Treble Boost', gains: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  vocal: { name: 'Vocal', gains: [-2, -1, 0, 2, 4, 4, 2, 0, -1, -2] },
  acoustic: { name: 'Acoustic', gains: [2, 1, 0, 1, 2, 2, 1, 0, 1, 2] },
  electronic: { name: 'Electronic', gains: [4, 3, 1, 0, -1, 1, 0, 2, 3, 4] },
  classical: { name: 'Classical', gains: [0, 0, 0, 0, 0, 0, -1, -1, -1, -2] },
  rock: { name: 'Rock', gains: [3, 2, -1, -2, 1, 2, 1, 2, 3, 3] },
  pop: { name: 'Pop', gains: [-1, 1, 2, 3, 2, 0, -1, -1, 1, 2] },
  jazz: { name: 'Jazz', gains: [2, 1, 0, 1, 2, 2, 1, 0, 1, 2] },
  rb: { name: 'R&B', gains: [4, 3, 1, 2, -1, -1, 1, 2, 3, 4] },
};

export const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const KEYBOARD_SHORTCUTS = {
  global: [
    { key: '⌥+Space / Alt+Space', desc: 'Open global search' },
    { key: '?', desc: 'Show keyboard shortcuts' },
    { key: 'Esc', desc: 'Close modal / search' },
  ],
  playback: [
    { key: 'Space / K', desc: 'Play / Pause' },
    { key: '← / J', desc: 'Seek backward 10s' },
    { key: '→ / L', desc: 'Seek forward 10s' },
    { key: '↑ / ↓', desc: 'Volume up / down' },
    { key: 'M', desc: 'Mute / Unmute' },
    { key: 'F', desc: 'Fullscreen' },
    { key: 'T', desc: 'Theatre mode' },
    { key: 'P', desc: 'Picture-in-picture' },
    { key: 'C', desc: 'Toggle captions' },
    { key: '0-9', desc: 'Seek to 0%-90%' },
    { key: 'N', desc: 'Next track / episode' },
    { key: 'Shift+N', desc: 'Previous track' },
    { key: 'S', desc: 'Shuffle' },
    { key: 'R', desc: 'Repeat' },
  ],
  navigation: [
    { key: 'G then H', desc: 'Go to Home' },
    { key: 'G then M', desc: 'Go to Movies' },
    { key: 'G then U', desc: 'Go to Music' },
    { key: 'G then V', desc: 'Go to Videos' },
    { key: 'G then P', desc: 'Go to Playlists' },
    { key: 'G then F', desc: 'Go to Favourites' },
    { key: 'G then S', desc: 'Go to Settings' },
  ],
};

export const SUPPORTED_AUDIO = ['.mp3', '.flac', '.wav', '.ogg', '.opus', '.m4a', '.aac', '.wma', '.aiff'];
export const SUPPORTED_VIDEO = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.wmv', '.flv', '.m4v'];
