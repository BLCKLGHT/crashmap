import type { GeoJSONSource, Map as MapboxMap, MapSourceDataEvent } from "mapbox-gl";
import { extractTrafficSegments } from "./trafficGeometry";
import { TrafficParticleEngine } from "./trafficParticleEngine";
import { EMPTY_TRAFFIC_PARTICLE_FRAME, TRAFFIC_FLOW_CONFIG } from "./trafficConfig";

type TrafficFlowLayerOptions = {
  beforeParticleLayerId?: string;
  beforeTrafficLayerId?: string;
};

type TrafficLayerVisibility = {
  trafficConditions: boolean;
  trafficFlow: boolean;
};

type MapboxTrafficFeature = {
  id?: string | number;
  properties?: Record<string, unknown> | null;
  geometry?: {
    type?: string;
    coordinates?: unknown;
  } | null;
};

const createTrafficParticleImage = (
  color: string,
  leadColor = "rgba(255,255,255,0.96)",
): ImageData | null => {
  const canvas = document.createElement("canvas");
  canvas.width = 56;
  canvas.height = 14;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.clearRect(0, 0, canvas.width, canvas.height);
  const gradient = context.createLinearGradient(0, 0, canvas.width, 0);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(0.28, color.replace("1)", "0.15)"));
  gradient.addColorStop(0.72, color);
  gradient.addColorStop(1, leadColor);

  context.fillStyle = gradient;
  context.beginPath();
  context.moveTo(4, 7);
  context.quadraticCurveTo(19, 0.5, 45, 2.4);
  context.quadraticCurveTo(55, 7, 45, 11.6);
  context.quadraticCurveTo(19, 13.5, 4, 7);
  context.closePath();
  context.fill();

  return context.getImageData(0, 0, canvas.width, canvas.height);
};

const addParticleImages = (map: MapboxMap): void => {
  const images = [
    ["traffic-flow-low", "rgba(125, 211, 252, 1)"],
    ["traffic-flow-moderate", "rgba(45, 212, 191, 1)"],
    ["traffic-flow-heavy", "rgba(251, 191, 36, 1)"],
    ["traffic-flow-severe", "rgba(248, 113, 113, 1)"],
  ] as const;

  for (const [id, color] of images) {
    if (map.hasImage(id)) continue;
    const image = createTrafficParticleImage(color);
    if (image) map.addImage(id, image, { pixelRatio: 2 });
  }
};

