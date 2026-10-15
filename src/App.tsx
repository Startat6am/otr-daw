import { useEffect, useRef, useState } from "react";

type ImportedAudio = {
  id: string;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  buffer: AudioBuffer;
};
type Clip = { id: string; assetId: string; start: number; sourceStart: number; sourceEnd: number };
type Track = { id: string; name: string; clips: Clip[]; gain: number };
const BPM = 120;
const PX_PER_SECOND = 58;
const BEAT = 60 / BPM;
const INITIAL_TRACKS: Track[] = [
  { id: "track-1", name: "Track 1", clips: [], gain: 1 },
  { id: "track-2", name: "Track 2", clips: [], gain: 1 },
];

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return minutes + ":" + String(rest).padStart(2, "0");
}
function uid() { return crypto.randomUUID(); }

function Waveform({ buffer }: { buffer: AudioBuffer }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.strokeStyle = "#9be7cf";
    ctx.lineWidth = 1.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    const channel = buffer.getChannelData(0);
    const samplesPerPixel = Math.max(1, Math.floor(channel.length / rect.width));
    const middle = rect.height / 2;
    for (let x = 0; x < rect.width; x++) {
      const start = x * samplesPerPixel;
      const end = Math.min(channel.length, start + samplesPerPixel);
      let min = 1, max = -1;
      for (let i = start; i < end; i++) {
        const v = channel[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      ctx.moveTo(x + .5, middle - max * rect.height * .43);
      ctx.lineTo(x + .5, middle - min * rect.height * .43);
    }
    ctx.stroke();
  }, [buffer]);
  return <canvas ref={canvasRef} className="waveform" aria-label="Audio waveform" />;
}

function ClipWaveform({ buffer }: { buffer: AudioBuffer }) {
  return <Waveform buffer={buffer} />;
}

