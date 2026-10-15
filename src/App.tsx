import { useEffect, useRef, useState } from "react";

type ImportedAudio = {
  id: string;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  buffer: AudioBuffer;
};

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return minutes + ":" + String(rest).padStart(2, "0");
}

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
    const width = rect.width;
    const height = rect.height;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "#9be7cf";
    ctx.lineWidth = 1.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    const channel = buffer.getChannelData(0);
    const samplesPerPixel = Math.max(1, Math.floor(channel.length / width));
    const middle = height / 2;
    for (let x = 0; x < width; x++) {
      const start = x * samplesPerPixel;
      const end = Math.min(channel.length, start + samplesPerPixel);
      let min = 1;
      let max = -1;
      for (let i = start; i < end; i++) {
        const value = channel[i];
        if (value < min) min = value;
        if (value > max) max = value;
      }
      ctx.moveTo(x + 0.5, middle - max * (height * 0.43));
      ctx.lineTo(x + 0.5, middle - min * (height * 0.43));
    }
    ctx.stroke();
  }, [buffer]);

  return <canvas ref={canvasRef} className="waveform" aria-label="Audio waveform" />;
}

export default function App() {
  const [assets, setAssets] = useState<ImportedAudio[]>([]);
  const [status, setStatus] = useState("Import an audio file to start your session.");
  const [busy, setBusy] = useState(false);
  const contextRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<Map<string, AudioBufferSourceNode>>(new Map());

  useEffect(() => () => {
    for (const source of sourcesRef.current.values()) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    void contextRef.current?.close();
  }, []);

  async function importFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setStatus("Decoding audio…");
    try {
      const context = contextRef.current ?? new AudioContext();
      contextRef.current = context;
      const imported: ImportedAudio[] = [];
      for (const file of Array.from(files)) {
        if (!/\.(wav|mp3|ogg|oga)$/i.test(file.name) && !file.type.startsWith("audio/")) {
          continue;
        }
        const bytes = await file.arrayBuffer();
        const buffer = await context.decodeAudioData(bytes);
        imported.push({
          id: crypto.randomUUID(),
          name: file.name,
          duration: buffer.duration,
          sampleRate: buffer.sampleRate,
          channels: buffer.numberOfChannels,
          buffer,
        });
      }
      if (imported.length === 0) {
        setStatus("No supported audio files found. Choose WAV, MP3 or OGG.");
      } else {
        setAssets((current) => [...current, ...imported]);
        setStatus(`Imported ${imported.length} audio file${imported.length === 1 ? "" : "s"}.`);
      }
    } catch (error) {
      console.error(error);
      setStatus("Could not decode this file. Try another WAV, MP3 or OGG file.");
    } finally {
      setBusy(false);
    }
  }

  async function togglePreview(asset: ImportedAudio) {
    let context = contextRef.current;
    if (!context) {
      context = new AudioContext();
      contextRef.current = context;
    }
    if (context.state === "suspended") await context.resume();
    const current = sourcesRef.current.get(asset.id);
    if (current) {
      try { current.stop(); } catch { /* already stopped */ }
      sourcesRef.current.delete(asset.id);
      return;
    }
    const source = context.createBufferSource();
    source.buffer = asset.buffer;
    source.connect(context.destination);
    source.onended = () => {
      if (sourcesRef.current.get(asset.id) === source) sourcesRef.current.delete(asset.id);
    };
    sourcesRef.current.set(asset.id, source);
    source.start();
  }

  function stopAll() {
    for (const source of sourcesRef.current.values()) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    sourcesRef.current.clear();
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="On The Run home">
          <span className="brand-mark">OTR</span>
          <span>on the run<span className="brand-dot">.</span></span>
        </a>
        <span className="version-pill">EARLY ACCESS</span>
      </header>

      <section className="welcome">
        <p className="eyebrow">MOBILE AUDIO WORKSTATION</p>
        <h1>Catch the sound.<br /><span>Shape the moment.</span></h1>
        <p className="intro">A studio that moves with you. Import audio and start building your session.</p>
      </section>

      <section className="workspace" aria-label="Audio workspace">
        <div className="section-heading">
          <div>
            <p className="eyebrow">YOUR SESSION</p>
            <h2>Audio library <span className="count">{assets.length}</span></h2>
          </div>
          <button className="stop-button" onClick={stopAll} disabled={assets.length === 0}>Stop all</button>
        </div>

        <label className={`import-card ${busy ? "is-busy" : ""}`}>
          <input
            type="file"
            accept="audio/wav,audio/mpeg,audio/ogg,.wav,.mp3,.ogg,.oga"
            multiple
            onChange={(event) => {
              void importFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
            disabled={busy}
          />
          <span className="import-icon">{busy ? "…" : "+"}</span>
          <span className="import-copy">
            <strong>{busy ? "Importing audio…" : "Bring in your sound"}</strong>
            <span>Choose WAV, MP3 or OGG from your device</span>
          </span>
          <span className="import-arrow">↗</span>
        </label>

        <p className="status" role="status">{status}</p>

        {assets.length > 0 ? (
          <div className="asset-list">
            {assets.map((asset, index) => (
              <article className="asset-card" key={asset.id}>
                <div className="asset-meta">
                  <span className="track-number">{String(index + 1).padStart(2, "0")}</span>
                  <div className="asset-title">
                    <strong title={asset.name}>{asset.name}</strong>
                    <span>{formatTime(asset.duration)} · {asset.sampleRate.toLocaleString()} Hz · {asset.channels} ch</span>
                  </div>
                  <button className="preview-button" onClick={() => void togglePreview(asset)} aria-label={`Preview ${asset.name}`} title="Preview audio">▶</button>
                </div>
                <Waveform buffer={asset.buffer} />
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-graphic" aria-hidden="true"><span /><span /><span /><span /><span /><span /><span /><span /><span /></div>
            <strong>Your next idea starts here</strong>
            <p>Import a sound to see its waveform and preview it.</p>
          </div>
        )}
      </section>

      <footer className="footer">
        <span><span className="live-dot" /> AUDIO ENGINE READY</span>
        <span>MADE FOR THE MOMENT</span>
      </footer>
    </main>
  );
}