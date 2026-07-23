import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Safety net: unmount any React tree rendered during a test so DOM state
// cannot leak into later tests. Suites may still call cleanup() themselves;
// running it again here is a harmless no-op.
afterEach(() => {
  cleanup();
});
