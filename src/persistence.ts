export type SavedAsset = {
  id: string;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  audioData: ArrayBuffer;
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
const CURRENT_PROJECT_KEY = "current";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open project database"));
  });
}

export async function loadSavedProject(): Promise<SavedProject | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(CURRENT_PROJECT_KEY);
      request.onsuccess = () => {
        const value = request.result as SavedProject | undefined;
        if (!value || value.schemaVersion !== 1) {
          resolve(null);
          return;
        }
        resolve(value);
      };
      request.onerror = () => reject(request.error ?? new Error("Could not read saved project"));
    });
  } finally {
    database.close();
  }
}

export async function saveProject(project: SavedProject): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(project, CURRENT_PROJECT_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save project"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Project save was aborted"));
    });
  } finally {
    database.close();
  }
}
