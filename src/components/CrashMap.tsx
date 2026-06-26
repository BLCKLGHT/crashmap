import { useEffect, useMemo, useRef, useState } from "react";
import type { Feature, Point } from "geojson";
import L from "leaflet";
import "leaflet.heat";
import Supercluster from "supercluster";
import type { CrashRecord, DriveLocation } from "../types/crash";
import { isFatalCrash, isSeriousCrash } from "../data/filterCrashes";

type CrashMapProps = {
  crashes: CrashRecord[];
  heatmapCrashes?: CrashRecord[];
  timePhase: "day" | "dawn" | "dusk" | "night";
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
const VIEW_UPDATE_DELAY_MS = 240;

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

const toFeature = (crash: CrashRecord): CrashFeature => {
  const severity = getSeverityClass(crash);

  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [crash.longitude, crash.latitude],
    },
    properties: {
      crash,
      risk: getRiskWeight(crash),
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

const sortByRisk = <Item extends { risk: number }>(items: Item[]): Item[] =>
  items.sort((a, b) => b.risk - a.risk);

const getNormalisedHeading = (heading?: number): number | null => {
  if (typeof heading !== "number" || !Number.isFinite(heading)) return null;
  return ((heading % 360) + 360) % 360;
};

const getMapPane = (map: L.Map): HTMLElement | null => {
  const mapWithPane = map as L.Map & { _mapPane?: HTMLElement };
  return mapWithPane._mapPane ?? null;
};

const stripBearingTransform = (transform: string): string =>
  transform.replace(/\srotate\([^)]*\)\sscale\([^)]*\)$/, "");

