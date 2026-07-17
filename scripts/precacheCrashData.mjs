import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const QUERY_URL =
  "https://data.stategrowth.tas.gov.au/ags/rest/services/PUBLIC/CDM_CRASH/FeatureServer/0/query";
const PAGE_SIZE = 2000;
const PAGE_BATCH_SIZE = 6;
const OUTPUT_PATH = resolve("public/data/tas-crashes.json");

const asOptionalString = (value) => {
  if (value === null || value === undefined || value === "") return undefined;
  return String(value);
};

const getFeatureId = (feature, fallback) => {
  const properties = feature.properties ?? {};
  return String(properties.ID ?? properties.VCRN ?? feature.id ?? `crash-${fallback}`);
};

const toCrashRecord = (feature, fallback) => {
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

const buildQueryUrl = (resultOffset) => {
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

const fetchCrashPage = async (resultOffset) => {
  const response = await fetch(buildQueryUrl(resultOffset));

  if (!response.ok) {
    throw new Error(`Crash data request failed with status ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data.features)) {
    throw new Error("Crash data response did not include a feature collection.");
  }

  return data.features;
};

const fetchAllCrashData = async () => {
  const records = [];
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

      console.log(`Crash data precache: ${records.length.toLocaleString("en-AU")} records`);

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
};

const main = async () => {
  if (process.env.SKIP_CRASH_DATA_PRECACHE === "1") {
    console.log("Crash data precache skipped via SKIP_CRASH_DATA_PRECACHE=1.");
    return;
  }

  try {
    const crashes = await fetchAllCrashData();
    const payload = {
      schemaVersion: 1,
      source: QUERY_URL,
      generatedAt: new Date().toISOString(),
      count: crashes.length,
      crashes,
    };

    await mkdir(dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, JSON.stringify(payload));
    console.log(
      `Crash data precache wrote ${crashes.length.toLocaleString("en-AU")} records to ${OUTPUT_PATH}`,
    );
  } catch (error) {
    console.warn(
      `Crash data precache failed; app will fall back to live ArcGIS pagination. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

await main();
