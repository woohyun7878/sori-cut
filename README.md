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

## Target Audience

Guitar/music cover creators who film themselves playing — starting with the workflow of [@junewoomusic](https://instagram.com/junewoomusic).

## License

[MIT](./LICENSE)
