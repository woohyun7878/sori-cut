import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

/**
 * Read a fixture exactly as it exists on disk.
 *
 * Round-trip tests compare against these bytes, so nothing here may normalize
 * line endings or trim whitespace.
 */
export function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

/** Every `.hlx` fixture, for tests that should run across the whole corpus. */
export function presetFixtures(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.hlx'))
    .sort();
}

/**
 * A minimal but structurally complete preset.
 *
 * Built by hand rather than copied, so tests can assert on exact values
 * without depending on someone else's preset staying unchanged. The
 * formatting deliberately imitates Style A, including the `.0` on floats and
 * the bare integers on `@type` and `@position`.
 */
export const MINIMAL_PRESET = `{
 "data" : {
  "device" : 2162689,
  "device_version" : 51380224,
  "meta" : {
   "application" : "HX Edit",
   "name" : "Test Preset"
  },
  "tone" : {
   "dsp0" : {
    "block0" : {
     "@enabled" : true,
     "@model" : "HD2_AmpBrit2204",
     "@path" : 0,
     "@position" : 0,
     "@type" : 3,
     "Drive" : 0.620,
     "Master" : 0.360,
     "Treble" : 0.650
    },
    "block1" : {
     "@enabled" : false,
     "@model" : "HD2_DistCompulsiveDrive",
     "@path" : 0,
     "@position" : 1,
     "@type" : 0,
     "Gain" : 0.660,
     "Level" : 0.650
    },
    "inputA" : {
     "@input" : 1,
     "@model" : "HD2_AppDSPFlow1Input",
     "decay" : 0.50,
     "noiseGate" : false,
     "threshold" : -48.0
    }
   },
   "global" : {
    "@current_snapshot" : 0,
    "@tempo" : 120.0,
    "@topology0" : "A"
   },
   "snapshot0" : {
    "@name" : "SNAPSHOT 1",
    "blocks" : {
     "dsp0" : {
      "block0" : true,
      "block1" : false
     }
    },
    "controllers" : {
     "dsp0" : {
      "block0" : {
       "Drive" : {
        "@value" : 0.620
       }
      }
     }
    }
   }
  }
 },
 "schema" : "L6Preset",
 "version" : 6
}`;
