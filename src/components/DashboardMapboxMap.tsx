import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { GeoJSONSource, Map as MapboxMap } from "mapbox-gl";
import type {
  CrashRecord,
  DashboardDrivingState,
  DriveLocation,
  WarningRoadSegment,
} from "../types/crash";
import { DashboardMiniMap } from "./DashboardMiniMap";

type DashboardMapboxMapProps = {
  location: DriveLocation | null;
  drivingState: DashboardDrivingState;
  isActive: boolean;
  nearbyCrashes: CrashRecord[];
  onSpeedLimitChange?: (speedLimitKmh: number | null) => void;
};

type SmoothedDriveState = {
  latitude: number;
  longitude: number;
  heading: number;
  speedKmh: number;
  timestamp: number;
};

type TracePoint = {
  latitude: number;
  longitude: number;
  timestamp: number;
};

type WarningFeatureProperties = {
  id: string;
  warningLevel: WarningRoadSegment["warningLevel"];
  warningColour: WarningRoadSegment["warningColour"];
  startDistanceMetres: number;
  endDistanceMetres: number;
  score: number;
  sourceTimestamp: number;
};

type WarningFeature = GeoJSON.Feature<GeoJSON.LineString, WarningFeatureProperties>;
type WarningFeatureCollection = GeoJSON.FeatureCollection<
  GeoJSON.LineString,
  WarningFeatureProperties
>;
type MapboxMaxspeed = {
  speed?: number;
  unit?: "km/h" | "mph";
  unknown?: boolean;
  none?: boolean;
};

const DRIVE_CAMERA_PITCH = 60;
const DRIVE_CAMERA_ZOOM = 16.5;
const VEHICLE_SCREEN_Y_RATIO = 0.74;
const MIN_CAMERA_MOVE_METRES = 3;
const MIN_CAMERA_HEADING_DEGREES = 2;
const MAX_CAMERA_UPDATE_MS = 1000;
const LOCATION_SMOOTHING = 0.22;
const SPEED_SMOOTHING = 0.18;
const HEADING_SMOOTHING = 0.16;
const STATIONARY_SPEED_KMH = 5;
const DEFAULT_CENTRE: [number, number] = [146.6, -42.05];
const SOURCE_ID = "dashboard-warning-road";
const GLOW_LAYER_ID = "dashboard-warning-road-glow";
const CORE_LAYER_ID = "dashboard-warning-road-core";
const FATAL_SOURCE_ID = "dashboard-fatal-crashes";
const FATAL_GLOW_LAYER_ID = "dashboard-fatal-crashes-glow";
const FATAL_CORE_LAYER_ID = "dashboard-fatal-crashes-core";
const MAP_MATCH_MIN_INTERVAL_MS = 4500;
const MAP_MATCH_MIN_TRACE_POINTS = 4;
const MAX_TRACE_POINTS = 10;
const MAP_LOAD_TIMEOUT_MS = 3500;
const TERRAIN_SOURCE_ID = "dashboard-mapbox-terrain";
const BUILDINGS_LAYER_ID = "dashboard-mapbox-buildings";
const ROUTE_AHEAD_MIN_INTERVAL_MS = 3500;
const ROUTE_AHEAD_MIN_MOVE_METRES = 18;
const ROUTE_AHEAD_MIN_HEADING_DEGREES = 8;

const getMapboxToken = (): string | undefined => {
  const meta = import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  };
  return (
    meta.env?.VITE_MAPBOX_ACCESS_TOKEN ||
    meta.env?.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN ||
    meta.env?.PUBLIC_MAPBOX_ACCESS_TOKEN
  );
};

