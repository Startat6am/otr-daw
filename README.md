# On The Run

A mobile-first browser audio workstation built with React, TypeScript, Vite and the Web Audio API.

## Current milestone

- [x] React + TypeScript + Vite foundation
- [x] Mobile-first dark UI
- [x] Import local WAV / MP3 / OGG files
- [x] Decode audio in the browser
- [x] Draw waveforms with Canvas 2D
- [x] Preview imported audio
- [x] Two-track timeline and clip placement
- [x] Synchronized Play / Pause / Stop transport
- [x] Select, delete, split and beat-nudge clips
- [ ] Touch drag, trim handles and snap-to-grid
- [ ] IndexedDB project persistence
- [ ] Verify the full workflow on real mobile devices

See **[ROADMAP.md](./ROADMAP.md)** for the complete milestone checklist. Keep it updated as work lands.

## Development

```sh
npm install
npm run dev
```

## Production build

```sh
npm run build
npm run preview
```

Audio files are processed locally in the browser. No audio upload server is used.
