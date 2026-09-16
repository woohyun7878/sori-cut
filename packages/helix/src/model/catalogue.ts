/**
 * The model catalogue.
 *
 * What a Helix model identifier actually means: what it is called, which
 * parameters it has, and what ranges those parameters really cover.
 *
 * The data is generated from presets we own (`pnpm helix:catalogue`) rather
 * than transcribed from Line 6's proprietary catalogue, so it is always a
 * record of what a real device produced. It is incomplete by construction --
 * a model nobody has ever used in one of our presets is simply absent -- and
 * every lookup here is written to degrade rather than guess.
 */

import { CATALOGUE, CATALOGUE_SOURCE } from './catalogue.generated.js';

export interface CatalogueParameter {
  /** Exact key as it appears in presets. */
  name: string;
  /** Observed value kinds, e.g. "number" or "number|string". */
  kind: string;
  /** How many times the parameter was seen across the source presets. */
  occurrences: number;
  /** True range, when a controller assignment revealed it. */
  min?: number;
  max?: number;
  /** Smallest and largest values actually seen. A floor, not a range. */
  observedMin?: number;
  observedMax?: number;
  /** Sample of non-numeric values seen, for enum-ish parameters. */
  values?: readonly string[];
}

export interface CatalogueEntry {
  /** Model identifier, e.g. "HD2_AmpEssexA30". */
  id: string;
  /** Curated display name, when one has been recorded. */
  label?: string;
  /** What the model emulates, when recorded. */
  basedOn?: string;
  /** Curated category, when recorded. */
  category?: string;
  occurrences: number;
  devices: readonly string[];
  firmwares: readonly string[];
  /** `@type` codes seen for this model. */
  types: readonly number[];
  parameters: readonly CatalogueParameter[];
}

/**
 * Built on first lookup, not at module load.
 *
 * This matters more than it looks: the catalogue is ~160KB of generated data,
 * and the web app imports this package for the parser. An eager `new Map(...)`
 * here is a top-level reference that a bundler cannot prove is side-effect
 * free, so it pins the whole array into the frontend bundle even though the UI
 * never calls a single lookup. Deferring it lets the data drop out entirely.
 */
let byId: Map<string, CatalogueEntry> | undefined;

function index(): Map<string, CatalogueEntry> {
  byId ??= new Map(CATALOGUE.map((entry) => [entry.id, entry]));
  return byId;
}

export { CATALOGUE, CATALOGUE_SOURCE };

export function catalogueEntry(model: string | undefined): CatalogueEntry | undefined {
  return model === undefined ? undefined : index().get(model);
}

export function catalogueParameter(
  model: string | undefined,
  parameter: string,
): CatalogueParameter | undefined {
  const entry = catalogueEntry(model);
  if (!entry) return undefined;

  const wanted = parameter.replace(/\s+/g, '').toLowerCase();
  return entry.parameters.find((p) => p.name.replace(/\s+/g, '').toLowerCase() === wanted);
}

/**
 * The range for a parameter, if anything reliable is known.
 *
 * Only controller-derived ranges are returned. Observed values are a floor on
 * what a parameter can be, not a range, and treating them as one would have a
 * tool reject a legitimate value because our corpus happens not to contain it.
 */
export function catalogueRange(
  model: string | undefined,
  parameter: string,
): { min: number; max: number } | undefined {
  const param = catalogueParameter(model, parameter);
  if (!param || param.min === undefined || param.max === undefined) return undefined;
  return { min: param.min, max: param.max };
}

/** Coverage, for the places that should say what they do not know. */
export function catalogueCoverage(): {
  models: number;
  parameters: number;
  parametersWithRange: number;
  named: number;
  presets: number;
} {
  return {
    models: CATALOGUE_SOURCE.models,
    parameters: CATALOGUE_SOURCE.parameters,
    parametersWithRange: CATALOGUE_SOURCE.parametersWithRange,
    named: CATALOGUE_SOURCE.named,
    presets: CATALOGUE_SOURCE.presets,
  };
}

/**
 * One compact line per parameter, for putting in a prompt.
 *
 * Written to be cheap in tokens and honest about gaps: a parameter with no
 * controller-derived range says nothing about its range rather than implying
 * the values our corpus happens to contain are the limits.
 *
 * Returns undefined for a model the catalogue has never seen, so a caller can
 * fall back rather than print an empty section.
 */
export function describeModel(model: string | undefined): string | undefined {
  const entry = catalogueEntry(model);
  if (!entry) return undefined;

  const heading = [entry.label ?? entry.id, entry.basedOn ? `(${entry.basedOn})` : null]
    .filter(Boolean)
    .join(' ');

  const parameters = entry.parameters.map((param) => {
    const range =
      param.min !== undefined && param.max !== undefined ? ` ${param.min}..${param.max}` : '';
    const values = param.values && param.values.length > 0 ? ` [${param.values.join(', ')}]` : '';
    return `${param.name}${range}${values}`;
  });

  return `${heading}: ${parameters.join('; ')}`;
}
