import type { CrashRecord } from "../types/crash";

const QUERY_URL =
  "https://data.stategrowth.tas.gov.au/ags/rest/services/PUBLIC/CDM_CRASH/FeatureServer/0/query";
const STATIC_CRASH_DATA_URL = "/data/tas-crashes.json";
const PAGE_SIZE = 2000;
const PAGE_BATCH_SIZE = 6;
const DB_NAME = "tasmania-crash-map";
const DB_VERSION = 1;
const STORE_NAME = "crashData";
const CACHE_KEY = "processed-crash-data:v2";

type ArcGisFeature = {
  id?: string | number;
  geometry?: {
    coordinates?: [number, number] | [number, number, number];
  };
  properties?: Record<string, string | number | null | undefined>;
};

type ArcGisGeoJson = {
  features?: ArcGisFeature[];
  error?: {
    message?: string;
    details?: string[];
  };
};

type CachedCrashPayload = {
  fetchedAt: string;
  crashes: CrashRecord[];
};

type StaticCrashPayload = {
  generatedAt?: string;
  encoding?: string;
  dictionaries?: {
    severity?: string[];
    speedZone?: string[];
    surfaceType?: string[];
    lightCondition?: string[];
    locationDescription?: string[];
  };
  crashes?: CrashRecord[] | PackedCrashRecord[];
};

type PackedCrashRecord = [
  id: string,
  latitude: number,
  longitude: number,
  dateTime?: string | number | null,
  severityIndex?: number | null,
  speedZoneIndex?: number | null,
  surfaceTypeIndex?: number | null,
  lightConditionIndex?: number | null,
  locationDescriptionIndex?: number | null,
];

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
      "ID,VCRN,DESCRIPTION,CRASH_DATE_TIME,SEVERITY,SPEED_ZONE,SURFACE_TYPE,LIGHT_CONDITION,LOCATION_DESCRIPTION",
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
  if (!Array.isArray(data.features)) {
    const serviceMessage = [data.error?.message, ...(data.error?.details ?? [])]
      .filter(Boolean)
      .join(" ");
    throw new Error(
      serviceMessage || "Crash data response did not include a feature collection.",
    );
  }
  return data.features ?? [];
};

const getDictionaryValue = (
  values: string[] | undefined,
  index: number | null | undefined,
): string | undefined => {
  if (typeof index !== "number") return undefined;
  return values?.[index];
};

const unpackStaticCrashPayload = (payload: StaticCrashPayload): CrashRecord[] => {
  if (payload.encoding !== "tas-crash-tuples-v1" || !Array.isArray(payload.crashes)) {
    return [];
  }

  return payload.crashes
    .filter((row): row is PackedCrashRecord => Array.isArray(row))
    .map((row) => ({
      id: String(row[0]),
      latitude: row[1],
      longitude: row[2],
      dateTime: asOptionalString(row[3]),
      severity: getDictionaryValue(payload.dictionaries?.severity, row[4]),
      speedZone: getDictionaryValue(payload.dictionaries?.speedZone, row[5]),
      surfaceType: getDictionaryValue(payload.dictionaries?.surfaceType, row[6]),
      lightCondition: getDictionaryValue(payload.dictionaries?.lightCondition, row[7]),
      locationDescription: getDictionaryValue(
        payload.dictionaries?.locationDescription,
        row[8],
      ),
    }));
};

const normaliseCrashRecords = (records: unknown[]): CrashRecord[] =>
  records.filter((record): record is CrashRecord => {
    if (!record || typeof record !== "object") return false;
    const candidate = record as Partial<CrashRecord>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.latitude === "number" &&
      typeof candidate.longitude === "number" &&
      Number.isFinite(candidate.latitude) &&
      Number.isFinite(candidate.longitude)
    );
  });

const normaliseStaticCrashPayload = (payload: unknown): CrashRecord[] => {
  if (Array.isArray(payload)) {
    return normaliseCrashRecords(payload);
  }

  const staticPayload = payload as StaticCrashPayload | null;
  if (!staticPayload) return [];

  const unpackedRecords = unpackStaticCrashPayload(staticPayload);
  if (unpackedRecords.length) return normaliseCrashRecords(unpackedRecords);

  return Array.isArray(staticPayload.crashes)
    ? normaliseCrashRecords(staticPayload.crashes)
    : [];
};

const fetchStaticCrashData = async (
  onProgress?: (loadedCount: number) => void,
): Promise<CrashRecord[]> => {
  const response = await fetch(STATIC_CRASH_DATA_URL, {
    cache: "force-cache",
  });

  if (!response.ok) {
    throw new Error(`Static crash data request failed with status ${response.status}`);
  }

  const records = normaliseStaticCrashPayload(await response.json());
  if (!records.length) {
    throw new Error("Static crash data file contained no usable crash records.");
  }

  onProgress?.(records.length);
  return records;
};

export async function fetchAllTasCrashData(
  onProgress?: (loadedCount: number) => void,
): Promise<CrashRecord[]> {
  try {
    return await fetchStaticCrashData(onProgress);
  } catch (error) {
    console.warn(
      error instanceof Error
        ? `Static crash data unavailable: ${error.message}`
        : "Static crash data unavailable.",
    );
  }

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

  if (!records.length) {
    throw new Error("Crash data request returned no usable crash records.");
  }

  return records;
}

export const readCachedCrashData = async (): Promise<CachedCrashPayload | null> => {
  try {
    const parsed = await runStoreRequest<CachedCrashPayload | undefined>("readonly", (store) =>
      store.get(CACHE_KEY),
    );
    if (!parsed || !Array.isArray(parsed.crashes) || parsed.crashes.length === 0) return null;

    return parsed;
  } catch {
    return null;
  }
};

export const writeCachedCrashData = async (
  crashes: CrashRecord[],
): Promise<CachedCrashPayload> => {
  if (!crashes.length) {
    throw new Error("Refusing to cache an empty crash dataset.");
  }

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
