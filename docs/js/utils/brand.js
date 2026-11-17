/**
 * Vault brand mark — "the arch": a vault door / a doorway home, with a play
 * notch cut through it (UI_REVAMP_PLAN.md §3.6, C-3). One idea, legible at
 * 16px, drawn with theme tokens so it is correct in every theme:
 *   tile = --accent-solid, arch = --on-accent (≥ 7:1 by the contrast gate).
 * docs/favicon.svg and the auth screen in index.html use the same geometry.
 */
export const BRAND_ARCH_PATH = 'M14 54V32a18 18 0 0 1 36 0v22Zm13.5-24v16.5L41 38.25Z';

export function brandMark({ size = 32, className = '' } = {}) {
  return `<svg class="brand-mark ${className}" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">`
    + '<rect class="brand-mark-tile" width="64" height="64" rx="16"/>'
    + `<path class="brand-mark-arch" fill-rule="evenodd" d="${BRAND_ARCH_PATH}"/>`
    + '</svg>';
}
