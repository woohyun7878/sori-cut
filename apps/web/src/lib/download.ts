/**
 * Trigger a browser download for an in-memory blob.
 *
 * Kept apart from the API client so the client stays free of DOM concerns and
 * remains straightforward to test.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
