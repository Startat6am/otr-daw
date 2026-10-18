import { useEffect, useRef, useState } from "react";
import { loadSavedProject, saveProject, type SavedProject } from "./persistence";
import { timeStretchBuffer } from "./timeStretch";

type ImportedAudio = {
  id: string;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  buffer: AudioBuffer;
  audioData: ArrayBuffer;
  bpm?: number;
};
type Clip = { id: string; assetId: string; start: number; sourceStart: number; sourceEnd: number; tempoBpm?: number; fadeIn?: number; fadeOut?: number };
type Track = { id: string; name: string; clips: Clip[]; gain: number; pan?: number; muted: boolean; solo: boolean };
const DEFAULT_BPM = 120;
const MIN_BPM = 40;
const MAX_BPM = 240;
const BASE_PX_PER_SECOND = 58;
const INITIAL_TRACKS: Track[] = [
  { id: "track-1", name: "Track 1", clips: [], gain: 1, pan: 0, muted: false, solo: false },
  { id: "track-2", name: "Track 2", clips: [], gain: 1, pan: 0, muted: false, solo: false },
];


function detectBpm(buffer: AudioBuffer): number | undefined {
  // Build a lightweight onset envelope at 100 Hz, capped at two minutes.
  const channelCount = buffer.numberOfChannels;
  const hop = Math.max(1, Math.round(buffer.sampleRate / 100));
  const frameCount = Math.min(Math.floor(buffer.length / hop), 12000);
  if (frameCount < 150) return undefined;
  const energy = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * hop;
    const end = Math.min(buffer.length, start + hop);
    let sum = 0;
    for (let channel = 0; channel < channelCount; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    }
    energy[frame] = Math.sqrt(sum / Math.max(1, (end - start) * channelCount));
  }
  const onset = new Float32Array(frameCount);
  let mean = 0;
  for (let i = 1; i < frameCount; i++) {
    onset[i] = Math.max(0, energy[i] - energy[i - 1]);
    mean += onset[i];
  }
  mean /= frameCount;
  if (mean < 0.00002) return undefined;
  let variance = 0;
  for (let i = 0; i < frameCount; i++) {
    onset[i] = Math.max(0, onset[i] - mean * 0.35);
    variance += onset[i] * onset[i];
  }
  if (variance < 1e-8) return undefined;
  let bestLag = 0;
  let bestScore = 0;
  const minLag = Math.floor(6000 / MAX_BPM);
  const maxLag = Math.ceil(6000 / MIN_BPM);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let i = lag; i < frameCount; i++) score += onset[i] * onset[i - lag];
    // Prefer a genuine periodic peak while mildly compensating for longer lags.
    score /= Math.sqrt(frameCount - lag);
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  if (!bestLag || bestScore <= 0) return undefined;
  let detected = Math.round(6000 / bestLag);
  // Bring common half/double-time estimates into a practical musical range.
  while (detected < 70) detected *= 2;
  while (detected > 180) detected /= 2;
  return Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(detected)));
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return minutes + ":" + String(rest).padStart(2, "0");
}
function uid() { return crypto.randomUUID(); }

function bufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}
function base64ToBuffer(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function Waveform({ buffer, sourceStart = 0, sourceEnd = buffer.duration }: { buffer: AudioBuffer; sourceStart?: number; sourceEnd?: number }) {
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
    const rangeStart = Math.max(0, Math.min(channel.length - 1, Math.floor(sourceStart * buffer.sampleRate)));
    const rangeEnd = Math.max(rangeStart + 1, Math.min(channel.length, Math.floor(sourceEnd * buffer.sampleRate)));
    const rangeLength = rangeEnd - rangeStart;
    const samplesPerPixel = Math.max(1, rangeLength / Math.max(1, rect.width));
    const middle = rect.height / 2;
    for (let x = 0; x < rect.width; x++) {
      const start = Math.min(rangeEnd, rangeStart + Math.floor(x * samplesPerPixel));
      const end = Math.min(rangeEnd, Math.max(start + 1, rangeStart + Math.floor((x + 1) * samplesPerPixel)));
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
  }, [buffer, sourceStart, sourceEnd]);
  return <canvas ref={canvasRef} className="waveform" aria-label="Audio waveform" />;
}

function ClipWaveform({ buffer, sourceStart, sourceEnd }: { buffer: AudioBuffer; sourceStart: number; sourceEnd: number }) {
  return <Waveform buffer={buffer} sourceStart={sourceStart} sourceEnd={sourceEnd} />;
}

