import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/*
 * jsdom 25 ships `Blob`/`File` without `text()`, `arrayBuffer()` or `stream()`.
 * Every browser Bender supports has had `Blob.text()` since 2019, so the app
 * uses it directly and this fills the gap for the test environment only.
 */
if (typeof Blob !== 'undefined' && typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function readAsText(this: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

// Safety net: unmount any React tree rendered during a test so DOM state
// cannot leak into later tests. Suites may still call cleanup() themselves;
// running it again here is a harmless no-op.
afterEach(() => {
  cleanup();
});