const fetchRuntimeMapboxToken = async (): Promise<string | null> => {
  const response = await fetch("/api/mapbox-token", {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { token?: string };
  return payload.token?.startsWith("pk.") ? payload.token : null;
};

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

const normaliseHeading = (heading: number): number => ((heading % 360) + 360) % 360;

const getHeadingDelta = (from: number, to: number): number =>
  ((((to - from) % 360) + 540) % 360) - 180;

const smoothHeading = (current: number, next: number, amount: number): number =>
  normaliseHeading(current + getHeadingDelta(current, next) * amount);

const getDistanceMetres = (
  fromLatitude: number,
  fromLongitude: number,
  toLatitude: number,
  toLongitude: number,
): number => {
  const earthRadius = 6_371_000;
  const fromLat = toRadians(fromLatitude);
  const toLat = toRadians(toLatitude);
  const deltaLat = toRadians(toLatitude - fromLatitude);
  const deltaLng = toRadians(toLongitude - fromLongitude);
  const value =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLng / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};

const getBearingDegrees = (
  fromLatitude: number,
  fromLongitude: number,
  toLatitude: number,
  toLongitude: number,
): number => {
  const fromLat = toRadians(fromLatitude);
  const toLat = toRadians(toLatitude);
  const deltaLng = toRadians(toLongitude - fromLongitude);
  const y = Math.sin(deltaLng) * Math.cos(toLat);
  const x =
    Math.cos(fromLat) * Math.sin(toLat) -
    Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLng);
  return normaliseHeading(toDegrees(Math.atan2(y, x)));
};

const getPointAhead = (
  latitude: number,
  longitude: number,
  heading: number,
  distanceMetres: number,
): { latitude: number; longitude: number } => {
  const angularDistance = distanceMetres / 6_371_000;
  const bearing = toRadians(heading);
  const latitudeRadians = toRadians(latitude);
  const longitudeRadians = toRadians(longitude);
  const nextLatitude = Math.asin(
    Math.sin(latitudeRadians) * Math.cos(angularDistance) +
      Math.cos(latitudeRadians) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const nextLongitude =
    longitudeRadians +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitudeRadians),
      Math.cos(angularDistance) - Math.sin(latitudeRadians) * Math.sin(nextLatitude),
    );

  return {
    latitude: toDegrees(nextLatitude),
    longitude: toDegrees(nextLongitude),
  };
};

const getCameraSettings = (speedKmh: number): { zoom: number; pitch: number; aheadMetres: number } => {
  const speed = Math.max(0, speedKmh);
  if (speed <= 20) {
    return { zoom: 17.5, pitch: 50, aheadMetres: 75 };
  }
  if (speed <= 60) {
    const ratio = (speed - 20) / 40;
    return {
      zoom: 17.5 + (17 - 17.5) * ratio,
      pitch: 50 + (55 - 50) * ratio,
      aheadMetres: 75 + (130 - 75) * ratio,
    };
  }
  if (speed <= 100) {
    const ratio = (speed - 60) / 40;
    return {
      zoom: 17 + (16.3 - 17) * ratio,
      pitch: 55 + (DRIVE_CAMERA_PITCH - 55) * ratio,
      aheadMetres: 130 + (230 - 130) * ratio,
    };
  }

  const ratio = Math.min((speed - 100) / 30, 1);
  return {
    zoom: 16.3 + (15.8 - 16.3) * ratio,
    pitch: DRIVE_CAMERA_PITCH + (62 - DRIVE_CAMERA_PITCH) * ratio,
    aheadMetres: 230 + (330 - 230) * ratio,
  };
};

const getCurrentLocation = (
  location: DriveLocation | null,
  drivingState: DashboardDrivingState,
): SmoothedDriveState | null => {
  if (!location) return null;
  const snapped = drivingState.snappedPosition;
  return {
    latitude: snapped?.latitude ?? location.latitude,
    longitude: snapped?.longitude ?? location.longitude,
    heading:
      typeof drivingState.heading === "number"
        ? drivingState.heading
        : typeof location.heading === "number"
          ? location.heading
          : 0,
    speedKmh:
      typeof drivingState.currentSpeed === "number"
        ? drivingState.currentSpeed
        : typeof location.speed === "number"
          ? Math.max(0, location.speed * 3.6)
          : 0,
    timestamp: location.timestamp,
  };
};

const buildCorridorLine = (
  origin: SmoothedDriveState,
  heading: number,
  startDistance: number,
  endDistance: number,
): GeoJSON.LineString => {
  const coordinates: number[][] = [];
  const length = Math.max(20, endDistance - startDistance);
  const steps = Math.max(2, Math.ceil(length / 45));

  for (let index = 0; index <= steps; index += 1) {
    const progress = index / steps;
    const distance = startDistance + length * progress;
    const gentleBend = Math.sin(progress * Math.PI) * 4;
    const point = getPointAhead(origin.latitude, origin.longitude, heading + gentleBend, distance);
    coordinates.push([point.longitude, point.latitude]);
  }

  return {
    type: "LineString",
    coordinates,
  };
};

