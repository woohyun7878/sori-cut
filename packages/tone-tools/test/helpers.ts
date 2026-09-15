import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ToneSession } from '../src/session.js';

/** A real Helix Floor preset: amp + cab, a drive, a volume pedal, snapshots. */
export function realPreset(): string {
  return readFileSync(
    fileURLToPath(new URL('../../helix/test/fixtures/possum.hlx', import.meta.url)),
    'utf8',
  );
}

export function openSession(text: string = realPreset()): ToneSession {
  const result = ToneSession.open(text);
  if ('error' in result) {
    throw new Error(`Fixture failed to open: ${result.error.message}`);
  }
  return result.session;
}

/**
 * A synthetic preset with a snapshot that mirrors block bypass and a
 * snapshot-controlled parameter, so tests can assert on the dual-write rule.
 */
export const SNAPSHOT_PRESET = `{
 "data" : {
  "device" : 2162689,
  "device_version" : 51380224,
  "meta" : {
   "name" : "Snapshot Test"
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
     "Master" : 0.360
    },
    "block1" : {
     "@enabled" : false,
     "@model" : "HD2_DynCompressor",
     "@path" : 0,
     "@position" : 1,
     "@type" : 0,
     "Level" : 0.500,
     "Sustain" : 0.400
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