const applyMapBearing = (map: L.Map, bearing: number): void => {
  const pane = getMapPane(map);
  if (!pane) return;

  const baseTransform = stripBearingTransform(pane.style.transform || "");
  const size = map.getSize();
  pane.style.transformOrigin = `${size.x / 2}px ${size.y / 2}px`;
  pane.style.transition = "transform 320ms ease";

  if (Math.abs(bearing) < 0.1) {
    pane.style.transform = baseTransform;
    return;
  }

  pane.style.transform = `${baseTransform} rotate(${bearing}deg) scale(1.35)`;
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

export function CrashMap({
  crashes,
  heatmapCrashes,
  timePhase,
  driveMode,
}: CrashMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const heatRef = useRef<L.Layer | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const clusterIndexRef = useRef<Supercluster<CrashPointProperties, ClusterProperties> | null>(
    null,
  );
  const canvasItemsRef = useRef<Array<RenderItem & { x: number; y: number; radius: number }>>(
    [],
  );
  const updateTimerRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastClusterKeyRef = useRef<string>("");
  const driveModeRef = useRef<CrashMapProps["driveMode"]>(driveMode);
  const isSimDraggingRef = useRef(false);
  const lastSimLocationRef = useRef<DriveLocation | null>(null);
  const [viewState, setViewState] = useState<ViewState | null>(null);
  const [renderItems, setRenderItems] = useState<RenderItem[]>([]);
  const [areaCrashCount, setAreaCrashCount] = useState(0);
  const [isUpdating, setIsUpdating] = useState(false);

  const heatPoints = useMemo(
    () =>
      (heatmapCrashes ?? crashes).map(
        (crash) =>
          [crash.latitude, crash.longitude, getHeatWeight(crash)] as [
            number,
            number,
            number,
          ],
      ),
    [crashes, heatmapCrashes],
  );

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

    index.load(crashes.map(toFeature));
    lastClusterKeyRef.current = "";
    return index;
  }, [crashes]);

  useEffect(() => {
    clusterIndexRef.current = clusterIndex;
  }, [clusterIndex]);

  useEffect(() => {
    driveModeRef.current = driveMode;
  }, [driveMode]);

  const mode = viewState ? getRenderMode(viewState.zoom) : "heatmap";
  const heading = getNormalisedHeading(driveMode?.location?.heading);
  const isHeadingUp = Boolean(driveMode?.isActive && heading !== null);
  const mapBearing = isHeadingUp ? -(heading ?? 0) : 0;

  const statusText = useMemo(() => {
    if (!viewState) return "Preparing map";
    if (mode === "heatmap") return "Zoom in to inspect individual crashes";
    if (isUpdating) return "Updating visible crash data...";

    return `Showing ${areaCrashCount.toLocaleString("en-AU")} crashes in this area`;
  }, [areaCrashCount, isUpdating, mode, viewState]);

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
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    const canvas = L.DomUtil.create("canvas", "crash-canvas-layer");
    canvas.style.position = "absolute";
    canvas.style.pointerEvents = "none";
    map.getPanes().overlayPane.appendChild(canvas);
    canvasRef.current = canvas;

    const updateViewport = () => {
      const currentDriveMode = driveModeRef.current;
      const currentHeading = getNormalisedHeading(currentDriveMode?.location?.heading);
      applyMapBearing(
        map,
        currentDriveMode?.isActive && currentHeading !== null ? -currentHeading : 0,
      );
      if (updateTimerRef.current) window.clearTimeout(updateTimerRef.current);
      setIsUpdating(true);
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
      map.off("moveend zoomend resize", updateViewport);
      map.off("click", handleMapClick);
      map.off("mousedown", handleMouseDown);
      map.off("mousemove", handleMouseMove);
      map.off("mouseup", stopSimDrag);
      map.off("mouseout", stopSimDrag);
      canvas.remove();
      map.remove();
      mapRef.current = null;
      canvasRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applyMapBearing(map, mapBearing);
  }, [mapBearing]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (heatRef.current) {
      map.removeLayer(heatRef.current);
      heatRef.current = null;
    }

    if ((mode === "heatmap" || driveMode?.isActive) && heatPoints.length) {
      heatRef.current = L.heatLayer(heatPoints, {
        radius: 18,
        blur: 18,
        minOpacity: driveMode?.isActive ? 0.12 : 0.3,
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
      const visibleDriveCrashes = sortByRisk(
        crashes.map((crash): RenderCrash => ({
          kind: "crash",
          latitude: crash.latitude,
          longitude: crash.longitude,
          crash,
          risk: getRiskWeight(crash),
        })),
      ).slice(0, MAX_RENDERED_OBJECTS);

      setAreaCrashCount(crashes.length);
      setRenderItems(visibleDriveCrashes);
      setIsUpdating(false);
      return;
    }

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

    const location = L.latLng(driveMode.location.latitude, driveMode.location.longitude);
    const targetZoom = Math.max(map.getZoom(), 14);

    if (map.getZoom() < 14) {
      map.flyTo(location, targetZoom, { animate: true, duration: 0.45 });
    } else {
      map.panTo(location, { animate: true, duration: 0.35 });
    }
  }, [driveMode?.isActive, driveMode?.location?.latitude, driveMode?.location?.longitude]);

  useEffect(() => {
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
      context.font = "700 12px Inter, system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";

      const nextClickableItems: Array<RenderItem & { x: number; y: number; radius: number }> =
        [];

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
          context.fillText(item.count > 999 ? `${Math.round(item.count / 100) / 10}k` : String(item.count), x, y);

          nextClickableItems.push({ ...item, x, y, radius });
          continue;
        }

        const radius = item.risk >= 8 ? 7 : item.risk >= 4 ? 6 : 4.5;
        const color = getCrashColor(item.crash);
        const shouldGlow = timePhase === "night" || timePhase === "dusk";

          context.shadowColor = shouldGlow || driveMode?.isActive ? color : "transparent";
          context.shadowBlur = shouldGlow ? 14 : 0;

        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = color;
        context.fill();
        context.shadowBlur = 0;
        context.lineWidth = 1.75;
        context.strokeStyle = "#ffffff";
        context.stroke();

        nextClickableItems.push({ ...item, x, y, radius });
      }

      if (driveMode?.isActive && driveMode.location) {
        const point = map.latLngToLayerPoint([
          driveMode.location.latitude,
          driveMode.location.longitude,
        ]);
        const x = point.x - topLeft.x;
        const y = point.y - topLeft.y;

        context.save();
        context.shadowColor = "#38bdf8";
        context.shadowBlur = 18;
        context.beginPath();
        context.arc(x, y, 11, 0, Math.PI * 2);
        context.fillStyle = "#0284c7";
        context.fill();
        context.shadowBlur = 0;
        context.lineWidth = 3;
        context.strokeStyle = "#ffffff";
        context.stroke();

        if (typeof driveMode.location.heading === "number") {
          const headingRadians = (driveMode.location.heading * Math.PI) / 180;
          context.translate(x, y);
          context.rotate(headingRadians);
          context.beginPath();
          context.moveTo(0, -24);
          context.lineTo(7, -6);
          context.lineTo(0, -10);
          context.lineTo(-7, -6);
          context.closePath();
          context.fillStyle = "#38bdf8";
          context.fill();
        }

        context.restore();
      }

      canvasItemsRef.current = nextClickableItems;
    });
  }, [driveMode, renderItems, timePhase, viewState]);

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
