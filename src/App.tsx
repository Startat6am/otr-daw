import { useEffect, useRef, useState } from "react";
import { loadSavedProject, saveProject, type SavedProject } from "./persistence";

type ImportedAudio = {
  id: string;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  buffer: AudioBuffer;
  audioData: ArrayBuffer;
};
type Clip = { id: string; assetId: string; start: number; sourceStart: number; sourceEnd: number };
type Track = { id: string; name: string; clips: Clip[]; gain: number; muted: boolean; solo: boolean };
const BPM = 120;
const BASE_PX_PER_SECOND = 58;
const BEAT = 60 / BPM;
const INITIAL_TRACKS: Track[] = [
  { id: "track-1", name: "Track 1", clips: [], gain: 1, muted: false, solo: false },
  { id: "track-2", name: "Track 2", clips: [], gain: 1, muted: false, solo: false },
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
  const [clipboardClip, setClipboardClip] = useState<{ clip: Clip; trackId: string } | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [masterGain, setMasterGain] = useState(0.85);
  const [masterLevel, setMasterLevel] = useState(0);
  const masterGainRef = useRef(0.85);
  const mixerNodesRef = useRef<Map<string, GainNode>>(new Map());
  const masterNodeRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const [, setHistoryVersion] = useState(0);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [saveState, setSaveState] = useState<"loading" | "saved" | "saving" | "error">("loading");
  const saveTimerRef = useRef<number | null>(null);
  const tracksRef = useRef<Track[]>(INITIAL_TRACKS);
  const undoStackRef = useRef<Track[][]>([]);
  const redoStackRef = useRef<Track[][]>([]);
  const PX_PER_SECOND = BASE_PX_PER_SECOND * timelineZoom;
  const contextRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const playingRef = useRef(false);
  const playheadRef = useRef(0);
  const clockStartRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const dragRef = useRef<{ clipId: string; fromTrackId: string; startX: number; start: number; sourceStart: number; sourceEnd: number; mode: "move" | "left" | "right"; moved: boolean } | null>(null);

  function commitTracks(updater: (current: Track[]) => Track[]) {
    const current = tracksRef.current;
    undoStackRef.current.push(current);
    if (undoStackRef.current.length > 100) undoStackRef.current.shift();
    redoStackRef.current = [];
    const next = updater(current);
    tracksRef.current = next;
    setTracks(next);
    setHistoryVersion((version) => version + 1);
  }
  function undoEdit() {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    redoStackRef.current.push(tracksRef.current);
    tracksRef.current = previous;
    setTracks(previous);
    setHistoryVersion((version) => version + 1);
    setStatus("Undo: previous edit restored.");
  }
  function redoEdit() {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(tracksRef.current);
    tracksRef.current = next;
    setTracks(next);
    setHistoryVersion((version) => version + 1);
    setStatus("Redo: edit restored.");
  }

  useEffect(() => {
    let cancelled = false;
    async function restoreProject() {
      try {
        const saved = await loadSavedProject();
        if (cancelled) return;
        if (saved) {
          const context = getContext();
          const restoredAssets: ImportedAudio[] = [];
          for (const item of saved.assets) {
            try {
              const audioData = item.audioData.slice(0);
              const buffer = await context.decodeAudioData(audioData.slice(0));
              restoredAssets.push({ ...item, audioData, buffer, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels });
            } catch {
              // Keep the rest of the project available if one stored audio file is no longer decodable.
            }
          }
          if (cancelled) return;
          const restoredTracks = saved.tracks.map((track) => ({ ...track, gain: Number.isFinite(track.gain) ? track.gain : 1, muted: Boolean(track.muted), solo: Boolean(track.solo), clips: track.clips.filter((clip) => restoredAssets.some((asset) => asset.id === clip.assetId)) }));
          setAssets(restoredAssets);
          tracksRef.current = restoredTracks;
          setTracks(restoredTracks);
          setSnapEnabled(saved.settings.snapEnabled);
          setTimelineZoom(saved.settings.timelineZoom);
          const restoredMaster = typeof saved.settings.masterGain === "number" ? Math.max(0, Math.min(1, saved.settings.masterGain)) : 0.85;
          masterGainRef.current = restoredMaster;
          setMasterGain(restoredMaster);
          setStatus(restoredAssets.length < saved.assets.length ? "Project restored. Some audio assets could not be decoded." : "Project restored from this device.");
        }
      } catch (error) {
        console.error("Could not restore project", error);
        if (!cancelled) setStatus("Local project storage is unavailable in this browser.");
      } finally {
        if (!cancelled) { setPersistenceReady(true); setSaveState("saved"); }
      }
    }
    void restoreProject();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!persistenceReady) return;
    setSaveState("saving");
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      const project: SavedProject = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        assets: assets.map((asset) => ({ id: asset.id, name: asset.name, duration: asset.duration, sampleRate: asset.sampleRate, channels: asset.channels, audioData: asset.audioData })),
        tracks,
        settings: { snapEnabled, timelineZoom, masterGain },
      };
      void saveProject(project).then(() => setSaveState("saved")).catch((error: unknown) => {
        console.error("Could not save project", error);
        setSaveState("error");
      });
    }, 450);
    return () => { if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current); };
  }, [assets, tracks, snapEnabled, timelineZoom, masterGain, persistenceReady]);

  function getContext() {
    if (!contextRef.current) contextRef.current = new AudioContext();
    return contextRef.current;
  }
  function ensureMixer(context: AudioContext, currentTracks: Track[]) {
    if (!masterNodeRef.current || masterNodeRef.current.context !== context) {
      const master = context.createGain();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      master.gain.value = masterGainRef.current;
      master.connect(analyser);
      analyser.connect(context.destination);
      masterNodeRef.current = master;
      analyserRef.current = analyser;
    }
    const soloActive = currentTracks.some((track) => track.solo);
    currentTracks.forEach((track) => {
      let node = mixerNodesRef.current.get(track.id);
      if (!node || node.context !== context) {
        node = context.createGain();
        node.connect(masterNodeRef.current!);
        mixerNodesRef.current.set(track.id, node);
      }
      const audible = !track.muted && (!soloActive || track.solo);
      node.gain.setTargetAtTime(audible ? track.gain : 0, context.currentTime, 0.015);
    });
  }
  function changeTrack(trackId: string, change: Partial<Pick<Track, "gain" | "muted" | "solo">>) {
    const next = tracksRef.current.map((track) => track.id === trackId ? { ...track, ...change } : track);
    tracksRef.current = next;
    setTracks(next);
    if (contextRef.current) ensureMixer(contextRef.current, next);
  }
  function setMaster(value: number) {
    const next = Math.max(0, Math.min(1, value));
    masterGainRef.current = next;
    setMasterGain(next);
    if (masterNodeRef.current && contextRef.current) masterNodeRef.current.gain.setTargetAtTime(next, contextRef.current.currentTime, 0.015);
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
    ensureMixer(context, tracksRef.current);
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
      source.buffer = asset.buffer;
      const trackGain = mixerNodesRef.current.get(track.id);
      if (!trackGain) return;
      source.connect(trackGain);
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
    if (!isPlaying) { setMasterLevel(0); return; }
    let frame = 0;
    const tick = () => {
      const context = contextRef.current;
      if (context && playingRef.current) {
        const analyser = analyserRef.current;
        if (analyser) {
          const samples = new Uint8Array(analyser.fftSize);
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) { const normalized = (sample - 128) / 128; sum += normalized * normalized; }
          setMasterLevel(Math.min(1, Math.sqrt(sum / samples.length) * 3.5));
        }
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
        const audioData = await file.arrayBuffer();
        const buffer = await context.decodeAudioData(audioData.slice(0));
        imported.push({ id: uid(), name: file.name, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, buffer, audioData });
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
    commitTracks((current) => current.map((track) => track.id === trackId ? { ...track, clips: [...track.clips, clip] } : track));
    setSelectedClip(clip.id);
    setStatus(`Added ${asset.name} to ${tracks.find((track) => track.id === trackId)?.name}.`);
  }
  function updateClip(clipId: string, change: Partial<Clip>, recordHistory = true) {
    const updater = (current: Track[]) => current.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, ...change } : clip) }));
    if (recordHistory) commitTracks(updater);
    else {
      const next = updater(tracksRef.current);
      tracksRef.current = next;
      setTracks(next);
    }
  }
  function nudgeClip(clip: Clip, amount: number) {
    updateClip(clip.id, { start: Math.max(0, clip.start + amount * BEAT) });
  }
  function snapTime(seconds: number) {
    return snapEnabled ? Math.round(seconds / BEAT) * BEAT : seconds;
  }
  function splitSelected() {
    if (!selectedClip) { setStatus("Select a clip first."); return; }
    let didSplit = false;
    commitTracks((current) => current.map((track) => {
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
    commitTracks((current) => current.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.id !== selectedClip) })));
    setSelectedClip(null);
    setStatus("Clip removed from the timeline.");
  }

  function findSelectedClip() {
    for (const track of tracksRef.current) {
      const clip = track.clips.find((item) => item.id === selectedClip);
      if (clip) return { clip, trackId: track.id };
    }
    return null;
  }
  function duplicateSelected() {
    const selected = findSelectedClip();
    if (!selected) return;
    const duration = selected.clip.sourceEnd - selected.clip.sourceStart;
    const duplicate = { ...selected.clip, id: uid(), start: snapTime(selected.clip.start + duration) };
    commitTracks((current) => current.map((track) => track.id === selected.trackId ? { ...track, clips: [...track.clips, duplicate] } : track));
    setSelectedClip(duplicate.id);
    setStatus("Clip duplicated after the original.");
  }
  function copySelected() {
    const selected = findSelectedClip();
    if (!selected) return;
    setClipboardClip({ clip: { ...selected.clip }, trackId: selected.trackId });
    setStatus("Clip copied. Move the playhead and tap Paste.");
  }
  function pasteClip() {
    if (!clipboardClip) return;
    const targetTrack = tracksRef.current.find((track) => track.id === clipboardClip.trackId) ?? tracksRef.current[0];
    if (!targetTrack) return;
    const pasted = { ...clipboardClip.clip, id: uid(), start: snapTime(playhead) };
    commitTracks((current) => current.map((track) => track.id === targetTrack.id ? { ...track, clips: [...track.clips, pasted] } : track));
    setSelectedClip(pasted.id);
    setStatus("Clip pasted at the playhead.");
  }
  function setSelectedClipTiming(start: number, duration: number) {
    const selected = findSelectedClip();
    if (!selected) return;
    const asset = assets.find((item) => item.id === selected.clip.assetId);
    if (!asset) return;
    const safeStart = Math.max(0, Number.isFinite(start) ? start : 0);
    const safeDuration = Math.max(0.05, Math.min(asset.duration - selected.clip.sourceStart, Number.isFinite(duration) ? duration : 0.05));
    updateClip(selected.clip.id, { start: safeStart, sourceEnd: selected.clip.sourceStart + safeDuration });
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

      <section className="mixer-panel" aria-label="Audio mixer">
        <div className="section-heading mixer-heading"><div><p className="eyebrow">LEVELS & CONTROL</p><h2>Mixer <span className="count">{tracks.length} tracks</span></h2></div><div className="master-meter" aria-label={`Master signal ${Math.round(masterLevel * 100)} percent`}><span style={{ width: `${Math.round(masterLevel * 100)}%` }} /></div></div>
        <div className="mixer-channels">
          {tracks.map((track, index) => <article className={`mixer-channel ${track.muted ? "channel-muted" : ""} ${track.solo ? "channel-solo" : ""}`} key={track.id}>
            <div className="channel-top"><span className="channel-index">{String(index + 1).padStart(2, "0")}</span><strong>{track.name}</strong><span className="channel-db">{track.gain === 0 ? "−∞" : `${(20 * Math.log10(track.gain)).toFixed(1)} dB`}</span></div>
            <label className="volume-control"><span>VOL</span><input aria-label={`${track.name} volume`} type="range" min="0" max="1" step="0.01" value={track.gain} onChange={(event) => changeTrack(track.id, { gain: Number(event.currentTarget.value) })} /><output>{Math.round(track.gain * 100)}%</output></label>
            <div className="channel-buttons"><button className={track.muted ? "channel-active" : ""} aria-pressed={track.muted} onClick={() => changeTrack(track.id, { muted: !track.muted })}>MUTE</button><button className={track.solo ? "channel-active solo-active" : ""} aria-pressed={track.solo} onClick={() => changeTrack(track.id, { solo: !track.solo })}>SOLO</button></div>
          </article>)}
          <article className="mixer-channel master-channel"><div className="channel-top"><span className="master-mark">M</span><strong>MASTER</strong><span className="channel-db">{masterGain === 0 ? "−∞" : `${(20 * Math.log10(masterGain)).toFixed(1)} dB`}</span></div><label className="volume-control"><span>OUT</span><input aria-label="Master volume" type="range" min="0" max="1" step="0.01" value={masterGain} onChange={(event) => setMaster(Number(event.currentTarget.value))} /><output>{Math.round(masterGain * 100)}%</output></label><div className="master-meter large-meter" aria-label={`Master output level ${Math.round(masterLevel * 100)} percent`}><span style={{ width: `${Math.round(masterLevel * 100)}%` }} /></div></article>
        </div>
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
        <div className="edit-tools"><span>Tap ruler to move playhead · drag empty space to scroll</span><button onClick={undoEdit} disabled={undoStackRef.current.length === 0} aria-label="Undo last edit">↶ Undo</button><button onClick={redoEdit} disabled={redoStackRef.current.length === 0} aria-label="Redo last undone edit">↷ Redo</button><button className={snapEnabled ? "tool-active" : ""} aria-pressed={snapEnabled} onClick={() => setSnapEnabled((value) => !value)}>Snap {snapEnabled ? "On" : "Off"}</button><div className="zoom-control" aria-label="Timeline zoom"><button aria-label="Zoom out" onClick={() => setTimelineZoom((value) => Math.max(.5, Math.round((value - .25) * 100) / 100))} disabled={timelineZoom <= .5}>−</button><span>{Math.round(timelineZoom * 100)}%</span><button aria-label="Zoom in" onClick={() => setTimelineZoom((value) => Math.min(2, Math.round((value + .25) * 100) / 100))} disabled={timelineZoom >= 2}>+</button></div><button onClick={splitSelected} disabled={!selectedClip}>Split at playhead</button><button onClick={duplicateSelected} disabled={!selectedClip}>Duplicate</button><button onClick={copySelected} disabled={!selectedClip}>Copy</button><button onClick={pasteClip} disabled={!clipboardClip}>Paste</button><button onClick={removeSelected} disabled={!selectedClip}>Delete clip</button></div>
        {selectedClip && (() => {
          const selected = tracks.flatMap((track) => track.clips.map((clip) => ({ clip, track }))).find((item) => item.clip.id === selectedClip);
          if (!selected) return null;
          const duration = selected.clip.sourceEnd - selected.clip.sourceStart;
          return <div className="clip-inspector" aria-label="Selected clip settings">
            <strong>Selected clip</strong>
            <label>Start (sec)<input aria-label="Clip start time in seconds" type="number" min="0" step={snapEnabled ? BEAT : 0.01} value={Number(selected.clip.start.toFixed(3))} onChange={(event) => setSelectedClipTiming(Number(event.currentTarget.value), duration)} /></label>
            <label>Length (sec)<input aria-label="Clip duration in seconds" type="number" min="0.05" max={selected.clip.sourceEnd - selected.clip.sourceStart + (assets.find((asset) => asset.id === selected.clip.assetId)?.duration ?? 0)} step={snapEnabled ? BEAT : 0.01} value={Number(duration.toFixed(3))} onChange={(event) => setSelectedClipTiming(selected.clip.start, Number(event.currentTarget.value))} /></label>
          </div>;
        })()}
        <div className="timeline-scroll">
          <div className="timeline-inner" style={{ width: timelineWidth }}>
            <div className="ruler" style={{ width: timelineWidth }} onPointerDown={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              seekPlayhead((event.clientX - rect.left) / PX_PER_SECOND);
            }}>
              {Array.from({ length: rulerCount + 1 }, (_, i) => <div className="ruler-mark" key={i} style={{ left: i * 2 * PX_PER_SECOND }}><span>{String(i + 1).padStart(2, "0")}</span></div>)}
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
                    undoStackRef.current.push(tracksRef.current);
                    if (undoStackRef.current.length > 100) undoStackRef.current.shift();
                    redoStackRef.current = [];
                    setHistoryVersion((version) => version + 1);
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setSelectedClip(clip.id);
                  }}
                  onPointerMove={(event) => {
                    const drag = dragRef.current;
                    if (!drag || drag.clipId !== clip.id || !event.buttons) return;
                    const delta = (event.clientX - drag.startX) / PX_PER_SECOND;
                    if (Math.abs(event.clientX - drag.startX) > 3) drag.moved = true;
                    if (drag.mode === "move") updateClip(clip.id, { start: Math.max(0, snapTime(drag.start + delta)) }, false);
                    else if (drag.mode === "left") {
                      const sourceStart = Math.max(0, Math.min(drag.sourceEnd - .05, snapEnabled ? snapTime(drag.sourceStart + delta) : drag.sourceStart + delta));
                      updateClip(clip.id, { sourceStart, start: Math.max(0, drag.start + sourceStart - drag.sourceStart) }, false);
                    } else {
                      const sourceEnd = snapEnabled ? snapTime(drag.sourceEnd + delta) : drag.sourceEnd + delta;
                      updateClip(clip.id, { sourceEnd: Math.max(drag.sourceStart + .05, Math.min(asset.duration, sourceEnd)) }, false);
                    }
                  }}
                  onPointerUp={(event) => {
                    const drag = dragRef.current;
                    if (!drag || drag.clipId !== clip.id) return;
                    const dropTrack = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-track-id]")?.dataset.trackId;
                    if (drag.moved && drag.mode === "move" && dropTrack && dropTrack !== drag.fromTrackId) {
                      const currentTracks = tracksRef.current;
                      const nextTracks = (() => {
                        let movedClip: Clip | undefined;
                        const without = currentTracks.map((item: Track) => ({ ...item, clips: item.clips.filter((candidate: Clip) => {
                          if (candidate.id === clip.id) { movedClip = candidate; return false; }
                          return true;
                        }) }));
                        return without.map((item: Track) => item.id === dropTrack && movedClip ? { ...item, clips: [...item.clips, movedClip] } : item);
                      })();
                      tracksRef.current = nextTracks;
                      setTracks(nextTracks);
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
        <p className="timeline-hint">Horizontal scroll · 4/4 grid · one beat = {BEAT.toFixed(2)}s · {snapEnabled ? "snap to beat enabled" : "free positioning"}. Zoom: {Math.round(timelineZoom * 100)}%.</p>
      </section>

      <footer className="footer"><span><span className="live-dot" /> AUDIO ENGINE READY</span><span className="save-indicator">{saveState === "loading" ? "LOADING PROJECT" : saveState === "saving" ? "SAVING LOCALLY…" : saveState === "error" ? "LOCAL SAVE FAILED" : "SAVED ON DEVICE"}</span><span>MADE FOR THE MOMENT</span></footer>
    </main>
  );
}