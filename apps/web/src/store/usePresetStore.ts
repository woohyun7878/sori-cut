/**
 * Bender's client state.
 *
 * The server owns the preset once it is uploaded: every edit, undo and reset
 * happens there, and this store holds the returned view as the single source
 * of truth. The only client-side preset work is an instant local parse on
 * upload, which gives immediate feedback and rejects a file that plainly is
 * not a Helix preset before spending a network round trip on it.
 */

import { create } from 'zustand';
import { HelixPreset } from '@bender/helix';
import {
  ApiError,
  createSession,
  createSessionFromTemplate,
  deleteSession,
  deriveDownloadName,
  fetchPresetBlob,
  redo as redoRequest,
  reset as resetRequest,
  sendMessage as sendMessageRequest,
  undo as undoRequest,
} from '../api/client';
import type { PresetView } from '../api/types';
import { buildToolActivity, collectWarnings, type ToolActivityItem } from '../lib/activity';
import { saveBlob } from '../lib/download';
import { showToast } from '../components/Toast';

/** Metadata from the instant local parse, shown before the server responds. */
export interface LocalPreview {
  fileName: string;
  name?: string;
  deviceName?: string;
  firmware?: string;
  blockCount: number;
  /** Byte length of the uploaded file. Absent for starter tones, which the
   * client never holds as text. */
  sizeBytes?: number;
}

export interface UserTurn {
  id: string;
  role: 'user';
  text: string;
}

export interface BenderTurn {
  id: string;
  role: 'bender';
  text: string;
  activity: ToolActivityItem[];
  warnings: string[];
  latencyMs: number;
  truncated: boolean;
}

export interface ErrorTurn {
  id: string;
  role: 'error';
  text: string;
  hint?: string;
}

export type ConversationTurn = UserTurn | BenderTurn | ErrorTurn;

export interface PresetStoreState {
  /** Instant local parse of the uploaded file, before/around the server view. */
  localPreview: LocalPreview | null;
  /** Reason the upload could not be opened, shown on the drop zone. */
  uploadError: string | null;
  isUploading: boolean;

  /** The server-side preset view — the source of truth after upload. */
  view: PresetView | null;

  /**
   * Set when the session came from a starter tone rather than a file, so the
   * rail can mark which foundation is in use and show its real signal chain.
   */
  sourceTemplateId: string | null;

  conversation: ConversationTurn[];
  isSending: boolean;
  /** True while an undo, redo, reset or download request is in flight. */
  isMutating: boolean;

  /** Mirrors `view` so existing undo/redo controls can select them directly. */
  canUndo: boolean;
  canRedo: boolean;

  loadPreset: (fileName: string, source: string) => Promise<void>;
  loadTemplate: (templateId: string) => Promise<void>;
  clearPreset: () => void;
  sendMessage: (message: string) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  revertAll: () => Promise<void>;
  download: () => Promise<void>;
}

const LOCAL_PARSE_MESSAGE =
  'This file could not be read as a Helix preset. Make sure it is an unmodified .hlx exported from HX Edit.';

let turnCounter = 0;
function nextId(): string {
  turnCounter += 1;
  return `turn-${turnCounter}`;
}

function previewFrom(fileName: string, source: string): LocalPreview | null {
  try {
    const preset = HelixPreset.parse(source);
    return {
      fileName,
      name: preset.name,
      deviceName: preset.deviceName,
      firmware: preset.firmware,
      blockCount: preset.blocks().filter((block) => block.role === 'block').length,
      sizeBytes: new TextEncoder().encode(source).length,
    };
  } catch {
    return null;
  }
}

function handleMutationError(error: unknown, onExpired: (message: string) => void): void {
  if (error instanceof ApiError && error.sessionExpired) {
    onExpired(error.message);
    return;
  }
  showToast(error instanceof ApiError ? error.message : 'That action could not be completed.');
}

