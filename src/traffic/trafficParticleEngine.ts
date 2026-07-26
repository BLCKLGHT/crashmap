import {
  EMPTY_TRAFFIC_PARTICLE_FRAME,
  TRAFFIC_FLOW_CONFIG,
  type TrafficParticle,
  type TrafficParticleFrame,
  type TrafficSegment,
} from "./trafficConfig";
import {
  interpolateLineAtDistance,
  offsetCoordinateByMetres,
  wrapProgress,
} from "./trafficInterpolation";
import { seededRange, temporalNoise } from "./trafficNoise";

const getZoomDensityMultiplier = (zoom: number): number => {
  const stops = TRAFFIC_FLOW_CONFIG.zoomDensity;
  if (zoom < TRAFFIC_FLOW_CONFIG.minParticleZoom) return 0;
  if (zoom <= stops[0].zoom) return stops[0].multiplier;

  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1];
    const next = stops[index];
    if (zoom <= next.zoom) {
      const ratio = (zoom - previous.zoom) / (next.zoom - previous.zoom);
      return previous.multiplier + (next.multiplier - previous.multiplier) * ratio;
    }
  }

  return stops[stops.length - 1].multiplier;
};

const getRoadClassMultiplier = (roadClass: string): number => {
  const key = roadClass.toLowerCase() as keyof typeof TRAFFIC_FLOW_CONFIG.roadClassMultiplier;
  return (
    TRAFFIC_FLOW_CONFIG.roadClassMultiplier[key] ??
    TRAFFIC_FLOW_CONFIG.roadClassMultiplier.default
  );
};

export const getSegmentParticleCount = (segment: TrafficSegment, zoom: number): number => {
  if (segment.closed || zoom < TRAFFIC_FLOW_CONFIG.minParticleZoom) return 0;

  const congestion = TRAFFIC_FLOW_CONFIG.congestion[segment.congestion];
  const count =
    (segment.lengthMetres / 1000) *
    congestion.particlesPerKilometre *
    getZoomDensityMultiplier(zoom) *
    getRoadClassMultiplier(segment.roadClass);

  if (count <= 0) return 0;
  return Math.max(1, Math.round(count));
};

const allocateParticleCounts = (
  segments: TrafficSegment[],
  zoom: number,
  particleLimit: number,
): Array<{ segment: TrafficSegment; count: number; weight: number }> => {
  const weighted = segments
    .map((segment) => ({
      segment,
      count: getSegmentParticleCount(segment, zoom),
      weight:
        segment.lengthMetres *
        TRAFFIC_FLOW_CONFIG.congestion[segment.congestion].particlesPerKilometre *
        getRoadClassMultiplier(segment.roadClass),
    }))
    .filter((entry) => entry.count > 0 && entry.weight > 0);

  const totalCount = weighted.reduce((total, entry) => total + entry.count, 0);
  if (totalCount <= particleLimit) return weighted;

  const totalWeight = weighted.reduce((total, entry) => total + entry.weight, 0);
  let remaining = particleLimit;
  return weighted
    .map((entry) => {
      const count = Math.max(0, Math.floor((entry.weight / totalWeight) * particleLimit));
      remaining -= count;
      return { ...entry, count };
    })
    .sort((a, b) => b.weight - a.weight)
    .map((entry) => {
      if (remaining <= 0) return entry;
      remaining -= 1;
      return { ...entry, count: entry.count + 1 };
    })
    .filter((entry) => entry.count > 0);
};

export class TrafficParticleEngine {
  private segments = new Map<string, TrafficSegment>();
  private particles: TrafficParticle[] = [];
  private lastTimeSeconds = 0;

  rebuild(segments: TrafficSegment[], zoom: number): void {
    this.segments = new Map(segments.map((segment) => [segment.id, segment]));
    this.lastTimeSeconds = 0;
    this.particles = allocateParticleCounts(
      segments,
      zoom,
      TRAFFIC_FLOW_CONFIG.maxVisibleParticles,
    ).flatMap(({ segment, count }) =>
      Array.from({ length: count }, (_, index) => {
        const seed = `${segment.id}:${index}:${TRAFFIC_FLOW_CONFIG.stableSalt}`;
        return {
          id: `${segment.id}:${index}`,
          segmentId: segment.id,
          index,
          progressMetres: seededRange(`${seed}:progress`, 0, segment.lengthMetres),
          speedMultiplier: seededRange(`${seed}:speed`, 0.76, 1.24),
          phaseOffset: seededRange(`${seed}:phase`, 0, Math.PI * 2),
          opacityMultiplier: seededRange(`${seed}:opacity`, 0.72, 1.08),
          scale: seededRange(`${seed}:scale`, 0.72, 1.18),
          lateralOffsetMetres:
            seededRange(`${seed}:lane`, -1, 1) * TRAFFIC_FLOW_CONFIG.lateralOffsetMetres,
        };
      }),
    );
  }

  getParticleCount(): number {
    return this.particles.length;
  }

  clear(): void {
    this.segments.clear();
    this.particles = [];
    this.lastTimeSeconds = 0;
  }

  frame(timeSeconds: number, zoom: number): TrafficParticleFrame {
    if (!this.particles.length || zoom < TRAFFIC_FLOW_CONFIG.minParticleZoom) {
      this.lastTimeSeconds = timeSeconds;
      return EMPTY_TRAFFIC_PARTICLE_FRAME;
    }

    const deltaSeconds =
      this.lastTimeSeconds > 0 ? Math.min(0.08, Math.max(0, timeSeconds - this.lastTimeSeconds)) : 0;
    this.lastTimeSeconds = timeSeconds;
    const lateralScale = zoom >= 14 ? 1 : zoom >= 12 ? 0.72 : 0.45;

    return {
      type: "FeatureCollection",
      features: this.particles.flatMap((particle) => {
        const segment = this.segments.get(particle.segmentId);
        if (!segment || segment.closed) return [];

        const congestion = TRAFFIC_FLOW_CONFIG.congestion[segment.congestion];
        const noise = temporalNoise(timeSeconds, particle.phaseOffset);
        const speed = congestion.baseSpeedMetresPerSecond * particle.speedMultiplier * noise;
        particle.progressMetres = wrapProgress(
          particle.progressMetres + speed * deltaSeconds,
          segment.lengthMetres,
        );

        const point = interpolateLineAtDistance(segment.coordinates, particle.progressMetres);
        if (!point) return [];

        const coordinate = offsetCoordinateByMetres(
          point.coordinate,
          point.bearing,
          particle.lateralOffsetMetres * lateralScale,
        );

        return [
          {
            type: "Feature" as const,
            properties: {
              id: particle.id,
              bearing: point.bearing,
              opacity: Math.min(0.92, congestion.opacity * particle.opacityMultiplier),
              scale: particle.scale,
              icon: congestion.icon,
            },
            geometry: {
              type: "Point" as const,
              coordinates: coordinate,
            },
          },
        ];
      }),
    };
  }
}