const getWarningScore = (level: WarningRoadSegment["warningLevel"]): number => {
  if (level === "high") return 1;
  if (level === "medium") return 0.62;
  return 0.25;
};

const getSpeedLimitFromMaxspeed = (maxspeeds?: MapboxMaxspeed[]): number | null => {
  if (!maxspeeds?.length) return null;

  for (const maxspeed of maxspeeds) {
    if (maxspeed.unknown || maxspeed.none) continue;
    if (typeof maxspeed.speed !== "number" || !Number.isFinite(maxspeed.speed)) continue;
    if (maxspeed.unit === "mph") return Math.round(maxspeed.speed * 1.60934);
    return Math.round(maxspeed.speed);
  }

  return null;
};

const interpolateCoordinate = (
  from: number[],
  to: number[],
  ratio: number,
): number[] => [
  from[0] + (to[0] - from[0]) * ratio,
  from[1] + (to[1] - from[1]) * ratio,
];

const sliceLineByDistance = (
  geometry: GeoJSON.LineString,
  startDistanceMetres: number,
  endDistanceMetres: number,
): GeoJSON.LineString | null => {
  const coordinates = geometry.coordinates;
  if (coordinates.length < 2 || endDistanceMetres <= startDistanceMetres) return null;

  const sliced: number[][] = [];
  let travelledMetres = 0;

  for (let index = 1; index < coordinates.length; index += 1) {
    const from = coordinates[index - 1];
    const to = coordinates[index];
    const segmentDistance = getDistanceMetres(from[1], from[0], to[1], to[0]);
    const segmentStart = travelledMetres;
    const segmentEnd = travelledMetres + segmentDistance;

    if (segmentEnd >= startDistanceMetres && segmentStart <= endDistanceMetres) {
      const startRatio =
        segmentDistance > 0
          ? Math.max(0, (startDistanceMetres - segmentStart) / segmentDistance)
          : 0;
      const endRatio =
        segmentDistance > 0
          ? Math.min(1, (endDistanceMetres - segmentStart) / segmentDistance)
          : 1;
      const start = interpolateCoordinate(from, to, startRatio);
      const end = interpolateCoordinate(from, to, endRatio);

      if (!sliced.length) sliced.push(start);
      sliced.push(end);
    }

    travelledMetres = segmentEnd;
    if (travelledMetres > endDistanceMetres) break;
  }

  return sliced.length >= 2
    ? {
        type: "LineString",
        coordinates: sliced,
      }
    : null;
};

const getLineDistanceMetres = (geometry: GeoJSON.LineString): number =>
  geometry.coordinates.reduce((total, coordinate, index, coordinates) => {
    if (index === 0) return total;
    const previous = coordinates[index - 1];
    return total + getDistanceMetres(previous[1], previous[0], coordinate[1], coordinate[0]);
  }, 0);

const getNearestRoutePoint = (
  geometry: GeoJSON.LineString | null,
  location: SmoothedDriveState,
): SmoothedDriveState => {
  if (!geometry?.coordinates.length) return location;

  let nearest = geometry.coordinates[0];
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const coordinate of geometry.coordinates) {
    const distance = getDistanceMetres(
      location.latitude,
      location.longitude,
      coordinate[1],
      coordinate[0],
    );
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = coordinate;
    }
  }

  if (nearestDistance > 65) return location;

  return {
    ...location,
    latitude: nearest[1],
    longitude: nearest[0],
  };
};

