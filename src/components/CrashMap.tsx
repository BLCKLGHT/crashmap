import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Feature, Point } from "geojson";
import L from "leaflet";
import "leaflet.heat";
import Supercluster from "supercluster";
import type {
  CrashRecord,
  CurrentDrivingConditions,
  DriveLocation,
  WeatherMapFilterMode,
} from "../types/crash";
import { getCrashConditionMatch } from "../data/conditionMatching";
import { isFatalCrash, isSeriousCrash } from "../data/filterCrashes";

type CrashMapProps = {
  crashes: CrashRecord[];
  heatmapCrashes?: CrashRecord[];
  currentConditions?: CurrentDrivingConditions | null;
  weatherMode?: WeatherMapFilterMode;
  timePhase: "day" | "dawn" | "dusk" | "night";
  isFullscreen?: boolean;
  driveMode?: {
    isActive: boolean;
    isSimulation: boolean;
    location: DriveLocation | null;
    nearbyCrashes: CrashRecord[];
    onSimulatedLocationChange: (location: Omit<DriveLocation, "timestamp">) => void;
  };
};

type CrashPointProperties = {
  crash: CrashRecord;
  risk: number;
  fatalCount: number;
  seriousCount: number;
};

type ClusterProperties = {
  cluster?: boolean;
  cluster_id?: number;
  point_count?: number;
  point_count_abbreviated?: string | number;
  risk: number;
  fatalCount: number;
  seriousCount: number;
};

type CrashFeature = Feature<Point, CrashPointProperties>;
type ClusterFeature = Feature<Point, ClusterProperties & Partial<CrashPointProperties>>;

type ViewState = {
  zoom: number;
  bounds: L.LatLngBounds;
};

type RenderMode = "heatmap" | "clusters" | "points";

type RenderCluster = {
  kind: "cluster";
  latitude: number;
  longitude: number;
  count: number;
  risk: number;
  clusterId: number;
  fatalCount: number;
  seriousCount: number;
};

type RenderCrash = {
  kind: "crash";
  latitude: number;
  longitude: number;
  crash: CrashRecord;
  risk: number;
};

type RenderItem = RenderCluster | RenderCrash;

declare module "leaflet" {
  function heatLayer(
    latlngs: Array<[number, number, number]>,
    options?: {
      radius?: number;
      blur?: number;
      maxZoom?: number;
      minOpacity?: number;
      gradient?: Record<number, string>;
    },
  ): Layer;
}

const LOW_ZOOM_MAX = 8;
const MEDIUM_ZOOM_MAX = 12;
const MAX_RENDERED_OBJECTS = 1000;
const DRIVE_MAX_RENDERED_OBJECTS = 500;
const DRIVE_CLOUD_POINT_LIMIT = 520;
const DRIVE_RENDER_REFRESH_MS = 1200;
const VIEW_UPDATE_DELAY_MS = 240;
const DRIVE_FOLLOW_ZOOM = 15;
const DRIVE_LOOKAHEAD_METRES = 55;
const DRIVE_MOVING_SPEED_MPS = 1.8;
const DRIVE_PAN_THRESHOLD_METRES = 10;

const TASMANIA_BOUNDS = L.latLngBounds(
  L.latLng(-43.85, 144.35),
  L.latLng(-39.55, 148.65),
);

const getSeverityClass = (crash: CrashRecord): "fatal" | "serious" | "other" => {
  if (isFatalCrash(crash)) return "fatal";
  if (isSeriousCrash(crash)) return "serious";
  return "other";
};

const getRiskWeight = (crash: CrashRecord): number => {
  if (isFatalCrash(crash)) return 8;
  if (isSeriousCrash(crash)) return 4;
  return 1;
};

const getHeatWeight = (crash: CrashRecord): number => {
  if (isFatalCrash(crash)) return 1;
  if (isSeriousCrash(crash)) return 0.82;
  return 0.52;
};

const getConditionWeight = (
  crash: CrashRecord,
  currentConditions?: CurrentDrivingConditions | null,
  weatherMode?: WeatherMapFilterMode,
): number => {
  if (weatherMode !== "weighted" || !currentConditions) return 1;
  return getCrashConditionMatch(crash, currentConditions).weight;
};

const getRenderMode = (zoom: number): RenderMode => {
  if (zoom <= LOW_ZOOM_MAX) return "heatmap";
  if (zoom <= MEDIUM_ZOOM_MAX) return "clusters";
  return "points";
};

