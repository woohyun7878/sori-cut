/**
 * @bender/helix — Line 6 Helix preset parsing, inspection and safe editing.
 *
 * The guarantee this package exists to provide:
 *
 *   parse(text).serialize() === text
 *
 * for any `.hlx` file, regardless of which of the three known writers produced
 * it. Everything else is built on top of that.
 *
 * See docs/helix-format-notes.md for the format evidence, and which parts of
 * it are observed fact versus hypothesis.
 */

export * from './json/ast.js';
export { parseJson, JsonParseError } from './json/parse.js';
export { stringifyJson, encodeString, encodeNumber } from './json/stringify.js';
export { detectStyle, DEFAULT_STYLE, MINIFIED_STYLE, type JsonStyle } from './json/style.js';

export { HelixPreset, HelixPresetError } from './model/preset.js';
export {
  validatePreset,
  formatValidation,
  type ValidationIssue,
  type ValidationResult,
  type IssueSeverity,
} from './model/validate.js';
export * from './model/types.js';
export {
  catalogueEntry,
  catalogueParameter,
  catalogueRange,
  catalogueCoverage,
  describeModel,
  CATALOGUE,
  CATALOGUE_SOURCE,
  type CatalogueEntry,
  type CatalogueParameter,
} from './model/catalogue.js';
export { MODEL_NAMES, type ModelName } from './model/model-names.generated.js';

import { HelixPreset } from './model/preset.js';

/** Parse a `.hlx` document. Convenience alias for `HelixPreset.parse`. */
export function parsePreset(text: string): HelixPreset {
  return HelixPreset.parse(text);
}

/** Serialize a preset back to `.hlx` text. */
export function serializePreset(preset: HelixPreset): string {
  return preset.serialize();
}