const buildFallbackSegments = (
  origin: SmoothedDriveState | null,
  drivingState: DashboardDrivingState,
  routeAheadGeometry: GeoJSON.LineString | null,
): WarningRoadSegment[] => {
  if (!origin) return [];
  if (drivingState.warningRoadSegments?.length) return drivingState.warningRoadSegments;

  const speed = drivingState.currentSpeed ?? origin.speedKmh;
  const lookaheadDistance = speed > 80 ? 1500 : speed > 40 ? 1000 : 500;
  const heading = typeof drivingState.heading === "number" ? drivingState.heading : origin.heading;
  const now = drivingState.riskTimestamp ?? Date.now();
  const warningDistance = drivingState.distanceToUpcomingWarningMetres;
  const warningLevel = drivingState.upcomingWarningLevel;
  const routeGeometry =
    routeAheadGeometry && routeAheadGeometry.coordinates.length >= 2
      ? routeAheadGeometry
      : null;
  const routeDistance = routeGeometry ? getLineDistanceMetres(routeGeometry) : 0;
  const contextGeometry = routeGeometry
    ? sliceLineByDistance(routeGeometry, 0, Math.min(lookaheadDistance, routeDistance))
    : null;

  const segments: WarningRoadSegment[] = [
    {
      id: "dashboard-road-context",
      geometry: contextGeometry ?? buildCorridorLine(origin, heading, 0, lookaheadDistance),
      warningLevel: "low",
      warningColour: "blue",
      startDistanceMetres: 0,
      endDistanceMetres: lookaheadDistance,
      score: getWarningScore("low"),
      sourceTimestamp: now,
    },
  ];

  if (
    warningLevel !== "low" &&
    typeof warningDistance === "number" &&
    warningDistance <= lookaheadDistance
  ) {
    const startDistance = Math.max(0, warningDistance);
    const endDistance = Math.min(lookaheadDistance, startDistance + 260);
    const warningGeometry = routeGeometry
      ? sliceLineByDistance(routeGeometry, startDistance, Math.min(endDistance, routeDistance))
      : null;
    segments.push({
      id: `dashboard-${warningLevel}-${Math.round(startDistance / 10) * 10}`,
      geometry: warningGeometry ?? buildCorridorLine(origin, heading, startDistance, endDistance),
      warningLevel,
      warningColour: drivingState.upcomingWarningColour,
      startDistanceMetres: startDistance,
      endDistanceMetres: endDistance,
      score: getWarningScore(warningLevel),
      sourceTimestamp: now,
    });
  }

  return segments;
};

const toFeatureCollection = (segments: WarningRoadSegment[]): WarningFeatureCollection => ({
  type: "FeatureCollection",
  features: segments.map((segment): WarningFeature => ({
    type: "Feature",
    properties: {
      id: segment.id,
      warningLevel: segment.warningLevel,
      warningColour: segment.warningColour,
      startDistanceMetres: segment.startDistanceMetres,
      endDistanceMetres: segment.endDistanceMetres,
      score: segment.score,
      sourceTimestamp: segment.sourceTimestamp,
    },
    geometry: segment.geometry,
  })),
});

const createEmptyFeatureCollection = (): WarningFeatureCollection => ({
  type: "FeatureCollection",
  features: [],
});

const isFatalCrashRecord = (crash: CrashRecord): boolean =>
  (crash.severity ?? "").toLowerCase().includes("fatal");

const toFatalFeatureCollection = (
  crashes: CrashRecord[],
): GeoJSON.FeatureCollection<GeoJSON.Point> => ({
  type: "FeatureCollection",
  features: crashes
    .filter(isFatalCrashRecord)
    .map((crash) => ({
      type: "Feature",
      properties: {
        id: crash.id,
        severity: crash.severity ?? "Fatal",
      },
      geometry: {
        type: "Point",
        coordinates: [crash.longitude, crash.latitude],
      },
    })),
});

const applyCamera = (map: MapboxMap, smoothed: SmoothedDriveState): void => {
  const camera = getCameraSettings(smoothed.speedKmh);
  const centreAhead = getPointAhead(
    smoothed.latitude,
    smoothed.longitude,
    smoothed.heading,
    camera.aheadMetres,
  );

  map.stop();
  map.easeTo({
    center: [centreAhead.longitude, centreAhead.latitude],
    bearing: smoothed.heading,
    pitch: camera.pitch,
    zoom: camera.zoom,
    duration: 520,
    easing: (time) => 1 - (1 - time) ** 3,
    essential: true,
  });
};