const formatDate = (value?: string): string => {
  if (!value) return "Not supplied";

  const numericValue = Number(value);
  const date = Number.isFinite(numericValue) ? new Date(numericValue) : new Date(value);

  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

const escapeHtml = (value?: string): string =>
  (value || "Not supplied")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const popupHtml = (crash: CrashRecord): string => `
  <article class="crash-popup">
    <h2>${escapeHtml(crash.severity || "Crash record")}</h2>
    <dl>
      <div><dt>Date/time</dt><dd>${escapeHtml(formatDate(crash.dateTime))}</dd></div>
      <div><dt>Speed zone</dt><dd>${escapeHtml(crash.speedZone)}</dd></div>
      <div><dt>Surface type</dt><dd>${escapeHtml(crash.surfaceType)}</dd></div>
      <div><dt>Light condition</dt><dd>${escapeHtml(crash.lightCondition)}</dd></div>
      <div><dt>Location</dt><dd>${escapeHtml(crash.locationDescription)}</dd></div>
    </dl>
  </article>
`;

const toFeature = (
  crash: CrashRecord,
  currentConditions?: CurrentDrivingConditions | null,
  weatherMode?: WeatherMapFilterMode,
): CrashFeature => {
  const severity = getSeverityClass(crash);
  const conditionWeight = getConditionWeight(crash, currentConditions, weatherMode);

  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [crash.longitude, crash.latitude],
    },
    properties: {
      crash,
      risk: getRiskWeight(crash) * conditionWeight,
      fatalCount: severity === "fatal" ? 1 : 0,
      seriousCount: severity === "serious" ? 1 : 0,
    },
  };
};

const boundsToBbox = (bounds: L.LatLngBounds): [number, number, number, number] => [
  bounds.getWest(),
  bounds.getSouth(),
  bounds.getEast(),
  bounds.getNorth(),
];

const isCrashFeature = (
  feature: ClusterFeature,
): feature is Feature<Point, CrashPointProperties> =>
  Boolean((feature.properties as Partial<CrashPointProperties>).crash);

const getRiskColor = (riskPerCrash: number): string => {
  if (riskPerCrash >= 5) return "#dc2626";
  if (riskPerCrash >= 2.5) return "#f97316";
  return "#0f766e";
};

const getCrashColor = (crash: CrashRecord): string => {
  const severity = getSeverityClass(crash);
  if (severity === "fatal") return "#dc2626";
  if (severity === "serious") return "#d97706";
  return "#0f766e";
};

const getCrashCloudColor = (crash: CrashRecord, alpha: number): string => {
  const severity = getSeverityClass(crash);
  if (severity === "fatal") return `rgba(220, 38, 38, ${alpha})`;
  if (severity === "serious") return `rgba(217, 119, 6, ${alpha})`;
  return `rgba(15, 118, 110, ${alpha})`;
};

const sortByRisk = <Item extends { risk: number }>(items: Item[]): Item[] =>
  items.sort((a, b) => b.risk - a.risk);

const sortByLowRiskFirst = <Item extends { risk: number }>(items: Item[]): Item[] =>
  items.sort((a, b) => a.risk - b.risk);

const getNormalisedHeading = (heading?: number): number | null => {
  if (typeof heading !== "number" || !Number.isFinite(heading)) return null;
  return ((heading % 360) + 360) % 360;
};

const canRotateLeafletPane = (): boolean => {
  // Leaflet's tile renderer is not designed for rotating the internal map pane.
  // Drive Mode stays north-up and uses the blue direction marker for bearing.
  return false;
};

const getMapPane = (map: L.Map): HTMLElement | null => {
  const mapWithPane = map as L.Map & { _mapPane?: HTMLElement };
  return mapWithPane._mapPane ?? null;
};

const stripBearingTransform = (transform: string): string =>
  transform.replace(/\srotate\([^)]*\)\sscale\([^)]*\)$/, "");

const getBearingScale = (size: L.Point, bearing: number): number => {
  const radians = (Math.abs(bearing) * Math.PI) / 180;
  const sin = Math.abs(Math.sin(radians));
  const cos = Math.abs(Math.cos(radians));
  const rotatedWidth = size.x * cos + size.y * sin;
  const rotatedHeight = size.x * sin + size.y * cos;

  return Math.max(1.18, size.x / rotatedWidth, size.y / rotatedHeight) + 0.12;
};

const applyMapBearing = (map: L.Map, bearing: number): void => {
  const pane = getMapPane(map);
  if (!pane) return;

  const baseTransform = stripBearingTransform(pane.style.transform || "");
  const size = map.getSize();
  pane.style.transformOrigin = `${size.x / 2}px ${size.y / 2}px`;
  pane.style.transition = "none";

  if (Math.abs(bearing) < 0.1) {
    pane.style.transform = baseTransform;
    return;
  }

  pane.style.transform = `${baseTransform} rotate(${bearing}deg) scale(${getBearingScale(
    size,
    bearing,
  ).toFixed(3)})`;
};

const bearingDegrees = (
  fromLatitude: number,
  fromLongitude: number,
  toLatitude: number,
  toLongitude: number,
): number => {
  const fromLat = (fromLatitude * Math.PI) / 180;
  const toLat = (toLatitude * Math.PI) / 180;
  const deltaLng = ((toLongitude - fromLongitude) * Math.PI) / 180;
  const y = Math.sin(deltaLng) * Math.cos(toLat);
  const x =
    Math.cos(fromLat) * Math.sin(toLat) -
    Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

const distanceMetres = (from: L.LatLng, to: L.LatLng): number => {
  const earthRadius = 6371000;
  const fromLat = (from.lat * Math.PI) / 180;
  const toLat = (to.lat * Math.PI) / 180;
  const deltaLat = ((to.lat - from.lat) * Math.PI) / 180;
  const deltaLng = ((to.lng - from.lng) * Math.PI) / 180;
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLng / 2) ** 2;

  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const destinationPoint = (
  latitude: number,
  longitude: number,
  headingDegrees: number,
  distanceMetres: number,
): L.LatLng => {
  const earthRadius = 6371000;
  const bearing = (headingDegrees * Math.PI) / 180;
  const angularDistance = distanceMetres / earthRadius;
  const lat1 = (latitude * Math.PI) / 180;
  const lng1 = (longitude * Math.PI) / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    );

  return L.latLng((lat2 * 180) / Math.PI, (lng2 * 180) / Math.PI);
};