export const usePresetStore = create<PresetStoreState>((set, get) => {
  function applyView(view: PresetView): void {
    set({ view, canUndo: view.canUndo, canRedo: view.canRedo });
  }

  /** A session-scoped request 404'd: the session is gone, send them to re-upload. */
  function handleExpired(message: string): void {
    set({
      view: null,
      canUndo: false,
      canRedo: false,
      conversation: [],
      localPreview: null,
      sourceTemplateId: null,
      uploadError: message,
    });
    showToast('Session expired — please re-upload');
  }

  return {
    localPreview: null,
    uploadError: null,
    isUploading: false,
    view: null,
    sourceTemplateId: null,
    conversation: [],
    isSending: false,
    isMutating: false,
    canUndo: false,
    canRedo: false,

    loadPreset: async (fileName, source) => {
      const preview = previewFrom(fileName, source);
      if (!preview) {
        set({ uploadError: LOCAL_PARSE_MESSAGE });
        return;
      }

      set({
        localPreview: preview,
        uploadError: null,
        isUploading: true,
        view: null,
        sourceTemplateId: null,
        conversation: [],
        canUndo: false,
        canRedo: false,
      });

      try {
        applyView(await createSession(source, fileName));
      } catch (error) {
        const message =
          error instanceof ApiError ? error.message : 'Something went wrong opening this preset.';
        set({ uploadError: message });
        showToast(message);
      } finally {
        set({ isUploading: false });
      }
    },

    loadTemplate: async (templateId) => {
      set({
        uploadError: null,
        isUploading: true,
        view: null,
        sourceTemplateId: null,
        conversation: [],
        canUndo: false,
        canRedo: false,
      });

      try {
        const view = await createSessionFromTemplate(templateId);
        applyView(view);
        set({
          sourceTemplateId: templateId,
          localPreview: {
            fileName: view.filename,
            name: view.name ?? undefined,
            deviceName: view.device ?? undefined,
            firmware: view.firmware ?? undefined,
            blockCount: view.chain.filter((block) => block.role === 'block').length,
          },
        });
      } catch (error) {
        const message =
          error instanceof ApiError ? error.message : 'Could not load that starter tone.';
        set({ uploadError: message });
        showToast(message);
      } finally {
        set({ isUploading: false });
      }
    },

    clearPreset: () => {
      const { view } = get();
      if (view) void deleteSession(view.sessionId).catch(() => undefined);
      set({
        localPreview: null,
        uploadError: null,
        view: null,
        sourceTemplateId: null,
        conversation: [],
        isSending: false,
        canUndo: false,
        canRedo: false,
      });
    },

    sendMessage: async (message) => {
      const { view, isSending } = get();
      const trimmed = message.trim();
      if (!view || isSending || trimmed === '') return;

      const userTurn: UserTurn = { id: nextId(), role: 'user', text: trimmed };
      set((state) => ({ conversation: [...state.conversation, userTurn], isSending: true }));

      try {
        const response = await sendMessageRequest(view.sessionId, trimmed);
        applyView(response.preset);

        const benderTurn: BenderTurn = {
          id: nextId(),
          role: 'bender',
          text: response.reply,
          activity: buildToolActivity(response.activity, response.toolCalls),
          warnings: collectWarnings(response.toolCalls),
          latencyMs: response.latencyMs,
          truncated: response.truncated,
        };
        set((state) => ({ conversation: [...state.conversation, benderTurn] }));
      } catch (error) {
        if (error instanceof ApiError && error.sessionExpired) {
          handleExpired(error.message);
          return;
        }

        const text =
          error instanceof ApiError
            ? error.message
            : 'Something went wrong while Bender was working.';
        const hint = error instanceof ApiError ? error.hint : undefined;
        const errorTurn: ErrorTurn = { id: nextId(), role: 'error', text, hint };
        set((state) => ({ conversation: [...state.conversation, errorTurn] }));
        showToast(text);
      } finally {
        set({ isSending: false });
      }
    },

    undo: async () => {
      const { view, canUndo, isMutating } = get();
      if (!view || !canUndo || isMutating) return;

      set({ isMutating: true });
      try {
        applyView(await undoRequest(view.sessionId));
      } catch (error) {
        handleMutationError(error, handleExpired);
      } finally {
        set({ isMutating: false });
      }
    },

    redo: async () => {
      const { view, canRedo, isMutating } = get();
      if (!view || !canRedo || isMutating) return;

      set({ isMutating: true });
      try {
        applyView(await redoRequest(view.sessionId));
      } catch (error) {
        handleMutationError(error, handleExpired);
      } finally {
        set({ isMutating: false });
      }
    },

    revertAll: async () => {
      const { view, isMutating } = get();
      if (!view || isMutating) return;

      set({ isMutating: true });
      try {
        applyView(await resetRequest(view.sessionId));
        set({ conversation: [] });
        showToast('Reverted to the uploaded preset');
      } catch (error) {
        handleMutationError(error, handleExpired);
      } finally {
        set({ isMutating: false });
      }
    },

    download: async () => {
      const { view } = get();
      if (!view) return;

      try {
        const { blob, filename } = await fetchPresetBlob(view.sessionId);
        saveBlob(blob, filename ?? deriveDownloadName(view.filename, view.modified));
      } catch (error) {
        if (error instanceof ApiError && error.sessionExpired) {
          handleExpired(error.message);
          return;
        }
        const message =
          error instanceof ApiError ? error.message : 'Could not download the preset.';
        showToast(message);
      }
    },
  };
});
