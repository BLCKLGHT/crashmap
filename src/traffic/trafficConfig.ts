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

export type TrafficParticleFrame = GeoJSON.FeatureCollection<
  GeoJSON.Point,
  TrafficParticleFrameFeatureProperties
>;

export const TRAFFIC_FLOW_CONFIG = {
  sourceId: "viewer-traffic-flow-particles",
  layerId: "viewer-traffic-flow-particles",
  trafficSourceId: "viewer-mapbox-traffic",
  trafficSourceLayer: "traffic",
  trafficConditionsLayerId: "viewer-traffic-conditions",
  minParticleZoom: 10,
  maxVisibleParticles: 220,
  minimumSegmentLengthMetres: 45,
  lateralOffsetMetres: 1,
  stableSalt: "tasmania-crash-map-traffic-flow-v1",
  congestion: {
    low: {
      baseSpeedMetresPerSecond: 38,
      particlesPerKilometre: 4,
      opacity: 0.42,
      icon: "traffic-flow-low",
    },
    moderate: {
      baseSpeedMetresPerSecond: 22,
      particlesPerKilometre: 7,
      opacity: 0.55,
      icon: "traffic-flow-moderate",
    },
    heavy: {
      baseSpeedMetresPerSecond: 10,
      particlesPerKilometre: 11,
      opacity: 0.7,
      icon: "traffic-flow-heavy",
    },
    severe: {
      baseSpeedMetresPerSecond: 4.4,
      particlesPerKilometre: 15,
      opacity: 0.82,
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
    { zoom: 10, multiplier: 0.25 },
    { zoom: 12, multiplier: 0.55 },
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