const addMapbox3dContext = (map: MapboxMap): void => {
  try {
    if (!map.getSource(TERRAIN_SOURCE_ID)) {
      map.addSource(TERRAIN_SOURCE_ID, {
        type: "raster-dem",
        url: "mapbox://mapbox.mapbox-terrain-dem-v1",
        tileSize: 512,
        maxzoom: 14,
      });
    }
    map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: 1 });
  } catch {
    // Terrain support depends on the loaded style and token permissions.
  }

  try {
    if (map.getLayer(BUILDINGS_LAYER_ID)) return;
    const labelLayer = map
      .getStyle()
      .layers?.find(
        (layer) =>
          layer.type === "symbol" &&
          typeof layer.layout?.["text-field"] !== "undefined",
      )?.id;

    map.addLayer(
      {
        id: BUILDINGS_LAYER_ID,
        source: "composite",
        "source-layer": "building",
        filter: ["==", ["get", "extrude"], "true"],
        type: "fill-extrusion",
        minzoom: 15,
        paint: {
          "fill-extrusion-color": "rgba(148, 163, 184, 0.34)",
          "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 15, 0, 16, ["get", "height"]],
          "fill-extrusion-base": ["interpolate", ["linear"], ["zoom"], 15, 0, 16, ["get", "min_height"]],
          "fill-extrusion-opacity": 0.24,
        },
      },
      labelLayer,
    );
  } catch {
    // Some Mapbox styles do not expose a composite building source.
  }
};

