import { useEffect, useRef, useState } from "react";
import { loadSavedProject, saveProject, type SavedProject } from "./persistence";
import { timeStretchBuffer } from "./timeStretch";

type ImportedAudio = {
  id: string;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  buffer?: AudioBuffer;
  audioData: Blob;
  waveformPeaks?: number[];
  waveformPeaksDetailed?: number[];
  bpm?: number;
};
type Clip = { id: string; assetId: string; start: number; sourceStart: number; sourceEnd: number; tempoBpm?: number; fadeIn?: number; fadeOut?: number };
type EffectType = "volume" | "eq" | "reverb";
type TrackEffect = { id: string; type: EffectType; enabled: boolean; amount: number; frequency: number; q: number; roomSize?: number };
type Track = { id: string; name: string; clips: Clip[]; gain: number; pan?: number; muted: boolean; solo: boolean; waveformDetail?: boolean; effects?: TrackEffect[] };
const DEFAULT_BPM = 120;
const MIN_BPM = 40;
const MAX_BPM = 240;
const BASE_PX_PER_SECOND = 58;
const INITIAL_TRACKS: Track[] = [
  { id: "track-1", name: "Track 1", clips: [], gain: 1, pan: 0, muted: false, solo: false },
  { id: "track-2", name: "Track 2", clips: [], gain: 1, pan: 0, muted: false, solo: false },
];


function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return minutes + ":" + String(rest).padStart(2, "0");
}
function uid() { return crypto.randomUUID(); }

function readAudioDuration(blob: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    const url = URL.createObjectURL(blob);
    const cleanup = () => {
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
      // Do not call load() after removing src: on mobile browsers this can
      // trigger another media load/reset during file-picker handoff.
      URL.revokeObjectURL(url);
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () => { const duration = audio.duration; cleanup(); if (Number.isFinite(duration) && duration > 0) resolve(duration); else reject(new Error("Audio duration unavailable")); };
    audio.onerror = () => { cleanup(); reject(new Error("Browser could not read audio metadata")); };
    audio.src = url;
  });
}

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

function audioBufferBytes(buffer: AudioBuffer) {
  return buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
}

function getCachedBuffer(cache: Map<string, AudioBuffer>, key: string) {
  const buffer = cache.get(key);
  if (!buffer) return undefined;
  // Refresh insertion order so the cache behaves as LRU.
  cache.delete(key);
  cache.set(key, buffer);
  return buffer;
}

function cacheAudioBuffer(cache: Map<string, AudioBuffer>, key: string, buffer: AudioBuffer, maxBytes: number) {
  const bytes = audioBufferBytes(buffer);
  if (bytes > maxBytes) return buffer; // Use it for the current operation, but do not retain it.
  cache.delete(key);
  cache.set(key, buffer);
  let total = 0;
  for (const item of cache.values()) total += audioBufferBytes(item);
  while (total > maxBytes && cache.size > 0) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    if (oldest) total -= audioBufferBytes(oldest);
  }
  return buffer;
}

function Waveform({ buffer, peaks, duration, sourceStart = 0, sourceEnd, detailed = false }: { buffer?: AudioBuffer; peaks?: number[]; duration?: number; sourceStart?: number; sourceEnd?: number; detailed?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || (!buffer && !peaks?.length)) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
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
    const middle = rect.height / 2;
    if (buffer) {
      const channel = buffer.getChannelData(0);
      const rangeStart = Math.max(0, Math.min(channel.length - 1, Math.floor(sourceStart * buffer.sampleRate)));
      const rangeEnd = Math.max(rangeStart + 1, Math.min(channel.length, Math.floor((sourceEnd ?? buffer.duration) * buffer.sampleRate)));
      const rangeLength = rangeEnd - rangeStart;
      const samplesPerPixel = Math.max(1, rangeLength / Math.max(1, rect.width));
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
    } else if (peaks?.length) {
      const pairedEnvelope = detailed && peaks.length >= 12000 && peaks.length % 2 === 0;
      const bucketCount = pairedEnvelope ? peaks.length / 2 : peaks.length;
      const totalDuration = Math.max(.001, duration ?? sourceEnd ?? 1);
      const rangeStart = Math.max(0, Math.min(bucketCount - 1, Math.floor(sourceStart / totalDuration * bucketCount)));
      const rangeEnd = Math.max(rangeStart + 1, Math.min(bucketCount, Math.ceil((sourceEnd ?? totalDuration) / totalDuration * bucketCount)));
      for (let x = 0; x < rect.width; x++) {
        const first = Math.min(bucketCount - 1, rangeStart + Math.floor(x / Math.max(1, rect.width) * (rangeEnd - rangeStart)));
        const after = Math.min(bucketCount, Math.max(first + 1, rangeStart + Math.ceil((x + 1) / Math.max(1, rect.width) * (rangeEnd - rangeStart))));
        if (pairedEnvelope) {
          let min = 1, max = -1;
          for (let bucket = first; bucket < after; bucket++) {
            min = Math.min(min, peaks[bucket * 2] ?? 0);
            max = Math.max(max, peaks[bucket * 2 + 1] ?? 0);
          }
          ctx.moveTo(x + .5, middle - max * rect.height * .43);
          ctx.lineTo(x + .5, middle - min * rect.height * .43);
        } else {
          let amplitude = 0;
          for (let bucket = first; bucket < after; bucket++) amplitude = Math.max(amplitude, peaks[bucket] ?? 0);
          amplitude = Math.max(.025, Math.min(1, amplitude));
          ctx.moveTo(x + .5, middle - amplitude * rect.height * .43);
          ctx.lineTo(x + .5, middle + amplitude * rect.height * .43);
        }
      }
    }
    ctx.stroke();
  }, [buffer, peaks, duration, sourceStart, sourceEnd, detailed]);
  return <canvas ref={canvasRef} className="waveform" aria-label={detailed ? "Detailed audio waveform" : "Audio waveform"} />;
}

