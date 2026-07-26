import {
  TRAFFIC_FLOW_CONFIG,
  type TrafficCongestion,
  type TrafficSegment,
} from "./trafficConfig";
import { getLineLengthMetres } from "./trafficInterpolation";

type TrafficFeatureLike = {
  id?: string | number;
  properties?: Record<string, unknown> | null;
  geometry?: {
    type?: string;
    coordinates?: unknown;
  } | null;
};

const normaliseRoadClass = (value: unknown): string => {
  if (typeof value !== "string") return "default";
  const label = value.trim().toLowerCase();
  return label || "default";
};

export const normaliseCongestion = (
  value: unknown,
  closedValue?: unknown,
): TrafficCongestion => {
  if (closedValue === true || closedValue === "true" || closedValue === 1) return "closed";
  if (typeof value !== "string") return "low";

  const label = value.trim().toLowerCase();
  if (label === "closed") return "closed";
  if (label === "severe") return "severe";
  if (label === "heavy") return "heavy";
  if (label === "moderate") return "moderate";
  return "low";
};

const isValidCoordinate = (coordinate: unknown): coordinate is [number, number] =>
  Array.isArray(coordinate) &&
  coordinate.length >= 2 &&
  typeof coordinate[0] === "number" &&
  typeof coordinate[1] === "number" &&
  Number.isFinite(coordinate[0]) &&
  Number.isFinite(coordinate[1]);

const normaliseLine = (line: unknown): Array<[number, number]> | null => {
  if (!Array.isArray(line)) return null;
  const coordinates = line.filter(isValidCoordinate).map((coordinate) => [
    coordinate[0],
    coordinate[1],
  ] as [number, number]);
  return coordinates.length >= 2 ? coordinates : null;
};

const getFeatureLines = (feature: TrafficFeatureLike): Array<Array<[number, number]>> => {
  if (feature.geometry?.type === "LineString") {
    const line = normaliseLine(feature.geometry.coordinates);
    return line ? [line] : [];
  }

  if (feature.geometry?.type === "MultiLineString" && Array.isArray(feature.geometry.coordinates)) {
    return feature.geometry.coordinates
      .map(normaliseLine)
      .filter((line): line is Array<[number, number]> => Boolean(line));
  }

  return [];
};

const getFeatureIdentity = (
  feature: TrafficFeatureLike,
  coordinates: Array<[number, number]>,
  index: number,
): string => {
  const propertyId = feature.properties?.id ?? feature.properties?.osm_id ?? feature.properties?.road_id;
  if (feature.id !== undefined) return String(feature.id);
  if (propertyId !== undefined) return String(propertyId);
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  return `${first[0].toFixed(5)},${first[1].toFixed(5)}:${last[0].toFixed(5)},${last[1].toFixed(5)}:${index}`;
};

export const extractTrafficSegments = (
  features: TrafficFeatureLike[],
): TrafficSegment[] => {
  const seen = new Set<string>();
  const segments: TrafficSegment[] = [];

  for (const feature of features) {
    const lines = getFeatureLines(feature);
    const properties = feature.properties ?? {};
    const congestion = normaliseCongestion(properties.congestion, properties.closed);
    const roadClass = normaliseRoadClass(
      properties.class ?? properties.road_class ?? properties.roadClass,
    );

    lines.forEach((coordinates, index) => {
      const lengthMetres = getLineLengthMetres(coordinates);
      if (lengthMetres < TRAFFIC_FLOW_CONFIG.minimumSegmentLengthMetres) return;

      const id = `${getFeatureIdentity(feature, coordinates, index)}:${index}`;
      const duplicateKey = `${id}:${coordinates.length}:${Math.round(lengthMetres)}`;
      if (seen.has(duplicateKey)) return;
      seen.add(duplicateKey);

      segments.push({
        id,
        coordinates,
        lengthMetres,
        congestion,
        roadClass,
        closed: congestion === "closed",
      });
    });
  }

  return segments;
};

