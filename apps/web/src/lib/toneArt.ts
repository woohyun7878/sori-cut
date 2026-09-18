/**
 * Visual identity for a starter tone.
 *
 * Each card is painted with a colour and a CSS art variant rather than an
 * image, so adding a starter tone costs a row in this table and nothing extra
 * ships to Pages. The look is keyed off the template's `category`, which the
 * backend already returns, so a new category degrades to a neutral slate
 * instead of failing to render.
 */

export type ToneArt = 'art-curve' | 'art-wave' | 'art-dune' | 'art-hatch';

export interface ToneLook {
  /** Painted into `--tone`; drives the art, the border and the selected tint. */
  color: string;
  art: ToneArt;
}

const BY_CATEGORY: Record<string, ToneLook> = {
  clean: { color: '#3d8f97', art: 'art-wave' },
  crunch: { color: '#b44e3f', art: 'art-curve' },
  'high gain': { color: '#748b52', art: 'art-hatch' },
  lead: { color: '#a8863a', art: 'art-dune' },
  'ambient lead': { color: '#6f74a8', art: 'art-curve' },
  bass: { color: '#8a5f9e', art: 'art-dune' },
  acoustic: { color: '#9a8757', art: 'art-wave' },
};

/** Fallback cycle, so an unrecognised category still looks deliberate. */
const FALLBACK: ToneLook[] = [
  { color: '#4d8a80', art: 'art-curve' },
  { color: '#8f6a4a', art: 'art-wave' },
  { color: '#6a7fa0', art: 'art-dune' },
  { color: '#8a6f93', art: 'art-hatch' },
];

export function toneLook(category: string, index: number): ToneLook {
  return BY_CATEGORY[category.trim().toLowerCase()] ?? FALLBACK[index % FALLBACK.length];
}

/** "01", "02", … — the rail numbers foundations for reference, not ranking. */
export function toneNumber(index: number): string {
  return String(index + 1).padStart(2, '0');
}
