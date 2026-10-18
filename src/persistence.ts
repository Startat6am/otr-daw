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

type ProjectMetadata = Omit<SavedProject, "assets"> & {
  assets: Array<Omit<SavedAsset, "audioData"> & { audioData?: never }>;
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
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
      if (!database.objectStoreNames.contains(ASSET_STORE)) database.createObjectStore(ASSET_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open project database"));
  });
}

export async function loadSavedProject(): Promise<SavedProject | null> {
  const database = await openDatabase();
  try {
    const stored = await new Promise<SavedProject | null>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(CURRENT_PROJECT_KEY);
      request.onsuccess = () => {
        const value = request.result as SavedProject | undefined;
        resolve(value && value.schemaVersion === 1 ? value : null);
      };
      request.onerror = () => reject(request.error ?? new Error("Could not read saved project"));
    });
    if (!stored) return null;

    const assets = await Promise.all(stored.assets.map(async (asset) => {
      const audioData = await new Promise<Blob | ArrayBuffer | undefined>((resolve, reject) => {
        const transaction = database.transaction(ASSET_STORE, "readonly");
        const request = transaction.objectStore(ASSET_STORE).get(asset.id);
        request.onsuccess = () => resolve(request.result as Blob | ArrayBuffer | undefined);
        request.onerror = () => reject(request.error ?? new Error("Could not read stored audio"));
      });
      // Migrate projects created before audio was stored independently.
      return { ...asset, audioData: audioData ?? asset.audioData };
    }));
    return { ...stored, assets };
  } finally {
    database.close();
  }
}

export async function saveProject(project: SavedProject): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, ASSET_STORE], "readwrite");
      const projectStore = transaction.objectStore(STORE_NAME);
      const assetStore = transaction.objectStore(ASSET_STORE);
      // Keep IndexedDB tidy when a user removes audio from the library.
      const retainedAssetIds = new Set(project.assets.map((asset) => asset.id));
      const storedKeysRequest = assetStore.getAllKeys();
      storedKeysRequest.onsuccess = () => {
        for (const key of storedKeysRequest.result) {
          if (!retainedAssetIds.has(String(key))) assetStore.delete(key);
        }
      };
      const metadata: ProjectMetadata = {
        ...project,
        assets: project.assets.map(({ audioData: _audioData, ...asset }) => asset),
      };
      // Avoid rewriting every existing audio blob on every autosave. Repeatedly
      // writing multi-megabyte assets can cause unnecessary memory spikes on mobile.
      let pendingChecks = project.assets.length;
      const finishChecks = () => {
        pendingChecks -= 1;
        if (pendingChecks === 0) projectStore.put(metadata, CURRENT_PROJECT_KEY);
      };
      if (project.assets.length === 0) {
        projectStore.put(metadata, CURRENT_PROJECT_KEY);
      } else {
        for (const asset of project.assets) {
          const check = assetStore.get(asset.id);
          check.onsuccess = () => {
            const existing = check.result as Blob | ArrayBuffer | undefined;
            const next = asset.audioData;
            const sameSize = existing instanceof Blob
              ? existing.size === (next instanceof Blob ? next.size : next.byteLength)
              : existing instanceof ArrayBuffer
                ? existing.byteLength === (next instanceof Blob ? next.size : next.byteLength)
                : false;
            const sameType = !(existing instanceof Blob) || !(next instanceof Blob) || existing.type === next.type;
            if (!sameSize || !sameType) assetStore.put(next, asset.id);
            finishChecks();
          };
          check.onerror = () => {
            assetStore.put(asset.audioData, asset.id);
            finishChecks();
          };
        }
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save project"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Project save was aborted"));
    });
  } finally {
    database.close();
  }
}
