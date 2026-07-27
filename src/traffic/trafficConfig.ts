export type TrafficCongestion = "low" | "moderate" | "heavy" | "severe" | "closed";

export type TrafficSegment = {
  id: string;
  coordinates: Array<[number, number]>;
  lengthMetres: number;
  congestion: TrafficCongestion;
  roadClass: string;
  closed: boolean;
};

export type TrafficParticle = {
  id: string;
  segmentId: string;
  index: number;
  progressMetres: number;
  speedMultiplier: number;
  phaseOffset: number;
  opacityMultiplier: number;
  scale: number;
  lateralOffsetMetres: number;
};

export type TrafficParticleFrameFeatureProperties = {
  id: string;
  bearing: number;
  opacity: number;
  scale: number;
  icon: string;
};

export type TrafficFlowLineFeatureProperties = {
  id: string;
  congestion: Exclude<TrafficCongestion, "closed">;
  opacity: number;
};

export type TrafficParticlePointFrame = GeoJSON.FeatureCollection<
  GeoJSON.Point,
  TrafficParticleFrameFeatureProperties
>;

export type TrafficParticleFrame = GeoJSON.FeatureCollection<
  GeoJSON.Point | GeoJSON.LineString,
  TrafficParticleFrameFeatureProperties | TrafficFlowLineFeatureProperties
>;

export const TRAFFIC_FLOW_CONFIG = {
  sourceId: "viewer-traffic-flow-particles",
  lineLayerIds: {
    low: "viewer-traffic-flow-line-low",
    moderate: "viewer-traffic-flow-line-moderate",
    heavy: "viewer-traffic-flow-line-heavy",
    severe: "viewer-traffic-flow-line-severe",
  },
  directLineLayerIds: {
    low: "viewer-traffic-flow-direct-low",
    moderate: "viewer-traffic-flow-direct-moderate",
    heavy: "viewer-traffic-flow-direct-heavy",
    severe: "viewer-traffic-flow-direct-severe",
  },
  trafficDotLayerIds: {
    low: "viewer-traffic-flow-dot-low",
    moderate: "viewer-traffic-flow-dot-moderate",
    heavy: "viewer-traffic-flow-dot-heavy",
    severe: "viewer-traffic-flow-dot-severe",
  },
  glowLayerId: "viewer-traffic-flow-particle-glow",
  layerId: "viewer-traffic-flow-particles",
  trafficSourceId: "viewer-mapbox-traffic",
  trafficSourceLayer: "traffic",
  trafficLoaderLayerId: "viewer-traffic-flow-source-loader",
  trafficConditionsLayerId: "viewer-traffic-conditions",
  minParticleZoom: 6,
  maxVisibleParticles: 850,
  maxVisibleFlowLines: 180,
  minimumSegmentLengthMetres: 8,
  lateralOffsetMetres: 1,
  stableSalt: "tasmania-crash-map-traffic-flow-v1",
  congestion: {
    low: {
      baseSpeedMetresPerSecond: 38,
      particlesPerKilometre: 3,
      opacity: 0.54,
      icon: "traffic-flow-low",
    },
    moderate: {
      baseSpeedMetresPerSecond: 22,
      particlesPerKilometre: 9,
      opacity: 0.7,
      icon: "traffic-flow-moderate",
    },
    heavy: {
      baseSpeedMetresPerSecond: 10,
      particlesPerKilometre: 24,
      opacity: 0.84,
      icon: "traffic-flow-heavy",
    },
    severe: {
      baseSpeedMetresPerSecond: 4.4,
      particlesPerKilometre: 42,
      opacity: 0.94,
      icon: "traffic-flow-severe",
    },
    closed: {
      baseSpeedMetresPerSecond: 0,
      particlesPerKilometre: 0,
      opacity: 0,
      icon: "traffic-flow-closed",
    },
  },
  zoomDensity: [
    { zoom: 6, multiplier: 0.08 },
    { zoom: 6.6, multiplier: 0.12 },
    { zoom: 8.8, multiplier: 0.24 },
    { zoom: 10, multiplier: 0.42 },
    { zoom: 12, multiplier: 0.78 },
    { zoom: 14, multiplier: 1 },
    { zoom: 16, multiplier: 1.28 },
  ],
  roadClassMultiplier: {
    motorway: 1.85,
    trunk: 1.65,
    primary: 1.4,
    secondary: 1.15,
    tertiary: 0.9,
    street: 0.62,
    residential: 0.48,
    service: 0.35,
    default: 0.72,
  },
} as const;

export const EMPTY_TRAFFIC_PARTICLE_FRAME: TrafficParticleFrame = {
  type: "FeatureCollection",
  features: [],
};

export const EMPTY_TRAFFIC_PARTICLE_POINT_FRAME: TrafficParticlePointFrame = {
  type: "FeatureCollection",
  features: [],
};