const safeSetLayerVisibility = (map: MapboxMap, layerId: string, visible: boolean): void => {
  if (!map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
};

const getExistingBeforeLayerId = (map: MapboxMap, layerId?: string): string | undefined =>
  layerId && map.getLayer(layerId) ? layerId : undefined;

export class TrafficFlowLayer {
  private readonly engine = new TrafficParticleEngine();
  private readonly map: MapboxMap;
  private readonly beforeParticleLayerId?: string;
  private readonly beforeTrafficLayerId?: string;
  private animationFrame: number | null = null;
  private isDisposed = false;
  private isTrafficFlowVisible = false;
  private isTrafficConditionsVisible = false;
  private reducedMotionQuery: MediaQueryList | null = null;
  private lastRebuildKey = "";

  constructor(map: MapboxMap, options: TrafficFlowLayerOptions = {}) {
    this.map = map;
    this.beforeParticleLayerId = options.beforeParticleLayerId;
    this.beforeTrafficLayerId = options.beforeTrafficLayerId;
    this.reducedMotionQuery =
      typeof window !== "undefined" && "matchMedia" in window
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;

    this.handleMoveEnd = this.handleMoveEnd.bind(this);
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
    this.handleSourceData = this.handleSourceData.bind(this);

    this.addLayers();
    this.map.on("moveend", this.handleMoveEnd);
    this.map.on("zoomend", this.handleMoveEnd);
    this.map.on("sourcedata", this.handleSourceData);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  setVisibility(visibility: TrafficLayerVisibility): void {
    this.isTrafficConditionsVisible = visibility.trafficConditions;
    this.isTrafficFlowVisible = visibility.trafficFlow;
    safeSetLayerVisibility(
      this.map,
      TRAFFIC_FLOW_CONFIG.trafficConditionsLayerId,
      visibility.trafficConditions,
    );
    safeSetLayerVisibility(
      this.map,
      TRAFFIC_FLOW_CONFIG.trafficLoaderLayerId,
      visibility.trafficFlow,
    );
    safeSetLayerVisibility(this.map, TRAFFIC_FLOW_CONFIG.layerId, visibility.trafficFlow);

    if (visibility.trafficFlow) {
      this.lastRebuildKey = "";
      this.rebuildParticles();
      this.start();
    } else {
      this.stop();
      this.engine.clear();
      this.setParticleData(EMPTY_TRAFFIC_PARTICLE_FRAME);
    }
  }

  dispose(): void {
    this.isDisposed = true;
    this.stop();
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.map.off("moveend", this.handleMoveEnd);
    this.map.off("zoomend", this.handleMoveEnd);
    this.map.off("sourcedata", this.handleSourceData);
  }

  private addLayers(): void {
    if (!this.map.getSource(TRAFFIC_FLOW_CONFIG.trafficSourceId)) {
      this.map.addSource(TRAFFIC_FLOW_CONFIG.trafficSourceId, {
        type: "vector",
        url: "mapbox://mapbox.mapbox-traffic-v1",
      });
    }

    if (!this.map.getLayer(TRAFFIC_FLOW_CONFIG.trafficConditionsLayerId)) {
      this.map.addLayer(
        {
          id: TRAFFIC_FLOW_CONFIG.trafficConditionsLayerId,
          type: "line",
          source: TRAFFIC_FLOW_CONFIG.trafficSourceId,
          "source-layer": TRAFFIC_FLOW_CONFIG.trafficSourceLayer,
          filter: [
            "any",
            ["has", "congestion"],
            ["==", ["get", "closed"], true],
            ["==", ["get", "closed"], "true"],
            ["==", ["get", "closed"], "yes"],
            ["==", ["get", "closed"], 1],
          ],
          layout: {
            "line-cap": "round",
            "line-join": "round",
            visibility: "none",
          },
          paint: {
            "line-color": [
              "case",
              [
                "any",
                ["==", ["get", "closed"], true],
                ["==", ["get", "closed"], "true"],
                ["==", ["get", "closed"], "yes"],
                ["==", ["get", "closed"], 1],
              ],
              "#64748b",
              [
                "match",
                ["get", "congestion"],
                "low",
                "#22c55e",
                "moderate",
                "#facc15",
                "heavy",
                "#f97316",
                "severe",
                "#ef4444",
                "#22c55e",
              ],
            ],
            "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.2, 14, 3.2, 17, 6],
            "line-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.34, 12, 0.58, 16, 0.72],
          },
        },
        getExistingBeforeLayerId(this.map, this.beforeTrafficLayerId),
      );
    }

    if (!this.map.getLayer(TRAFFIC_FLOW_CONFIG.trafficLoaderLayerId)) {
      this.map.addLayer(
        {
          id: TRAFFIC_FLOW_CONFIG.trafficLoaderLayerId,
          type: "line",
          source: TRAFFIC_FLOW_CONFIG.trafficSourceId,
          "source-layer": TRAFFIC_FLOW_CONFIG.trafficSourceLayer,
          filter: [
            "any",
            ["has", "congestion"],
            ["==", ["get", "closed"], true],
            ["==", ["get", "closed"], "true"],
            ["==", ["get", "closed"], "yes"],
            ["==", ["get", "closed"], 1],
          ],
          layout: {
            visibility: "none",
          },
          paint: {
            "line-color": "rgba(0, 0, 0, 0)",
            "line-opacity": 0,
            "line-width": 1,
          },
        },
        getExistingBeforeLayerId(this.map, this.beforeTrafficLayerId),
      );
    }

    if (!this.map.getSource(TRAFFIC_FLOW_CONFIG.sourceId)) {
      this.map.addSource(TRAFFIC_FLOW_CONFIG.sourceId, {
        type: "geojson",
        data: EMPTY_TRAFFIC_PARTICLE_FRAME,
      });
    }

    addParticleImages(this.map);

    if (!this.map.getLayer(TRAFFIC_FLOW_CONFIG.layerId)) {
      this.map.addLayer(
        {
          id: TRAFFIC_FLOW_CONFIG.layerId,
          type: "symbol",
          source: TRAFFIC_FLOW_CONFIG.sourceId,
          layout: {
            "icon-image": ["get", "icon"],
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "icon-rotation-alignment": "map",
            "icon-pitch-alignment": "map",
            "icon-rotate": ["get", "bearing"],
            "icon-size": [
              "*",
              ["get", "scale"],
              ["interpolate", ["linear"], ["zoom"], 10, 0.16, 12, 0.24, 14, 0.36, 17, 0.56],
            ],
            visibility: "none",
          },
          paint: {
            "icon-opacity": ["get", "opacity"],
          },
        },
        getExistingBeforeLayerId(this.map, this.beforeParticleLayerId),
      );
    }
  }

  private handleSourceData(event: MapSourceDataEvent): void {
    if (event.sourceId !== TRAFFIC_FLOW_CONFIG.trafficSourceId || !event.isSourceLoaded) return;
    if (this.isTrafficFlowVisible) this.rebuildParticles();
  }

  private handleMoveEnd(): void {
    if (this.isTrafficFlowVisible) this.rebuildParticles();
  }

  private handleVisibilityChange(): void {
    if (document.hidden) {
      this.stop();
      return;
    }
    if (this.isTrafficFlowVisible) this.start();
  }

  private rebuildParticles(): void {
    if (this.reducedMotionQuery?.matches) {
      this.stop();
      this.setParticleData(EMPTY_TRAFFIC_PARTICLE_FRAME);
      return;
    }

    const zoom = this.map.getZoom();
    if (zoom < TRAFFIC_FLOW_CONFIG.minParticleZoom) {
      this.engine.clear();
      this.setParticleData(EMPTY_TRAFFIC_PARTICLE_FRAME);
      return;
    }

    let features: MapboxTrafficFeature[] = [];
    try {
      features = this.map.querySourceFeatures(TRAFFIC_FLOW_CONFIG.trafficSourceId, {
        sourceLayer: TRAFFIC_FLOW_CONFIG.trafficSourceLayer,
      }) as MapboxTrafficFeature[];
    } catch {
      return;
    }

    const centre = this.map.getCenter();
    const rebuildKey = `${Math.round(zoom * 4) / 4}:${centre.lng.toFixed(2)}:${centre.lat.toFixed(
      2,
    )}:${features.length}`;
    if (rebuildKey === this.lastRebuildKey) return;
    this.lastRebuildKey = rebuildKey;

    this.engine.rebuild(extractTrafficSegments(features), zoom);
  }

  private start(): void {
    if (
      this.animationFrame !== null ||
      this.isDisposed ||
      !this.isTrafficFlowVisible ||
      document.hidden ||
      this.reducedMotionQuery?.matches
    ) {
      return;
    }

    const animate = (time: number) => {
      if (this.isDisposed || !this.isTrafficFlowVisible || document.hidden) {
        this.animationFrame = null;
        return;
      }

      const frame = this.engine.frame(time / 1000, this.map.getZoom());
      this.setParticleData(frame);
      this.animationFrame = window.requestAnimationFrame(animate);
    };

    this.animationFrame = window.requestAnimationFrame(animate);
  }

  private stop(): void {
    if (this.animationFrame !== null) {
      window.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  private setParticleData(frame: GeoJSON.FeatureCollection<GeoJSON.Point>): void {
    const source = this.map.getSource(TRAFFIC_FLOW_CONFIG.sourceId) as GeoJSONSource | undefined;
    source?.setData(frame);
  }
}
