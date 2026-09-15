import { create } from 'zustand';
import { HelixPreset } from '@bender/helix';
import { type UndoRedoState, undoMiddleware } from './undoMiddleware';

/**
 * A parsed `.hlx` preset plus the metadata Bender surfaces about it.
 *
 * `source` is the exact text the file was parsed from and is kept as the
 * round-trip source of truth: a later phase edits the preset and must be able
 * to re-serialize byte-for-byte from what the user uploaded.
 */
export interface LoadedPreset {
  /** Original upload file name, e.g. "Dual Rectifier.hlx". */
  fileName: string;
  /** Exact `.hlx` text the file was parsed from. */
  source: string;
  /** Preset display name from `data.meta.name`, when present. */
  name?: string;
  /** Friendly device name, e.g. "HX Stomp". */
  deviceName?: string;
  /** Decoded firmware version, e.g. "3.11". */
  firmware?: string;
  /** Number of processing blocks in the signal chain. */
  blockCount: number;
}

export interface PresetState extends UndoRedoState {
  /** The currently loaded preset, or null before any upload. */
  preset: LoadedPreset | null;
  /** Human-readable reason the last upload could not be read, if any. */
  error: string | null;
  /** Parse `.hlx` text and load it as the active preset. */
  loadPreset: (fileName: string, source: string) => void;
  /** Clear the active preset and any load error. */
  clearPreset: () => void;
}

const initialState = {
  preset: null as LoadedPreset | null,
  error: null as string | null,
};

export const usePresetStore = create<PresetState>()(
  undoMiddleware((set) => ({
    ...initialState,
    loadPreset: (fileName, source) => {
      try {
        const preset = HelixPreset.parse(source);
        set({
          preset: {
            fileName,
            source,
            name: preset.name,
            deviceName: preset.deviceName,
            firmware: preset.firmware,
            blockCount: preset.blocks().length,
          },
          error: null,
        });
      } catch (err) {
        set({
          error:
            err instanceof Error
              ? err.message
              : 'Could not read this file as a Helix preset.',
        });
      }
    },
    clearPreset: () => set({ ...initialState }),
  })),
);
