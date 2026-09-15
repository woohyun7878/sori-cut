/**
 * Production bundle for the Bender server.
 *
 * `tsc` is not usable here. The workspace packages (`@bender/helix`,
 * `@bender/tone-tools`) deliberately export raw TypeScript source, which is
 * right for dev and for Vite but means the compiled output still contains
 * `import '@bender/helix'` -- and Node cannot load a `.ts` file, so the build
 * produced something that typechecked and then crashed on startup with
 * ERR_UNKNOWN_FILE_EXTENSION.
 *
 * Bundling resolves those imports at build time, so the pnpm workspace does
 * not have to be reconstructed inside a container. The published third-party
 * dependencies stay external and are installed normally at deploy time --
 * `@azure/identity` in particular resolves auth plugins through dynamic
 * `require`, which a bundler cannot follow and would silently break.
 *
 * The artifact is therefore `dist/server.mjs` plus a production install of the
 * four runtime dependencies. See `apps/server/Dockerfile`.
 *
 * The `.mjs` extension is deliberate. esbuild emits ESM here, but Node decides
 * how to parse a `.js` file from the nearest `package.json` `type` field. That
 * made the output run inside the repo and fail anywhere it was copied on its
 * own -- which is exactly what a container image does -- with
 * "Cannot use import statement outside a module". `.mjs` is unambiguous no
 * matter what directory the file lands in.
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const externalDeps = Object.fromEntries(
  Object.entries(pkg.dependencies ?? {}).filter(([name]) => !name.startsWith('@bender/')),
);

const result = await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  minify: false,
  // Readable stack traces matter more than bytes for a server, and an
  // unminified bundle is far easier to audit for an accidentally inlined
  // credential.
  external: Object.keys(externalDeps),
  banner: {
    // Some transitive CommonJS dependencies reference these, which do not
    // exist in an ESM bundle unless we provide them.
    js: [
      "import { createRequire as __benderCreateRequire } from 'node:module';",
      "import { fileURLToPath as __benderFileURLToPath } from 'node:url';",
      "import { dirname as __benderDirname } from 'node:path';",
      'const require = __benderCreateRequire(import.meta.url);',
      'const __filename = __benderFileURLToPath(import.meta.url);',
      'const __dirname = __benderDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
});

if (result.errors.length > 0) process.exit(1);

/**
 * Emit a manifest describing what the bundle actually needs at runtime.
 *
 * The server's own package.json cannot be used for this. It declares
 * `@bender/helix` and `@bender/tone-tools` as `workspace:*`, a pnpm-only
 * protocol that npm rejects outright with EUNSUPPORTEDPROTOCOL -- so a
 * container runtime stage that copied it and ran `npm install` would fail on
 * dependencies that are already inlined into the bundle and do not need
 * installing at all.
 *
 * Writing the manifest here keeps it honest: it is derived from the same
 * dependency list that decided esbuild's `external`, so the file can never
 * drift from what the bundle imports.
 */
writeFileSync(
  new URL('../dist/package.json', import.meta.url),
  `${JSON.stringify(
    {
      name: `${pkg.name}-dist`,
      version: pkg.version,
      private: true,
      type: 'module',
      main: 'server.mjs',
      dependencies: externalDeps,
    },
    null,
    2,
  )}\n`,
);

