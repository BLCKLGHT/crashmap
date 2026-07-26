import { useEffect, useMemo, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapboxMap, MapMouseEvent, Marker, Popup } from "mapbox-gl";
import type {
  CrashRecord,
  CurrentDrivingConditions,
  DriveLocation,
  ViewerLayerToggles,
  WeatherMatchSetting,
} from "../types/crash";
import { getCrashConditionMatch } from "../data/conditionMatching";
import { isFatalCrash, isSeriousCrash } from "../data/filterCrashes";
import { fetchRuntimeMapboxToken, getMapboxToken } from "../data/mapboxToken";
import { TrafficFlowLayer } from "../traffic/TrafficFlowLayer";
import vehicleTopImageUrl from "../assets/vehicle-top.png";

type CrashMapProps = {
  crashes: CrashRecord[];
  heatmapCrashes?: CrashRecord[];
  currentConditions?: CurrentDrivingConditions | null;
  weatherMode?: WeatherMatchSetting;
  weatherMatchedCrashIds?: string[];
  timePhase: "day" | "dawn" | "dusk" | "night";
  isFullscreen?: boolean;
  viewerLayers?: ViewerLayerToggles;
  driveMode?: {
    isActive: boolean;
    isSimulation: boolean;
    location: DriveLocation | null;
    nearbyCrashes: CrashRecord[];
    onSimulatedLocationChange: (location: Omit<DriveLocation, "timestamp">) => void;
  };
};

type CrashFeatureProperties = {
  id: string;
  severity: string;
  severityRank: number;
  heatWeight: number;
  conditionWeight: number;
  dateTime: string;
  speedZone: string;
  surfaceType: string;
  lightCondition: string;
  locationDescription: string;
};

type VehicleFeatureProperties = {
  heading: number;
  accuracy: number;
  isSimulated: boolean;
};

const CRASH_SOURCE_ID = "mapbox-crash-points";
const VEHICLE_SOURCE_ID = "mapbox-drive-location";
const HEATMAP_LAYER_ID = "mapbox-crash-heatmap";
const CLUSTER_LAYER_ID = "mapbox-crash-clusters";
const CLUSTER_COUNT_LAYER_ID = "mapbox-crash-cluster-count";
const SINGLE_COUNT_LAYER_ID = "mapbox-crash-single-counts";
const SINGLE_COUNT_TEXT_LAYER_ID = "mapbox-crash-single-count-labels";
const CRASH_GLOW_LAYER_ID = "mapbox-crash-glow";
const CRASH_DOT_LAYER_ID = "mapbox-crash-dots";
const VEHICLE_ACCURACY_LAYER_ID = "mapbox-drive-accuracy";
const TASMANIA_BOUNDS: [[number, number], [number, number]] = [
  [144.35, -43.85],
  [148.65, -39.55],
];
const TASMANIA_CENTRE: [number, number] = [146.6, -42.05];
const CLUSTER_MIN_ZOOM = 5.5;
const CLUSTER_MAX_ZOOM = 11;
const CLUSTER_LAYER_MAX_ZOOM = 12.6;
const POINT_MIN_ZOOM = 12;
const SINGLE_COUNT_MAX_ZOOM = 12.35;
const DRIVE_ZOOM = 15.5;
const DEFAULT_VIEWER_LAYERS: ViewerLayerToggles = {
  crashMarkers: true,
  heatmap: true,
  trafficConditions: false,
  trafficFlow: false,
};
const CRASH_MARKER_LAYER_IDS = [
  CLUSTER_LAYER_ID,
  CLUSTER_COUNT_LAYER_ID,
  SINGLE_COUNT_LAYER_ID,
  SINGLE_COUNT_TEXT_LAYER_ID,
  CRASH_GLOW_LAYER_ID,
  CRASH_DOT_LAYER_ID,
];

