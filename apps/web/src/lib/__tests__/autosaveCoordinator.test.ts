import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  enqueue,
  cancelProject,
  flushAll,
  flushNow,
  onStatus,
  hasPending,
  isTombstoned,
  _reset,
  type SaveSnapshot,
  type SaveStatus,
} from '../autosaveCoordinator';

// Mock projectStorage
const mockSaveProject = vi.fn().mockResolvedValue(undefined);
vi.mock('../projectStorage', () => ({
  saveProject: (...args: unknown[]) => mockSaveProject(...args),
}));

function makeSnapshot(projectId: string, projectName: string): SaveSnapshot {
  return {
    projectId,
    projectName,
    originalAudio: null,
    stems: [],
    recordings: [],
    video: null,
    tracks: [],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  _reset();
  mockSaveProject.mockClear();
  mockSaveProject.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('autosaveCoordinator', () => {
  describe('basic debounce + enqueue', () => {
    it('debounces writes by 2 seconds', async () => {
      enqueue(makeSnapshot('p1', 'Project 1'));
      expect(mockSaveProject).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1500);
      expect(mockSaveProject).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(600);
      expect(mockSaveProject).toHaveBeenCalledTimes(1);
      expect(mockSaveProject).toHaveBeenCalledWith('p1', 'Project 1', expect.any(Object));
    });

    it('coalesces multiple enqueues for the same project to latest snapshot', async () => {
      enqueue(makeSnapshot('p1', 'v1'));
      enqueue(makeSnapshot('p1', 'v2'));
      enqueue(makeSnapshot('p1', 'v3'));

      await vi.advanceTimersByTimeAsync(2100);
      expect(mockSaveProject).toHaveBeenCalledTimes(1);
      expect(mockSaveProject).toHaveBeenCalledWith('p1', 'v3', expect.any(Object));
    });

    it('persists multiple projects independently', async () => {
      enqueue(makeSnapshot('p1', 'Proj A'));
      enqueue(makeSnapshot('p2', 'Proj B'));

      await vi.advanceTimersByTimeAsync(2100);
      expect(mockSaveProject).toHaveBeenCalledTimes(2);
      const ids = mockSaveProject.mock.calls.map(([id]: [string]) => id);
      expect(ids).toContain('p1');
      expect(ids).toContain('p2');
    });

    it('reports saving → saved on success', async () => {
      const statuses: SaveStatus[] = [];
      onStatus((s) => statuses.push(s));

      enqueue(makeSnapshot('p1', 'test'));
      await vi.advanceTimersByTimeAsync(2100);

      expect(statuses).toContain('saving');
      expect(statuses).toContain('saved');
    });
  });

  describe('REQUIRED: switch via reset→load produces no ghost project', () => {
    it('loadFromSaved replacing project A does not persist intermediate empty state', async () => {
      // Simulate: user is on project A, then does loadFromSaved to switch to B
      // The coordinator only sees the "after" state (what is enqueued).
      // If the hook enqueues A's edit, then the store is replaced atomically
      // with B, the coordinator should write A's last snapshot, then B's.
      // Crucially, no ghost project with empty state is ever created.

      enqueue(makeSnapshot('proj-A', 'A edited'));

      // Simulate atomic switch: enqueue B's state (no intermediate reset state)
      enqueue(makeSnapshot('proj-B', 'B initial'));

      await vi.advanceTimersByTimeAsync(2100);

      // Check all save calls — none should be a "ghost" project with empty name
      for (const [id, name] of mockSaveProject.mock.calls) {
        expect(name).toBeTruthy();
        expect(id === 'proj-A' || id === 'proj-B').toBe(true);
      }

      // A's latest snapshot is "A edited", B's is "B initial"
      const callsForA = mockSaveProject.mock.calls.filter(([id]: [string]) => id === 'proj-A');
      const callsForB = mockSaveProject.mock.calls.filter(([id]: [string]) => id === 'proj-B');
      expect(callsForA.length).toBe(1);
      expect(callsForA[0][1]).toBe('A edited');
      expect(callsForB.length).toBe(1);
      expect(callsForB[0][1]).toBe('B initial');
    });

    it('rapid project switch A→B→A keeps only latest per-project snapshot', async () => {
      enqueue(makeSnapshot('proj-A', 'A v1'));
      enqueue(makeSnapshot('proj-B', 'B v1'));
      enqueue(makeSnapshot('proj-A', 'A v2')); // Override A's queued snapshot

      await vi.advanceTimersByTimeAsync(2100);

      const callsForA = mockSaveProject.mock.calls.filter(([id]: [string]) => id === 'proj-A');
      expect(callsForA.length).toBe(1);
      expect(callsForA[0][1]).toBe('A v2'); // Only the latest
    });
  });

  describe('REQUIRED: delete with debounced/in-flight snapshots never resurrects', () => {
    it('cancelProject prevents queued snapshot from being saved', async () => {
      enqueue(makeSnapshot('proj-X', 'About to die'));
      cancelProject('proj-X');

      await vi.advanceTimersByTimeAsync(2100);
      expect(mockSaveProject).not.toHaveBeenCalled();
      expect(isTombstoned('proj-X')).toBe(true);
    });

    it('cancelProject during in-flight save prevents resurrection', async () => {
      let resolveSave!: () => void;
      mockSaveProject.mockImplementationOnce(
        () => new Promise<void>((resolve) => { resolveSave = resolve; }),
      );

      enqueue(makeSnapshot('proj-X', 'v1'));
      await vi.advanceTimersByTimeAsync(2100); // Starts the save
      expect(mockSaveProject).toHaveBeenCalledTimes(1);

      // Now enqueue another snapshot for the same project and tombstone it
      enqueue(makeSnapshot('proj-X', 'v2'));
      cancelProject('proj-X');

      // Resolve the in-flight save
      resolveSave();
      await vi.advanceTimersByTimeAsync(0);

      // v2 should never be saved (tombstoned)
      // v1 was already in-flight so it went through, but that's acceptable —
      // the key guarantee is that no NEW save happens after cancelProject.
      const totalCalls = mockSaveProject.mock.calls.filter(
        ([id]: [string]) => id === 'proj-X',
      );
      expect(totalCalls.length).toBe(1); // Only the already-started one
      expect(hasPending()).toBe(false);
    });

    it('tombstoned project cannot be re-enqueued', async () => {
      cancelProject('proj-dead');
      enqueue(makeSnapshot('proj-dead', 'resurrection attempt'));

      await vi.advanceTimersByTimeAsync(2100);
      expect(mockSaveProject).not.toHaveBeenCalled();
      expect(hasPending()).toBe(false);
    });
  });

  describe('REQUIRED: first save rejection retains/retries failed and later snapshots', () => {
    it('retains failed entry and retries up to MAX_RETRIES', async () => {
      mockSaveProject.mockRejectedValue(new Error('write failed'));

      enqueue(makeSnapshot('p1', 'will fail'));
      await vi.advanceTimersByTimeAsync(2100);

      // MAX_RETRIES = 2, so initial + 2 retries = 3 attempts
      expect(mockSaveProject).toHaveBeenCalledTimes(3);
      // Queue should still have the entry (it wasn't cleared on failure)
      expect(hasPending()).toBe(true);
    });

    it('does not drop other projects entries when one fails', async () => {
      mockSaveProject.mockImplementation(async (id: string) => {
        if (id === 'p1') throw new Error('p1 always fails');
        // p2 succeeds
      });

      enqueue(makeSnapshot('p1', 'will fail'));
      enqueue(makeSnapshot('p2', 'should succeed eventually'));

      await vi.advanceTimersByTimeAsync(2100);

      // p1 fails and breaks the drain loop, p2 may or may not have run
      // But p2 should still be pending or already saved
      // Let the retry drain fire
      await vi.advanceTimersByTimeAsync(2100);

      // p2 should have been attempted and succeeded at some point
      const callsForP2 = mockSaveProject.mock.calls.filter(
        ([id]: [string]) => id === 'p2',
      );
      expect(callsForP2.length).toBeGreaterThanOrEqual(1);
    });

    it('successful retry after transient failure clears the entry', async () => {
      let attempts = 0;
      mockSaveProject.mockImplementation(async () => {
        attempts++;
        if (attempts <= 2) throw new Error('transient');
        // 3rd attempt succeeds
      });

      enqueue(makeSnapshot('p1', 'transient fail'));
      await vi.advanceTimersByTimeAsync(2100);

      // After 3 attempts (initial + 2 retries), it should succeed
      expect(attempts).toBe(3);
      expect(hasPending()).toBe(false);
    });

    it('reports error status on exhausted retries', async () => {
      const statuses: SaveStatus[] = [];
      onStatus((s) => statuses.push(s));
      mockSaveProject.mockRejectedValue(new Error('permanent'));

      enqueue(makeSnapshot('p1', 'fail'));
      await vi.advanceTimersByTimeAsync(2100);

      expect(statuses).toContain('error');
    });
  });

  describe('REQUIRED: remount ordering — generation monotonicity ensures latest wins', () => {
    it('newer generation always overwrites older queued snapshot for same project', async () => {
      // Simulate: instance A1 enqueues gen 1, A2 enqueues gen 2, A3 enqueues gen 3
      enqueue(makeSnapshot('proj-A', 'A1 state')); // gen 1
      enqueue(makeSnapshot('proj-A', 'A2 state')); // gen 2
      enqueue(makeSnapshot('proj-A', 'A3 state')); // gen 3

      await vi.advanceTimersByTimeAsync(2100);
      expect(mockSaveProject).toHaveBeenCalledTimes(1);
      expect(mockSaveProject).toHaveBeenCalledWith('proj-A', 'A3 state', expect.any(Object));
    });

    it('stale generation committed after newer does not overwrite', async () => {
      // Enqueue gen 1, start flushing, enqueue gen 2 during flush
      let resolveSave!: () => void;
      mockSaveProject.mockImplementationOnce(
        () => new Promise<void>((resolve) => { resolveSave = resolve; }),
      );

      enqueue(makeSnapshot('proj-A', 'gen1'));
      await vi.advanceTimersByTimeAsync(2100); // Drain starts

      // While drain is processing gen1, enqueue gen2
      enqueue(makeSnapshot('proj-A', 'gen2'));

      // Resolve gen1 save
      resolveSave();
      await vi.advanceTimersByTimeAsync(0);

      // gen2 should still be in queue and eventually saved
      await vi.advanceTimersByTimeAsync(2100);

      const callsForA = mockSaveProject.mock.calls.filter(
        ([id]: [string]) => id === 'proj-A',
      );
      // Should have saved gen1, then gen2
      expect(callsForA.length).toBe(2);
      expect(callsForA[1][1]).toBe('gen2');
    });
  });

  describe('REQUIRED: unload (flushAll) attempts every queued project', () => {
    it('flushAll immediately drains all queued projects', async () => {
      enqueue(makeSnapshot('p1', 'P1'));
      enqueue(makeSnapshot('p2', 'P2'));
      enqueue(makeSnapshot('p3', 'P3'));

      // Don't wait for debounce — call flushAll immediately
      await flushAll();

      expect(mockSaveProject).toHaveBeenCalledTimes(3);
      const ids = mockSaveProject.mock.calls.map(([id]: [string]) => id);
      expect(ids).toContain('p1');
      expect(ids).toContain('p2');
      expect(ids).toContain('p3');
    });

    it('flushAll captures latest state for each project (not stale)', async () => {
      enqueue(makeSnapshot('p1', 'old'));
      enqueue(makeSnapshot('p1', 'newer'));
      enqueue(makeSnapshot('p2', 'only'));

      await flushAll();

      const callForP1 = mockSaveProject.mock.calls.find(([id]: [string]) => id === 'p1');
      expect(callForP1![1]).toBe('newer');
    });

    it('flushNow awaits completion', async () => {
      enqueue(makeSnapshot('p1', 'flush'));

      await flushNow();

      expect(mockSaveProject).toHaveBeenCalledTimes(1);
      expect(hasPending()).toBe(false);
    });
  });

  describe('transaction/abort error suppression (from prior fix)', () => {
    it('typed error survives save failure (not masked by cleanup)', async () => {
      const statuses: SaveStatus[] = [];
      onStatus((s) => statuses.push(s));

      const error = new Error('QuotaExceededError');
      mockSaveProject.mockRejectedValue(error);

      enqueue(makeSnapshot('p1', 'fail'));
      await vi.advanceTimersByTimeAsync(2100);

      expect(statuses).toContain('error');
      // The queue retains the failed snapshot
      expect(hasPending()).toBe(true);
    });
  });
});