function ClipWaveform({ buffer, peaks, duration, sourceStart, sourceEnd, detailed }: { buffer?: AudioBuffer; peaks?: number[]; duration: number; sourceStart: number; sourceEnd: number; detailed?: boolean }) {
  return <Waveform buffer={buffer} peaks={peaks} duration={duration} sourceStart={sourceStart} sourceEnd={sourceEnd} detailed={detailed} />;
}

export default function App() {
  const [assets, setAssets] = useState<ImportedAudio[]>([]);
  const [projectName, setProjectName] = useState("Untitled project");
  const [bpm, setBpm] = useState(DEFAULT_BPM);
  const BEAT = 60 / bpm;
  const [tracks, setTracks] = useState<Track[]>(INITIAL_TRACKS);
  const [status, setStatus] = useState("Import audio, add it to a track, then press play.");
  const [busy, setBusy] = useState(false);
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);
  const [mixerCollapsed, setMixerCollapsed] = useState(false);
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
  const [effectMenuTrack, setEffectMenuTrack] = useState<string | null>(null);
  const [selectedEffect, setSelectedEffect] = useState<{ trackId: string; effectId: string } | null>(null);
  const [effectEditorCollapsed, setEffectEditorCollapsed] = useState(false);
  const [effectEditorPosition, setEffectEditorPosition] = useState<{ x: number; y: number } | null>(null);
  const effectEditorDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [masterLevel, setMasterLevel] = useState(0);
  const masterGainRef = useRef(0.85);
  const mixerNodesRef = useRef<Map<string, GainNode>>(new Map());
  const pannerNodesRef = useRef<Map<string, StereoPannerNode>>(new Map());
  const effectNodesRef = useRef<Map<string, { type: string; nodes: AudioNode[] }>>(new Map());
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
  const decodedAssetsRef = useRef<Map<string, AudioBuffer>>(new Map());
  const decodePromisesRef = useRef<Map<string, Promise<AudioBuffer>>>(new Map());
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const stretchedBuffersRef = useRef<Map<string, AudioBuffer>>(new Map());
  // Keep decoded PCM and time-stretched copies bounded on memory-constrained phones.
  const decodedCacheBudgetBytes = 48 * 1024 * 1024;
  const stretchedCacheBudgetBytes = 24 * 1024 * 1024;
  const stretchWorkingBudgetBytes = 16 * 1024 * 1024;
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
          const restoredAssets: ImportedAudio[] = [];
          for (const item of saved.assets) {
            try {
              const audioBlob = item.audioData instanceof Blob ? item.audioData : new Blob([item.audioData], { type: "application/octet-stream" });
              // Restore metadata and compressed audio only; decode PCM on playback.
              restoredAssets.push({ ...item, audioData: audioBlob, buffer: undefined });
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
        assets: assets.map((asset) => ({ id: asset.id, name: asset.name, duration: asset.duration, sampleRate: asset.sampleRate, channels: asset.channels, audioData: asset.audioData, waveformPeaks: asset.waveformPeaks, waveformPeaksDetailed: asset.waveformPeaksDetailed, bpm: asset.bpm })),
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
    decodedAssetsRef.current.clear();
    decodePromisesRef.current.clear();
    stretchedBuffersRef.current.clear();
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
        assets: await Promise.all(assets.map(async (asset) => ({ id: asset.id, name: asset.name, duration: asset.duration, sampleRate: asset.sampleRate, channels: asset.channels, audioData: bufferToBase64(await asset.audioData.arrayBuffer()), waveformPeaks: asset.waveformPeaks, waveformPeaksDetailed: asset.waveformPeaksDetailed, bpm: asset.bpm }))),
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
      const restoredAssets: ImportedAudio[] = [];
      for (const item of parsed.assets) {
        if (typeof item.audioData !== "string") throw new Error("Project audio data is missing");
        const decodedBytes = base64ToBuffer(item.audioData);
        const audioBlob = new Blob([decodedBytes], { type: "application/octet-stream" });
        restoredAssets.push({ ...item, audioData: audioBlob, buffer: undefined });
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
      decodedAssetsRef.current.clear();
      decodePromisesRef.current.clear();
      stretchedBuffersRef.current.clear();
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
    if (!contextRef.current) contextRef.current = new AudioContext({ sampleRate: 44100 });
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
        panner.connect(masterNodeRef.current!);
        mixerNodesRef.current.set(track.id, node);
        pannerNodesRef.current.set(track.id, panner);
        effectNodesRef.current.delete(track.id);
      }
      const effects = (track.effects ?? []).filter((effect) => effect.enabled);
      const previous = effectNodesRef.current.get(track.id);
      if (!previous || previous.nodes.some((item) => item.context !== context) || previous.nodes.length !== effects.length || previous.type !== effects.map((effect) => `${effect.type}:${effect.type === "reverb" ? `${effect.roomSize ?? 0.55}:${effect.amount}` : ""}`).join(",")) {
        previous?.nodes.forEach((item) => { try { item.disconnect(); } catch { /* already disconnected */ } });
        const nodes: AudioNode[] = effects.map((effect) => {
          if (effect.type === "volume") return context.createGain();
          if (effect.type === "eq") return context.createBiquadFilter();
          const convolver = context.createConvolver();
          const roomSize = Math.max(0.15, Math.min(1, effect.roomSize ?? 0.55));
          const impulseLength = Math.floor(context.sampleRate * (0.25 + roomSize * 1.75));
          const impulse = context.createBuffer(2, impulseLength, context.sampleRate);
          for (let channel = 0; channel < 2; channel++) {
            const data = impulse.getChannelData(channel);
            for (let i = 0; i < impulseLength; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / impulseLength, 1.5 + (1 - roomSize) * 3) * Math.max(0, Math.min(1, effect.amount));
          }
          convolver.buffer = impulse;
          return convolver;
        });
        effectNodesRef.current.set(track.id, { type: effects.map((effect) => `${effect.type}:${effect.type === "reverb" ? `${effect.roomSize ?? 0.55}:${effect.amount}` : ""}`).join(","), nodes });
        node.disconnect();
        node.connect(nodes[0] as AudioNode || panner);
        nodes.forEach((item, index) => { if (index + 1 < nodes.length) item.connect(nodes[index + 1]); else item.connect(panner!); });
        if (nodes.length === 0) node.connect(panner);
      } else {
        // Keep nodes alive while updating parameters so playback doesn't click or reset.
        const nodes = previous.nodes;
        effects.forEach((effect, index) => {
          const item = nodes[index];
          if (effect.type === "volume" && item instanceof GainNode) item.gain.setTargetAtTime(Math.max(0, Math.min(2, effect.amount)), context.currentTime, 0.02);
          if (effect.type === "eq" && item instanceof BiquadFilterNode) {
            item.type = "peaking";
            item.frequency.setTargetAtTime(Math.max(60, Math.min(16000, effect.frequency)), context.currentTime, 0.02);
            item.Q.setTargetAtTime(Math.max(0.1, Math.min(10, effect.q)), context.currentTime, 0.02);
            item.gain.setTargetAtTime(Math.max(-12, Math.min(12, effect.amount)), context.currentTime, 0.02);
          }
          if (effect.type === "reverb" && item instanceof ConvolverNode) item.normalize = true;
        });
      }
      const activeNodes = effectNodesRef.current.get(track.id)?.nodes ?? [];
      effects.forEach((effect, index) => {
        const item = activeNodes[index];
        if (effect.type === "volume" && item instanceof GainNode) item.gain.setTargetAtTime(Math.max(0, Math.min(2, effect.amount)), context.currentTime, 0.02);
        if (effect.type === "eq" && item instanceof BiquadFilterNode) {
          item.type = "peaking";
          item.frequency.setTargetAtTime(Math.max(60, Math.min(16000, effect.frequency)), context.currentTime, 0.02);
          item.Q.setTargetAtTime(Math.max(0.1, Math.min(10, effect.q)), context.currentTime, 0.02);
          item.gain.setTargetAtTime(Math.max(-12, Math.min(12, effect.amount)), context.currentTime, 0.02);
        }
      });
      const audible = !track.muted && (!soloActive || track.solo);
      node.gain.setTargetAtTime(audible ? track.gain : 0, context.currentTime, 0.015);
      panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, track.pan ?? 0)), context.currentTime, 0.015);
    });
  }
  function addEffect(trackId: string, type: EffectType) {
    const effect: TrackEffect = { id: uid(), type, enabled: true, amount: type === "volume" ? 1 : type === "eq" ? 0 : 0.35, frequency: 1200, q: 1, roomSize: 0.55 };
    const next = tracksRef.current.map((track) => track.id === trackId ? { ...track, effects: [...(track.effects ?? []), effect] } : track);
    tracksRef.current = next;
    setTracks(next);
    setSelectedEffect({ trackId, effectId: effect.id });
    setEffectMenuTrack(null);
    if (contextRef.current) ensureMixer(contextRef.current, next);
    setStatus(`${type === "eq" ? "EQ" : type === "reverb" ? "Reverb" : "Volume"} effect added.`);
  }
  function updateEffect(trackId: string, effectId: string, change: Partial<TrackEffect>) {
    const next = tracksRef.current.map((track) => track.id === trackId ? { ...track, effects: (track.effects ?? []).map((effect) => effect.id === effectId ? { ...effect, ...change } : effect) } : track);
    tracksRef.current = next;
    setTracks(next);
    if (contextRef.current) ensureMixer(contextRef.current, next);
  }
  function removeEffect(trackId: string, effectId: string) {
    const next = tracksRef.current.map((track) => track.id === trackId ? { ...track, effects: (track.effects ?? []).filter((effect) => effect.id !== effectId) } : track);
    tracksRef.current = next;
    setTracks(next);
    setSelectedEffect((current) => current?.effectId === effectId ? null : current);
    if (contextRef.current) ensureMixer(contextRef.current, next);
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
  async function getDecodedAsset(asset: ImportedAudio, context: AudioContext) {
    const cached = asset.buffer ?? getCachedBuffer(decodedAssetsRef.current, asset.id);
    if (cached) return cached;
    const pending = decodePromisesRef.current.get(asset.id);
    if (pending) return pending;
    const decoding = (async () => {
      // Only the compressed file is read here. PCM is created on first playback, not on import.
      const compressedBytes = await asset.audioData.arrayBuffer();
      const decoded = await context.decodeAudioData(compressedBytes);
      cacheAudioBuffer(decodedAssetsRef.current, asset.id, decoded, decodedCacheBudgetBytes);
      if (!asset.waveformPeaks) {
        const waveformPeaks = peaksFromBuffer(decoded);
        setAssets((current) => current.map((item) => item.id === asset.id ? { ...item, waveformPeaks } : item));
      }
      return decoded;
    })();
    decodePromisesRef.current.set(asset.id, decoding);
    try {
      return await decoding;
    } finally {
      if (decodePromisesRef.current.get(asset.id) === decoding) decodePromisesRef.current.delete(asset.id);
    }
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
      const duration = Math.min(clipDuration - elapsed, playbackLimit - Math.max(position, clip.start));
      if (duration <= 0) continue;
      const cacheKey = `${clip.id}:${clip.sourceStart}:${clip.sourceEnd}:${bpm}:${asset.id}`;
      let playbackBuffer: AudioBuffer;
      let offset: number;
      let sourcePlayDuration: number;
      let playbackRate = 1;
      const needsStretch = Math.abs(stretchRatio - 1) >= 0.002;
      const estimatedFrames = Math.max(1, Math.ceil(sourceDuration * 44100 * stretchRatio));
      const estimatedWorkingBytes = estimatedFrames * (asset.channels * Float32Array.BYTES_PER_ELEMENT + Float32Array.BYTES_PER_ELEMENT)
        + Math.ceil(sourceDuration * 44100) * asset.channels * Float32Array.BYTES_PER_ELEMENT;
      // For long clips, playback-rate adjustment is much cheaper than allocating a full
      // stretched PCM copy plus its overlap-add weight array.
      const useRealtimeRate = needsStretch && estimatedWorkingBytes > stretchWorkingBudgetBytes;
      if (!needsStretch || useRealtimeRate) {
        const decoded = await getDecodedAsset(asset, context);
        playbackBuffer = decoded;
        playbackRate = useRealtimeRate ? 1 / stretchRatio : 1;
        offset = clip.sourceStart + (useRealtimeRate ? elapsed / stretchRatio : elapsed);
        sourcePlayDuration = useRealtimeRate ? duration / stretchRatio : duration;
      } else {
        let stretched = getCachedBuffer(stretchedBuffersRef.current, cacheKey);
        if (!stretched) {
          const decoded = await getDecodedAsset(asset, context);
          const startFrame = Math.max(0, Math.min(decoded.length - 1, Math.floor(clip.sourceStart * decoded.sampleRate)));
          const endFrame = Math.min(decoded.length, Math.max(startFrame + 1, Math.floor(clip.sourceEnd * decoded.sampleRate)));
          const segment = context.createBuffer(decoded.numberOfChannels, endFrame - startFrame, decoded.sampleRate);
          for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
            segment.copyToChannel(decoded.getChannelData(channel).subarray(startFrame, endFrame), channel);
          }
          stretched = timeStretchBuffer(segment, stretchRatio, context);
          cacheAudioBuffer(stretchedBuffersRef.current, cacheKey, stretched, stretchedCacheBudgetBytes);
        }
        playbackBuffer = stretched;
        offset = elapsed;
        sourcePlayDuration = duration;
      }
      const source = context.createBufferSource();
      source.buffer = playbackBuffer;
      source.playbackRate.value = playbackRate;
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
      source.start(scheduledAt, offset, sourcePlayDuration);
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
    try {
      await scheduleFrom(playheadRef.current, context);
    } catch (error) {
      console.error("Audio playback could not be scheduled", error);
      stopSources();
      playingRef.current = false;
      setIsPlaying(false);
      // A failed decode may leave substantial temporary allocations. Drop caches so a retry starts clean.
      decodedAssetsRef.current.clear();
      stretchedBuffersRef.current.clear();
      const reason = error instanceof Error ? error.message : String(error);
      setStatus(reason.toLowerCase().includes("memory")
        ? "The browser ran out of audio memory. Caches were released; reload the project and try again."
        : "Could not start audio playback. Try reloading the project or using a shorter audio clip.");
    }
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
    // Import should remain lightweight even after several preview/playback passes.
    // Active AudioBufferSourceNodes keep their own references, so clearing these caches is safe.
    if (!playingRef.current) {
      decodedAssetsRef.current.clear();
      stretchedBuffersRef.current.clear();
    }
    setBusy(true);
    setStatus("Reading audio metadata…");
    try {
      const imported: ImportedAudio[] = [];
      let failedFiles = 0;
      let lastImportError = "";
      for (const file of Array.from(files)) {
        if (!/\.(wav|mp3|ogg|oga)$/i.test(file.name) && !file.type.startsWith("audio/")) continue;
        try {
          const audioBlob = file.slice(0, file.size, file.type || "application/octet-stream");
          const duration = await readAudioDuration(audioBlob);
          imported.push({ id: uid(), name: file.name, duration, sampleRate: 44100, channels: 2, buffer: undefined, audioData: audioBlob });
        } catch (error) {
          console.error("Audio file import failed", file.name, error);
          lastImportError = error instanceof Error ? error.message : String(error);
          failedFiles++;
        }
      }
      if (imported.length) setAssets((current) => [...current, ...imported]);
      if (imported.length && failedFiles) setStatus(`Imported ${imported.length} file(s); ${failedFiles} file(s) failed. Last error: ${lastImportError || "unknown browser error"}`);
      else if (imported.length) setStatus(`Imported ${imported.length} file${imported.length === 1 ? "" : "s"}. Add clips to tracks below.`);
      else if (failedFiles) {
        const memoryFailure = /memory|allocat|resource/i.test(lastImportError);
        setStatus(memoryFailure
          ? `Browser resource error while reading audio: ${lastImportError}. Audio caches were cleared; reload the app if it persists.`
          : `Could not read audio metadata: ${lastImportError || "unknown browser error"}. Try a WAV, MP3 or OGG file.`);
      } else setStatus("No supported audio files found. Choose WAV, MP3 or OGG.");
    } catch (error) {
      console.error("Audio import failed", error);
      const reason = error instanceof Error ? error.message : String(error);
      setStatus(`Audio import failed: ${reason}`);
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
    const track: Track = { id: uid(), name: "Track " + nextNumber, clips: [], gain: 1, muted: false, solo: false, waveformDetail: false };
    commitTracks((current) => [...current, track]);
    setStatus(track.name + " added.");
  }

  async function toggleTrackWaveformDetail(trackId: string) {
    const track = tracksRef.current.find((item) => item.id === trackId);
    if (!track) return;
    if (track.waveformDetail) {
      commitTracks((current) => current.map((item) => item.id === trackId ? { ...item, waveformDetail: false } : item));
      setStatus(`Detailed waveform disabled for ${track.name}.`);
      return;
    }
    const assetIds = [...new Set(track.clips.map((clip) => clip.assetId))];
    const missing = assetIds.filter((id) => {
      const asset = assets.find((item) => item.id === id);
      return Boolean(asset && (asset.waveformPeaksDetailed?.length ?? 0) < 12000);
    });
    if (missing.length) {
      setStatus(`Building detailed waveform for ${track.name}…`);
      try {
        const context = contextRef.current ?? new AudioContext();
        contextRef.current = context;
        for (const assetId of missing) {
          const asset = assets.find((item) => item.id === assetId);
          if (!asset) continue;
          const decoded = await getDecodedAsset(asset, context);
          const waveformPeaksDetailed = peaksFromBuffer(decoded, 6000, true);
          setAssets((current) => current.map((item) => item.id === assetId ? { ...item, waveformPeaksDetailed } : item));
        }
        setStatus(`Detailed waveform ready for ${track.name}.`);
      } catch (error) {
        console.error("Could not build detailed waveform", error);
        setStatus("Could not build detailed waveform. Try again after playing a short section of audio.");
        return;
      }
    }
    commitTracks((current) => current.map((item) => item.id === trackId ? { ...item, waveformDetail: true } : item));
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

  function removeAsset(asset: ImportedAudio) {
    const uses = tracksRef.current.reduce((count, track) => count + track.clips.filter((clip) => clip.assetId === asset.id).length, 0);
    if (uses > 0 && !window.confirm(`Remove "${asset.name}" from the library and delete its ${uses} timeline clip(s)?`)) return;
    setAssets((current) => current.filter((item) => item.id !== asset.id));
    if (uses > 0) commitTracks((current) => current.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.assetId !== asset.id) })));
    decodedAssetsRef.current.delete(asset.id);
    decodePromisesRef.current.delete(asset.id);
    for (const key of stretchedBuffersRef.current.keys()) if (key.endsWith(`:${asset.id}`)) stretchedBuffersRef.current.delete(key);
    setStatus(`"${asset.name}" removed from the library.`);
  }

  function addClip(asset: ImportedAudio, trackId: string) {
    const clip: Clip = { id: uid(), assetId: asset.id, start: 0, sourceStart: 0, sourceEnd: asset.duration, tempoBpm: asset.bpm ?? bpm };
    commitTracks((current) => current.map((track) => track.id === trackId ? { ...track, clips: [...track.clips, clip] } : track));
    setSelectedClip(clip.id);
    setStatus(`Added ${asset.name} to ${tracks.find((track) => track.id === trackId)?.name}.`);
  }

  function peaksFromBuffer(decoded: AudioBuffer, bucketCount = 1200, preserveShape = false) {
    // Standard mode stays compact. Detailed mode stores a true min/max envelope
    // for each bucket so quiet/negative transients are not lost.
    const peaks = new Array<number>(bucketCount * (preserveShape ? 2 : 1)).fill(0);
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      const start = Math.floor(bucket * decoded.length / bucketCount);
      const end = Math.max(start + 1, Math.floor((bucket + 1) * decoded.length / bucketCount));
      let peak = 0;
      let min = 1;
      let max = -1;
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const samples = decoded.getChannelData(channel);
        for (let i = start; i < Math.min(end, samples.length); i++) {
          const sample = samples[i];
          peak = Math.max(peak, Math.abs(sample));
          min = Math.min(min, sample);
          max = Math.max(max, sample);
        }
      }
      if (preserveShape) {
        peaks[bucket * 2] = min;
        peaks[bucket * 2 + 1] = max;
      } else {
        peaks[bucket] = peak;
      }
    }
    return peaks;
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
      </section>

      <section className="workspace" aria-label="Audio workspace">
        <div className="section-heading">
          <div><p className="eyebrow">YOUR SESSION</p><h2>Audio library <span className="count">{assets.length}</span></h2></div>
          <button className="collapse-button" aria-expanded={!libraryCollapsed} onClick={() => setLibraryCollapsed((value) => !value)}>{libraryCollapsed ? "＋ Expand" : "− Collapse"}</button>
        </div>
        {!libraryCollapsed && <>
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
            <div className="asset-actions">{tracks.map((track) => <button className="add-clip-button" key={track.id} onClick={() => addClip(asset, track.id)}>+ {track.name}</button>)}<button className="remove-asset-button" onClick={() => removeAsset(asset)} aria-label={`Remove ${asset.name} from library`}>Remove</button></div>
          </article>
        ))}</div> : <div className="empty-state"><div className="empty-graphic" aria-hidden="true">{Array.from({length: 9}, (_, i) => <span key={i} />)}</div><strong>Your next idea starts here</strong><p>Import a sound, then add it to any track.</p></div>}
        </>}
      </section>

      <section className="mixer-panel" aria-label="Audio mixer">
        <div className="section-heading mixer-heading"><div><p className="eyebrow">LEVELS & CONTROL</p><h2>Mixer <span className="count">{tracks.length} tracks</span></h2></div><div className="mixer-heading-actions"><div className="master-meter" aria-label={`Master signal ${Math.round(masterLevel * 100)} percent`}><span style={{ width: `${Math.round(masterLevel * 100)}%` }} /></div><button className="collapse-button" aria-expanded={!mixerCollapsed} onClick={() => setMixerCollapsed((value) => !value)}>{mixerCollapsed ? "＋ Expand" : "− Collapse"}</button></div></div>
        {!mixerCollapsed && <div className="mixer-channels">

          <article className="mixer-channel master-channel"><div className="channel-top"><span className="master-mark">M</span><strong>MASTER</strong><span className="channel-db">{masterGain === 0 ? "−∞" : `${(20 * Math.log10(masterGain)).toFixed(1)} dB`}</span></div><label className="volume-control"><span>OUT</span><input aria-label="Master volume" type="range" min="0" max="1" step="0.01" value={masterGain} onChange={(event) => setMaster(Number(event.currentTarget.value))} /><output>{Math.round(masterGain * 100)}%</output></label><div className="master-meter large-meter" aria-label={`Master output level ${Math.round(masterLevel * 100)} percent`}><span style={{ width: `${Math.round(masterLevel * 100)}%` }} /></div></article>
          {tracks.map((track, index) => <article className={`mixer-channel ${track.muted ? "channel-muted" : ""} ${track.solo ? "channel-solo" : ""}`} key={track.id}>
            <div className="channel-top"><span className="channel-index">{String(index + 1).padStart(2, "0")}</span><strong>{track.name}</strong><span className="channel-db">{track.gain === 0 ? "−∞" : `${(20 * Math.log10(track.gain)).toFixed(1)} dB`}</span></div>
            <label className="volume-control"><span>VOL</span><input aria-label={`${track.name} volume`} type="range" min="0" max="1" step="0.01" value={track.gain} onChange={(event) => changeTrack(track.id, { gain: Number(event.currentTarget.value) })} /><output>{Math.round(track.gain * 100)}%</output></label>
            <div className="channel-buttons"><button className={track.muted ? "channel-active" : ""} aria-pressed={track.muted} onClick={() => changeTrack(track.id, { muted: !track.muted })}>MUTE</button><button className={track.solo ? "channel-active solo-active" : ""} aria-pressed={track.solo} onClick={() => changeTrack(track.id, { solo: !track.solo })}>SOLO</button></div>
            <div className="channel-effects">
              <div className="effect-list">{(track.effects ?? []).map((effect) => <div key={effect.id} className={`effect-module ${selectedEffect?.effectId === effect.id ? "effect-module-selected" : ""} ${effect.enabled ? "" : "effect-module-bypassed"}`}><button type="button" className={`effect-module-led ${effect.enabled ? "is-on" : ""}`} aria-label={`${effect.enabled ? "Disable" : "Enable"} ${effect.type}`} aria-pressed={effect.enabled} onClick={() => updateEffect(track.id, effect.id, { enabled: !effect.enabled })} /><button type="button" className="effect-module-open" onClick={() => { setSelectedEffect({ trackId: track.id, effectId: effect.id }); setEffectEditorCollapsed(false); setEffectMenuTrack(null); }}><span>{effect.type === "eq" ? "EQ" : effect.type === "reverb" ? "REVERB" : "VOLUME"}</span><small>{effect.enabled ? "ON" : "BYPASS"}</small></button></div>)}</div>
              <button className="add-effect-button" onClick={() => setEffectMenuTrack((current) => current === track.id ? null : track.id)}>＋ ADD EFFECT</button>
              {effectMenuTrack === track.id && <div className="effect-picker"><strong>Add effect</strong><button onClick={() => addEffect(track.id, "volume")}>Volume <small>Level / boost</small></button><button onClick={() => addEffect(track.id, "eq")}>EQ <small>Tone shaping</small></button><button onClick={() => addEffect(track.id, "reverb")}>Reverb <small>Space / ambience</small></button></div>}
            </div>
          </article>)}

        </div>}
      </section>

      {selectedEffect && (() => {
        const track = tracks.find((item) => item.id === selectedEffect.trackId);
        const effect = track?.effects?.find((item) => item.id === selectedEffect.effectId);
        if (!track || !effect) return null;
        return <section className={`effect-editor effect-editor-floating ${effectEditorCollapsed ? "is-collapsed" : ""}`} role="dialog" aria-label={`${effect.type} effect settings`} style={effectEditorPosition ? { left: effectEditorPosition.x, top: effectEditorPosition.y, right: "auto", bottom: "auto" } : undefined}>
          <div className="effect-editor-header" onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            const panel = event.currentTarget.parentElement;
            if (!panel) return;
            const rect = panel.getBoundingClientRect();
            effectEditorDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: rect.left, originY: rect.top };
            event.currentTarget.setPointerCapture(event.pointerId);
          }} onPointerMove={(event) => {
            const drag = effectEditorDragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            const panel = event.currentTarget.parentElement;
            if (!panel) return;
            const maxX = Math.max(0, window.innerWidth - panel.offsetWidth);
            const maxY = Math.max(0, window.innerHeight - Math.min(panel.offsetHeight, 34));
            setEffectEditorPosition({ x: Math.max(0, Math.min(maxX, drag.originX + event.clientX - drag.startX)), y: Math.max(0, Math.min(maxY, drag.originY + event.clientY - drag.startY)) });
          }} onPointerUp={(event) => { if (effectEditorDragRef.current?.pointerId === event.pointerId) effectEditorDragRef.current = null; }} onPointerCancel={() => { effectEditorDragRef.current = null; }}><div className="effect-editor-title"><strong>{track.name}</strong><span>{effect.type === "eq" ? "EQ" : effect.type === "reverb" ? "Reverb" : "Volume"}</span></div><div className="effect-window-actions"><button className="effect-window-collapse" onClick={() => setEffectEditorCollapsed((value) => !value)} aria-label={effectEditorCollapsed ? "Expand effect settings" : "Collapse effect settings"}>{effectEditorCollapsed ? "＋" : "−"}</button><button className="effect-close" onClick={() => { setSelectedEffect(null); setEffectEditorPosition(null); }} aria-label="Close effect settings">×</button></div></div>
          {!effectEditorCollapsed && <>
            <label className="effect-enable"><span>Enabled</span><input type="checkbox" checked={effect.enabled} onChange={(event) => updateEffect(track.id, effect.id, { enabled: event.currentTarget.checked })}/></label>
            {effect.type === "volume" && <label className="effect-param"><span>Output level <b>{Math.round(effect.amount * 100)}%</b></span><input type="range" min="0" max="2" step="0.01" value={effect.amount} onChange={(event) => updateEffect(track.id, effect.id, { amount: Number(event.currentTarget.value) })}/></label>}
            {effect.type === "eq" && <><label className="effect-param"><span>Frequency <b>{Math.round(effect.frequency)} Hz</b></span><input type="range" min="60" max="16000" step="10" value={effect.frequency} onChange={(event) => updateEffect(track.id, effect.id, { frequency: Number(event.currentTarget.value) })}/></label><label className="effect-param"><span>Gain <b>{effect.amount > 0 ? "+" : ""}{effect.amount.toFixed(1)} dB</b></span><input type="range" min="-12" max="12" step="0.5" value={effect.amount} onChange={(event) => updateEffect(track.id, effect.id, { amount: Number(event.currentTarget.value) })}/></label><label className="effect-param"><span>Q / width <b>{effect.q.toFixed(1)}</b></span><input type="range" min="0.1" max="10" step="0.1" value={effect.q} onChange={(event) => updateEffect(track.id, effect.id, { q: Number(event.currentTarget.value) })}/></label></>}
            {effect.type === "reverb" && <><label className="effect-param"><span>Room size <b>{Math.round((effect.roomSize ?? 0.55) * 100)}%</b></span><input type="range" min="0.15" max="1" step="0.05" value={effect.roomSize ?? 0.55} onChange={(event) => updateEffect(track.id, effect.id, { roomSize: Number(event.currentTarget.value) })}/></label><label className="effect-param"><span>Reverb level <b>{Math.round(effect.amount * 100)}%</b></span><input type="range" min="0" max="1" step="0.01" value={effect.amount} onChange={(event) => updateEffect(track.id, effect.id, { amount: Number(event.currentTarget.value) })}/></label></>}
            <div className="effect-editor-actions"><button className="effect-remove" onClick={() => removeEffect(track.id, effect.id)}>Remove effect</button><button className="effect-done" onClick={() => setSelectedEffect(null)}>Done</button></div>
          </>}
        </section>;
      })()}
      <section className="timeline-panel" aria-label="Multitrack timeline">
        <div className="timeline-heading">
          <div><p className="eyebrow">ARRANGEMENT</p><h2>Timeline</h2></div>
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
          <div className="timeline-inner" style={{ width: timelineWidth + (trackSidebarCollapsed ? 27 : (window.innerWidth <= 520 ? 107 : 135)) }}>
            <div className="timeline-gutter"><button className="sidebar-toggle" type="button" aria-label={trackSidebarCollapsed ? "Expand track sidebar" : "Collapse track sidebar"} title={trackSidebarCollapsed ? "Expand track sidebar" : "Collapse track sidebar"} onClick={() => setTrackSidebarCollapsed((value) => !value)}>{trackSidebarCollapsed ? "›" : "‹"}</button></div><div className="special-marker-strip" style={{ width: timelineWidth }} aria-label="Special timeline markers">
              <div className="loop-marker loop-marker-start" style={{ left: loopStart * PX_PER_SECOND }} title={`Loop start ${formatTime(loopStart)}`}><span>IN</span></div>
              <div className="loop-marker loop-marker-end" style={{ left: loopEnd * PX_PER_SECOND }} title={`Loop end ${formatTime(loopEnd)}`}><span>OUT</span></div>
            </div><div className="ruler" style={{ width: timelineWidth }} onPointerDown={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              seekPlayhead((event.clientX - rect.left) / PX_PER_SECOND);
            }}>
              {loopEnd > loopStart && <div className={loopEnabled ? "loop-range loop-range-active" : "loop-range"} style={{ left: loopStart * PX_PER_SECOND, width: Math.max(2, (loopEnd - loopStart) * PX_PER_SECOND) }} aria-label={`Loop range from ${formatTime(loopStart)} to ${formatTime(loopEnd)}`} />}
              {Array.from({ length: rulerCount + 1 }, (_, i) => <div className="ruler-mark" key={i} style={{ left: i * BEAT * 4 * PX_PER_SECOND }}><span>{String(i + 1).padStart(2, "0")}</span></div>)}
            </div>
            {tracks.map((track) => <div className="timeline-track" data-track-id={track.id} key={track.id} style={{ width: timelineWidth, backgroundImage: `repeating-linear-gradient(to right, #252a28 0, #252a28 1px, transparent 1px, transparent ${Math.max(1, BEAT * 4 / gridDivision * PX_PER_SECOND)}px)` }}>
              <div className="track-label"><span title={track.name}>{trackSidebarCollapsed ? String(tracks.findIndex((item) => item.id === track.id) + 1).padStart(2, "0") : track.name}</span>{!trackSidebarCollapsed && <><div className="track-mini-controls"><div className="track-knob-wrap"><div className="track-knob pan-knob" role="slider" tabIndex={0} aria-label={track.name + " pan"} aria-valuemin={-100} aria-valuemax={100} aria-valuenow={Math.round((track.pan ?? 0) * 100)} title={`PAN ${Math.round((track.pan ?? 0) * 100)}`} style={{ "--knob-angle": `${(track.pan ?? 0) * 135}deg` } as React.CSSProperties} onPointerDown={(event) => startTrackKnob(event, track.id, "pan", track.pan ?? 0)} onPointerMove={moveTrackKnob} onPointerUp={endTrackKnob} onPointerCancel={endTrackKnob} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowDown") { event.preventDefault(); changeTrack(track.id, { pan: Math.max(-1, (track.pan ?? 0) - .05) }); } else if (event.key === "ArrowRight" || event.key === "ArrowUp") { event.preventDefault(); changeTrack(track.id, { pan: Math.min(1, (track.pan ?? 0) + .05) }); } }}><span /></div><small>PAN</small></div><div className="track-knob-wrap"><div className="track-knob volume-knob" role="slider" tabIndex={0} aria-label={track.name + " volume"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(track.gain * 100)} title={`VOL ${Math.round(track.gain * 100)}%`} style={{ "--knob-angle": `${-135 + track.gain * 270}deg` } as React.CSSProperties} onPointerDown={(event) => startTrackKnob(event, track.id, "gain", track.gain)} onPointerMove={moveTrackKnob} onPointerUp={endTrackKnob} onPointerCancel={endTrackKnob} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowLeft") { event.preventDefault(); changeTrack(track.id, { gain: Math.max(0, track.gain - .05) }); } else if (event.key === "ArrowUp" || event.key === "ArrowRight") { event.preventDefault(); changeTrack(track.id, { gain: Math.min(1, track.gain + .05) }); } }}><span /></div><small>VOL</small></div></div><button className={`waveform-detail-toggle${track.waveformDetail ? " is-active" : ""}`} type="button" aria-pressed={Boolean(track.waveformDetail)} title={track.clips.length === 0 ? "Add a clip to enable detailed waveform" : track.waveformDetail ? "Use standard waveform detail" : "Improve waveform detail"} disabled={track.clips.length === 0} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); void toggleTrackWaveformDetail(track.id); }}>{track.waveformDetail ? "DETAIL ON" : "WAVE DETAIL"}</button></>}<div className="track-label-actions"><button type="button" title={"Rename " + track.name} aria-label={"Rename " + track.name} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); renameTrack(track.id); }}>✎</button><button type="button" title={"Delete " + track.name} aria-label={"Delete " + track.name} disabled={tracks.length <= 1} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); removeTrack(track.id); }}>×</button></div></div>
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
                  <strong>{asset.name}</strong><div className="clip-wave"><ClipWaveform buffer={track.waveformDetail ? undefined : (asset.buffer ?? decodedAssetsRef.current.get(asset.id))} peaks={track.waveformDetail ? (asset.waveformPeaksDetailed ?? asset.waveformPeaks) : asset.waveformPeaks} duration={asset.duration} sourceStart={clip.sourceStart} sourceEnd={clip.sourceEnd} detailed={track.waveformDetail} /></div>
                  <span className={"trim-handle trim-right " + (trimMode ? "trim-enabled" : "trim-disabled")} data-edge="right" aria-label={trimMode ? "Trim clip end" : "Move clip from end edge"} />
                  {selectedClip === clip.id && <div className="clip-nudges"><button onClick={(event) => { event.stopPropagation(); nudgeClip(clip, -1); }}>− grid</button><button onClick={(event) => { event.stopPropagation(); nudgeClip(clip, 1); }}>+ grid</button></div>}
                </div>;
              })}
            </div>)}
            <div className="track-sidebar-footer" style={{ width: timelineWidth + (trackSidebarCollapsed ? 27 : (window.innerWidth <= 520 ? 107 : 135)) }}>
              <button className="sidebar-add-track" onClick={addTrack} disabled={tracks.length >= 16}><span>＋</span> Add track</button>
            </div>
            <div className="playhead" style={{ left: playhead * PX_PER_SECOND + (trackSidebarCollapsed ? 27 : (window.innerWidth <= 520 ? 107 : 135)) }} />
          </div>
        </div>
        <p className="timeline-hint">Horizontal scroll · 4/4 grid · one beat = {BEAT.toFixed(2)}s · {snapEnabled ? "snap 1/" + gridDivision : "free positioning"} · trim {trimMode ? "enabled (destructive)" : "disabled"} · loop {loopEnabled ? "enabled" : "disabled"}. Zoom: {Math.round(timelineZoom * 100)}%.</p>
      </section>

      <footer className="footer"><span><span className="live-dot" /> AUDIO ENGINE READY</span><span className="save-indicator">{saveState === "loading" ? "LOADING PROJECT" : saveState === "saving" ? "SAVING LOCALLY…" : saveState === "error" ? "LOCAL SAVE FAILED" : "SAVED ON DEVICE"}</span><span>MADE FOR THE MOMENT</span></footer>
    </main>
  );
}