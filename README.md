# 소리컷 / sori-cut

> The all-in-one short-form editor for music cover creators

**sori** (sound) + **cut** — trim, layer, and publish your covers.

## Vision

sori-cut replaces the fragmented workflow of music short-form content creators (Reels/Shorts/TikTok) with a single browser-based editor:

1. **Stem Splitting** — Separate vocals, drums, bass, and guitar from existing tracks
2. **Recording Studio** — Capture guitar/instrument audio via Web Audio API
3. **Video Sync** — Align recorded audio to filmed video
4. **Timeline Editor** — Trim, arrange, add effects
5. **Export** — Optimized for vertical 9:16 formats

## Tech Stack

- **TypeScript + React** (Vite)
- **TailwindCSS** for styling
- **Web Audio API** for recording & audio processing
- **Mediabunny** for bounded browser-side media metadata inspection
- **FFmpeg.wasm** for video/audio manipulation
- **pnpm workspaces** monorepo

## Project Structure

```
sori-cut/
├── apps/
│   └── web/              # Vite + React web app
├── packages/
│   ├── ui/               # Shared UI components
│   ├── audio-engine/     # Web Audio API recording & processing
│   ├── video-engine/     # FFmpeg.wasm video pipeline
│   └── editor-core/      # Timeline & editor state management
├── pnpm-workspace.yaml
└── package.json
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/) >= 8

### Setup

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Build for production
pnpm build
```

The dev server will start at `http://localhost:3000`.

## Auto-sync media limits

Auto-sync accepts audio tracks from MP4/MOV/M4A, WebM/MKV, AAC/ADTS, Ogg
(Opus or Vorbis), FLAC, MP3, and WAV inputs. Mediabunny inspects the complete
bounded encoded input before Web Audio decoding and rejects missing audio
tracks, malformed or unknown media, invalid metadata, and decoded shapes over
128 MiB.

Each accepted encoded input is capped at 48 MiB and requires a streaming
response body. The advertised encoded peak for accepted inputs is 96 MiB
without relying on BYOB readers, fetch chunk sizing, or garbage collection:

- With `Content-Length`, a destination of at most 48 MiB can coexist with one
  ordinary reader chunk of at most the accepted 48 MiB payload.
- Without `Content-Length`, retained chunks total at most 48 MiB and can coexist
  with the final assembled copy of at most 48 MiB.

The reference and target are fetched and decoded sequentially. The encoded
buffer reference is explicitly released before the next input fetch; only the
bounded 8 kHz mono analysis array is retained.

## Deployment (GitHub Pages)

- This repository deploys `apps/web` to GitHub Pages via `.github/workflows/deploy-pages.yml`.
- The deployed artifact includes `apps/web/public/CNAME` with `soricut.studio`.
- Public reachability for `https://soricut.studio/` and `https://www.soricut.studio/` is monitored every 30 minutes by `.github/workflows/pages-uptime-check.yml`.

## Design

See the [Studio redesign references](./docs/design/README.md).

## Target Audience

Guitar/music cover creators who film themselves playing — starting with the workflow of [@junewoomusic](https://instagram.com/junewoomusic).

## License

[MIT](./LICENSE)
