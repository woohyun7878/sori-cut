import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useAutoSave, type SaveStatus } from '../useAutoSave';
import { useProjectStore } from '../../store/useProjectStore';

// Mock crypto.randomUUID
let uuidCounter = 0;
vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++uuidCounter}` });

// Mock URL
vi.stubGlobal('URL', {
  createObjectURL: () => 'blob:mock-url',
  revokeObjectURL: vi.fn(),
});

// Mock projectStorage
const mockSaveProject = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/projectStorage', () => ({
  saveProject: (...args: unknown[]) => mockSaveProject(...args),
}));

beforeEach(() => {
  vi.useFakeTimers();
  uuidCounter = 0;
  // Reset store to known state before mounting any hooks
  useProjectStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mockSaveProject.mockClear();
});

describe('useAutoSave', () => {
  it('debounces saves by 2 seconds after state change', async () => {
    const statuses: SaveStatus[] = [];
    renderHook(() => useAutoSave((s) => statuses.push(s)));
    mockSaveProject.mockClear(); // Clear any calls from mount

    // Trigger a store change
    act(() => {
      useProjectStore.getState().setProjectName('Updated');
    });

    // Should not have saved yet
    expect(mockSaveProject).not.toHaveBeenCalled();

    // Advance 1.5s — still not saved
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(mockSaveProject).not.toHaveBeenCalled();

    // Advance past 2s — now it saves
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(mockSaveProject).toHaveBeenCalledTimes(1);
    expect(statuses).toContain('saving');
    expect(statuses).toContain('saved');
  });

  it('resets debounce timer on rapid changes', async () => {
    renderHook(() => useAutoSave());
    mockSaveProject.mockClear();

    // Trigger multiple rapid changes
    act(() => {
      useProjectStore.getState().setProjectName('A');
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      useProjectStore.getState().setProjectName('B');
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      useProjectStore.getState().setProjectName('C');
    });

    // Should not have saved yet (timer keeps resetting)
    expect(mockSaveProject).not.toHaveBeenCalled();

    // Wait the full debounce from last change
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(mockSaveProject).toHaveBeenCalledTimes(1);
    // The saved name should be the latest
    const [, savedName] = mockSaveProject.mock.calls[0];
    expect(savedName).toBe('C');
  });

  it('retries pending saves after current save completes', async () => {
    // Make the first save take a while
    let resolveSave!: () => void;
    mockSaveProject.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSave = resolve; }),
    );

    renderHook(() => useAutoSave());
    mockSaveProject.mockClear();

    // Re-apply the slow mock for the first real save
    mockSaveProject.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSave = resolve; }),
    );

    // Trigger first change
    act(() => {
      useProjectStore.getState().setProjectName('First');
    });

    // Fire the debounce
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(mockSaveProject).toHaveBeenCalledTimes(1);

    // While save is in-flight, make another change
    act(() => {
      useProjectStore.getState().setProjectName('Second');
    });

    // The debounce fires but save is in progress — should queue pending
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    // Still only 1 call (first is still running)
    expect(mockSaveProject).toHaveBeenCalledTimes(1);

    // Resolve the first save — should trigger pending retry
    await act(async () => {
      resolveSave();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockSaveProject).toHaveBeenCalledTimes(2);
  });

  it('reports error status when save fails', async () => {
    const statuses: SaveStatus[] = [];
    renderHook(() => useAutoSave((s) => statuses.push(s)));
    mockSaveProject.mockClear();
    statuses.length = 0;

    mockSaveProject.mockRejectedValueOnce(new Error('DB full'));

    act(() => {
      useProjectStore.getState().setProjectName('Fail');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    expect(statuses).toContain('error');
  });

  it('does not save on transient state changes (playhead, isPlaying)', async () => {
    renderHook(() => useAutoSave());
    mockSaveProject.mockClear();

    act(() => {
      useProjectStore.getState().setPlayheadPosition(5);
      useProjectStore.getState().setIsPlaying(true);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(mockSaveProject).not.toHaveBeenCalled();
  });
});
