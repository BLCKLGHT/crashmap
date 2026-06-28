import { isFatalCrash, isSeriousCrash } from "./filterCrashes";
import type { CrashRecord, DriveLocation, DriveRiskSummary } from "../types/crash";

const CELL_SIZE_DEGREES = 0.01;
const EARTH_RADIUS_METRES = 6371000;
const AHEAD_DISTANCE_METRES = 500;

type IndexedCrash = {
  crash: CrashRecord;
  latitude: number;
  longitude: number;
};

export type CrashSpatialIndex = {
  cells: Map<string, IndexedCrash[]>;
};

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

const cellKey = (latitude: number, longitude: number): string =>
  `${Math.floor(latitude / CELL_SIZE_DEGREES)}:${Math.floor(longitude / CELL_SIZE_DEGREES)}`;

const getCellRange = (latitude: number, longitude: number, radiusMetres: number) => {
  const latDelta = radiusMetres / 111320;
  const lngDelta = radiusMetres / (111320 * Math.max(Math.cos(toRadians(latitude)), 0.18));

  return {
    minLatCell: Math.floor((latitude - latDelta) / CELL_SIZE_DEGREES),
    maxLatCell: Math.floor((latitude + latDelta) / CELL_SIZE_DEGREES),
    minLngCell: Math.floor((longitude - lngDelta) / CELL_SIZE_DEGREES),
    maxLngCell: Math.floor((longitude + lngDelta) / CELL_SIZE_DEGREES),
  };
};

const distanceMetres = (
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number => {
  const deltaLat = toRadians(latitudeB - latitudeA);
  const deltaLng = toRadians(longitudeB - longitudeA);
  const latA = toRadians(latitudeA);
  const latB = toRadians(latitudeB);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(latA) * Math.cos(latB) * Math.sin(deltaLng / 2) ** 2;

  return EARTH_RADIUS_METRES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const projectPoint = (
  latitude: number,
  longitude: number,
  headingDegrees: number,
  distance: number,
): { latitude: number; longitude: number } => {
  const angularDistance = distance / EARTH_RADIUS_METRES;
  const bearing = toRadians(headingDegrees);
  const latA = toRadians(latitude);
  const lngA = toRadians(longitude);

  const latB = Math.asin(
    Math.sin(latA) * Math.cos(angularDistance) +
      Math.cos(latA) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lngB =
    lngA +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latA),
      Math.cos(angularDistance) - Math.sin(latA) * Math.sin(latB),
    );

  return {
    latitude: toDegrees(latB),
    longitude: toDegrees(lngB),
  };
};

const queryRadius = (
  index: CrashSpatialIndex,
  latitude: number,
  longitude: number,
  radiusMetres: number,
): Array<{ crash: CrashRecord; distance: number }> => {
  const range = getCellRange(latitude, longitude, radiusMetres);
  const results: Array<{ crash: CrashRecord; distance: number }> = [];

  for (let latCell = range.minLatCell; latCell <= range.maxLatCell; latCell += 1) {
    for (let lngCell = range.minLngCell; lngCell <= range.maxLngCell; lngCell += 1) {
      const crashes = index.cells.get(`${latCell}:${lngCell}`);
      if (!crashes) continue;

      for (const indexedCrash of crashes) {
        const distance = distanceMetres(
          latitude,
          longitude,
          indexedCrash.latitude,
          indexedCrash.longitude,
        );

        if (distance <= radiusMetres) {
          results.push({ crash: indexedCrash.crash, distance });
        }
      }
    }
  }

  return results;
};

export const createCrashSpatialIndex = (crashes: CrashRecord[]): CrashSpatialIndex => {
  const cells = new Map<string, IndexedCrash[]>();

  for (const crash of crashes) {
    if (!Number.isFinite(crash.latitude) || !Number.isFinite(crash.longitude)) continue;
    const key = cellKey(crash.latitude, crash.longitude);
    const cell = cells.get(key) ?? [];
    cell.push({ crash, latitude: crash.latitude, longitude: crash.longitude });
    cells.set(key, cell);
  }

  return { cells };
};

export const getDriveRiskSummary = (
  index: CrashSpatialIndex | null,
  location: DriveLocation | null,
  radiusMetres = 750,
): DriveRiskSummary | null => {
  if (!index || !location) return null;

  const nearby = queryRadius(index, location.latitude, location.longitude, radiusMetres);
  const aheadPoint =
    typeof location.heading === "number" && Number.isFinite(location.heading)
      ? projectPoint(
          location.latitude,
          location.longitude,
          location.heading,
          AHEAD_DISTANCE_METRES,
        )
      : null;
  const ahead = aheadPoint
    ? queryRadius(index, aheadPoint.latitude, aheadPoint.longitude, radiusMetres)
    : [];

  const nearbyIds = new Set<string>();
  const nearbyCrashes: CrashRecord[] = [];
  let fatalCount = 0;
  let seriousCount = 0;
  let propertyDamageCount = 0;
  let closestFatalMetres: number | undefined;
  let closestSeriousOrFatalMetres: number | undefined;

  for (const result of nearby) {
    nearbyIds.add(result.crash.id);
    nearbyCrashes.push(result.crash);

    if (isFatalCrash(result.crash)) {
      fatalCount += 1;
      closestFatalMetres = Math.min(
        closestFatalMetres ?? Number.POSITIVE_INFINITY,
        result.distance,
      );
      closestSeriousOrFatalMetres = Math.min(
        closestSeriousOrFatalMetres ?? Number.POSITIVE_INFINITY,
        result.distance,
      );
    } else if (isSeriousCrash(result.crash)) {
      seriousCount += 1;
      closestSeriousOrFatalMetres = Math.min(
        closestSeriousOrFatalMetres ?? Number.POSITIVE_INFINITY,
        result.distance,
      );
    } else {
      propertyDamageCount += 1;
    }
  }

  for (const result of ahead) {
    if (nearbyIds.has(result.crash.id)) continue;
    nearbyIds.add(result.crash.id);
    nearbyCrashes.push(result.crash);
  }

  let warningTitle: string | undefined;
  if (fatalCount >= 1) warningTitle = "Fatal crash recorded in this area";
  else if (seriousCount >= 3) warningTitle = "Higher concentration of serious crashes nearby";
  else if (nearby.length >= 15) warningTitle = "Historical crash hotspot nearby";

  return {
    radiusMetres,
    totalCount: nearby.length,
    fatalCount,
    seriousCount,
    propertyDamageCount,
    aheadCount: ahead.length,
    closestFatalMetres:
      closestFatalMetres === Number.POSITIVE_INFINITY ? undefined : closestFatalMetres,
    closestSeriousOrFatalMetres:
      closestSeriousOrFatalMetres === Number.POSITIVE_INFINITY
        ? undefined
        : closestSeriousOrFatalMetres,
    warningTitle,
    warningMessage: warningTitle
      ? "Historical crash data only. Not live navigation or real-time hazard detection."
      : undefined,
    nearbyCrashes,
  };
};
