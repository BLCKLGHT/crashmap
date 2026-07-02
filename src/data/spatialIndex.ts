import { isFatalCrash, isSeriousCrash } from "./filterCrashes";
import { getCrashConditionMatch } from "./conditionMatching";
import type {
  CrashRecord,
  CurrentDrivingConditions,
  DashboardLookaheadRisk,
  DriveLocation,
  DriveRiskSummary,
  HistoricalWeatherMatch,
  WeatherMatchMode,
} from "../types/crash";

const CELL_SIZE_DEGREES = 0.01;
const EARTH_RADIUS_METRES = 6371000;
const AHEAD_DISTANCE_METRES = 500;

type IndexedCrash = {
  crash: CrashRecord;
  latitude: number;
  longitude: number;
};

export type LookaheadCrash = {
  crash: CrashRecord;
  forwardMetres: number;
  lateralMetres: number;
  distance: number;
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

const normaliseSpeedZone = (speedZone?: string): string | undefined => {
  if (!speedZone) return undefined;
  const value = speedZone.trim();
  if (!value || /not (known|stated)/i.test(value)) return undefined;

  const numeric = value.match(/\d+/)?.[0];
  if (!numeric) return value;

  const speed = Number(numeric);
  return Number.isFinite(speed) ? String(speed) : value;
};

const getSeverityScore = (crash: CrashRecord): number => {
  if (isFatalCrash(crash)) return 10;
  if (isSeriousCrash(crash)) return 5;
  const severity = crash.severity?.toLowerCase() ?? "";
  if (severity.includes("minor") || severity.includes("injury")) return 2;
  return 1;
};

const classifyLookaheadRisk = (
  totalCrashCount: number,
  seriousCount: number,
  fatalCount: number,
  conditionMatchScore = totalCrashCount,
): Pick<DashboardLookaheadRisk, "riskLevel" | "label" | "message"> => {
  // Initial awareness thresholds, not a live hazard model:
  // high = any fatality, multiple serious crashes, or very heavy total crash history;
  // medium = at least one serious crash or a moderate crash cluster;
  // low = sparse property-only crash history.
  // The total-count threshold is intentionally higher than the drive-mode warning threshold
  // because Dashboard Mode looks 500m ahead on roads with dense historical records.
  if (fatalCount >= 1 || seriousCount >= 2 || conditionMatchScore >= 25) {
    return {
      riskLevel: "high",
      label: "High crash history ahead",
      message:
        fatalCount >= 1
          ? "Fatal crash recorded in this road segment"
          : "High crash history recorded in this road segment",
    };
  }

  if (seriousCount >= 1 || conditionMatchScore >= 8) {
    return {
      riskLevel: "medium",
      label: "Medium crash history ahead",
      message: "Medium crash history recorded in this road segment",
    };
  }

  return {
    riskLevel: "low",
    label: "Low crash history ahead",
    message: "Low crash history recorded in this road segment",
  };
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
  nearby.sort((a, b) => a.distance - b.distance);
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
  let nearbySpeedZone: string | undefined;
  let closestFatalMetres: number | undefined;
  let closestSeriousOrFatalMetres: number | undefined;

  for (const result of nearby) {
    nearbyIds.add(result.crash.id);
    nearbyCrashes.push(result.crash);
    nearbySpeedZone ??= normaliseSpeedZone(result.crash.speedZone);

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
    nearbySpeedZone,
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

export const getDashboardLookaheadCrashes = (
  index: CrashSpatialIndex | null,
  location: DriveLocation | null,
  lookaheadDistanceMetres = 500,
  corridorWidthMetres = 80,
): LookaheadCrash[] => {
  if (!index || !location || typeof location.heading !== "number") return [];

  const heading = ((location.heading % 360) + 360) % 360;
  const searchRadius = Math.hypot(lookaheadDistanceMetres, corridorWidthMetres / 2);
  const candidates = queryRadius(index, location.latitude, location.longitude, searchRadius);
  const headingRadians = toRadians(heading);
  const forwardUnitX = Math.sin(headingRadians);
  const forwardUnitY = Math.cos(headingRadians);
  const halfWidth = corridorWidthMetres / 2;
  const lookahead: LookaheadCrash[] = [];

  for (const result of candidates) {
    const northMetres = (result.crash.latitude - location.latitude) * 111320;
    const eastMetres =
      (result.crash.longitude - location.longitude) *
      111320 *
      Math.max(Math.cos(toRadians(location.latitude)), 0.18);
    const forwardMetres = eastMetres * forwardUnitX + northMetres * forwardUnitY;
    const lateralMetres = Math.abs(eastMetres * forwardUnitY - northMetres * forwardUnitX);

    if (
      forwardMetres <= 0 ||
      forwardMetres > lookaheadDistanceMetres ||
      lateralMetres > halfWidth
    ) {
      continue;
    }

    lookahead.push({
      crash: result.crash,
      forwardMetres,
      lateralMetres,
      distance: result.distance,
    });
  }

  return lookahead.sort((a, b) => {
    const severityDelta = getSeverityScore(b.crash) - getSeverityScore(a.crash);
    return severityDelta || a.forwardMetres - b.forwardMetres;
  });
};

export const getDashboardLookaheadRisk = (
  index: CrashSpatialIndex | null,
  location: DriveLocation | null,
  lookaheadDistanceMetres = 500,
  corridorWidthMetres = 80,
  currentConditions: CurrentDrivingConditions | null = null,
  weatherMode: WeatherMatchMode = "weighted",
  historicalWeatherMatches: Record<string, HistoricalWeatherMatch> = {},
): DashboardLookaheadRisk | null => {
  if (!index || !location) return null;

  const heading =
    typeof location.heading === "number" && Number.isFinite(location.heading)
      ? ((location.heading % 360) + 360) % 360
      : undefined;
  const hasHeading = heading !== undefined;
  const searchRadius = Math.hypot(lookaheadDistanceMetres, corridorWidthMetres / 2);
  const candidates = queryRadius(index, location.latitude, location.longitude, searchRadius);
  const headingRadians = toRadians(heading ?? 0);
  const forwardUnitX = Math.sin(headingRadians);
  const forwardUnitY = Math.cos(headingRadians);
  const halfWidth = corridorWidthMetres / 2;
  const effectiveWeatherMode = currentConditions ? weatherMode : "all";

  let totalCrashCount = 0;
  let seriousCount = 0;
  let fatalCount = 0;
  let propertyDamageCount = 0;
  let nearestCrashDistanceMetres: number | undefined;
  let matchedCrashCount = 0;
  let matchedSeriousCount = 0;
  let matchedFatalCount = 0;
  let wetCrashCount = 0;
  let darkCrashCount = 0;
  let conditionMatchScore = 0;
  let conditionDataCount = 0;

  for (const result of candidates) {
    if (!hasHeading) break;

    const northMetres = (result.crash.latitude - location.latitude) * 111320;
    const eastMetres =
      (result.crash.longitude - location.longitude) *
      111320 *
      Math.max(Math.cos(toRadians(location.latitude)), 0.18);
    const forwardMetres = eastMetres * forwardUnitX + northMetres * forwardUnitY;
    const lateralMetres = Math.abs(eastMetres * forwardUnitY - northMetres * forwardUnitX);

    if (
      forwardMetres <= 0 ||
      forwardMetres > lookaheadDistanceMetres ||
      lateralMetres > halfWidth
    ) {
      continue;
    }

    const conditionMatch = getCrashConditionMatch(result.crash, currentConditions);
    const historicalMatch = historicalWeatherMatches[result.crash.id];
    if (effectiveWeatherMode === "strict" && !conditionMatch.isMatch) continue;
    if (
      effectiveWeatherMode === "similar" &&
      conditionMatch.hasConditionData &&
      !conditionMatch.isMatch
    ) {
      continue;
    }

    totalCrashCount += 1;
    nearestCrashDistanceMetres = Math.min(
      nearestCrashDistanceMetres ?? Number.POSITIVE_INFINITY,
      forwardMetres,
    );

    const isFatal = isFatalCrash(result.crash);
    const isSerious = isSeriousCrash(result.crash);

    if (isFatal) fatalCount += 1;
    else if (isSerious) seriousCount += 1;
    else propertyDamageCount += 1;

    if (conditionMatch.hasConditionData || historicalMatch) conditionDataCount += 1;
    if (conditionMatch.surface === "wet" || historicalMatch?.wetMatch) wetCrashCount += 1;
    if (conditionMatch.light === "dark" || historicalMatch?.lightMatch) darkCrashCount += 1;
    if (conditionMatch.isMatch || historicalMatch?.weatherMatch || historicalMatch?.lightMatch) {
      matchedCrashCount += 1;
      if (isFatal) matchedFatalCount += 1;
      else if (isSerious) matchedSeriousCount += 1;
    }

    const baseScore = getSeverityScore(result.crash);
    const historicalMultiplier = historicalMatch?.scoreMultiplier ?? 1;
    conditionMatchScore +=
      effectiveWeatherMode === "weighted"
        ? baseScore * conditionMatch.weight * historicalMultiplier
        : baseScore * historicalMultiplier;
  }

  const classification = classifyLookaheadRisk(
    totalCrashCount,
    seriousCount,
    fatalCount,
    conditionMatchScore,
  );

  return {
    lookaheadDistanceMetres,
    corridorWidthMetres,
    totalCrashCount,
    seriousCount,
    fatalCount,
    propertyDamageCount,
    matchedCrashCount,
    matchedSeriousCount,
    matchedFatalCount,
    wetCrashCount,
    darkCrashCount,
    conditionMatchScore,
    conditionLabel: currentConditions
      ? `${currentConditions.surfaceCondition} road, ${currentConditions.lightCondition.replace("_", "/")}`
      : undefined,
    conditionDataAvailable: conditionDataCount > 0,
    nearestCrashDistanceMetres:
      nearestCrashDistanceMetres === Number.POSITIVE_INFINITY
        ? undefined
        : nearestCrashDistanceMetres,
    hasHeading,
    ...classification,
  };
};
