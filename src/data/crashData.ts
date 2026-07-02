import type { CrashRecord } from "../types/crash";

const QUERY_URL =
  "https://data.stategrowth.tas.gov.au/ags/rest/services/PUBLIC/CDM_CRASH/FeatureServer/0/query";
const PAGE_SIZE = 2000;
const PAGE_BATCH_SIZE = 6;
const DB_NAME = "tasmania-crash-map";
const DB_VERSION = 1;
const STORE_NAME = "crashData";
const CACHE_KEY = "processed-crash-data:v1";

type ArcGisFeature = {
  id?: string | number;
  geometry?: {
    coordinates?: [number, number] | [number, number, number];
  };
  properties?: Record<string, string | number | null | undefined>;
};

type ArcGisGeoJson = {
  features?: ArcGisFeature[];
};

type CachedCrashPayload = {
  fetchedAt: string;
  crashes: CrashRecord[];
};

const openCrashDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const runStoreRequest = async <Result>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<Result>,
): Promise<Result> => {
  const db = await openCrashDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
};

const asOptionalString = (value: unknown): string | undefined => {
  if (value === null || value === undefined || value === "") return undefined;
  return String(value);
};

const getFeatureId = (feature: ArcGisFeature, fallback: number): string => {
  const properties = feature.properties ?? {};
  return String(properties.ID ?? properties.VCRN ?? feature.id ?? `crash-${fallback}`);
};

const toCrashRecord = (feature: ArcGisFeature, fallback: number): CrashRecord | null => {
  const coordinates = feature.geometry?.coordinates;
  const longitude = coordinates?.[0];
  const latitude = coordinates?.[1];

  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return null;
  }

  const properties = feature.properties ?? {};

  return {
    id: getFeatureId(feature, fallback),
    latitude,
    longitude,
    dateTime: asOptionalString(properties.CRASH_DATE_TIME),
    severity: asOptionalString(properties.SEVERITY ?? properties.DESCRIPTION),
    speedZone: asOptionalString(properties.SPEED_ZONE),
    surfaceType: asOptionalString(properties.SURFACE_TYPE),
    lightCondition: asOptionalString(properties.LIGHT_CONDITION),
    weatherCondition: asOptionalString(properties.WEATHER_CONDITION),
    locationDescription: asOptionalString(properties.LOCATION_DESCRIPTION),
  };
};

const buildQueryUrl = (resultOffset: number): string => {
  const params = new URLSearchParams({
    where: "1=1",
    outFields:
      "ID,VCRN,DESCRIPTION,CRASH_DATE_TIME,SEVERITY,SPEED_ZONE,SURFACE_TYPE,LIGHT_CONDITION,WEATHER_CONDITION,LOCATION_DESCRIPTION",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
    resultRecordCount: String(PAGE_SIZE),
    resultOffset: String(resultOffset),
  });

  return `${QUERY_URL}?${params.toString()}`;
};

const fetchCrashPage = async (resultOffset: number): Promise<ArcGisFeature[]> => {
  const response = await fetch(buildQueryUrl(resultOffset));

  if (!response.ok) {
    throw new Error(`Crash data request failed with status ${response.status}`);
  }

  const data = (await response.json()) as ArcGisGeoJson;
  return data.features ?? [];
};

export async function fetchAllTasCrashData(
  onProgress?: (loadedCount: number) => void,
): Promise<CrashRecord[]> {
  const records: CrashRecord[] = [];
  let resultOffset = 0;

  while (true) {
    const offsets = Array.from(
      { length: PAGE_BATCH_SIZE },
      (_, index) => resultOffset + index * PAGE_SIZE,
    );
    const pages = await Promise.all(offsets.map(fetchCrashPage));
    let foundLastPage = false;

    for (const features of pages) {
      for (const feature of features) {
        const record = toCrashRecord(feature, records.length);
        if (record) records.push(record);
      }

      onProgress?.(records.length);

      if (features.length < PAGE_SIZE) {
        foundLastPage = true;
        break;
      }
    }

    if (foundLastPage) break;
    resultOffset += PAGE_SIZE * PAGE_BATCH_SIZE;
  }

  return records;
}

export const readCachedCrashData = async (): Promise<CachedCrashPayload | null> => {
  try {
    const parsed = await runStoreRequest<CachedCrashPayload | undefined>("readonly", (store) =>
      store.get(CACHE_KEY),
    );
    if (!parsed || !Array.isArray(parsed.crashes)) return null;

    return parsed;
  } catch {
    return null;
  }
};

export const writeCachedCrashData = async (
  crashes: CrashRecord[],
): Promise<CachedCrashPayload> => {
  const payload = {
    fetchedAt: new Date().toISOString(),
    crashes,
  };

  await runStoreRequest("readwrite", (store) => store.put(payload, CACHE_KEY));
  return payload;
};

export const clearCachedCrashData = async (): Promise<void> => {
  await runStoreRequest("readwrite", (store) => store.delete(CACHE_KEY));
};
