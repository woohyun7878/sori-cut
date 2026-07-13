# 소리컷 / sori-cut

> 음악 커버 크리에이터를 위한 올인원 숏폼 편집기  
> The all-in-one short-form editor for music cover creators

**소리**(sound) + **컷**(cut) — 소리를 자르고, 붙이고, 세상에 내보내세요.

## Vision

sori-cut replaces the fragmented workflow of Korean music short-form content creators (Reels/Shorts/TikTok) with a single browser-based editor:

1. **스템 분리 (Stem Splitting)** — Separate vocals, drums, bass, and guitar from existing tracks
2. **녹음 스튜디오 (Recording Studio)** — Capture guitar/instrument audio via Web Audio API
3. **영상 싱크 (Video Sync)** — Align recorded audio to filmed video
4. **타임라인 편집 (Timeline Editor)** — Trim, arrange, add effects
5. **내보내기 (Export)** — Optimized for vertical 9:16 formats

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

Korean guitar/music cover creators who film themselves playing — starting with the workflow of [@junewoomusic](https://instagram.com/junewoomusic).

## License

[MIT](./LICENSE)