const getStyleForPhase = (phase: CrashMapProps["timePhase"]): string =>
  phase === "night" || phase === "dusk"
    ? "mapbox://styles/mapbox/navigation-night-v1"
    : "mapbox://styles/mapbox/navigation-day-v1";

const getSeverityRank = (crash: CrashRecord): number => {
  if (isFatalCrash(crash)) return 3;
  if (isSeriousCrash(crash)) return 2;
  return 1;
};

const getHeatWeight = (crash: CrashRecord): number => {
  if (isFatalCrash(crash)) return 1;
  if (isSeriousCrash(crash)) return 0.82;
  return 0.5;
};

const getConditionWeight = (
  crash: CrashRecord,
  currentConditions?: CurrentDrivingConditions | null,
  weatherMode?: WeatherMatchSetting,
): number => {
  if (weatherMode !== "current" || !currentConditions) return 1;
  return getCrashConditionMatch(crash, currentConditions).weight;
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

const popupHtml = (properties: CrashFeatureProperties): string => `
  <article class="crash-popup">
    <h2>${escapeHtml(properties.severity || "Crash record")}</h2>
    <dl>
      <div><dt>Date/time</dt><dd>${escapeHtml(formatDate(properties.dateTime))}</dd></div>
      <div><dt>Speed zone</dt><dd>${escapeHtml(properties.speedZone)}</dd></div>
      <div><dt>Surface type</dt><dd>${escapeHtml(properties.surfaceType)}</dd></div>
      <div><dt>Light condition</dt><dd>${escapeHtml(properties.lightCondition)}</dd></div>
      <div><dt>Location</dt><dd>${escapeHtml(properties.locationDescription)}</dd></div>
    </dl>
  </article>
`;

const toCrashFeatureCollection = (
  crashes: CrashRecord[],
  currentConditions?: CurrentDrivingConditions | null,
  weatherMode?: WeatherMatchSetting,
  weatherMatchedCrashIds: string[] = [],
): GeoJSON.FeatureCollection<GeoJSON.Point, CrashFeatureProperties> => {
  const matchedIds = new Set(weatherMatchedCrashIds);
  return {
    type: "FeatureCollection",
    features: crashes.map((crash) => {
      const conditionWeight =
        weatherMode === "historical" && matchedIds.size > 0
          ? matchedIds.has(crash.id)
            ? 1.35
            : 0.55
          : getConditionWeight(crash, currentConditions, weatherMode);
      return {
        type: "Feature",
        properties: {
          id: crash.id,
          severity: crash.severity ?? "Crash record",
          severityRank: getSeverityRank(crash),
          heatWeight: getHeatWeight(crash) * conditionWeight,
          conditionWeight,
          dateTime: crash.dateTime ?? "",
          speedZone: crash.speedZone ?? "",
          surfaceType: crash.surfaceType ?? "",
          lightCondition: crash.lightCondition ?? "",
          locationDescription: crash.locationDescription ?? "",
        },
        geometry: {
          type: "Point",
          coordinates: [crash.longitude, crash.latitude],
        },
      };
    }),
  };
};

const toVehicleFeatureCollection = (
  location: DriveLocation | null,
): GeoJSON.FeatureCollection<GeoJSON.Point, VehicleFeatureProperties> => ({
  type: "FeatureCollection",
  features: location
    ? [
        {
          type: "Feature",
          properties: {
            heading: location.heading ?? 0,
            accuracy: location.accuracy ?? 0,
            isSimulated: Boolean(location.isSimulated),
          },
          geometry: {
            type: "Point",
            coordinates: [location.longitude, location.latitude],
          },
        },
      ]
    : [],
});

export function CrashMap({
  crashes,
  currentConditions,
  weatherMode,
  weatherMatchedCrashIds,
  timePhase,
  viewerLayers,
  driveMode,
}: CrashMapProps) {
  const buildTimeToken = getMapboxToken();
  const [runtimeToken, setRuntimeToken] = useState<string | null>(buildTimeToken ?? null);
  const [status, setStatus] = useState(buildTimeToken ? "loading" : "checking-token");
  const [isMapReady, setIsMapReady] = useState(false);
  const [mapZoom, setMapZoom] = useState(6);
  const token = runtimeToken ?? buildTimeToken;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const trafficFlowLayerRef = useRef<TrafficFlowLayer | null>(null);
  const driveLocationRef = useRef<DriveLocation | null>(null);
  const simulationRef = useRef<CrashMapProps["driveMode"]>(driveMode);
  const crashFeatureCollectionRef =
    useRef<GeoJSON.FeatureCollection<GeoJSON.Point, CrashFeatureProperties> | null>(null);
  const vehicleFeatureCollectionRef =
    useRef<GeoJSON.FeatureCollection<GeoJSON.Point, VehicleFeatureProperties> | null>(null);

  driveLocationRef.current = driveMode?.location ?? null;
  simulationRef.current = driveMode;

  const crashFeatureCollection = useMemo(
    () =>
      toCrashFeatureCollection(
        crashes,
        currentConditions,
        weatherMode,
        weatherMatchedCrashIds,
      ),
    [crashes, currentConditions, weatherMatchedCrashIds, weatherMode],
  );

  const vehicleFeatureCollection = useMemo(
    () => toVehicleFeatureCollection(driveMode?.location ?? null),
    [driveMode?.location],
  );
  const effectiveViewerLayers = useMemo<ViewerLayerToggles>(
    () => ({ ...DEFAULT_VIEWER_LAYERS, ...viewerLayers }),
    [viewerLayers],
  );
  crashFeatureCollectionRef.current = crashFeatureCollection;
  vehicleFeatureCollectionRef.current = vehicleFeatureCollection;

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

    void import("mapbox-gl")
      .then((module) => {
        if (isCancelled || !containerRef.current) return;
        const mapboxgl = module.default;
        mapboxgl.accessToken = token;

        const map = new mapboxgl.Map({
          container: containerRef.current,
          style: getStyleForPhase(timePhase),
          center: driveLocationRef.current
            ? [driveLocationRef.current.longitude, driveLocationRef.current.latitude]
            : TASMANIA_CENTRE,
          zoom: driveLocationRef.current ? DRIVE_ZOOM : 6,
          pitch: driveLocationRef.current ? 52 : 0,
          bearing: driveLocationRef.current?.heading ?? 0,
          attributionControl: false,
          antialias: true,
        });
        createdMap = map;
        mapRef.current = map;

        map.addControl(
          new mapboxgl.AttributionControl({
            compact: true,
            customAttribution: "Mapbox",
          }),
        );

        map.on("load", () => {
          map.addSource(CRASH_SOURCE_ID, {
            type: "geojson",
            data: crashFeatureCollectionRef.current ?? crashFeatureCollection,
            cluster: true,
            clusterMaxZoom: CLUSTER_MAX_ZOOM,
            clusterRadius: 52,
            clusterProperties: {
              fatalCount: ["+", ["case", ["==", ["get", "severityRank"], 3], 1, 0]],
              seriousCount: ["+", ["case", ["==", ["get", "severityRank"], 2], 1, 0]],
              riskSum: ["+", ["get", "severityRank"]],
            },
          });
          map.addSource(VEHICLE_SOURCE_ID, {
            type: "geojson",
            data: vehicleFeatureCollectionRef.current ?? vehicleFeatureCollection,
          });

          map.addLayer({
            id: HEATMAP_LAYER_ID,
            type: "heatmap",
            source: CRASH_SOURCE_ID,
            maxzoom: CLUSTER_MIN_ZOOM,
            paint: {
              "heatmap-weight": [
                "interpolate",
                ["linear"],
                ["get", "heatWeight"],
                0,
                0,
                1,
                1,
              ],
              "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 4.8, 0.55, 5.5, 0.8],
              "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 4.8, 8, 5.5, 13],
              "heatmap-opacity": [
                "interpolate",
                ["linear"],
                ["zoom"],
                4.8,
                0.56,
                CLUSTER_MIN_ZOOM,
                0,
              ],
              "heatmap-color": [
                "interpolate",
                ["linear"],
                ["heatmap-density"],
                0,
                "rgba(15, 118, 110, 0)",
                0.2,
                "rgba(20, 184, 166, 0.62)",
                0.48,
                "rgba(249, 115, 22, 0.78)",
                0.78,
                "rgba(239, 68, 68, 0.88)",
                1,
                "rgba(127, 29, 29, 0.96)",
              ],
            },
          });

          map.addLayer({
            id: CLUSTER_LAYER_ID,
            type: "circle",
            source: CRASH_SOURCE_ID,
            minzoom: CLUSTER_MIN_ZOOM,
            maxzoom: CLUSTER_LAYER_MAX_ZOOM,
            filter: ["has", "point_count"],
            paint: {
              "circle-color": [
                "case",
                [">", ["get", "fatalCount"], 0],
                "#dc2626",
                [">", ["get", "seriousCount"], 0],
                "#f97316",
                "#0f766e",
              ],
              "circle-radius": [
                "interpolate",
                ["linear"],
                ["get", "point_count"],
                1,
                12,
                80,
                24,
                500,
                36,
                5000,
                52,
              ],
              "circle-opacity": [
                "interpolate",
                ["linear"],
                ["zoom"],
                CLUSTER_MIN_ZOOM,
                0.58,
                11.8,
                0.76,
                CLUSTER_LAYER_MAX_ZOOM,
                0.24,
              ],
              "circle-stroke-color": "rgba(255, 255, 255, 0.88)",
              "circle-stroke-width": [
                "interpolate",
                ["linear"],
                ["get", "point_count"],
                1,
                1.1,
                500,
                2,
              ],
            },
          });

          map.addLayer({
            id: CLUSTER_COUNT_LAYER_ID,
            type: "symbol",
            source: CRASH_SOURCE_ID,
            minzoom: CLUSTER_MIN_ZOOM,
            maxzoom: CLUSTER_LAYER_MAX_ZOOM,
            filter: ["has", "point_count"],
            layout: {
              "text-field": ["get", "point_count_abbreviated"],
              "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
              "text-size": ["interpolate", ["linear"], ["zoom"], 6.4, 10, 10, 12, 12.6, 11],
            },
            paint: {
              "text-color": "#ffffff",
              "text-opacity": [
                "interpolate",
                ["linear"],
                ["zoom"],
                11.8,
                1,
                CLUSTER_LAYER_MAX_ZOOM,
                0.28,
              ],
            },
          });

          map.addLayer({
            id: SINGLE_COUNT_LAYER_ID,
            type: "circle",
            source: CRASH_SOURCE_ID,
            minzoom: CLUSTER_MIN_ZOOM,
            maxzoom: SINGLE_COUNT_MAX_ZOOM,
            filter: ["!", ["has", "point_count"]],
            paint: {
              "circle-color": [
                "match",
                ["get", "severityRank"],
                3,
                "#dc2626",
                2,
                "#f97316",
                "#0f766e",
              ],
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 5.5, 8, 10, 11, 12, 13],
              "circle-opacity": [
                "interpolate",
                ["linear"],
                ["zoom"],
                5.5,
                0.5,
                11.8,
                0.62,
                SINGLE_COUNT_MAX_ZOOM,
                0,
              ],
              "circle-stroke-color": "rgba(255, 255, 255, 0.88)",
              "circle-stroke-width": 1.1,
            },
          });

          map.addLayer({
            id: SINGLE_COUNT_TEXT_LAYER_ID,
            type: "symbol",
            source: CRASH_SOURCE_ID,
            minzoom: CLUSTER_MIN_ZOOM,
            maxzoom: SINGLE_COUNT_MAX_ZOOM,
            filter: ["!", ["has", "point_count"]],
            layout: {
              "text-field": "1",
              "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
              "text-size": ["interpolate", ["linear"], ["zoom"], 5.5, 9, 10, 10.5, 12, 11],
            },
            paint: {
              "text-color": "#ffffff",
              "text-opacity": [
                "interpolate",
                ["linear"],
                ["zoom"],
                5.5,
                0.72,
                11.8,
                0.9,
                SINGLE_COUNT_MAX_ZOOM,
                0,
              ],
            },
          });

          map.addLayer({
            id: CRASH_GLOW_LAYER_ID,
            type: "circle",
            source: CRASH_SOURCE_ID,
            minzoom: POINT_MIN_ZOOM,
            filter: ["!", ["has", "point_count"]],
            paint: {
              "circle-radius": [
                "interpolate",
                ["linear"],
                ["zoom"],
                POINT_MIN_ZOOM,
                ["match", ["get", "severityRank"], 3, 14, 2, 11, 8],
                17,
                18,
              ],
              "circle-color": [
                "match",
                ["get", "severityRank"],
                3,
                "#ef4444",
                2,
                "#f97316",
                "#14b8a6",
              ],
              "circle-blur": 0.62,
              "circle-opacity": [
                "match",
                ["get", "severityRank"],
                3,
                0.38,
                2,
                0.26,
                0.16,
              ],
            },
          });

          map.addLayer({
            id: CRASH_DOT_LAYER_ID,
            type: "circle",
            source: CRASH_SOURCE_ID,
            minzoom: POINT_MIN_ZOOM,
            filter: ["!", ["has", "point_count"]],
            paint: {
              "circle-radius": [
                "interpolate",
                ["linear"],
                ["zoom"],
                POINT_MIN_ZOOM,
                ["match", ["get", "severityRank"], 3, 6, 2, 4.8, 3.8],
                17,
                ["match", ["get", "severityRank"], 3, 8, 2, 5, 4],
              ],
              "circle-color": [
                "match",
                ["get", "severityRank"],
                3,
                "#dc2626",
                2,
                "#d97706",
                "#0f766e",
              ],
              "circle-stroke-color": "rgba(255, 255, 255, 0.86)",
              "circle-stroke-width": [
                "match",
                ["get", "severityRank"],
                3,
                1.8,
                2,
                1.2,
                0.8,
              ],
              "circle-opacity": 0.94,
            },
          });

          trafficFlowLayerRef.current = new TrafficFlowLayer(map, {
            beforeTrafficLayerId: HEATMAP_LAYER_ID,
            beforeParticleLayerId: CRASH_GLOW_LAYER_ID,
          });
          trafficFlowLayerRef.current?.setVisibility({
            trafficConditions: effectiveViewerLayers.trafficConditions,
            trafficFlow: effectiveViewerLayers.trafficFlow,
          });

          map.addLayer({
            id: VEHICLE_ACCURACY_LAYER_ID,
            type: "circle",
            source: VEHICLE_SOURCE_ID,
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 12, 17, 42],
              "circle-color": "rgba(59, 130, 246, 0.16)",
              "circle-stroke-color": "rgba(59, 130, 246, 0.35)",
              "circle-stroke-width": 1,
            },
          });

          const vehicleElement = document.createElement("button");
          vehicleElement.type = "button";
          vehicleElement.className = "mapbox-vehicle-marker";
          vehicleElement.setAttribute("aria-label", "Current vehicle position");
          vehicleElement.innerHTML = `<img src="${vehicleTopImageUrl}" alt="" draggable="false" />`;

          const marker = new mapboxgl.Marker({
            element: vehicleElement,
            anchor: "center",
            rotationAlignment: "map",
            pitchAlignment: "map",
            draggable: Boolean(simulationRef.current?.isSimulation),
          });
          marker
            .setLngLat(
              driveLocationRef.current
                ? [driveLocationRef.current.longitude, driveLocationRef.current.latitude]
                : TASMANIA_CENTRE,
            )
            .setRotation(driveLocationRef.current?.heading ?? 0)
            .addTo(map);
          marker.getElement().style.display = driveLocationRef.current ? "" : "none";
          marker.on("drag", () => {
            const simulation = simulationRef.current;
            if (!simulation?.isSimulation) return;
            const lngLat = marker.getLngLat();
            simulation.onSimulatedLocationChange({
              latitude: lngLat.lat,
              longitude: lngLat.lng,
              heading: simulation.location?.heading ?? 0,
              headingSource: "simulated",
              speed: 0,
              isSimulated: true,
            });
          });
          markerRef.current = marker;

          map.fitBounds(TASMANIA_BOUNDS, {
            padding: { top: 72, right: 34, bottom: 150, left: 34 },
            duration: 0,
          });
          setIsMapReady(true);
          setMapZoom(map.getZoom());
          setStatus("ready");
        });

        map.on("zoomend", () => {
          setMapZoom(map.getZoom());
        });

        map.on("click", CLUSTER_LAYER_ID, (event) => {
          const feature = map.queryRenderedFeatures(event.point, {
            layers: [CLUSTER_LAYER_ID],
          })[0];
          const clusterId = feature?.properties?.cluster_id as number | undefined;
          const source = map.getSource(CRASH_SOURCE_ID) as GeoJSONSource | undefined;
          if (clusterId === undefined || !source) return;
          source.getClusterExpansionZoom(clusterId, (error, zoom) => {
            if (error || typeof zoom !== "number") return;
            map.easeTo({
              center: (feature.geometry as GeoJSON.Point).coordinates as [number, number],
              zoom: Math.min(zoom + 0.5, 17),
              duration: 420,
            });
          });
        });

        map.on("click", CRASH_DOT_LAYER_ID, (event) => {
          const feature = event.features?.[0];
          if (!feature || feature.geometry.type !== "Point") return;
          popupRef.current?.remove();
          popupRef.current = new mapboxgl.Popup({
            closeButton: true,
            closeOnClick: true,
            maxWidth: "280px",
          })
            .setLngLat(feature.geometry.coordinates as [number, number])
            .setHTML(popupHtml(feature.properties as CrashFeatureProperties))
            .addTo(map);
        });

        map.on("click", SINGLE_COUNT_LAYER_ID, (event) => {
          const feature = event.features?.[0];
          if (!feature || feature.geometry.type !== "Point") return;
          popupRef.current?.remove();
          popupRef.current = new mapboxgl.Popup({
            closeButton: true,
            closeOnClick: true,
            maxWidth: "280px",
          })
            .setLngLat(feature.geometry.coordinates as [number, number])
            .setHTML(popupHtml(feature.properties as CrashFeatureProperties))
            .addTo(map);
        });

        map.on("mouseenter", CLUSTER_LAYER_ID, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", CLUSTER_LAYER_ID, () => {
          map.getCanvas().style.cursor = "";
        });
        map.on("mouseenter", CRASH_DOT_LAYER_ID, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", CRASH_DOT_LAYER_ID, () => {
          map.getCanvas().style.cursor = "";
        });
        map.on("mouseenter", SINGLE_COUNT_LAYER_ID, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", SINGLE_COUNT_LAYER_ID, () => {
          map.getCanvas().style.cursor = "";
        });

        map.on("click", (event: MapMouseEvent) => {
          const simulation = simulationRef.current;
          if (!simulation?.isSimulation) return;
          const features = map.queryRenderedFeatures(event.point, {
            layers: [
              CRASH_DOT_LAYER_ID,
              SINGLE_COUNT_LAYER_ID,
              SINGLE_COUNT_TEXT_LAYER_ID,
              CLUSTER_LAYER_ID,
              CLUSTER_COUNT_LAYER_ID,
            ],
          });
          if (features.length) return;
          simulation.onSimulatedLocationChange({
            latitude: event.lngLat.lat,
            longitude: event.lngLat.lng,
            heading: simulation.location?.heading ?? 0,
            headingSource: "simulated",
            speed: 0,
            isSimulated: true,
          });
        });

        map.on("error", (event) => {
          setStatus(event.error?.message ?? "mapbox-error");
        });
      })
      .catch(() => {
        setStatus("mapbox-load-failed");
      });

    return () => {
      isCancelled = true;
      popupRef.current?.remove();
      markerRef.current?.remove();
      trafficFlowLayerRef.current?.dispose();
      trafficFlowLayerRef.current = null;
      markerRef.current = null;
      createdMap?.remove();
      mapRef.current = null;
      setIsMapReady(false);
    };
  }, [token]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady || !map.isStyleLoaded()) return;

    const setLayerVisibility = (layerId: string, isVisible: boolean) => {
      if (!map.getLayer(layerId)) return;
      map.setLayoutProperty(layerId, "visibility", isVisible ? "visible" : "none");
    };

    setLayerVisibility(HEATMAP_LAYER_ID, effectiveViewerLayers.heatmap);
    CRASH_MARKER_LAYER_IDS.forEach((layerId) =>
      setLayerVisibility(layerId, effectiveViewerLayers.crashMarkers),
    );
    trafficFlowLayerRef.current?.setVisibility({
      trafficConditions: effectiveViewerLayers.trafficConditions,
      trafficFlow: effectiveViewerLayers.trafficFlow,
    });
  }, [effectiveViewerLayers, isMapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady || !map.isStyleLoaded()) return;
    const source = map.getSource(CRASH_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(crashFeatureCollection);
  }, [crashFeatureCollection, isMapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady || !map.isStyleLoaded()) return;
    const source = map.getSource(VEHICLE_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(vehicleFeatureCollection);

    const marker = markerRef.current;
    const location = driveMode?.location;
    if (!marker) return;
    marker.getElement().style.display = location ? "" : "none";
    marker.setDraggable(Boolean(driveMode?.isSimulation));
    if (location) {
      marker
        .setLngLat([location.longitude, location.latitude])
        .setRotation(location.heading ?? 0);
    }
  }, [isMapReady, vehicleFeatureCollection]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const location = driveMode?.location;
    if (driveMode?.isActive && location) {
      map.easeTo({
        center: [location.longitude, location.latitude],
        zoom: Math.max(map.getZoom(), DRIVE_ZOOM),
        pitch: 52,
        bearing: location.heading ?? map.getBearing(),
        duration: 520,
        easing: (time) => 1 - (1 - time) ** 3,
        essential: true,
      });
      return;
    }

    if (!driveMode?.isActive) {
      map.easeTo({
        pitch: 0,
        bearing: 0,
        duration: 380,
      });
    }
  }, [driveMode?.isActive, driveMode?.location, isMapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;
    window.requestAnimationFrame(() => map.resize());
  }, [isMapReady]);

  const visualModeLabel =
    !effectiveViewerLayers.crashMarkers && effectiveViewerLayers.trafficFlow
      ? "Traffic flow particles show indicative road movement"
      : mapZoom < CLUSTER_MIN_ZOOM
      ? "Heat glow shows broad crash concentration"
      : mapZoom < POINT_MIN_ZOOM
        ? "Circles group nearby crashes by count and severity"
        : "Dots show individual crash records";

  return (
    <section className={`map-shell map-shell--${timePhase}`}>
      <div ref={containerRef} className="map map--mapbox" />
      {status !== "ready" && (
        <div className="mapbox-status">
          {token ? "Loading Mapbox map" : "Mapbox token missing"}
        </div>
      )}
      <div className="map-mode" aria-live="polite">
        <strong>
          {driveMode?.isActive
            ? "Drive map"
            : crashes.length.toLocaleString("en-AU") + " crashes"}
        </strong>
        <span>
          {driveMode?.isActive
            ? "Following current position"
            : visualModeLabel}
        </span>
      </div>
    </section>
  );
}
