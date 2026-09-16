import { describe, expect, it } from 'vitest';
import {
  CATALOGUE,
  catalogueCoverage,
  catalogueEntry,
  catalogueParameter,
  catalogueRange,
  describeModel,
  labelForModel,
  MODEL_NAMES,
} from '../src/index.js';

/**
 * The catalogue is generated, so these tests are about its contract rather
 * than its contents: that lookups degrade instead of guessing, that a range is
 * only ever reported when a controller assignment proved it, and that the
 * generated data stays consistent with itself. Asserting on specific models
 * would break every time someone adds a preset.
 */
describe('model catalogue', () => {
  it('is built from presets we own', () => {
    const coverage = catalogueCoverage();
    expect(coverage.presets).toBeGreaterThan(0);
    expect(coverage.models).toBe(CATALOGUE.length);
    expect(coverage.models).toBeGreaterThan(0);
  });

  it('knows the models our fixtures use', () => {
    expect(catalogueEntry('HD2_AmpBrit2204')).toBeDefined();
  });

  it('returns nothing for a model it has never seen', () => {
    expect(catalogueEntry('HD2_AmpNotAThing')).toBeUndefined();
    expect(catalogueEntry(undefined)).toBeUndefined();
    expect(catalogueParameter('HD2_AmpNotAThing', 'Drive')).toBeUndefined();
    expect(catalogueRange('HD2_AmpNotAThing', 'Drive')).toBeUndefined();
    expect(describeModel('HD2_AmpNotAThing')).toBeUndefined();
  });

  it('matches parameters regardless of spacing and case', () => {
    const exact = catalogueParameter('HD2_AmpBrit2204', 'Drive');
    expect(exact).toBeDefined();
    expect(catalogueParameter('HD2_AmpBrit2204', 'drive')).toEqual(exact);
    expect(catalogueParameter('HD2_AmpBrit2204', ' D r i v e ')).toEqual(exact);
  });

  it('reports a range only when a controller assignment revealed it', () => {
    for (const entry of CATALOGUE) {
      for (const param of entry.parameters) {
        const range = catalogueRange(entry.id, param.name);
        if (range === undefined) continue;

        // A reported range must come from min/max, never from observed values.
        expect(param.min).toBeDefined();
        expect(param.max).toBeDefined();
        expect(range.min).toBe(param.min);
        expect(range.max).toBe(param.max);
      }
    }
  });

  it('never presents observed values as a range', () => {
    const observedOnly = CATALOGUE.flatMap((entry) =>
      entry.parameters
        .filter((param) => param.observedMin !== undefined && param.min === undefined)
        .map((param) => ({ id: entry.id, name: param.name })),
    );

    // The corpus is small, so parameters with values but no controller
    // assignment are the common case. If this ever hits zero the test has
    // stopped proving anything.
    expect(observedOnly.length).toBeGreaterThan(0);
    for (const { id, name } of observedOnly) {
      expect(catalogueRange(id, name)).toBeUndefined();
    }
  });

  it('records every parameter it saw at least once', () => {
    for (const entry of CATALOGUE) {
      expect(entry.occurrences).toBeGreaterThan(0);
      for (const param of entry.parameters) {
        expect(param.occurrences).toBeGreaterThan(0);
        expect(param.name).not.toBe('');
        // Structural keys belong to the parser, not the catalogue.
        expect(param.name.startsWith('@')).toBe(false);
      }
    }
  });

  it('describes a model compactly enough to put in a prompt', () => {
    const description = describeModel('HD2_AmpBrit2204');
    expect(description).toBeDefined();
    expect(description).toContain('HD2_AmpBrit2204');
    expect(description).toContain('Drive');
    expect(description!.split('\n')).toHaveLength(1);
  });
});

describe('labelForModel', () => {
  it('prefers a curated name when one exists', () => {
    const [id, name] = Object.entries(MODEL_NAMES).find(([, value]) => value.label) ?? [];
    if (!id || !name?.label) {
      // No names curated yet. The fallback path is covered below.
      expect(Object.keys(MODEL_NAMES)).toHaveLength(0);
      return;
    }
    expect(labelForModel(id)).toBe(name.label);
  });

  it('falls back to splitting on case boundaries', () => {
    expect(labelForModel('HD2_AmpEssexA30')).toBe('Amp Essex A30');
  });

  it('keeps digit runs intact rather than guessing where they split', () => {
    expect(labelForModel('HD2_Cab4x121960T75')).not.toContain('4x12 1960');
  });

  it('handles a missing model', () => {
    expect(labelForModel(undefined)).toBe('Unknown');
  });
});
