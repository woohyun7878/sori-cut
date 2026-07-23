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
    mockSaveProject.mockClear();

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

  it('saves correct snapshot for each project when switching during debounce', async () => {
    renderHook(() => useAutoSave());
    mockSaveProject.mockClear();

    // Edit project A
    act(() => {
      useProjectStore.getState().loadFromSaved({ projectId: 'proj-A', projectName: 'Project A' });
    });
    mockSaveProject.mockClear();
    act(() => {
      useProjectStore.getState().setProjectName('A edited');
    });

    // Before debounce fires, switch to project B
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    act(() => {
      useProjectStore.getState().loadFromSaved({ projectId: 'proj-B', projectName: 'Project B' });
    });
    act(() => {
      useProjectStore.getState().setProjectName('B edited');
    });

    // Let the debounce fire
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2200);
    });

    // Both projects should have been saved with their respective snapshots
    const callsForA = mockSaveProject.mock.calls.filter(
      ([id]: [string]) => id === 'proj-A',
    );
    const callsForB = mockSaveProject.mock.calls.filter(
      ([id]: [string]) => id === 'proj-B',
    );

    expect(callsForA.length).toBeGreaterThanOrEqual(1);
    expect(callsForB.length).toBeGreaterThanOrEqual(1);
    // Project A was saved with "A edited"
    expect(callsForA[callsForA.length - 1][1]).toBe('A edited');
    // Project B was saved with "B edited"
    expect(callsForB[callsForB.length - 1][1]).toBe('B edited');
  });

  it('saves project A snapshot when switching to B while A save is in-flight', async () => {
    let resolveSaveA!: () => void;

    renderHook(() => useAutoSave());
    mockSaveProject.mockClear();

    // Set up project A
    act(() => {
      useProjectStore.getState().loadFromSaved({ projectId: 'proj-A', projectName: 'Project A' });
    });
    mockSaveProject.mockClear();

    // Make the first save (for A) slow
    mockSaveProject.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSaveA = resolve; }),
    );

    // Edit project A and let debounce fire
    act(() => {
      useProjectStore.getState().setProjectName('A v2');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    // Save A is now in-flight
    expect(mockSaveProject).toHaveBeenCalledTimes(1);
    expect(mockSaveProject.mock.calls[0][0]).toBe('proj-A');
    expect(mockSaveProject.mock.calls[0][1]).toBe('A v2');

    // Switch to project B and make edits
    act(() => {
      useProjectStore.getState().loadFromSaved({ projectId: 'proj-B', projectName: 'Project B' });
    });
    act(() => {
      useProjectStore.getState().setProjectName('B v1');
    });

    // Debounce for B queues while A is in-flight
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    // Resolve A's save
    await act(async () => {
      resolveSaveA();
      await vi.advanceTimersByTimeAsync(0);
    });

    // B should now be saved — find the call for proj-B
    const callsForB = mockSaveProject.mock.calls.filter(
      ([id]: [string]) => id === 'proj-B',
    );
    expect(callsForB.length).toBeGreaterThanOrEqual(1);
    expect(callsForB[callsForB.length - 1][1]).toBe('B v1');
  });

  it('retries pending saves after current save completes', async () => {
    let resolveSave!: () => void;

    renderHook(() => useAutoSave());
    mockSaveProject.mockClear();

    // Make the first real save slow
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

  it('flushes pending snapshot on unmount (before debounce fires)', async () => {
    const { unmount } = renderHook(() => useAutoSave());
    mockSaveProject.mockClear();

    // Make a change — debounce is scheduled but hasn't fired
    act(() => {
      useProjectStore.getState().setProjectName('Unsaved edit');
    });
    await act(async () => {
      vi.advanceTimersByTime(500); // Only 500ms of 2000ms debounce
    });

    // Unmount before debounce fires (e.g. navigating to Export page)
    act(() => {
      unmount();
    });

    // The pending snapshot should have been flushed on unmount
    expect(mockSaveProject).toHaveBeenCalledTimes(1);
    expect(mockSaveProject.mock.calls[0][1]).toBe('Unsaved edit');
  });
});