export function DashboardMapboxMap({
  location,
  drivingState,
  isActive,
  nearbyCrashes,
  onSpeedLimitChange,
}: DashboardMapboxMapProps) {
  const buildTimeToken = getMapboxToken();
  const [runtimeToken, setRuntimeToken] = useState<string | null>(buildTimeToken ?? null);
  const token = runtimeToken ?? buildTimeToken;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const smoothedRef = useRef<SmoothedDriveState | null>(null);
  const lastCameraRef = useRef<{
    latitude: number;
    longitude: number;
    heading: number;
    time: number;
  } | null>(null);
  const traceRef = useRef<TracePoint[]>([]);
  const lastMatchRef = useRef<{ time: number; status: string }>({ time: 0, status: "idle" });
  const lastRouteRef = useRef<{
    time: number;
    latitude: number;
    longitude: number;
    heading: number;
    status: string;
  } | null>(null);
  const sourceUpdatesRef = useRef(0);
  const warningSegmentsRef = useRef<WarningRoadSegment[]>([]);
  const fatalCrashesRef = useRef<CrashRecord[]>([]);
  const [status, setStatus] = useState(token ? "loading" : "checking-token");
  const [isMapReady, setIsMapReady] = useState(false);
  const [routeAheadGeometry, setRouteAheadGeometry] = useState<GeoJSON.LineString | null>(null);

  const currentLocation = useMemo(
    () => {
      const rawLocation = getCurrentLocation(location, drivingState);
      return rawLocation ? getNearestRoutePoint(routeAheadGeometry, rawLocation) : null;
    },
    [drivingState, location, routeAheadGeometry],
  );

  const warningSegments = useMemo(
    () => buildFallbackSegments(currentLocation, drivingState, routeAheadGeometry),
    [currentLocation, drivingState, routeAheadGeometry],
  );
  warningSegmentsRef.current = warningSegments;
  fatalCrashesRef.current = nearbyCrashes;

  useEffect(() => {
    if (buildTimeToken || runtimeToken) return;

    let isCancelled = false;
    setStatus("checking-token");
    void fetchRuntimeMapboxToken()
      .then((nextToken) => {
        if (isCancelled) return;
        if (nextToken) {
          setRuntimeToken(nextToken);
          setStatus("loading");
        } else {
          setStatus("missing-token");
        }
      })
      .catch(() => {
        if (!isCancelled) setStatus("missing-token");
      });

    return () => {
      isCancelled = true;
    };
  }, [buildTimeToken, runtimeToken]);

  useEffect(() => {
    if (!token || !containerRef.current || mapRef.current) return;

    let isCancelled = false;
    let createdMap: MapboxMap | null = null;
    const loadTimeout = window.setTimeout(() => {
      setStatus((current) => (current === "ready" ? current : "load-timeout"));
    }, MAP_LOAD_TIMEOUT_MS);

    void import("mapbox-gl")
      .then((module) => {
        if (isCancelled || !containerRef.current) return;
        const mapboxgl = module.default;
        mapboxgl.accessToken = token;
        const map = new mapboxgl.Map({
          container: containerRef.current,
          style: "mapbox://styles/mapbox/navigation-night-v1",
          center: currentLocation
            ? [currentLocation.longitude, currentLocation.latitude]
            : DEFAULT_CENTRE,
          zoom: currentLocation ? DRIVE_CAMERA_ZOOM : 6.5,
          pitch: currentLocation ? DRIVE_CAMERA_PITCH : 0,
          bearing: currentLocation?.heading ?? 0,
          attributionControl: false,
          interactive: false,
          antialias: true,
        });
        createdMap = map;

        map.addControl(
          new mapboxgl.AttributionControl({
            compact: true,
            customAttribution: "Mapbox",
          }),
        );

        map.on("load", () => {
          window.clearTimeout(loadTimeout);
          addMapbox3dContext(map);
          map.addSource(SOURCE_ID, {
            type: "geojson",
            data: toFeatureCollection(warningSegmentsRef.current),
            lineMetrics: true,
          });
          map.addSource(FATAL_SOURCE_ID, {
            type: "geojson",
            data: toFatalFeatureCollection(fatalCrashesRef.current),
          });
          map.addLayer({
            id: GLOW_LAYER_ID,
            type: "line",
            source: SOURCE_ID,
            layout: {
              "line-cap": "round",
              "line-join": "round",
            },
            paint: {
              "line-color": [
                "match",
                ["get", "warningColour"],
                "red",
                "#ef4444",
                "orange",
                "#f97316",
                "blue",
                "#38bdf8",
                "#38bdf8",
              ],
              "line-width": [
                "interpolate",
                ["linear"],
                ["zoom"],
                14,
                12,
                18,
                22,
              ],
              "line-opacity": [
                "interpolate",
                ["linear"],
                ["get", "startDistanceMetres"],
                0,
                0.46,
                300,
                0.36,
                1000,
                0.24,
              ],
              "line-blur": 2.2,
            },
          });
          map.addLayer({
            id: CORE_LAYER_ID,
            type: "line",
            source: SOURCE_ID,
            layout: {
              "line-cap": "round",
              "line-join": "round",
            },
            paint: {
              "line-color": [
                "match",
                ["get", "warningColour"],
                "red",
                "#f87171",
                "orange",
                "#fb923c",
                "blue",
                "#7dd3fc",
                "#7dd3fc",
              ],
              "line-width": [
                "interpolate",
                ["linear"],
                ["zoom"],
                14,
                5,
                18,
                10,
              ],
              "line-opacity": [
                "interpolate",
                ["linear"],
                ["get", "startDistanceMetres"],
                0,
                0.96,
                300,
                0.84,
                1000,
                0.68,
              ],
            },
          });
          map.addLayer({
            id: FATAL_GLOW_LAYER_ID,
            type: "circle",
            source: FATAL_SOURCE_ID,
            paint: {
              "circle-radius": [
                "interpolate",
                ["linear"],
                ["zoom"],
                14,
                10,
                18,
                22,
              ],
              "circle-color": "#ef4444",
              "circle-opacity": 0.26,
              "circle-blur": 0.45,
            },
          });
          map.addLayer({
            id: FATAL_CORE_LAYER_ID,
            type: "circle",
            source: FATAL_SOURCE_ID,
            paint: {
              "circle-radius": [
                "interpolate",
                ["linear"],
                ["zoom"],
                14,
                4,
                18,
                8,
              ],
              "circle-color": "#ef4444",
              "circle-stroke-color": "rgba(255, 255, 255, 0.92)",
              "circle-stroke-width": 1.8,
              "circle-opacity": 0.96,
            },
          });
          setStatus("ready");
          setIsMapReady(true);
          window.requestAnimationFrame(() => {
            map.resize();
            if (smoothedRef.current) applyCamera(map, smoothedRef.current);
          });
        });

        map.on("error", (event) => {
          setStatus(event.error?.message ?? "mapbox-error");
        });

        mapRef.current = map;
      })
      .catch(() => {
        setStatus("mapbox-load-failed");
      });

    return () => {
      window.clearTimeout(loadTimeout);
      isCancelled = true;
      createdMap?.remove();
      mapRef.current = null;
      setIsMapReady(false);
    };
  }, [token]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady || !map.isStyleLoaded()) return;
    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;

    source.setData(toFeatureCollection(warningSegments));
    sourceUpdatesRef.current += 1;
  }, [isMapReady, warningSegments]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady || !map.isStyleLoaded()) return;
    const source = map.getSource(FATAL_SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;

    source.setData(toFatalFeatureCollection(nearbyCrashes));
  }, [isMapReady, nearbyCrashes]);

  useEffect(() => {
    if (!token || !currentLocation || !isActive) return;

    const now = Date.now();
    const lastRoute = lastRouteRef.current;
    const movedMetres = lastRoute
      ? getDistanceMetres(
          lastRoute.latitude,
          lastRoute.longitude,
          currentLocation.latitude,
          currentLocation.longitude,
        )
      : Number.POSITIVE_INFINITY;
    const headingDelta = lastRoute
      ? Math.abs(getHeadingDelta(lastRoute.heading, currentLocation.heading))
      : Number.POSITIVE_INFINITY;

    if (
      lastRoute &&
      now - lastRoute.time < ROUTE_AHEAD_MIN_INTERVAL_MS &&
      movedMetres < ROUTE_AHEAD_MIN_MOVE_METRES &&
      headingDelta < ROUTE_AHEAD_MIN_HEADING_DEGREES
    ) {
      return;
    }

    const speed = drivingState.currentSpeed ?? currentLocation.speedKmh;
    const lookaheadDistance = speed > 80 ? 1500 : speed > 40 ? 1000 : 650;
    const destination = getPointAhead(
      currentLocation.latitude,
      currentLocation.longitude,
      currentLocation.heading,
      lookaheadDistance,
    );
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${currentLocation.longitude.toFixed(
      6,
    )},${currentLocation.latitude.toFixed(6)};${destination.longitude.toFixed(
      6,
    )},${destination.latitude.toFixed(
      6,
    )}?geometries=geojson&overview=full&steps=false&alternatives=false&annotations=maxspeed&access_token=${token}`;

    lastRouteRef.current = {
      time: now,
      latitude: currentLocation.latitude,
      longitude: currentLocation.longitude,
      heading: currentLocation.heading,
      status: "checking",
    };

    const controller = new AbortController();
    void fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Directions failed with ${response.status}`);
        return response.json() as Promise<{
          routes?: Array<{
            geometry?: GeoJSON.LineString;
            legs?: Array<{ annotation?: { maxspeed?: MapboxMaxspeed[] } }>;
          }>;
        }>;
      })
      .then((payload) => {
        const route = payload.routes?.[0];
        const geometry = route?.geometry;
        const speedLimit = getSpeedLimitFromMaxspeed(route?.legs?.[0]?.annotation?.maxspeed);
        onSpeedLimitChange?.(speedLimit);
        if (geometry?.coordinates.length && geometry.coordinates.length >= 2) {
          setRouteAheadGeometry(geometry);
          lastRouteRef.current = {
            time: now,
            latitude: currentLocation.latitude,
            longitude: currentLocation.longitude,
            heading: currentLocation.heading,
            status: "ready",
          };
        }
      })
      .catch((error) => {
        if ((error as Error).name === "AbortError") return;
        lastRouteRef.current = {
          time: now,
          latitude: currentLocation.latitude,
          longitude: currentLocation.longitude,
          heading: currentLocation.heading,
          status: "failed",
        };
        onSpeedLimitChange?.(null);
        if (import.meta.env.DEV) setStatus("directions-failed");
      });

    return () => controller.abort();
  }, [currentLocation, drivingState.currentSpeed, isActive, onSpeedLimitChange, token]);

  useEffect(() => {
    if (!currentLocation) return;

    const previous = smoothedRef.current;
    if (!previous) {
      smoothedRef.current = currentLocation;
      return;
    }

    const movedMetres = getDistanceMetres(
      previous.latitude,
      previous.longitude,
      currentLocation.latitude,
      currentLocation.longitude,
    );
    const inferredHeading =
      movedMetres >= MIN_CAMERA_MOVE_METRES
        ? getBearingDegrees(
            previous.latitude,
            previous.longitude,
            currentLocation.latitude,
            currentLocation.longitude,
          )
        : previous.heading;
    const rawHeading =
      currentLocation.speedKmh >= STATIONARY_SPEED_KMH
        ? currentLocation.heading || inferredHeading
        : previous.heading;

    smoothedRef.current = {
      latitude:
        previous.latitude + (currentLocation.latitude - previous.latitude) * LOCATION_SMOOTHING,
      longitude:
        previous.longitude + (currentLocation.longitude - previous.longitude) * LOCATION_SMOOTHING,
      heading: smoothHeading(previous.heading, rawHeading, HEADING_SMOOTHING),
      speedKmh: previous.speedKmh + (currentLocation.speedKmh - previous.speedKmh) * SPEED_SMOOTHING,
      timestamp: currentLocation.timestamp,
    };
  }, [currentLocation]);

  useEffect(() => {
    const map = mapRef.current;
    const smoothed = smoothedRef.current;
    if (!map || !isMapReady || !isActive || !smoothed) return;

    const now = Date.now();
    const last = lastCameraRef.current;
    const movedMetres = last
      ? getDistanceMetres(last.latitude, last.longitude, smoothed.latitude, smoothed.longitude)
      : Number.POSITIVE_INFINITY;
    const headingDelta = last
      ? Math.abs(getHeadingDelta(last.heading, smoothed.heading))
      : Number.POSITIVE_INFINITY;

    if (
      last &&
      movedMetres < MIN_CAMERA_MOVE_METRES &&
      headingDelta < MIN_CAMERA_HEADING_DEGREES &&
      now - last.time < MAX_CAMERA_UPDATE_MS
    ) {
      return;
    }

    applyCamera(map, smoothed);

    lastCameraRef.current = {
      latitude: smoothed.latitude,
      longitude: smoothed.longitude,
      heading: smoothed.heading,
      time: now,
    };
  }, [currentLocation, isActive, isMapReady]);

  useEffect(() => {
    if (!token || !currentLocation || !isActive) return;

    traceRef.current = [
      ...traceRef.current,
      {
        latitude: currentLocation.latitude,
        longitude: currentLocation.longitude,
        timestamp: currentLocation.timestamp,
      },
    ].slice(-MAX_TRACE_POINTS);

    const now = Date.now();
    if (
      traceRef.current.length < MAP_MATCH_MIN_TRACE_POINTS ||
      now - lastMatchRef.current.time < MAP_MATCH_MIN_INTERVAL_MS
    ) {
      return;
    }

    lastMatchRef.current = { time: now, status: "checking" };
    const coordinates = traceRef.current
      .map((point) => `${point.longitude.toFixed(6)},${point.latitude.toFixed(6)}`)
      .join(";");
    const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coordinates}?geometries=geojson&overview=full&radiuses=${traceRef.current
      .map(() => 25)
      .join(";")}&access_token=${token}`;

    const controller = new AbortController();
    void fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Map Matching failed with ${response.status}`);
        return response.json() as Promise<{ matchings?: Array<{ geometry?: GeoJSON.LineString }> }>;
      })
      .then((payload) => {
        const matchedLine = payload.matchings?.[0]?.geometry;
        if (!matchedLine?.coordinates.length) return;
        const latest = matchedLine.coordinates[matchedLine.coordinates.length - 1];
        const current = smoothedRef.current;
        if (current) {
          smoothedRef.current = {
            ...current,
            longitude: latest[0],
            latitude: latest[1],
          };
        }
        lastMatchRef.current = { time: now, status: "ready" };
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") {
          lastMatchRef.current = { time: now, status: "failed" };
          if (import.meta.env.DEV) setStatus("matching-failed");
        }
      });

    return () => controller.abort();
  }, [currentLocation, isActive, token]);

  return (
    <div className="dashboard-mapbox" aria-hidden="true">
      <div
        className={`dashboard-mapbox__fallback-map ${isMapReady ? "" : "is-visible"}`}
      >
        <DashboardMiniMap location={location} showVehicle={false} />
      </div>
      <div
        ref={containerRef}
        className={`dashboard-mapbox__canvas ${isMapReady ? "is-ready" : ""}`}
      />
      <div
        className="dashboard-mapbox__vehicle"
        style={{ "--vehicle-y": `${VEHICLE_SCREEN_Y_RATIO * 100}%` } as CSSProperties}
      >
        <span />
      </div>
      {location?.accuracy && location.accuracy > 45 && (
        <div
          className="dashboard-mapbox__accuracy"
          style={{ "--vehicle-y": `${VEHICLE_SCREEN_Y_RATIO * 100}%` } as CSSProperties}
        />
      )}
      {status !== "ready" && (
        <div className="dashboard-mapbox__fallback">
          {token ? "Map loading" : "Mapbox token missing"}
        </div>
      )}
      {import.meta.env.DEV && (
        <div className="dashboard-mapbox__debug">
          {status}
          {smoothedRef.current
            ? ` · ${Math.round(smoothedRef.current.speedKmh)} km/h · ${Math.round(
                smoothedRef.current.heading,
              )}°`
            : ""}
          {` · ${sourceUpdatesRef.current} updates`}
        </div>
      )}
    </div>
  );
}
