import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useAutoSave, type SaveStatus } from '../useAutoSave';
import { useProjectStore } from '../../store/useProjectStore';
import * as coordinator from '../../lib/autosaveCoordinator';

// Mock crypto.randomUUID
let uuidCounter = 0;
vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++uuidCounter}` });

// Mock URL
vi.stubGlobal('URL', {
  createObjectURL: () => 'blob:mock-url',
  revokeObjectURL: vi.fn(),
});

// Mock projectStorage (coordinator imports it)
const mockSaveProject = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/projectStorage', () => ({
  saveProject: (...args: unknown[]) => mockSaveProject(...args),
}));

beforeEach(() => {
  vi.useFakeTimers();
  uuidCounter = 0;
  coordinator._reset();
  useProjectStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mockSaveProject.mockClear();
});

describe('useAutoSave (coordinator-backed)', () => {
  it('debounces saves by 2 seconds after state change', async () => {
    const statuses: SaveStatus[] = [];
    renderHook(() => useAutoSave((s) => statuses.push(s)));
    mockSaveProject.mockClear();

    act(() => {
      useProjectStore.getState().setProjectName('Updated');
    });

    expect(mockSaveProject).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(mockSaveProject).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(mockSaveProject).toHaveBeenCalledTimes(1);
    expect(statuses).toContain('saving');
    expect(statuses).toContain('saved');
  });

  it('coalesces rapid changes to latest snapshot', async () => {
    renderHook(() => useAutoSave());
    mockSaveProject.mockClear();

    act(() => { useProjectStore.getState().setProjectName('A'); });
    await act(async () => { vi.advanceTimersByTime(1000); });
    act(() => { useProjectStore.getState().setProjectName('B'); });
    await act(async () => { vi.advanceTimersByTime(1000); });
    act(() => { useProjectStore.getState().setProjectName('C'); });

    expect(mockSaveProject).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(mockSaveProject).toHaveBeenCalledTimes(1);
    expect(mockSaveProject.mock.calls[0][1]).toBe('C');
  });

  it('does not save on transient state changes (playhead, isPlaying)', async () => {
    renderHook(() => useAutoSave());
    mockSaveProject.mockClear();

    act(() => {
      useProjectStore.getState().setPlayheadPosition(5);
      useProjectStore.getState().setIsPlaying(true);
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(mockSaveProject).not.toHaveBeenCalled();
  });

  it('reports error status when save fails', async () => {
    const statuses: SaveStatus[] = [];
    renderHook(() => useAutoSave((s) => statuses.push(s)));
    mockSaveProject.mockClear();
    statuses.length = 0;

    mockSaveProject.mockRejectedValue(new Error('DB full'));

    act(() => { useProjectStore.getState().setProjectName('Fail'); });

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(statuses).toContain('error');

    mockSaveProject.mockResolvedValue(undefined);
  });

  it('hook unmount does not lose coordinator queue (coordinator is global)', async () => {
    const { unmount } = renderHook(() => useAutoSave());
    mockSaveProject.mockClear();

    act(() => { useProjectStore.getState().setProjectName('Queued'); });

    // Unmount before debounce fires
    act(() => { unmount(); });

    // The coordinator still owns the queued snapshot — drain fires after debounce
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(mockSaveProject).toHaveBeenCalledTimes(1);
    expect(mockSaveProject.mock.calls[0][1]).toBe('Queued');
  });
});
