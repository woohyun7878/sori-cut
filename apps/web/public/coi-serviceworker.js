/* coi-serviceworker - Cross-Origin Isolation via Service Worker
 * Required for SharedArrayBuffer (FFmpeg.wasm, ONNX Runtime) on GitHub Pages
 * https://github.com/gzuidhof/coi-serviceworker — MIT License
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', function (event) {
  // Pass through non-GET requests and opaque requests unchanged
  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(function (response) {
        if (response.status === 0) {
          return response;
        }

        const newHeaders = new Headers(response.headers);
        newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
        newHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      })
      .catch((e) => console.error('[coi-serviceworker]', e))
  );
});
