# On The Run — Roadmap

> Living checklist for the mobile-first audio workstation. Update this file whenever a milestone lands.
>
> **Current milestone:** Phase 3 — Touch editing  
> **Last updated:** 2026-10-15

## Status legend

- [x] Done and committed
- [ ] Not done yet
- **NOW** = current focus

## Phase 0 — Project foundation

- [x] Create the GitHub repository and Vite + React + TypeScript app
- [x] Add responsive dark mobile-first UI
- [x] Configure TypeScript production build and Vercel deployment
- [x] Add project README

## Phase 1 — Audio import and preview

- [x] Import local WAV, MP3 and OGG audio using the browser File API
- [x] Decode audio with the Web Audio API
- [x] Show file name, duration, sample rate and channel count
- [x] Draw a waveform with Canvas 2D
- [x] Preview imported audio and stop playback

## Phase 2 — Multitrack editing foundation

- [x] Add two starter tracks
- [x] Place an imported audio file on either track
- [x] Render clips on a horizontally scrollable timeline
- [x] Show clip waveforms and a moving playhead
- [x] Synchronize clips through a shared Web Audio transport
- [x] Add shared Play/Pause and Stop controls
- [x] Select and delete a clip
- [x] Split a selected clip at the playhead
- [x] Nudge a selected clip by one beat
- [ ] Verify the complete workflow on real iOS and Android devices

## Phase 3 — Touch editing **NOW**

- [x] Drag clips horizontally with touch and pointer input
- [x] Move clips between tracks
- [x] Trim clip start and end handles without changing source audio
- [x] Add snap-to-grid toggle and beat/bar grid
- [x] Add timeline zoom controls
- [ ] Improve selected-clip controls for small screens
- [ ] Add undo/redo for editing operations

**Progress:** Basic drag, cross-track move, trim handles, beat snapping toggle and timeline zoom (50–200%) are implemented. Device testing, selected-clip mobile polish and undo/redo remain open.

**Definition of done:** On a phone, a user can import audio, move and trim clips, align them to the beat, split them, and play the arrangement reliably.

## Phase 4 — Project persistence

- [ ] Define a serializable project format (metadata, tracks, clips, tempo and settings)
- [ ] Store audio assets and project data in IndexedDB
- [ ] Restore the last session after reload
- [ ] Create, rename and delete projects
- [ ] Handle missing or unsupported assets gracefully
- [ ] Add project schema versioning for future migrations

## Phase 5 — Timing and arrangement

- [ ] Editable BPM and time signature
- [ ] Bar/beat ruler tied to tempo
- [ ] Metronome and count-in
- [ ] Loop range and loop playback
- [ ] Add, rename and reorder tracks
- [ ] Track mute, solo and volume controls
- [ ] Clip gain and basic fades

## Phase 6 — Mixing and effects

- [ ] Establish a track-to-master audio graph
- [ ] Add master volume and clipping protection
- [ ] Add a basic volume effect
- [ ] Add EQ and reverb as first built-in effects
- [ ] Design send/return routing for future effects
- [ ] Save effect settings in the project format

## Phase 7 — Export

- [ ] Offline render of the arrangement
- [ ] Export stereo WAV
- [ ] Show export progress and handle long sessions
- [ ] Test export against the live playback mix

## Phase 8 — MIDI and advanced DAW features

- [ ] MIDI note clips and piano roll
- [ ] MIDI input where browser/device support allows
- [ ] Automation lanes
- [ ] Additional instruments and sample playback
- [ ] Advanced routing and effect sends
- [ ] Performance profiling for long sessions and many tracks

## Engineering and quality checklist

- [x] Keep the first version client-side; no audio upload server
- [x] Use Web Audio API for decoding and synchronized playback
- [x] Use Canvas 2D for waveform rendering
- [ ] Add automated tests for timeline math and clip editing
- [ ] Add runtime safeguards for unsupported browser audio formats
- [ ] Test memory use with long and multichannel audio
- [ ] Audit accessibility, keyboard controls and reduced-motion behavior
- [ ] Document supported mobile browsers and known limitations

---

## Working rules

1. Update this checklist in the same change that completes a milestone.
2. Only mark an item complete after it is implemented; deployment success alone does not count as device testing.
3. Keep the app usable on a phone at every stage.
4. Prefer small, testable milestones and keep audio processing in the browser unless a real need for a backend appears.
