# On The Run

A mobile-first browser audio workstation built with React, TypeScript, Vite and the Web Audio API.

## Current milestone

- [x] React + TypeScript + Vite foundation
- [x] Mobile-first dark UI
- [x] Import local WAV / MP3 / OGG files
- [x] Decode audio in the browser
- [x] Draw a waveform with Canvas 2D
- [x] Preview imported audio
- [ ] Multi-track timeline and clip editing
- [ ] Synchronized transport
- [ ] IndexedDB project persistence

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