export default function App() {
  const [assets, setAssets] = useState<ImportedAudio[]>([]);
  const [projectName, setProjectName] = useState("Untitled project");
  const [bpm, setBpm] = useState(DEFAULT_BPM);
  const BEAT = 60 / bpm;
  const [tracks, setTracks] = useState<Track[]>(INITIAL_TRACKS);
  const [status, setStatus] = useState("Import audio, add it to a track, then press play.");
  const [busy, setBusy] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [selectedClip, setSelectedClip] = useState<string | null>(null);
  const [clipInspectorCollapsed, setClipInspectorCollapsed] = useState(false);
  const [clipInspectorPosition, setClipInspectorPosition] = useState<{ x: number; y: number } | null>(null);
  const clipInspectorDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [clipboardClip, setClipboardClip] = useState<{ clip: Clip; trackId: string } | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [gridDivision, setGridDivision] = useState(4);
  const [overlapEnabled, setOverlapEnabled] = useState(true);
  const [trimMode, setTrimMode] = useState(false);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState((60 / DEFAULT_BPM) * 4 * 4);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [trackSidebarCollapsed, setTrackSidebarCollapsed] = useState(false);
  const bpmGestureRef = useRef<{ startY: number; startBpm: number; lastStep: number } | null>(null);
  const gridGestureRef = useRef<{ startY: number; startIndex: number; lastStep: number } | null>(null);
  const timelinePanRef = useRef<{ pointerId: number; startX: number; startScrollLeft: number } | null>(null);
  const [masterGain, setMasterGain] = useState(0.85);
  const [masterLevel, setMasterLevel] = useState(0);
  const masterGainRef = useRef(0.85);
  const mixerNodesRef = useRef<Map<string, GainNode>>(new Map());
  const pannerNodesRef = useRef<Map<string, StereoPannerNode>>(new Map());
  const trackKnobGestureRef = useRef<{ trackId: string; kind: "pan" | "gain"; startY: number; startValue: number; pointerId: number } | null>(null);
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
  const stretchedBuffersRef = useRef<Map<string, AudioBuffer>>(new Map());
  const resumeAfterTempoChangeRef = useRef(false);
  const playingRef = useRef(false);
  const playheadRef = useRef(0);
  const clockStartRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const dragRef = useRef<{ clipId: string; fromTrackId: string; startX: number; start: number; sourceStart: number; sourceEnd: number; mode: "move" | "left" | "right" | "fadeIn" | "fadeOut"; fadeIn: number; fadeOut: number; moved: boolean } | null>(null);

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
              restoredAssets.push({ ...item, audioData, buffer, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, bpm: typeof item.bpm === "number" ? item.bpm : detectBpm(buffer) });
            } catch {
              // Keep the rest of the project available if one stored audio file is no longer decodable.
            }
          }
          if (cancelled) return;
          const restoredTracks = saved.tracks.map((track) => ({ ...track, gain: Number.isFinite(track.gain) ? track.gain : 1, pan: Number.isFinite(track.pan) ? Math.max(-1, Math.min(1, track.pan!)) : 0, muted: Boolean(track.muted), solo: Boolean(track.solo), clips: track.clips.filter((clip) => restoredAssets.some((asset) => asset.id === clip.assetId)) }));
          setAssets(restoredAssets);
          tracksRef.current = restoredTracks;
          setTracks(restoredTracks);
          setSnapEnabled(saved.settings.snapEnabled);
          setBpm(typeof saved.settings.bpm === "number" ? Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(saved.settings.bpm))) : DEFAULT_BPM);

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
        assets: assets.map((asset) => ({ id: asset.id, name: asset.name, duration: asset.duration, sampleRate: asset.sampleRate, channels: asset.channels, audioData: asset.audioData, bpm: asset.bpm })),
        tracks,
        settings: { snapEnabled, timelineZoom, masterGain, bpm },
      };
      void saveProject(project).then(() => setSaveState("saved")).catch((error: unknown) => {
        console.error("Could not save project", error);
        setSaveState("error");
      });
    }, 450);
    return () => { if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current); };
  }, [assets, tracks, snapEnabled, timelineZoom, masterGain, bpm, persistenceReady]);


  async function createNewProject() {
    if ((assets.length || tracks.some((track) => track.clips.length)) && !window.confirm("Create a new project? Export or save your current project first if you want to keep it.")) return;
    stopTransport();
    setAssets([]);
    const freshTracks = INITIAL_TRACKS.map((track) => ({ ...track, id: uid(), clips: [] }));
    tracksRef.current = freshTracks;
    setTracks(freshTracks);
    setProjectName("Untitled project");
    setBpm(DEFAULT_BPM);
    setSnapEnabled(true);
    setGridDivision(4);
    setOverlapEnabled(true);
    setTimelineZoom(1);
    masterGainRef.current = 0.85;
    setMasterGain(0.85);
    setPlayhead(0);
    playheadRef.current = 0;
    setSelectedClip(null);
    setClipboardClip(null);
    undoStackRef.current = [];
    redoStackRef.current = [];
    setHistoryVersion((version) => version + 1);
    setStatus("New project created.");
  }

  async function saveProjectFile() {
    try {
      const project = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        projectName: projectName.trim() || "Untitled project",
        assets: assets.map((asset) => ({ id: asset.id, name: asset.name, duration: asset.duration, sampleRate: asset.sampleRate, channels: asset.channels, audioData: bufferToBase64(asset.audioData), bpm: asset.bpm })),
        tracks,
        settings: { snapEnabled, timelineZoom, masterGain, bpm },
      };
      const blob = new Blob([JSON.stringify(project)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      const safeName = (project.projectName || "project").replace(/[^a-z0-9-_ ]/gi, "").trim().replace(/\s+/g, "-") || "project";
      anchor.download = safeName + ".otr.json";
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus("Project saved to a file.");
    } catch (error) {
      console.error("Could not save project file", error);
      setStatus("Could not save project file.");
    }
  }

  async function loadProjectFile(file: File) {
    try {
      const parsed = JSON.parse(await file.text()) as any;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.assets) || !Array.isArray(parsed.tracks) || !parsed.settings) {
        throw new Error("Invalid project file");
      }
      const context = getContext();
      const restoredAssets: ImportedAudio[] = [];
      for (const item of parsed.assets) {
        if (typeof item.audioData !== "string") throw new Error("Project audio data is missing");
        const audioData = base64ToBuffer(item.audioData);
        const buffer = await context.decodeAudioData(audioData.slice(0));
        restoredAssets.push({ ...item, audioData, buffer, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels });
      }
      const restoredTracks: Track[] = parsed.tracks.map((track: Track) => ({
        ...track,
        gain: Number.isFinite(track.gain) ? track.gain : 1,
        pan: Number.isFinite(track.pan) ? Math.max(-1, Math.min(1, track.pan!)) : 0,
        muted: Boolean(track.muted),
        solo: Boolean(track.solo),
        clips: track.clips.filter((clip) => restoredAssets.some((asset) => asset.id === clip.assetId)),
      }));
      stopTransport();
      setAssets(restoredAssets);
      tracksRef.current = restoredTracks;
      setTracks(restoredTracks);
      setProjectName(parsed.projectName || file.name.replace(/\.otr\.json$/i, "") || "Imported project");
      setBpm(typeof parsed.settings.bpm === "number" ? Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(parsed.settings.bpm))) : DEFAULT_BPM);

      setSnapEnabled(Boolean(parsed.settings.snapEnabled));
      setTimelineZoom(typeof parsed.settings.timelineZoom === "number" ? Math.max(.5, Math.min(2, parsed.settings.timelineZoom)) : 1);
      const restoredMaster = typeof parsed.settings.masterGain === "number" ? Math.max(0, Math.min(1, parsed.settings.masterGain)) : 0.85;
      masterGainRef.current = restoredMaster;
      setMasterGain(restoredMaster);
      setPlayhead(0);
      playheadRef.current = 0;
      setSelectedClip(null);
      setClipboardClip(null);
      undoStackRef.current = [];
      redoStackRef.current = [];
      setHistoryVersion((version) => version + 1);
      setStatus("Project loaded.");
    } catch (error) {
      console.error("Could not load project file", error);
      setStatus("Could not load project. Check that this is a valid .otr.json file.");
    }
  }

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
      let panner = pannerNodesRef.current.get(track.id);
      if (!node || node.context !== context || !panner || panner.context !== context) {
        node = context.createGain();
        panner = context.createStereoPanner();
        node.connect(panner);
        panner.connect(masterNodeRef.current!);
        mixerNodesRef.current.set(track.id, node);
        pannerNodesRef.current.set(track.id, panner);
      }
      const audible = !track.muted && (!soloActive || track.solo);
      node.gain.setTargetAtTime(audible ? track.gain : 0, context.currentTime, 0.015);
      panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, track.pan ?? 0)), context.currentTime, 0.015);
    });
  }
  function changeTrack(trackId: string, change: Partial<Pick<Track, "gain" | "pan" | "muted" | "solo">>) {
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
  async function scheduleFrom(position: number, context: AudioContext) {
    stopSources();
    ensureMixer(context, tracksRef.current);
    const looping = loopEnabled && loopEnd > loopStart;
    const playbackLimit = looping ? loopEnd : Number.POSITIVE_INFINITY;
    const startAt = context.currentTime + (looping ? .01 : .08);
    clockStartRef.current = startAt;
    playheadRef.current = position;
    for (const track of tracksRef.current) for (const clip of track.clips) {
      const asset = assets.find((item) => item.id === clip.assetId);
      if (!asset) continue;
      const sourceDuration = clip.sourceEnd - clip.sourceStart;
      const sourceTempo = clip.tempoBpm ?? DEFAULT_BPM;
      const stretchRatio = Math.max(0.25, Math.min(4, sourceTempo / bpm));
      const clipDuration = sourceDuration * stretchRatio;
      const clipEnd = clip.start + clipDuration;
      if (clipEnd <= position) continue;
      const elapsed = Math.max(0, position - clip.start);
      const cacheKey = `${clip.id}:${clip.sourceStart}:${clip.sourceEnd}:${bpm}:${asset.id}`;
      let stretched = stretchedBuffersRef.current.get(cacheKey);
      if (!stretched) {
        const startFrame = Math.max(0, Math.floor(clip.sourceStart * asset.buffer.sampleRate));
        const endFrame = Math.min(asset.buffer.length, Math.max(startFrame + 1, Math.floor(clip.sourceEnd * asset.buffer.sampleRate)));
        const segment = context.createBuffer(asset.buffer.numberOfChannels, endFrame - startFrame, asset.buffer.sampleRate);
        for (let channel = 0; channel < asset.buffer.numberOfChannels; channel++) segment.copyToChannel(asset.buffer.getChannelData(channel).subarray(startFrame, endFrame), channel);
        stretched = timeStretchBuffer(segment, stretchRatio, context);
        stretchedBuffersRef.current.set(cacheKey, stretched);
      }
      const offset = elapsed;
      const duration = Math.min(clipDuration - elapsed, playbackLimit - Math.max(position, clip.start));
      if (duration <= 0) continue;
      const source = context.createBufferSource();
      source.buffer = stretched;
      const trackGain = mixerNodesRef.current.get(track.id);
      if (!trackGain) return;
      const fadeInGain = context.createGain();
      const fadeOutGain = context.createGain();
      source.connect(fadeInGain);
      fadeInGain.connect(fadeOutGain);
      fadeOutGain.connect(trackGain);
      const scheduledAt = startAt + Math.max(0, clip.start - position);
      const fadeIn = Math.min(clipDuration, Math.max(0, (clip.fadeIn ?? 0) * stretchRatio));
      const fadeOut = Math.min(clipDuration, Math.max(0, (clip.fadeOut ?? 0) * stretchRatio));
      if (fadeIn > elapsed) {
        fadeInGain.gain.setValueAtTime(Math.max(0, elapsed / fadeIn), scheduledAt);
        fadeInGain.gain.linearRampToValueAtTime(1, scheduledAt + fadeIn - elapsed);
      } else {
        fadeInGain.gain.setValueAtTime(1, scheduledAt);
      }
      if (fadeOut > 0 && elapsed > clipDuration - fadeOut) {
        fadeOutGain.gain.setValueAtTime(Math.max(0, (clipDuration - elapsed) / fadeOut), scheduledAt);
        fadeOutGain.gain.linearRampToValueAtTime(0, scheduledAt + duration);
      } else {
        fadeOutGain.gain.setValueAtTime(1, scheduledAt);
        if (fadeOut > 0) {
          const fadeOutStart = scheduledAt + Math.max(0, clipDuration - fadeOut - elapsed);
          fadeOutGain.gain.setValueAtTime(1, fadeOutStart);
          fadeOutGain.gain.linearRampToValueAtTime(0, scheduledAt + duration);
        }
      }
      sourcesRef.current.push(source);
      source.start(scheduledAt, offset, duration);
    }
    playingRef.current = true;
    setIsPlaying(true);
  }
  useEffect(() => {
    if (!resumeAfterTempoChangeRef.current || !contextRef.current) return;
    resumeAfterTempoChangeRef.current = false;
    void scheduleFrom(playheadRef.current, contextRef.current);
  }, [bpm]);

  async function toggleTransport() {
    const context = getContext();
    if (playingRef.current) { pauseTransport(); return; }
    if (context.state === "suspended") await context.resume();
    const maxEnd = Math.max(0, ...tracks.flatMap((track) => track.clips.map((clip) => clip.start + clipTimelineDuration(clip))));
    if (playheadRef.current >= maxEnd && maxEnd > 0) {
      playheadRef.current = 0;
      setPlayhead(0);
    }
    if (maxEnd === 0) {
      setStatus("Add an audio clip to a track before pressing play.");
      return;
    }
    await scheduleFrom(playheadRef.current, context);
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
    if (playingRef.current && context) void scheduleFrom(next, context);
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
        if (loopEnabled && loopEnd > loopStart && position >= loopEnd) {
          playheadRef.current = loopStart;
          setPlayhead(loopStart);
          void scheduleFrom(loopStart, context);
        } else {
          setPlayhead(position);
          const end = Math.max(0, ...tracks.flatMap((track) => track.clips.map((clip) => clip.start + clipTimelineDuration(clip))));
          if (!(loopEnabled && loopEnd > loopStart) && end > 0 && position >= end) {
            playingRef.current = false;
            setIsPlaying(false);
            stopSources();
            playheadRef.current = 0;
            setPlayhead(0);
            return;
          }
        }
      }
      frame = requestAnimationFrame(tick);
      rafRef.current = frame;
    };
    frame = requestAnimationFrame(tick);
    rafRef.current = frame;
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, tracks, loopEnabled, loopStart, loopEnd]);

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
        const detectedBpm = detectBpm(buffer);
        imported.push({ id: uid(), name: file.name, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, buffer, audioData, bpm: detectedBpm });
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
  function addTrack() {
    if (tracksRef.current.length >= 16) {
      setStatus("Track limit reached (16 tracks).");
      return;
    }
    const nextNumber = tracksRef.current.reduce((max, track) => {
      const match = track.name.match(/^(?:Track|Дорожка)\\s+(\\d+)$/i);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1;
    const track: Track = { id: uid(), name: "Track " + nextNumber, clips: [], gain: 1, muted: false, solo: false };
    commitTracks((current) => [...current, track]);
    setStatus(track.name + " added.");
  }
  function renameTrack(trackId: string) {
    const track = tracksRef.current.find((item) => item.id === trackId);
    if (!track) return;
    const answer = window.prompt("Track name", track.name);
    if (answer === null) return;
    const name = answer.trim().slice(0, 40);
    if (!name) {
      setStatus("Track name cannot be empty.");
      return;
    }
    commitTracks((current) => current.map((item) => item.id === trackId ? { ...item, name } : item));
    setStatus("Track renamed to " + name + ".");
  }
  function removeTrack(trackId: string) {
    const current = tracksRef.current;
    if (current.length <= 1) {
      setStatus("Keep at least one track in the project.");
      return;
    }
    const track = current.find((item) => item.id === trackId);
    if (!track) return;
    if (track.clips.length && !window.confirm('Delete "' + track.name + '" and its ' + track.clips.length + ' clip(s)?')) return;
    commitTracks((items) => items.filter((item) => item.id !== trackId));
    if (track.clips.some((clip) => clip.id === selectedClip)) setSelectedClip(null);
    if (clipboardClip?.trackId === trackId) setClipboardClip(null);
    mixerNodesRef.current.delete(trackId);
    pannerNodesRef.current.delete(trackId);
    setStatus(track.name + " removed.");
  }

  function addClip(asset: ImportedAudio, trackId: string) {
    const clip: Clip = { id: uid(), assetId: asset.id, start: 0, sourceStart: 0, sourceEnd: asset.duration, tempoBpm: asset.bpm ?? bpm };
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
    updateClip(clip.id, { start: Math.max(0, snapTime(clip.start + amount * BEAT * 4 / gridDivision)) });
  }
  function snapTime(seconds: number) {
    const gridStep = BEAT * 4 / gridDivision;
    return snapEnabled ? Math.round(seconds / gridStep) * gridStep : seconds;
  }
  function moveStartWithoutOverlap(clipId: string, trackId: string, proposedStart: number, direction: number) {
    const startAt = Math.max(0, proposedStart);
    if (overlapEnabled) return startAt;
    const track = tracksRef.current.find((item) => item.id === trackId);
    const clip = track?.clips.find((item) => item.id === clipId);
    if (!track || !clip) return startAt;

    // Use timeline durations (including tempo stretch), not raw source seconds.
    const duration = clipTimelineDuration(clip);
    const others = track.clips
      .filter((item) => item.id !== clipId)
      .sort((a, b) => a.start - b.start);
    let start = startAt;

    // Scan in the direction of travel so multiple neighboring clips cannot
    // push the dragged clip back into an overlap that was already checked.
    const ordered = direction < 0 ? [...others].reverse() : others;
    for (const other of ordered) {
      const otherEnd = other.start + clipTimelineDuration(other);
      const overlaps = start < otherEnd - 0.001 && start + duration > other.start + 0.001;
      if (overlaps) {
        start = direction < 0
          ? Math.max(0, other.start - duration)
          : otherEnd;
      }
    }
    return Math.max(0, start);
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
      const left = { ...clip, sourceEnd: cut, fadeOut: 0 };
      const right: Clip = { ...clip, id: uid(), start: playhead, sourceStart: cut, fadeIn: 0 };
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
    const duration = clipTimelineDuration(selected.clip);
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
    const ratio = (selected.clip.tempoBpm ?? DEFAULT_BPM) / bpm;
    const sourceLength = Math.max(0.05, Math.min(asset.duration - selected.clip.sourceStart, (Number.isFinite(duration) ? duration : 0.05) / ratio));
    updateClip(selected.clip.id, { start: safeStart, sourceEnd: selected.clip.sourceStart + sourceLength });
  }

  const clipTimelineDuration = (clip: Clip) => (clip.sourceEnd - clip.sourceStart) * ((clip.tempoBpm ?? DEFAULT_BPM) / bpm);
  const maxEnd = Math.max(16, ...tracks.flatMap((track) => track.clips.map((clip) => clip.start + clipTimelineDuration(clip) + 2)));
  const timelineWidth = maxEnd * PX_PER_SECOND;
  const rulerCount = Math.ceil(maxEnd / (BEAT * 4));
  function applyBpm(value: number) {
    const next = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(value)));
    if (next === bpm) return;
    const wasPlaying = playingRef.current;
    if (wasPlaying && contextRef.current) {
      const context = contextRef.current;
      playheadRef.current = Math.max(0, playheadRef.current + context.currentTime - clockStartRef.current);
      setPlayhead(playheadRef.current);
      playingRef.current = false;
      setIsPlaying(false);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      stopSources();
    }
    resumeAfterTempoChangeRef.current = wasPlaying;
    const beatScale = next / bpm;
    setLoopStart((value) => value * beatScale);
    setLoopEnd((value) => value * beatScale);
    setBpm(next);
    stretchedBuffersRef.current.clear();
  }
  function startTrackKnob(event: React.PointerEvent<HTMLDivElement>, trackId: string, kind: "pan" | "gain", value: number) {
    event.preventDefault();
    event.stopPropagation();
    trackKnobGestureRef.current = { trackId, kind, startY: event.clientY, startValue: value, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveTrackKnob(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = trackKnobGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const delta = (gesture.startY - event.clientY) / 90;
    const value = gesture.kind === "pan"
      ? Math.max(-1, Math.min(1, gesture.startValue + delta * 2))
      : Math.max(0, Math.min(1, gesture.startValue + delta));
    changeTrack(gesture.trackId, gesture.kind === "pan" ? { pan: Math.round(value * 100) / 100 } : { gain: Math.round(value * 100) / 100 });
  }
  function endTrackKnob(event: React.PointerEvent<HTMLDivElement>) {
    if (trackKnobGestureRef.current?.pointerId === event.pointerId) trackKnobGestureRef.current = null;
  }

  function onBpmWheelStart(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    bpmGestureRef.current = { startY: event.clientY, startBpm: bpm, lastStep: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function onBpmWheelMove(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = bpmGestureRef.current;
    if (!gesture) return;
    const step = Math.trunc((gesture.startY - event.clientY) / 8);
    if (step !== gesture.lastStep) {
      gesture.lastStep = step;
      applyBpm(gesture.startBpm + step);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="On The Run home"><span className="brand-mark">OTR</span><span>on the run<span className="brand-dot">.</span></span></a>
        <div className="project-actions">
          <input className="project-name-input" aria-label="Project name" value={projectName} onChange={(event) => setProjectName(event.currentTarget.value)} />
          <div className="project-icon-actions">
            <button className="icon-action" title="New project" aria-label="New project" onClick={() => void createNewProject()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
            <button className="icon-action" title="Save project to file" aria-label="Save project to file" onClick={() => void saveProjectFile()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h12l4 4v14H3V3h2Z" /><path d="M7 3v6h10V3M7 21v-7h10v7" /></svg></button>
            <label className="project-load-button icon-action" title="Load project from file" aria-label="Load project from file"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h7l2 2H21v11H3z" /><path d="M12 17V11m-3 3 3-3 3 3" /></svg><input aria-label="Load project file" type="file" accept=".json,.otr.json,application/json" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void loadProjectFile(file); event.currentTarget.value = ""; }} /></label>
          </div>
        </div>
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
              <div className="asset-title"><strong title={asset.name}>{asset.name}</strong><span>{formatTime(asset.duration)} · {asset.sampleRate.toLocaleString()} Hz · {asset.channels} ch · {asset.bpm ? `BPM ~${asset.bpm}` : "BPM —"}</span></div>
            </div>
            <div className="asset-actions">{tracks.map((track) => <button className="add-clip-button" key={track.id} onClick={() => addClip(asset, track.id)}>+ {track.name}</button>)}</div>
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
          <div><p className="eyebrow">ARRANGEMENT</p><h2>Timeline</h2></div><button className="add-track-button" onClick={addTrack} disabled={tracks.length >= 16}>＋ Add track</button>
        </div>
        <div className="edit-tools"><span>Tap ruler to move playhead · drag empty space to scroll</span><button onClick={undoEdit} disabled={undoStackRef.current.length === 0} aria-label="Undo last edit">↶ Undo</button><button onClick={redoEdit} disabled={redoStackRef.current.length === 0} aria-label="Redo last undone edit">↷ Redo</button><button className={snapEnabled ? "tool-active" : ""} aria-pressed={snapEnabled} onClick={() => setSnapEnabled((value) => !value)}>Snap {snapEnabled ? "On" : "Off"}</button><button className={overlapEnabled ? "tool-active" : ""} aria-pressed={overlapEnabled} onClick={() => setOverlapEnabled((value) => !value)}>Overlap {overlapEnabled ? "On" : "Off"}</button><button className={trimMode ? "tool-active" : ""} aria-pressed={trimMode} onClick={() => setTrimMode((value) => !value)}>✂ Trim {trimMode ? "On" : "Off"}</button><button onClick={() => { const next = snapTime(playhead); const step = BEAT * 4 / gridDivision; setLoopStart(next); if (next >= loopEnd) setLoopEnd(next + step); setStatus("Loop start set at playhead."); }}>Loop start</button><button onClick={() => { const next = snapTime(playhead); setLoopEnd(Math.max(next, loopStart + BEAT * 4 / gridDivision)); setStatus("Loop end set at playhead."); }}>Loop end</button><span className="loop-readout">{formatTime(loopStart)}–{formatTime(loopEnd)}</span><div className="zoom-control" aria-label="Timeline zoom"><button aria-label="Zoom out" onClick={() => setTimelineZoom((value) => Math.max(.5, Math.round((value - .25) * 100) / 100))} disabled={timelineZoom <= .5}>−</button><span>{Math.round(timelineZoom * 100)}%</span><button aria-label="Zoom in" onClick={() => setTimelineZoom((value) => Math.min(2, Math.round((value + .25) * 100) / 100))} disabled={timelineZoom >= 2}>+</button></div><button onClick={splitSelected} disabled={!selectedClip}>Split at playhead</button><button onClick={duplicateSelected} disabled={!selectedClip}>Duplicate</button><button onClick={copySelected} disabled={!selectedClip}>Copy</button><button onClick={pasteClip} disabled={!clipboardClip}>Paste</button><button onClick={removeSelected} disabled={!selectedClip}>Delete clip</button></div>
        <div className="playback-bpm-panel"><div className="bpm-control"><span>BPM</span><div className="bpm-wheel" role="slider" tabIndex={0} aria-label="Tempo BPM: swipe up or down to change" aria-valuemin={MIN_BPM} aria-valuemax={MAX_BPM} aria-valuenow={bpm} onPointerDown={onBpmWheelStart} onPointerMove={onBpmWheelMove} onPointerUp={() => { bpmGestureRef.current = null; }} onPointerCancel={() => { bpmGestureRef.current = null; }} onKeyDown={(event) => { if (event.key === "ArrowUp") { event.preventDefault(); applyBpm(bpm + 1); } else if (event.key === "ArrowDown") { event.preventDefault(); applyBpm(bpm - 1); } else if (event.key === "PageUp") { event.preventDefault(); applyBpm(bpm + 5); } else if (event.key === "PageDown") { event.preventDefault(); applyBpm(bpm - 5); } }}><strong>{bpm}</strong></div><div className="transport transport-inline" aria-label="Playback controls"><button className="transport-button" onClick={stopTransport} aria-label="Stop playback">■</button><button className="transport-button play-button" onClick={() => void toggleTransport()} aria-label={isPlaying ? "Pause playback" : "Start playback"}>{isPlaying ? "Ⅱ" : "▶"}</button><button className={`transport-button loop-toggle${loopEnabled ? " tool-active" : ""}`} aria-label={loopEnabled ? "Disable loop" : "Enable loop"} title={loopEnabled ? "Loop on" : "Loop off"} aria-pressed={loopEnabled} onClick={() => setLoopEnabled((value) => !value)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg></button><span className="time-readout">{formatTime(playhead)}</span><div className="grid-wheel" role="slider" tabIndex={0} aria-label={`Grid division 1/${gridDivision}; swipe up or down to change`} aria-valuemin={0} aria-valuemax={4} aria-valuenow={[2,4,8,16,32].indexOf(gridDivision)} onPointerDown={(event) => { event.preventDefault(); gridGestureRef.current = { startY: event.clientY, startIndex: [2,4,8,16,32].indexOf(gridDivision), lastStep: 0 }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { const gesture = gridGestureRef.current; if (!gesture) return; const step = Math.trunc((gesture.startY - event.clientY) / 12); if (step !== gesture.lastStep) { gesture.lastStep = step; setGridDivision([2,4,8,16,32][Math.max(0, Math.min(4, gesture.startIndex + step))]); } }} onPointerUp={() => { gridGestureRef.current = null; }} onPointerCancel={() => { gridGestureRef.current = null; }} onKeyDown={(event) => { const divisions = [2,4,8,16,32]; const index = divisions.indexOf(gridDivision); if (event.key === "ArrowUp" || event.key === "ArrowRight") { event.preventDefault(); setGridDivision(divisions[Math.min(4,index+1)]); } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") { event.preventDefault(); setGridDivision(divisions[Math.max(0,index-1)]); } }}><span className="grid-wheel-label">GRID</span><strong>1/{gridDivision}</strong></div></div></div></div>
        {selectedClip && (() => {
          const selected = tracks.flatMap((track) => track.clips.map((clip) => ({ clip, track }))).find((item) => item.clip.id === selectedClip);
          if (!selected) return null;
          const duration = clipTimelineDuration(selected.clip);
          return <div className={`clip-inspector${clipInspectorCollapsed ? " clip-inspector-collapsed" : ""}`} aria-label="Selected clip settings" style={clipInspectorPosition ? { left: clipInspectorPosition.x, top: clipInspectorPosition.y, right: "auto" } : undefined}>
            <div className="clip-inspector-header"
              onPointerDown={(event) => {
                if ((event.target as HTMLElement).closest("button")) return;
                const panel = event.currentTarget.closest(".timeline-panel") as HTMLElement | null;
                const inspector = event.currentTarget.parentElement;
                if (!panel || !inspector) return;
                const panelRect = panel.getBoundingClientRect();
                const rect = inspector.getBoundingClientRect();
                const originX = rect.left - panelRect.left;
                const originY = rect.top - panelRect.top;
                clipInspectorDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX, originY };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = clipInspectorDragRef.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                const panel = event.currentTarget.closest(".timeline-panel") as HTMLElement | null;
                const inspector = event.currentTarget.parentElement;
                if (!panel || !inspector) return;
                const maxX = Math.max(0, panel.clientWidth - inspector.offsetWidth);
                const maxY = Math.max(0, panel.clientHeight - 38);
                setClipInspectorPosition({
                  x: Math.max(0, Math.min(maxX, drag.originX + event.clientX - drag.startX)),
                  y: Math.max(0, Math.min(maxY, drag.originY + event.clientY - drag.startY)),
                });
              }}
              onPointerUp={(event) => { if (clipInspectorDragRef.current?.pointerId === event.pointerId) clipInspectorDragRef.current = null; }}
              onPointerCancel={() => { clipInspectorDragRef.current = null; }}
            >
              <strong>Selected clip</strong>
              <button className="clip-inspector-collapse" type="button" aria-label={clipInspectorCollapsed ? "Expand clip settings" : "Collapse clip settings"} title={clipInspectorCollapsed ? "Expand" : "Collapse"} onPointerDown={(event) => event.stopPropagation()} onClick={() => setClipInspectorCollapsed((value) => !value)}>{clipInspectorCollapsed ? "▢" : "−"}</button>
              <button className="clip-inspector-close" type="button" aria-label="Close clip settings" title="Close" onPointerDown={(event) => event.stopPropagation()} onClick={() => { setSelectedClip(null); setClipInspectorCollapsed(false); setClipInspectorPosition(null); }}>×</button>
            </div>
            {!clipInspectorCollapsed && <>
              <label>Start (sec)<input aria-label="Clip start time in seconds" type="number" min="0" step={snapEnabled ? BEAT * 4 / gridDivision : 0.01} value={Number(selected.clip.start.toFixed(3))} onChange={(event) => setSelectedClipTiming(Number(event.currentTarget.value), duration)} /></label>
              <label>Length (sec)<input aria-label="Clip duration in seconds" type="number" min="0.05" max={selected.clip.sourceEnd - selected.clip.sourceStart + (assets.find((asset) => asset.id === selected.clip.assetId)?.duration ?? 0)} step={snapEnabled ? BEAT * 4 / gridDivision : 0.01} value={Number(duration.toFixed(3))} onChange={(event) => setSelectedClipTiming(selected.clip.start, Number(event.currentTarget.value))} /></label>
              <label>Fade In (sec)<input aria-label="Clip fade in duration in seconds" type="number" min="0" max={duration} step="0.05" value={Number(Math.min(duration, selected.clip.fadeIn ?? 0).toFixed(2))} onChange={(event) => updateClip(selected.clip.id, { fadeIn: Math.max(0, Math.min(duration, Number(event.currentTarget.value) || 0)) })} /></label>
              <label>Fade Out (sec)<input aria-label="Clip fade out duration in seconds" type="number" min="0" max={duration} step="0.05" value={Number(Math.min(duration, selected.clip.fadeOut ?? 0).toFixed(2))} onChange={(event) => updateClip(selected.clip.id, { fadeOut: Math.max(0, Math.min(duration, Number(event.currentTarget.value) || 0)) })} /></label>
            </>}
          </div>;
        })()}
        <div className={"timeline-scroll " + (trackSidebarCollapsed ? "sidebar-collapsed" : "sidebar-expanded")}
          onClick={(event) => {
            const target = event.target as HTMLElement;
            if (target.closest(".ruler, .timeline-clip, .track-label, button, input, select, label")) return;
            setSelectedClip(null);
          }}
          onPointerDown={(event) => {
            const target = event.target as HTMLElement;
            if (target.closest(".ruler, .timeline-clip, .track-label, button, input, select, label")) return;
            setSelectedClip(null);
            timelinePanRef.current = { pointerId: event.pointerId, startX: event.clientX, startScrollLeft: event.currentTarget.scrollLeft };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const pan = timelinePanRef.current;
            if (!pan || pan.pointerId !== event.pointerId) return;
            event.currentTarget.scrollLeft = pan.startScrollLeft - (event.clientX - pan.startX);
          }}
          onPointerUp={(event) => { if (timelinePanRef.current?.pointerId === event.pointerId) timelinePanRef.current = null; }}
          onPointerCancel={() => { timelinePanRef.current = null; }}>
          <div className="timeline-inner" style={{ width: timelineWidth + (trackSidebarCollapsed ? 24 : (window.innerWidth <= 520 ? 107 : 135)) }}>
            <div className="timeline-gutter"><button className="sidebar-toggle" type="button" aria-label={trackSidebarCollapsed ? "Expand track sidebar" : "Collapse track sidebar"} title={trackSidebarCollapsed ? "Expand track sidebar" : "Collapse track sidebar"} onClick={() => setTrackSidebarCollapsed((value) => !value)}>{trackSidebarCollapsed ? "›" : "‹"}</button></div><div className="ruler" style={{ width: timelineWidth }} onPointerDown={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              seekPlayhead((event.clientX - rect.left) / PX_PER_SECOND);
            }}>
              {loopEnd > loopStart && <div className={loopEnabled ? "loop-range loop-range-active" : "loop-range"} style={{ left: loopStart * PX_PER_SECOND, width: Math.max(2, (loopEnd - loopStart) * PX_PER_SECOND) }} aria-label={`Loop range from ${formatTime(loopStart)} to ${formatTime(loopEnd)}`} />}
              <div className="loop-marker loop-marker-start" style={{ left: loopStart * PX_PER_SECOND }} title={`Loop start ${formatTime(loopStart)}`}><span>IN</span></div>
              <div className="loop-marker loop-marker-end" style={{ left: loopEnd * PX_PER_SECOND }} title={`Loop end ${formatTime(loopEnd)}`}><span>OUT</span></div>
              {Array.from({ length: rulerCount + 1 }, (_, i) => <div className="ruler-mark" key={i} style={{ left: i * BEAT * 4 * PX_PER_SECOND }}><span>{String(i + 1).padStart(2, "0")}</span></div>)}
            </div>
            {tracks.map((track) => <div className="timeline-track" data-track-id={track.id} key={track.id} style={{ width: timelineWidth, backgroundImage: `repeating-linear-gradient(to right, #252a28 0, #252a28 1px, transparent 1px, transparent ${Math.max(1, BEAT * 4 / gridDivision * PX_PER_SECOND)}px)` }}>
              <div className="track-label"><span title={track.name}>{trackSidebarCollapsed ? String(tracks.findIndex((item) => item.id === track.id) + 1).padStart(2, "0") : track.name}</span>{!trackSidebarCollapsed && <div className="track-mini-controls"><div className="track-knob-wrap"><div className="track-knob pan-knob" role="slider" tabIndex={0} aria-label={track.name + " pan"} aria-valuemin={-100} aria-valuemax={100} aria-valuenow={Math.round((track.pan ?? 0) * 100)} title={`PAN ${Math.round((track.pan ?? 0) * 100)}`} style={{ "--knob-angle": `${(track.pan ?? 0) * 135}deg` } as React.CSSProperties} onPointerDown={(event) => startTrackKnob(event, track.id, "pan", track.pan ?? 0)} onPointerMove={moveTrackKnob} onPointerUp={endTrackKnob} onPointerCancel={endTrackKnob} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowDown") { event.preventDefault(); changeTrack(track.id, { pan: Math.max(-1, (track.pan ?? 0) - .05) }); } else if (event.key === "ArrowRight" || event.key === "ArrowUp") { event.preventDefault(); changeTrack(track.id, { pan: Math.min(1, (track.pan ?? 0) + .05) }); } }}><span /></div><small>PAN</small></div><div className="track-knob-wrap"><div className="track-knob volume-knob" role="slider" tabIndex={0} aria-label={track.name + " volume"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(track.gain * 100)} title={`VOL ${Math.round(track.gain * 100)}%`} style={{ "--knob-angle": `${-135 + track.gain * 270}deg` } as React.CSSProperties} onPointerDown={(event) => startTrackKnob(event, track.id, "gain", track.gain)} onPointerMove={moveTrackKnob} onPointerUp={endTrackKnob} onPointerCancel={endTrackKnob} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowLeft") { event.preventDefault(); changeTrack(track.id, { gain: Math.max(0, track.gain - .05) }); } else if (event.key === "ArrowUp" || event.key === "ArrowRight") { event.preventDefault(); changeTrack(track.id, { gain: Math.min(1, track.gain + .05) }); } }}><span /></div><small>VOL</small></div></div>}<div className="track-label-actions"><button type="button" title={"Rename " + track.name} aria-label={"Rename " + track.name} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); renameTrack(track.id); }}>✎</button><button type="button" title={"Delete " + track.name} aria-label={"Delete " + track.name} disabled={tracks.length <= 1} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); removeTrack(track.id); }}>×</button></div></div>
              {track.clips.map((clip) => {
                const asset = assets.find((item) => item.id === clip.assetId);
                if (!asset) return null;
                const duration = clipTimelineDuration(clip);
                return <div key={clip.id} className={"timeline-clip " + (selectedClip === clip.id ? "selected " : "") + (dragRef.current?.clipId === clip.id ? "is-dragging" : "")} style={{ left: clip.start * PX_PER_SECOND, width: Math.max(34, duration * PX_PER_SECOND) }} onClick={() => setSelectedClip(clip.id)} role="button" tabIndex={0} aria-label={"Select clip " + asset.name} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedClip(clip.id); }}
                  onPointerDown={(event) => {
                    const target = event.target as HTMLElement;
                    const edge = target.closest<HTMLElement>("[data-edge]")?.dataset.edge;
                    const fade = target.closest<HTMLElement>("[data-fade]")?.dataset.fade;
                    dragRef.current = { clipId: clip.id, fromTrackId: track.id, startX: event.clientX, start: clip.start, sourceStart: clip.sourceStart, sourceEnd: clip.sourceEnd, fadeIn: clip.fadeIn ?? 0, fadeOut: clip.fadeOut ?? 0, mode: fade === "fadeIn" || fade === "fadeOut" ? fade : trimMode && (edge === "left" || edge === "right") ? edge : "move", moved: false };
                    undoStackRef.current.push(tracksRef.current);
                    if (undoStackRef.current.length > 100) undoStackRef.current.shift();
                    redoStackRef.current = [];
                    setHistoryVersion((version) => version + 1);
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setSelectedClip(clip.id);
                  }}
                  onPointerMove={(event) => {
                    const drag = dragRef.current;
                    if (!drag || drag.clipId !== clip.id) return;
                    const delta = (event.clientX - drag.startX) / PX_PER_SECOND;
                    if (Math.abs(event.clientX - drag.startX) > 3) drag.moved = true;
                    if (drag.mode === "fadeIn") {
                      updateClip(clip.id, { fadeIn: Math.max(0, Math.min(clip.sourceEnd - clip.sourceStart, drag.fadeIn + delta)) }, false);
                    } else if (drag.mode === "fadeOut") {
                      updateClip(clip.id, { fadeOut: Math.max(0, Math.min(clip.sourceEnd - clip.sourceStart, drag.fadeOut - delta)) }, false);
                    } else if (drag.mode === "move") {
                      const proposed = Math.max(0, snapTime(drag.start + delta));
                      const start = moveStartWithoutOverlap(clip.id, drag.fromTrackId, proposed, delta);
                      updateClip(clip.id, { start }, false);
                    }
                    else if (drag.mode === "left") {
                      const ratio = (clip.tempoBpm ?? DEFAULT_BPM) / bpm;
                      const timelineDelta = snapEnabled ? snapTime(drag.start + delta) - drag.start : delta;
                      const sourceStart = Math.max(drag.sourceStart, Math.min(drag.sourceEnd - .05, drag.sourceStart + timelineDelta / ratio));
                      const actualDelta = (sourceStart - drag.sourceStart) * ratio;
                      updateClip(clip.id, { sourceStart, start: Math.max(0, drag.start + actualDelta) }, false);
                    } else {
                      const ratio = (clip.tempoBpm ?? DEFAULT_BPM) / bpm;
                      const proposedEnd = drag.start + (drag.sourceEnd - drag.sourceStart) * ratio + delta;
                      const snappedEnd = snapEnabled ? snapTime(proposedEnd) : proposedEnd;
                      const sourceEnd = drag.sourceStart + Math.max(.05 * ratio, snappedEnd - drag.start) / ratio;
                      updateClip(clip.id, { sourceEnd: Math.max(drag.sourceStart + .05, Math.min(drag.sourceEnd, asset.duration, sourceEnd)) }, false);
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
                        return without.map((item: Track) => {
                          if (item.id !== dropTrack || !movedClip) return item;
                          let placed = movedClip;
                          if (!overlapEnabled) {
                            const duration = placed.sourceEnd - placed.sourceStart;
                            const conflicts = item.clips.filter((other: Clip) => placed.start < other.start + other.sourceEnd - other.sourceStart - 0.001 && placed.start + duration * ((placed.tempoBpm ?? DEFAULT_BPM) / bpm) > other.start + 0.001);
                            if (conflicts.length) {
                              const direction = placed.start >= clip.start ? 1 : -1;
                              const edge = direction >= 0 ? Math.max(...conflicts.map((other: Clip) => other.start + (other.sourceEnd - other.sourceStart) * ((other.tempoBpm ?? DEFAULT_BPM) / bpm))) : Math.max(0, Math.min(...conflicts.map((other: Clip) => other.start)) - duration);
                              placed = { ...placed, start: edge };
                            }
                          }
                          return { ...item, clips: [...item.clips, placed] };
                        });
                      })();
                      tracksRef.current = nextTracks;
                      setTracks(nextTracks);
                      setStatus("Clip moved to another track.");
                    }
                    dragRef.current = null;
                  }}
                  onPointerCancel={() => { dragRef.current = null; }}>
                  {selectedClip === clip.id && <>
                    <span className="fade-shade fade-in-shade" style={{ width: `${Math.min(100, Math.max(0, (clip.fadeIn ?? 0) / duration * 100))}%` }} />
                    <span className="fade-shade fade-out-shade" style={{ width: `${Math.min(100, Math.max(0, (clip.fadeOut ?? 0) / duration * 100))}%` }} />
                    <span className="fade-handle fade-in-handle" data-fade="fadeIn" style={{ left: `${Math.min(100, Math.max(0, (clip.fadeIn ?? 0) / duration * 100))}%` }} title="Drag to adjust Fade In" aria-label="Adjust fade in" />
                    <span className="fade-handle fade-out-handle" data-fade="fadeOut" style={{ right: `${Math.min(100, Math.max(0, (clip.fadeOut ?? 0) / duration * 100))}%` }} title="Drag to adjust Fade Out" aria-label="Adjust fade out" />
                  </>}
                  <span className={"trim-handle trim-left " + (trimMode ? "trim-enabled" : "trim-disabled")} data-edge="left" aria-label={trimMode ? "Trim clip start" : "Move clip from start edge"} />
                  <strong>{asset.name}</strong><div className="clip-wave"><ClipWaveform buffer={asset.buffer} sourceStart={clip.sourceStart} sourceEnd={clip.sourceEnd} /></div>
                  <span className={"trim-handle trim-right " + (trimMode ? "trim-enabled" : "trim-disabled")} data-edge="right" aria-label={trimMode ? "Trim clip end" : "Move clip from end edge"} />
                  {selectedClip === clip.id && <div className="clip-nudges"><button onClick={(event) => { event.stopPropagation(); nudgeClip(clip, -1); }}>− grid</button><button onClick={(event) => { event.stopPropagation(); nudgeClip(clip, 1); }}>+ grid</button></div>}
                </div>;
              })}
            </div>)}
            <div className="playhead" style={{ left: playhead * PX_PER_SECOND + (trackSidebarCollapsed ? 24 : (window.innerWidth <= 520 ? 107 : 135)) }} />
          </div>
        </div>
        <p className="timeline-hint">Horizontal scroll · 4/4 grid · one beat = {BEAT.toFixed(2)}s · {snapEnabled ? "snap 1/" + gridDivision : "free positioning"} · trim {trimMode ? "enabled (destructive)" : "disabled"} · loop {loopEnabled ? "enabled" : "disabled"}. Zoom: {Math.round(timelineZoom * 100)}%.</p>
      </section>

      <footer className="footer"><span><span className="live-dot" /> AUDIO ENGINE READY</span><span className="save-indicator">{saveState === "loading" ? "LOADING PROJECT" : saveState === "saving" ? "SAVING LOCALLY…" : saveState === "error" ? "LOCAL SAVE FAILED" : "SAVED ON DEVICE"}</span><span>MADE FOR THE MOMENT</span></footer>
    </main>
  );
}