export function CrashMap({
  crashes,
  heatmapCrashes,
  currentConditions,
  weatherMode,
  timePhase,
  isFullscreen = false,
  driveMode,
}: CrashMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const heatRef = useRef<L.Layer | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fatalPulseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const locationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const clusterIndexRef = useRef<Supercluster<CrashPointProperties, ClusterProperties> | null>(
    null,
  );
  const canvasItemsRef = useRef<Array<RenderItem & { x: number; y: number; radius: number }>>(
    [],
  );
  const updateTimerRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const pulseAnimationFrameRef = useRef<number | null>(null);
  const lastDriveRenderUpdateRef = useRef(0);
  const lastClusterKeyRef = useRef<string>("");
  const driveModeRef = useRef<CrashMapProps["driveMode"]>(driveMode);
  const isSimDraggingRef = useRef(false);
  const lastSimLocationRef = useRef<DriveLocation | null>(null);
  const [viewState, setViewState] = useState<ViewState | null>(null);
  const [renderItems, setRenderItems] = useState<RenderItem[]>([]);
  const [driveCloudItems, setDriveCloudItems] = useState<RenderCrash[]>([]);
  const [areaCrashCount, setAreaCrashCount] = useState(0);
  const [isUpdating, setIsUpdating] = useState(false);

  const heatPoints = useMemo(() => {
    if (driveMode?.isActive) return [];

    const heatSource = heatmapCrashes ?? crashes;

    return heatSource.map(
        (crash) =>
          [
            crash.latitude,
            crash.longitude,
            getHeatWeight(crash) * getConditionWeight(crash, currentConditions, weatherMode),
          ] as [
            number,
            number,
            number,
          ],
      );
  }, [crashes, currentConditions, driveMode?.isActive, heatmapCrashes, weatherMode]);

  const clusterIndex = useMemo(() => {
    const index = new Supercluster<CrashPointProperties, ClusterProperties>({
      radius: 72,
      maxZoom: MEDIUM_ZOOM_MAX,
      minPoints: 4,
      map: (props) => ({
        risk: props.risk,
        fatalCount: props.fatalCount,
        seriousCount: props.seriousCount,
      }),
      reduce: (accumulated, props) => {
        accumulated.risk += props.risk;
        accumulated.fatalCount += props.fatalCount;
        accumulated.seriousCount += props.seriousCount;
      },
    });

    index.load(crashes.map((crash) => toFeature(crash, currentConditions, weatherMode)));
    lastClusterKeyRef.current = "";
    return index;
  }, [crashes, currentConditions, weatherMode]);

  useEffect(() => {
    clusterIndexRef.current = clusterIndex;
  }, [clusterIndex]);

  useEffect(() => {
    driveModeRef.current = driveMode;
  }, [driveMode]);

  const mode = viewState ? getRenderMode(viewState.zoom) : "heatmap";
  const heading = getNormalisedHeading(driveMode?.location?.heading);
  const shouldRotateMap = useMemo(() => canRotateLeafletPane(), []);
  const isHeadingUp = Boolean(driveMode?.isActive && heading !== null && shouldRotateMap);
  const mapBearing = isHeadingUp ? -(heading ?? 0) : 0;

  const statusText = useMemo(() => {
    if (!viewState) return "Preparing map";
    if (mode === "heatmap") return "Zoom in to inspect individual crashes";
    if (isUpdating) return "Updating visible crash data...";

    return `Showing ${areaCrashCount.toLocaleString("en-AU")} crashes in this area`;
  }, [areaCrashCount, isUpdating, mode, viewState]);

  const nearestFatalCrash = useMemo<RenderCrash | null>(() => {
    if (!driveMode?.isActive || !driveMode.location) return null;

    const userLocation = L.latLng(driveMode.location.latitude, driveMode.location.longitude);
    let nearest: RenderCrash | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const item of renderItems) {
      if (item.kind !== "crash" || !isFatalCrash(item.crash)) continue;

      const distance = distanceMetres(userLocation, L.latLng(item.latitude, item.longitude));
      if (distance < nearestDistance) {
        nearest = item;
        nearestDistance = distance;
      }
    }

    return nearest;
  }, [driveMode?.isActive, driveMode?.location, renderItems]);

  const drawCrashCanvas = useCallback(() => {
    const map = mapRef.current;
    const canvas = canvasRef.current;
    if (!map || !canvas) return;

    if (animationFrameRef.current) window.cancelAnimationFrame(animationFrameRef.current);

    animationFrameRef.current = window.requestAnimationFrame(() => {
      const size = map.getSize();
      const pixelRatio = window.devicePixelRatio || 1;
      const topLeft = map.containerPointToLayerPoint([0, 0]);

      canvas.width = size.x * pixelRatio;
      canvas.height = size.y * pixelRatio;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
      L.DomUtil.setPosition(canvas, topLeft);

      const context = canvas.getContext("2d");
      if (!context) return;

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, size.x, size.y);
      context.font = "800 12px Inter, system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";

      const nextClickableItems: Array<RenderItem & { x: number; y: number; radius: number }> =
        [];

      if (driveMode?.isActive && driveCloudItems.length) {
        context.save();
        context.globalCompositeOperation = "source-over";

        for (const item of driveCloudItems) {
          const layerPoint = map.latLngToLayerPoint([item.latitude, item.longitude]);
          const x = layerPoint.x - topLeft.x;
          const y = layerPoint.y - topLeft.y;
          const severity = getSeverityClass(item.crash);
          const cloudRadius = severity === "fatal" ? 42 : severity === "serious" ? 36 : 30;
          const alpha = severity === "fatal" ? 0.18 : severity === "serious" ? 0.14 : 0.1;
          const gradient = context.createRadialGradient(x, y, 0, x, y, cloudRadius);

          gradient.addColorStop(0, getCrashCloudColor(item.crash, alpha));
          gradient.addColorStop(0.52, getCrashCloudColor(item.crash, alpha * 0.5));
          gradient.addColorStop(1, getCrashCloudColor(item.crash, 0));

          context.beginPath();
          context.arc(x, y, cloudRadius, 0, Math.PI * 2);
          context.fillStyle = gradient;
          context.fill();
        }

        context.restore();
      }

      for (const item of renderItems) {
        const layerPoint = map.latLngToLayerPoint([item.latitude, item.longitude]);
        const x = layerPoint.x - topLeft.x;
        const y = layerPoint.y - topLeft.y;

        if (item.kind === "cluster") {
          const riskPerCrash = item.risk / Math.max(item.count, 1);
          const radius = Math.max(16, Math.min(34, 12 + Math.log2(item.count + 1) * 3.2));
          const color = getRiskColor(riskPerCrash);
          const shouldGlow = timePhase === "night" || timePhase === "dusk";

          context.shadowColor = shouldGlow ? color : "transparent";
          context.shadowBlur = shouldGlow ? 18 : 0;

          context.beginPath();
          context.arc(x, y, radius + 4, 0, Math.PI * 2);
          context.fillStyle = `${color}33`;
          context.fill();
          context.beginPath();
          context.arc(x, y, radius, 0, Math.PI * 2);
          context.fillStyle = color;
          context.fill();
          context.lineWidth = 2;
          context.strokeStyle = "#ffffff";
          context.stroke();
          context.shadowBlur = 0;
          context.fillStyle = "#ffffff";
          context.fillText(
            item.count > 999 ? `${Math.round(item.count / 100) / 10}k` : String(item.count),
            x,
            y,
          );

          nextClickableItems.push({ ...item, x, y, radius });
          continue;
        }

        const severity = getSeverityClass(item.crash);
        const isFatal = severity === "fatal";
        const isSerious = severity === "serious";
        const radius = driveMode?.isActive
          ? isFatal
            ? 14
            : isSerious
              ? 7
              : 4.75
          : item.risk >= 8
            ? 7
            : item.risk >= 4
              ? 6
              : 4.5;
        const color = getCrashColor(item.crash);
        const shouldGlow = timePhase === "night" || timePhase === "dusk" || driveMode?.isActive;
        const glowBlur = driveMode?.isActive
          ? isFatal
            ? 28
            : isSerious
              ? 10
              : 8
          : shouldGlow
            ? 14
            : 0;

        if (driveMode?.isActive && (isFatal || isSerious)) {
          context.shadowColor = color;
          context.shadowBlur = isFatal ? 28 : 9;
          context.beginPath();
          context.arc(
            x,
            y,
            radius + (isFatal ? 10 : 3.5),
            0,
            Math.PI * 2,
          );
          context.fillStyle = isFatal
            ? "rgba(220, 38, 38, 0.24)"
            : "rgba(217, 119, 6, 0.16)";
          context.fill();
          context.shadowBlur = 0;

          context.beginPath();
          context.arc(
            x,
            y,
            radius + (isFatal ? 5 : 2),
            0,
            Math.PI * 2,
          );
          context.lineWidth = isFatal ? 3.4 : 2;
          context.strokeStyle = isFatal
            ? "rgba(255, 255, 255, 0.95)"
            : "rgba(255, 255, 255, 0.9)";
          context.stroke();
        }

        context.shadowColor = shouldGlow ? color : "transparent";
        context.shadowBlur = glowBlur;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = color;
        context.fill();
        context.shadowBlur = 0;
        context.lineWidth = driveMode?.isActive && (isFatal || isSerious) ? (isFatal ? 2.6 : 2) : 1.75;
        context.strokeStyle = "#ffffff";
        context.stroke();

        if (driveMode?.isActive && isFatal) {
          context.beginPath();
          context.arc(x, y, Math.max(3.2, radius * 0.32), 0, Math.PI * 2);
          context.fillStyle = "#ffffff";
          context.fill();
        }

        nextClickableItems.push({
          ...item,
          x,
          y,
          radius: radius + (isFatal ? 16 : isSerious ? 4 : 2),
        });
      }

      canvasItemsRef.current = nextClickableItems;
    });
  }, [driveCloudItems, driveMode?.isActive, renderItems, timePhase]);

  const drawLocationCanvas = useCallback(() => {
    const map = mapRef.current;
    const canvas = locationCanvasRef.current;
    if (!map || !canvas) return;

    const size = map.getSize();
    const pixelRatio = window.devicePixelRatio || 1;
    const topLeft = map.containerPointToLayerPoint([0, 0]);

    canvas.width = size.x * pixelRatio;
    canvas.height = size.y * pixelRatio;
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    L.DomUtil.setPosition(canvas, topLeft);

    const context = canvas.getContext("2d");
    if (!context) return;

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, size.x, size.y);

    if (!driveMode?.isActive || !driveMode.location) return;

    const point = map.latLngToLayerPoint([
      driveMode.location.latitude,
      driveMode.location.longitude,
    ]);
    const x = point.x - topLeft.x;
    const y = point.y - topLeft.y;

    context.save();
    context.shadowColor = "#38bdf8";
    context.shadowBlur = 20;
    context.beginPath();
    context.arc(x, y, 12, 0, Math.PI * 2);
    context.fillStyle = "#0284c7";
    context.fill();
    context.shadowBlur = 0;
    context.lineWidth = 3.5;
    context.strokeStyle = "#ffffff";
    context.stroke();

    if (typeof driveMode.location.heading === "number") {
      const headingRadians = (driveMode.location.heading * Math.PI) / 180;
      context.translate(x, y);
      context.rotate(headingRadians);
      context.beginPath();
      context.moveTo(0, -28);
      context.lineTo(8, -7);
      context.lineTo(0, -11);
      context.lineTo(-8, -7);
      context.closePath();
      context.fillStyle = "#38bdf8";
      context.fill();
      context.lineWidth = 1.5;
      context.strokeStyle = "#ffffff";
      context.stroke();
    }

    context.restore();
  }, [driveMode?.isActive, driveMode?.location]);

  const drawFatalPulseCanvas = useCallback((pulse = 0) => {
    const map = mapRef.current;
    const canvas = fatalPulseCanvasRef.current;
    if (!map || !canvas) return;

    const size = map.getSize();
    const pixelRatio = window.devicePixelRatio || 1;
    const topLeft = map.containerPointToLayerPoint([0, 0]);

    canvas.width = size.x * pixelRatio;
    canvas.height = size.y * pixelRatio;
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    L.DomUtil.setPosition(canvas, topLeft);

    const context = canvas.getContext("2d");
    if (!context) return;

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, size.x, size.y);

    if (!driveMode?.isActive || !nearestFatalCrash) return;

    const layerPoint = map.latLngToLayerPoint([
      nearestFatalCrash.latitude,
      nearestFatalCrash.longitude,
    ]);
    const x = layerPoint.x - topLeft.x;
    const y = layerPoint.y - topLeft.y;
    const radius = 20 + pulse * 12;

    context.save();
    context.shadowColor = "#dc2626";
    context.shadowBlur = 28 + pulse * 22;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = `rgba(220, 38, 38, ${0.16 + pulse * 0.18})`;
    context.fill();
    context.shadowBlur = 0;
    context.lineWidth = 3.2;
    context.strokeStyle = `rgba(255, 255, 255, ${0.82 + pulse * 0.18})`;
    context.stroke();
    context.restore();
  }, [driveMode?.isActive, nearestFatalCrash]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      zoomControl: false,
      preferCanvas: true,
      attributionControl: true,
      maxBounds: TASMANIA_BOUNDS.pad(0.45),
      maxBoundsViscosity: 0.4,
    });

    map.fitBounds(TASMANIA_BOUNDS, { padding: [16, 16] });
    L.control.zoom({ position: "bottomright" }).addTo(map);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      keepBuffer: 6,
      updateWhenIdle: false,
      updateWhenZooming: false,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    const canvas = L.DomUtil.create("canvas", "crash-canvas-layer");
    canvas.style.position = "absolute";
    canvas.style.pointerEvents = "none";
    map.getPanes().overlayPane.appendChild(canvas);
    canvasRef.current = canvas;

    const fatalPulseCanvas = L.DomUtil.create("canvas", "fatal-pulse-canvas-layer");
    fatalPulseCanvas.style.position = "absolute";
    fatalPulseCanvas.style.pointerEvents = "none";
    map.getPanes().overlayPane.appendChild(fatalPulseCanvas);
    fatalPulseCanvasRef.current = fatalPulseCanvas;

    const locationPane = map.createPane("driveLocationPane");
    locationPane.style.zIndex = "650";
    locationPane.style.pointerEvents = "none";
    const locationCanvas = L.DomUtil.create("canvas", "drive-location-canvas-layer");
    locationCanvas.style.position = "absolute";
    locationCanvas.style.pointerEvents = "none";
    locationPane.appendChild(locationCanvas);
    locationCanvasRef.current = locationCanvas;

    const updateViewport = () => {
      const currentDriveMode = driveModeRef.current;
      const currentHeading = getNormalisedHeading(currentDriveMode?.location?.heading);
      applyMapBearing(
        map,
        currentDriveMode?.isActive && currentHeading !== null ? -currentHeading : 0,
      );
      if (updateTimerRef.current) window.clearTimeout(updateTimerRef.current);
      if (!currentDriveMode?.isActive) setIsUpdating(true);
      updateTimerRef.current = window.setTimeout(() => {
        window.requestAnimationFrame(() => {
          setViewState({
            zoom: map.getZoom(),
            bounds: map.getBounds().pad(0.12),
          });
        });
      }, VIEW_UPDATE_DELAY_MS);
    };

    const handleMapClick = (event: L.LeafletMouseEvent) => {
      const currentDriveMode = driveModeRef.current;
      if (currentDriveMode?.isActive && currentDriveMode.isSimulation) {
        const previous = lastSimLocationRef.current ?? currentDriveMode.location;
        currentDriveMode.onSimulatedLocationChange({
          latitude: event.latlng.lat,
          longitude: event.latlng.lng,
          heading: previous
            ? bearingDegrees(previous.latitude, previous.longitude, event.latlng.lat, event.latlng.lng)
            : currentDriveMode.location?.heading,
          isSimulated: true,
        });
        return;
      }

      const clicked = canvasItemsRef.current.find((item) => {
        const distance = Math.hypot(item.x - event.containerPoint.x, item.y - event.containerPoint.y);
        return distance <= item.radius + 4;
      });

      if (!clicked) return;

      if (clicked.kind === "cluster") {
        const currentIndex = clusterIndexRef.current;
        if (!currentIndex) return;

        const expansionZoom = Math.min(
          currentIndex.getClusterExpansionZoom(clicked.clusterId),
          map.getMaxZoom(),
        );
        map.flyTo([clicked.latitude, clicked.longitude], expansionZoom, { duration: 0.35 });
        return;
      }

      L.popup({ maxWidth: 320 })
        .setLatLng([clicked.latitude, clicked.longitude])
        .setContent(popupHtml(clicked.crash))
        .openOn(map);
    };

    const handleMouseDown = (event: L.LeafletMouseEvent) => {
      const currentDriveMode = driveModeRef.current;
      if (!currentDriveMode?.isActive || !currentDriveMode.isSimulation) return;
      isSimDraggingRef.current = true;
      lastSimLocationRef.current = currentDriveMode.location;
      map.dragging.disable();
      currentDriveMode.onSimulatedLocationChange({
        latitude: event.latlng.lat,
        longitude: event.latlng.lng,
        heading: currentDriveMode.location?.heading,
        isSimulated: true,
      });
    };

    const handleMouseMove = (event: L.LeafletMouseEvent) => {
      const currentDriveMode = driveModeRef.current;
      if (!isSimDraggingRef.current || !currentDriveMode?.isActive || !currentDriveMode.isSimulation) {
        return;
      }

      const previous = lastSimLocationRef.current ?? currentDriveMode.location;
      currentDriveMode.onSimulatedLocationChange({
        latitude: event.latlng.lat,
        longitude: event.latlng.lng,
        heading: previous
          ? bearingDegrees(previous.latitude, previous.longitude, event.latlng.lat, event.latlng.lng)
          : currentDriveMode.location?.heading,
        isSimulated: true,
      });
      lastSimLocationRef.current = {
        latitude: event.latlng.lat,
        longitude: event.latlng.lng,
        heading: currentDriveMode.location?.heading,
        timestamp: Date.now(),
        isSimulated: true,
      };
    };

    const stopSimDrag = () => {
      if (!isSimDraggingRef.current) return;
      isSimDraggingRef.current = false;
      map.dragging.enable();
    };

    map.on("moveend zoomend resize", updateViewport);
    map.on("click", handleMapClick);
    map.on("mousedown", handleMouseDown);
    map.on("mousemove", handleMouseMove);
    map.on("mouseup", stopSimDrag);
    map.on("mouseout", stopSimDrag);
    updateViewport();
    mapRef.current = map;

    return () => {
      if (updateTimerRef.current) window.clearTimeout(updateTimerRef.current);
      if (animationFrameRef.current) window.cancelAnimationFrame(animationFrameRef.current);
      if (pulseAnimationFrameRef.current) window.cancelAnimationFrame(pulseAnimationFrameRef.current);
      map.off("moveend zoomend resize", updateViewport);
      map.off("click", handleMapClick);
      map.off("mousedown", handleMouseDown);
      map.off("mousemove", handleMouseMove);
      map.off("mouseup", stopSimDrag);
      map.off("mouseout", stopSimDrag);
      canvas.remove();
      fatalPulseCanvas.remove();
      locationCanvas.remove();
      map.remove();
      mapRef.current = null;
      canvasRef.current = null;
      fatalPulseCanvasRef.current = null;
      locationCanvasRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applyMapBearing(map, mapBearing);
  }, [mapBearing]);

  useEffect(() => {
    const updateMapSize = () => {
      const map = mapRef.current;
      if (!map) return;

      map.invalidateSize({ animate: false, pan: false });
      setViewState({
        zoom: map.getZoom(),
        bounds: map.getBounds().pad(0.12),
      });
    };

    const scheduleResize = () => {
      window.requestAnimationFrame(updateMapSize);
      const firstTimer = window.setTimeout(updateMapSize, 120);
      const secondTimer = window.setTimeout(updateMapSize, 360);
      return [firstTimer, secondTimer];
    };

    let timers = scheduleResize();
    const handleViewportChange = () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers = scheduleResize();
    };

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("orientationchange", handleViewportChange);
    window.visualViewport?.addEventListener("resize", handleViewportChange);

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("orientationchange", handleViewportChange);
      window.visualViewport?.removeEventListener("resize", handleViewportChange);
    };
  }, [isFullscreen]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (heatRef.current) {
      map.removeLayer(heatRef.current);
      heatRef.current = null;
    }

    if (mode === "heatmap" && !driveMode?.isActive && heatPoints.length) {
      heatRef.current = L.heatLayer(heatPoints, {
        radius: 18,
        blur: 18,
        minOpacity: 0.3,
        maxZoom: LOW_ZOOM_MAX,
        gradient: {
          0.2: "#2dd4bf",
          0.45: "#facc15",
          0.7: "#fb923c",
          1: "#dc2626",
        },
      }).addTo(map);
    }
  }, [driveMode?.isActive, heatPoints, mode]);

  useEffect(() => {
    if (!viewState) return;

    if (driveMode?.isActive) {
      const now = window.performance.now();
      if (
        now - lastDriveRenderUpdateRef.current < DRIVE_RENDER_REFRESH_MS &&
        (renderItems.length > 0 || driveCloudItems.length > 0)
      ) {
        setIsUpdating(false);
        return;
      }

      lastDriveRenderUpdateRef.current = now;
      const visibleCrashes = crashes.filter((crash) =>
        viewState.bounds.contains(L.latLng(crash.latitude, crash.longitude)),
      );
      const visibleCloudCrashes = sortByLowRiskFirst(
        visibleCrashes.map((crash): RenderCrash => ({
          kind: "crash",
          latitude: crash.latitude,
          longitude: crash.longitude,
          crash,
          risk: getRiskWeight(crash),
        })),
      ).slice(0, DRIVE_CLOUD_POINT_LIMIT);
      const visibleDriveCrashes = sortByRisk(
        visibleCrashes.map((crash): RenderCrash => ({
          kind: "crash",
          latitude: crash.latitude,
          longitude: crash.longitude,
          crash,
          risk: getRiskWeight(crash),
        })),
      ).slice(0, DRIVE_MAX_RENDERED_OBJECTS);

      setAreaCrashCount(visibleCrashes.length);
      setDriveCloudItems(visibleCloudCrashes);
      setRenderItems(visibleDriveCrashes);
      setIsUpdating(false);
      return;
    }

    lastDriveRenderUpdateRef.current = 0;
    setDriveCloudItems([]);

    if (mode === "heatmap") {
      setRenderItems([]);
      setAreaCrashCount(0);
      setIsUpdating(false);
      return;
    }

    const zoom = Math.floor(viewState.zoom);
    const bbox = boundsToBbox(viewState.bounds);
    const bboxKey = bbox.map((value) => value.toFixed(3)).join(",");
    const clusterKey = `${mode}:${zoom}:${bboxKey}:${crashes.length}`;

    if (clusterKey === lastClusterKeyRef.current) {
      setIsUpdating(false);
      return;
    }

    lastClusterKeyRef.current = clusterKey;

    window.requestAnimationFrame(() => {
      if (mode === "clusters") {
        const clusters = clusterIndex
          .getClusters(bbox, zoom)
          .map((feature): RenderItem => {
            const [longitude, latitude] = feature.geometry.coordinates;

            if (isCrashFeature(feature as ClusterFeature)) {
              const properties = feature.properties as CrashPointProperties;

              return {
                kind: "crash",
                latitude,
                longitude,
                crash: properties.crash,
                risk: properties.risk,
              };
            }

            const properties = feature.properties as ClusterProperties;
            const count = properties.point_count ?? 1;
            const risk = properties.risk ?? count;

            return {
              kind: "cluster",
              latitude,
              longitude,
              count,
              risk,
              clusterId: properties.cluster_id ?? 0,
              fatalCount: properties.fatalCount ?? 0,
              seriousCount: properties.seriousCount ?? 0,
            };
          });

        setAreaCrashCount(
          clusters.reduce((total, item) => total + (item.kind === "cluster" ? item.count : 1), 0),
        );
        setRenderItems(sortByRisk(clusters).slice(0, MAX_RENDERED_OBJECTS));
        setIsUpdating(false);
        return;
      }

      const visibleCrashes = sortByRisk(
        crashes
          .filter((crash) =>
            viewState.bounds.contains(L.latLng(crash.latitude, crash.longitude)),
          )
          .map((crash): RenderCrash => ({
            kind: "crash",
            latitude: crash.latitude,
            longitude: crash.longitude,
            crash,
            risk: getRiskWeight(crash),
          })),
      );

      setAreaCrashCount(visibleCrashes.length);
      setRenderItems(visibleCrashes.slice(0, MAX_RENDERED_OBJECTS));
      setIsUpdating(false);
    });
  }, [clusterIndex, crashes, driveMode?.isActive, mode, viewState]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !driveMode?.isActive || !driveMode.location) return;

    const userLocation = L.latLng(driveMode.location.latitude, driveMode.location.longitude);
    const canUseBearingLookahead =
      driveMode.location.isSimulated ||
      (driveMode.location.headingSource !== "compass" &&
        (driveMode.location.speed ?? 0) >= DRIVE_MOVING_SPEED_MPS);
    const headingForLookahead = canUseBearingLookahead
      ? getNormalisedHeading(driveMode.location.heading)
      : null;
    const targetCenter =
      headingForLookahead === null
        ? userLocation
        : destinationPoint(
            driveMode.location.latitude,
            driveMode.location.longitude,
            headingForLookahead,
            DRIVE_LOOKAHEAD_METRES,
          );
    const targetZoom = Math.max(map.getZoom(), DRIVE_FOLLOW_ZOOM);
    const centreDistance = distanceMetres(map.getCenter(), targetCenter);
    const shouldZoom = map.getZoom() < DRIVE_FOLLOW_ZOOM;

    if (!shouldZoom && centreDistance < DRIVE_PAN_THRESHOLD_METRES) {
      setViewState({
        zoom: map.getZoom(),
        bounds: map.getBounds().pad(0.12),
      });
      return;
    }

    map.stop();
    if (driveMode.location.isSimulated) {
      if (shouldZoom) {
        map.setZoom(DRIVE_FOLLOW_ZOOM, { animate: false });
      }
      map.panTo(targetCenter, {
        animate: true,
        duration: 0.75,
        easeLinearity: 0.22,
        noMoveStart: true,
      });
    } else {
      map.setView(targetCenter, targetZoom, { animate: false });
      map.invalidateSize({ animate: false, pan: false });
    }
    applyMapBearing(map, mapBearing);
    setViewState({
      zoom: map.getZoom(),
      bounds: map.getBounds().pad(0.12),
    });
  }, [
    driveMode?.isActive,
    driveMode?.location?.latitude,
    driveMode?.location?.longitude,
  ]);

  useEffect(() => {
    if (driveMode?.isActive) return;
    const map = mapRef.current;
    if (map) map.stop();
  }, [driveMode?.isActive]);

  useEffect(() => {
    drawCrashCanvas();
  }, [drawCrashCanvas]);

  useEffect(() => {
    if (!driveMode?.isActive || !nearestFatalCrash) {
      if (pulseAnimationFrameRef.current) {
        window.cancelAnimationFrame(pulseAnimationFrameRef.current);
        pulseAnimationFrameRef.current = null;
      }
      drawFatalPulseCanvas(0);
      return;
    }

    const pulseNearestFatal = () => {
      const pulse = (Math.sin(window.performance.now() / 230) + 1) / 2;
      drawFatalPulseCanvas(pulse);
      pulseAnimationFrameRef.current = window.requestAnimationFrame(pulseNearestFatal);
    };

    pulseAnimationFrameRef.current = window.requestAnimationFrame(pulseNearestFatal);
    return () => {
      if (pulseAnimationFrameRef.current) {
        window.cancelAnimationFrame(pulseAnimationFrameRef.current);
        pulseAnimationFrameRef.current = null;
      }
    };
  }, [drawFatalPulseCanvas, driveMode?.isActive, nearestFatalCrash]);

  useEffect(() => {
    drawLocationCanvas();
  }, [drawLocationCanvas]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const redrawCanvases = () => {
      drawCrashCanvas();
      drawFatalPulseCanvas(0);
      drawLocationCanvas();
    };

    map.on("move zoom", redrawCanvases);
    return () => {
      map.off("move zoom", redrawCanvases);
    };
  }, [drawCrashCanvas, drawFatalPulseCanvas, drawLocationCanvas]);

  useEffect(() => {
    mapRef.current?.invalidateSize();
  }, [crashes.length]);

  const modeLabel =
    driveMode?.isActive
      ? "Drive Mode nearby crashes"
      : mode === "heatmap"
      ? "Heatmap overview"
      : mode === "clusters"
        ? "Risk-weighted clusters"
        : "Visible crashes only";

  return (
    <div
      className={`map-shell map-shell--${timePhase} ${
        isHeadingUp ? "map-shell--heading-up" : ""
      }`}
    >
      <div ref={containerRef} className="map" aria-label="Tasmania crash map" />
      <div className="map-mode" aria-live="polite">
        <strong>{modeLabel}</strong>
        <span>{statusText}</span>
      </div>
      {isUpdating && mode !== "heatmap" && (
        <div className="map-updating" role="status" aria-live="polite">
          <span className="loader loader--small" aria-hidden="true" />
          <span>Updating map</span>
        </div>
      )}
    </div>
  );
}
