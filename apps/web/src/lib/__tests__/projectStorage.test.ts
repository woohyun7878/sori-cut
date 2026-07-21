import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openDB: vi.fn(),
  projectGet: vi.fn(),
}));

vi.mock('idb', () => ({
  openDB: mocks.openDB,
}));

import { loadProject, type SavedProject } from '../projectStorage';

describe('projectStorage legacy sync offset migration', () => {
  beforeEach(() => {
    mocks.projectGet.mockReset();
    mocks.openDB.mockResolvedValue({
      transaction: () => ({
        objectStore: (name: string) =>
          name === 'projects' ? { get: mocks.projectGet } : { get: vi.fn() },
      }),
    });
  });

  it.each([
    { startOffset: 2.5, sourceStartOffset: 0, expected: 2.5 },
    { startOffset: 0, sourceStartOffset: 2.5, expected: -2.5 },
    { startOffset: 4, sourceStartOffset: 1.5, expected: 2.5 },
  ])(
    'restores legacy timeline/source offsets as signed sync offset $expected',
    async ({ startOffset, sourceStartOffset, expected }) => {
      mocks.projectGet.mockResolvedValue({
        id: 'legacy',
        name: 'Legacy',
        createdAt: 1,
        updatedAt: 2,
        originalAudio: null,
        stems: [],
        recordings: [],
        video: null,
        tracks: [
          {
            id: 'legacy-track',
            name: 'Legacy track',
            type: 'audio',
            sourceUrl: 'blob:legacy',
            startOffset,
            sourceStartOffset,
            duration: 10,
            muted: false,
            volume: 1,
          },
        ],
      } satisfies SavedProject);

      const loaded = await loadProject('legacy');

      expect(loaded?.tracks[0]).toMatchObject({
        startOffset,
        sourceStartOffset,
        syncOffset: expected,
      });
    },
  );
});
