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
 * Bundling resolves those imports at build time and emits one self-contained
 * file. The deployment artifact becomes `dist/server.js` plus a `node:` runtime
 * and nothing else -- no pnpm workspace to reconstruct inside a container, and
 * no hoisting behaviour to depend on.
 *
 * Native and optional-native dependencies stay external: bundling a package
 * that ships platform-specific binaries produces an artifact that only runs on
 * the machine that built it, which for a Linux container built on Windows is
 * exactly the wrong outcome.
 */

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const result = await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  minify: false,
  // Readable stack traces matter more than bytes for a server, and an
  // unminified bundle is far easier to audit for an accidentally inlined
  // credential.
  external: Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith('@bender/')),
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
