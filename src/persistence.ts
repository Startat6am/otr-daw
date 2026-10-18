export type SavedAsset = {
  id: string;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  audioData: ArrayBuffer | Blob;
  bpm?: number;
};

export type SavedClip = { id: string; assetId: string; start: number; sourceStart: number; sourceEnd: number; fadeIn?: number; fadeOut?: number };
export type SavedTrack = { id: string; name: string; clips: SavedClip[]; gain: number; pan?: number; muted?: boolean; solo?: boolean };
export type SavedProject = {
  schemaVersion: 1;
  updatedAt: string;
  assets: SavedAsset[];
  tracks: SavedTrack[];
  settings: { snapEnabled: boolean; timelineZoom: number; masterGain?: number; bpm?: number };
};

const DB_NAME = "on-the-run-daw";
const STORE_NAME = "projects";
const ASSET_STORE = "audio-assets";
const CURRENT_PROJECT_KEY = "current";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    // Version 2 moves audio blobs into their own object store. This avoids rewriting
    // large binary payloads whenever only a track setting or clip position changes.
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
      if (!database.objectStoreNames.contains(ASSET_STORE)) database.createObjectStore(ASSET_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open project database"));
    request.onblocked = () => reject(new Error("Project database upgrade is blocked by another open tab. Close other On The Run tabs and reload."));
  });
}

export async function loadSavedProject(): Promise<SavedProject | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, ASSET_STORE], "readonly");
      const projectRequest = transaction.objectStore(STORE_NAME).get(CURRENT_PROJECT_KEY);
      projectRequest.onsuccess = () => {
        const value = projectRequest.result as (Omit<SavedProject, "assets"> & { assets: Array<Omit<SavedAsset, "audioData"> & { audioData?: ArrayBuffer | Blob }> }) | undefined;
        if (!value || value.schemaVersion !== 1) {
          resolve(null);
          return;
        }
        const assets = value.assets ?? [];
        const assetStore = transaction.objectStore(ASSET_STORE);
        let remaining = assets.length;
        if (!remaining) {
          resolve({ ...value, assets: [] } as SavedProject);
          return;
        }
        const restored: SavedAsset[] = [];
        let failed = false;
        assets.forEach((asset) => {
          // Compatibility with projects saved before audio was separated.
          if (asset.audioData) {
            restored.push(asset as SavedAsset);
            if (--remaining === 0) resolve({ ...value, assets: restored } as SavedProject);
            return;
          }
          const request = assetStore.get(asset.id);
          request.onsuccess = () => {
            if (request.result instanceof Blob || request.result instanceof ArrayBuffer) {
              restored.push({ ...asset, audioData: request.result } as SavedAsset);
            } else {
              failed = true;
            }
            remaining--;
            if (remaining === 0) {
              if (failed) reject(new Error("Some stored audio assets are missing"));
              else resolve({ ...value, assets: restored } as SavedProject);
            }
          };
          request.onerror = () => {
            failed = true;
            remaining--;
            if (remaining === 0) reject(request.error ?? new Error("Could not read stored audio"));
          };
        });
      };
      projectRequest.onerror = () => reject(projectRequest.error ?? new Error("Could not read saved project"));
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not read project database"));
    });
  } finally {
    database.close();
  }
}

export async function saveProject(project: SavedProject): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, ASSET_STORE], "readwrite");
      const projects = transaction.objectStore(STORE_NAME);
      const audioAssets = transaction.objectStore(ASSET_STORE);
      const metadata = {
        ...project,
        // Binary audio is stored separately and only written when a new project
        // asset arrives, rather than being serialized with every autosave.
        assets: project.assets.map(({ id, name, duration, sampleRate, channels, bpm }) => ({
          id, name, duration, sampleRate, channels, bpm,
        })),
      };
      const keepIds = new Set(project.assets.map((asset) => asset.id));
      let pending = 0;
      let failed = false;
      const fail = (error: unknown) => {
        if (failed) return;
        failed = true;
        try { transaction.abort(); } catch { /* transaction may already be inactive */ }
        reject(error instanceof Error ? error : new Error("Could not save project"));
      };

      // Keep existing binary records; add only missing ones. This avoids rewriting
      // blobs on every autosave after a clip move, pan, volume or BPM change.
      const keysRequest = audioAssets.getAllKeys();
      keysRequest.onerror = () => fail(keysRequest.error ?? new Error("Could not inspect audio storage"));
      keysRequest.onsuccess = () => {
        for (const key of keysRequest.result) {
          if (typeof key === "string" && !keepIds.has(key)) audioAssets.delete(key);
        }
        for (const asset of project.assets) {
          pending++;
          const getRequest = audioAssets.get(asset.id);
          getRequest.onerror = () => fail(getRequest.error ?? new Error("Could not read audio storage"));
          getRequest.onsuccess = () => {
            if (getRequest.result === undefined) {
              const audio = asset.audioData instanceof Blob ? asset.audioData : new Blob([asset.audioData], { type: "application/octet-stream" });
              audioAssets.put(audio, asset.id);
            }
            pending--;
          };
        }
        projects.put(metadata, CURRENT_PROJECT_KEY);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save project"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Project save was aborted"));
    });
  } finally {
    database.close();
  }
}