export default function App() {
  const [assets, setAssets] = useState<ImportedAudio[]>([]);
  const [tracks, setTracks] = useState<Track[]>(INITIAL_TRACKS);
  const [status, setStatus] = useState("Import audio, add it to a track, then press play.");
  const [busy, setBusy] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [selectedClip, setSelectedClip] = useState<string | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const playingRef = useRef(false);
  const playheadRef = useRef(0);
  const clockStartRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const dragRef = useRef<{ clipId: string; fromTrackId: string; startX: number; start: number; sourceStart: number; sourceEnd: number; mode: "move" | "left" | "right"; moved: boolean } | null>(null);

  function getContext() {
    if (!contextRef.current) contextRef.current = new AudioContext();
    return contextRef.current;
  }
  function stopSources() {
    sourcesRef.current.forEach((source) => { try { source.stop(); } catch { /* already ended */ } });
    sourcesRef.current = [];
  }
  function pauseTransport() {
    const context = contextRef.current;
    if (playingRef.current && context) {
      playheadRef.current = Math.max(0, playheadRef.current + context.currentTime - clockStartRef.current);
      setPlayhead(playheadRef.current);
    }
    playingRef.current = false;
    setIsPlaying(false);
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    stopSources();
  }
  function scheduleFrom(position: number, context: AudioContext) {
    stopSources();
    const startAt = context.currentTime + .08;
    clockStartRef.current = startAt;
    playheadRef.current = position;
    tracks.forEach((track) => track.clips.forEach((clip) => {
      const asset = assets.find((item) => item.id === clip.assetId);
      if (!asset) return;
      const clipDuration = clip.sourceEnd - clip.sourceStart;
      const clipEnd = clip.start + clipDuration;
      if (clipEnd <= position) return;
      const elapsed = Math.max(0, position - clip.start);
      const offset = clip.sourceStart + elapsed;
      const duration = clip.sourceEnd - offset;
      if (duration <= 0) return;
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = asset.buffer;
      gain.gain.value = track.gain;
      source.connect(gain);
      gain.connect(context.destination);
      sourcesRef.current.push(source);
      source.start(startAt + Math.max(0, clip.start - position), offset, duration);
    }));
    playingRef.current = true;
    setIsPlaying(true);
  }
  async function toggleTransport() {
    const context = getContext();
    if (playingRef.current) { pauseTransport(); return; }
    if (context.state === "suspended") await context.resume();
    const maxEnd = Math.max(0, ...tracks.flatMap((track) => track.clips.map((clip) => clip.start + clip.sourceEnd - clip.sourceStart)));
    if (playheadRef.current >= maxEnd && maxEnd > 0) {
      playheadRef.current = 0;
      setPlayhead(0);
    }
    if (maxEnd === 0) {
      setStatus("Add an audio clip to a track before pressing play.");
      return;
    }
    scheduleFrom(playheadRef.current, context);
  }
  function stopTransport() {
    pauseTransport();
    playheadRef.current = 0;
    setPlayhead(0);
  }

  function seekPlayhead(position: number) {
    const next = Math.max(0, Math.min(maxTimelineSeconds(), position));
    playheadRef.current = next;
    setPlayhead(next);
    const context = contextRef.current;
    if (playingRef.current && context) scheduleFrom(next, context);
  }
  function maxTimelineSeconds() {
    return Math.max(16, ...tracks.flatMap((track) => track.clips.map((clip) => clip.start + clip.sourceEnd - clip.sourceStart + 2)));
  }

  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    const tick = () => {
      const context = contextRef.current;
      if (context && playingRef.current) {
        const position = Math.max(0, context.currentTime - clockStartRef.current + playheadRef.current);
        setPlayhead(position);
        const end = Math.max(0, ...tracks.flatMap((track) => track.clips.map((clip) => clip.start + clip.sourceEnd - clip.sourceStart)));
        if (end > 0 && position >= end) {
          playingRef.current = false;
          setIsPlaying(false);
          stopSources();
          playheadRef.current = 0;
          setPlayhead(0);
          return;
        }
      }
      frame = requestAnimationFrame(tick);
      rafRef.current = frame;
    };
    frame = requestAnimationFrame(tick);
    rafRef.current = frame;
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, tracks]);

  useEffect(() => () => {
    playingRef.current = false;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    stopSources();
    void contextRef.current?.close();
  }, []);

  async function importFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setStatus("Decoding audio…");
    try {
      const context = getContext();
      if (context.state === "suspended") await context.resume();
      const imported: ImportedAudio[] = [];
      for (const file of Array.from(files)) {
        if (!/\.(wav|mp3|ogg|oga)$/i.test(file.name) && !file.type.startsWith("audio/")) continue;
        const buffer = await context.decodeAudioData(await file.arrayBuffer());
        imported.push({ id: uid(), name: file.name, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, buffer });
      }
      if (!imported.length) setStatus("No supported audio files found. Choose WAV, MP3 or OGG.");
      else {
        setAssets((current) => [...current, ...imported]);
        setStatus(`Imported ${imported.length} file${imported.length === 1 ? "" : "s"}. Add clips to tracks below.`);
      }
    } catch (error) {
      console.error(error);
      setStatus("Could not decode this file. Try another WAV, MP3 or OGG file.");
    } finally { setBusy(false); }
  }
  function addClip(asset: ImportedAudio, trackId: string) {
    const clip: Clip = { id: uid(), assetId: asset.id, start: 0, sourceStart: 0, sourceEnd: asset.duration };
    setTracks((current) => current.map((track) => track.id === trackId ? { ...track, clips: [...track.clips, clip] } : track));
    setSelectedClip(clip.id);
    setStatus(`Added ${asset.name} to ${tracks.find((track) => track.id === trackId)?.name}.`);
  }
  function updateClip(clipId: string, change: Partial<Clip>) {
    setTracks((current) => current.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, ...change } : clip) })));
  }
  function nudgeClip(clip: Clip, amount: number) {
    updateClip(clip.id, { start: Math.max(0, clip.start + amount * BEAT) });
  }
  function splitSelected() {
    if (!selectedClip) { setStatus("Select a clip first."); return; }
    let didSplit = false;
    setTracks((current) => current.map((track) => {
      const index = track.clips.findIndex((clip) => clip.id === selectedClip);
      if (index < 0) return track;
      const clip = track.clips[index];
      const local = playhead - clip.start;
      const length = clip.sourceEnd - clip.sourceStart;
      if (local <= .03 || local >= length - .03) return track;
      const cut = clip.sourceStart + local;
      const left = { ...clip, sourceEnd: cut };
      const right: Clip = { ...clip, id: uid(), start: playhead, sourceStart: cut };
      const next = [...track.clips];
      next.splice(index, 1, left, right);
      didSplit = true;
      return { ...track, clips: next };
    }));
    setStatus(didSplit ? "Clip split at the playhead." : "Move the playhead inside the selected clip to split it.");
  }
  function removeSelected() {
    if (!selectedClip) return;
    setTracks((current) => current.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.id !== selectedClip) })));
    setSelectedClip(null);
    setStatus("Clip removed from the timeline.");
  }

  const maxEnd = Math.max(16, ...tracks.flatMap((track) => track.clips.map((clip) => clip.start + clip.sourceEnd - clip.sourceStart + 2)));
  const timelineWidth = maxEnd * PX_PER_SECOND;
  const rulerCount = Math.ceil(maxEnd / 2);

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="On The Run home"><span className="brand-mark">OTR</span><span>on the run<span className="brand-dot">.</span></span></a>
        <span className="version-pill">EARLY ACCESS · 0.2</span>
      </header>

      <section className="welcome">
        <p className="eyebrow">MOBILE AUDIO WORKSTATION</p>
        <h1>Catch the sound.<br /><span>Shape the moment.</span></h1>
        <p className="intro">A studio that moves with you. Build a session, line up clips, and hear them together.</p>
      </section>

      <section className="workspace" aria-label="Audio workspace">
        <div className="section-heading">
          <div><p className="eyebrow">YOUR SESSION</p><h2>Audio library <span className="count">{assets.length}</span></h2></div>
          <button className="stop-button" onClick={stopTransport}>Stop</button>
        </div>
        <label className={`import-card ${busy ? "is-busy" : ""}`}>
          <input type="file" accept="audio/wav,audio/mpeg,audio/ogg,.wav,.mp3,.ogg,.oga" multiple onChange={(event) => { void importFiles(event.currentTarget.files); event.currentTarget.value = ""; }} disabled={busy} />
          <span className="import-icon">{busy ? "…" : "+"}</span>
          <span className="import-copy"><strong>{busy ? "Importing audio…" : "Bring in your sound"}</strong><span>Choose WAV, MP3 or OGG from your device</span></span>
          <span className="import-arrow">↗</span>
        </label>
        <p className="status" role="status">{status}</p>
        {assets.length > 0 ? <div className="asset-list">{assets.map((asset, index) => (
          <article className="asset-card" key={asset.id}>
            <div className="asset-meta">
              <span className="track-number">{String(index + 1).padStart(2, "0")}</span>
              <div className="asset-title"><strong title={asset.name}>{asset.name}</strong><span>{formatTime(asset.duration)} · {asset.sampleRate.toLocaleString()} Hz · {asset.channels} ch</span></div>
            </div>
            <div className="asset-actions"><button className="add-clip-button" onClick={() => addClip(asset, "track-1")}>+ Track 1</button><button className="add-clip-button" onClick={() => addClip(asset, "track-2")}>+ Track 2</button></div>
          </article>
        ))}</div> : <div className="empty-state"><div className="empty-graphic" aria-hidden="true">{Array.from({length: 9}, (_, i) => <span key={i} />)}</div><strong>Your next idea starts here</strong><p>Import a sound, then add it to any track.</p></div>}
      </section>

      <section className="timeline-panel" aria-label="Multitrack timeline">
        <div className="timeline-heading">
          <div><p className="eyebrow">ARRANGEMENT</p><h2>Timeline <span className="count">{BPM} BPM</span></h2></div>
          <div className="transport">
            <button className="transport-button" onClick={stopTransport} aria-label="Stop playback">■</button>
            <button className="transport-button play-button" onClick={() => void toggleTransport()} aria-label={isPlaying ? "Pause playback" : "Start playback"}>{isPlaying ? "Ⅱ" : "▶"}</button>
            <span className="time-readout">{formatTime(playhead)}</span>
          </div>
        </div>
        <div className="edit-tools"><span>Tap ruler or empty track to move playhead · tap clip to select</span><button onClick={splitSelected} disabled={!selectedClip}>Split at playhead</button><button onClick={removeSelected} disabled={!selectedClip}>Delete clip</button></div>
        <div className="timeline-scroll">
          <div className="timeline-inner" style={{ width: timelineWidth }}>
            <div className="ruler" style={{ width: timelineWidth }} onPointerDown={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              seekPlayhead((event.clientX - rect.left) / PX_PER_SECOND);
            }}>
              {Array.from({ length: rulerCount + 1 }, (_, i) => <div className="ruler-mark" key={i} style={{ left: i * 2 * PX_PER_SECOND }}><span>{String(i * 4 + 1).padStart(2, "0")}</span></div>)}
            </div>
            {tracks.map((track) => <div className="timeline-track" data-track-id={track.id} key={track.id} style={{ width: timelineWidth }}>
              <div className="track-label">{track.name}</div>
              {track.clips.map((clip) => {
                const asset = assets.find((item) => item.id === clip.assetId);
                if (!asset) return null;
                const duration = clip.sourceEnd - clip.sourceStart;
                return <div key={clip.id} className={"timeline-clip " + (selectedClip === clip.id ? "selected " : "") + (dragRef.current?.clipId === clip.id ? "is-dragging" : "")} style={{ left: clip.start * PX_PER_SECOND, width: Math.max(34, duration * PX_PER_SECOND) }} onClick={() => setSelectedClip(clip.id)} role="button" tabIndex={0} aria-label={"Select clip " + asset.name} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedClip(clip.id); }}
                  onPointerDown={(event) => {
                    const target = event.target as HTMLElement;
                    const edge = target.closest<HTMLElement>("[data-edge]")?.dataset.edge;
                    dragRef.current = { clipId: clip.id, fromTrackId: track.id, startX: event.clientX, start: clip.start, sourceStart: clip.sourceStart, sourceEnd: clip.sourceEnd, mode: edge === "left" || edge === "right" ? edge : "move", moved: false };
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setSelectedClip(clip.id);
                  }}
                  onPointerMove={(event) => {
                    const drag = dragRef.current;
                    if (!drag || drag.clipId !== clip.id || !event.buttons) return;
                    const delta = (event.clientX - drag.startX) / PX_PER_SECOND;
                    if (Math.abs(event.clientX - drag.startX) > 3) drag.moved = true;
                    if (drag.mode === "move") updateClip(clip.id, { start: Math.max(0, drag.start + delta) });
                    else if (drag.mode === "left") {
                      const sourceStart = Math.max(0, Math.min(drag.sourceEnd - .05, drag.sourceStart + delta));
                      updateClip(clip.id, { sourceStart, start: Math.max(0, drag.start + sourceStart - drag.sourceStart) });
                    } else updateClip(clip.id, { sourceEnd: Math.max(drag.sourceStart + .05, Math.min(asset.duration, drag.sourceEnd + delta)) });
                  }}
                  onPointerUp={(event) => {
                    const drag = dragRef.current;
                    if (!drag || drag.clipId !== clip.id) return;
                    const dropTrack = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-track-id]")?.dataset.trackId;
                    if (drag.moved && drag.mode === "move" && dropTrack && dropTrack !== drag.fromTrackId) {
                      setTracks((current) => {
                        let movedClip: Clip | undefined;
                        const without = current.map((item) => ({ ...item, clips: item.clips.filter((candidate) => {
                          if (candidate.id === clip.id) { movedClip = candidate; return false; }
                          return true;
                        }) }));
                        return without.map((item) => item.id === dropTrack && movedClip ? { ...item, clips: [...item.clips, movedClip] } : item);
                      });
                      setStatus("Clip moved to another track.");
                    }
                    dragRef.current = null;
                  }}
                  onPointerCancel={() => { dragRef.current = null; }}>
                  <span className="trim-handle trim-left" data-edge="left" aria-label="Trim clip start" />
                  <strong>{asset.name}</strong><div className="clip-wave"><ClipWaveform buffer={asset.buffer} /></div>
                  <span className="trim-handle trim-right" data-edge="right" aria-label="Trim clip end" />
                  {selectedClip === clip.id && <div className="clip-nudges"><button onClick={(event) => { event.stopPropagation(); nudgeClip(clip, -1); }}>− beat</button><button onClick={(event) => { event.stopPropagation(); nudgeClip(clip, 1); }}>+ beat</button></div>}
                </div>;
              })}
            </div>)}
            <div className="playhead" style={{ left: playhead * PX_PER_SECOND }} />
          </div>
        </div>
        <p className="timeline-hint">Horizontal scroll · 4/4 grid · one beat = {BEAT.toFixed(2)}s. Beat nudges move selected clips.</p>
      </section>

      <footer className="footer"><span><span className="live-dot" /> AUDIO ENGINE READY</span><span>MADE FOR THE MOMENT</span></footer>
    </main>
  );
}