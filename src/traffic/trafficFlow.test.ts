import { describe, expect, it } from "vitest";
import { TRAFFIC_FLOW_CONFIG, type TrafficSegment } from "./trafficConfig";
import { extractTrafficSegments, normaliseCongestion } from "./trafficGeometry";
import {
  getBearingDegrees,
  getDistanceMetres,
  getLineLengthMetres,
  interpolateLineAtDistance,
  wrapProgress,
} from "./trafficInterpolation";
import { seededRange, seededUnit, temporalNoise } from "./trafficNoise";
import { getSegmentParticleCount, TrafficParticleEngine } from "./trafficParticleEngine";

const makeSegment = (
  id: string,
  congestion: TrafficSegment["congestion"],
  roadClass = "primary",
  coordinates: Array<[number, number]> = [
    [147.31, -42.88],
    [147.33, -42.88],
  ],
): TrafficSegment => ({
  id,
  coordinates,
  lengthMetres: getLineLengthMetres(coordinates),
  congestion,
  roadClass,
  closed: congestion === "closed",
});

describe("traffic deterministic noise", () => {
  it("returns stable seeded values", () => {
    expect(seededUnit("segment-a:0:salt")).toBe(seededUnit("segment-a:0:salt"));
    expect(seededRange("segment-a:1:salt", 2, 7)).toBe(seededRange("segment-a:1:salt", 2, 7));
    expect(seededUnit("segment-a:0:salt")).not.toBe(seededUnit("segment-a:1:salt"));
  });

  it("keeps temporal noise smooth and bounded", () => {
    const first = temporalNoise(10, 1.25);
    const next = temporalNoise(10.2, 1.25);

    expect(first).toBeGreaterThan(0.9);
    expect(first).toBeLessThan(1.1);
    expect(Math.abs(first - next)).toBeLessThan(0.02);
    expect(temporalNoise(10, 1.25)).toBe(first);
  });
});

describe("traffic geometry interpolation", () => {
  it("calculates length, bearing, and coordinates along a line", () => {
    const line: Array<[number, number]> = [
      [147.31, -42.88],
      [147.32, -42.88],
    ];
    const length = getLineLengthMetres(line);
    const midpoint = interpolateLineAtDistance(line, length / 2);

    expect(length).toBeGreaterThan(800);
    expect(length).toBeLessThan(830);
    expect(getBearingDegrees(line[0], line[1])).toBeCloseTo(90, 0);
    expect(midpoint?.coordinate[0]).toBeCloseTo(147.315, 3);
    expect(midpoint?.bearing).toBeCloseTo(90, 0);
  });

  it("wraps progress forwards and backwards", () => {
    expect(wrapProgress(125, 100)).toBe(25);
    expect(wrapProgress(-25, 100)).toBe(75);
    expect(wrapProgress(25, 0)).toBe(0);
  });

  it("ignores invalid, duplicate, and short traffic geometry", () => {
    const features = [
      {
        id: "good",
        properties: { congestion: "heavy", class: "primary" },
        geometry: {
          type: "LineString",
          coordinates: [
            [147.31, -42.88],
            [147.32, -42.88],
          ],
        },
      },
      {
        id: "bad",
        properties: { congestion: "moderate" },
        geometry: { type: "Point", coordinates: [147.31, -42.88] },
      },
      {
        id: "missing-congestion",
        properties: { class: "primary" },
        geometry: {
          type: "LineString",
          coordinates: [
            [147.31, -42.88],
            [147.32, -42.88],
          ],
        },
      },
      {
        id: "too-short",
        properties: { congestion: "low" },
        geometry: {
          type: "LineString",
          coordinates: [
            [147.31, -42.88],
            [147.31001, -42.88],
          ],
        },
      },
    ];

    const segments = extractTrafficSegments(features);

    expect(segments).toHaveLength(1);
    expect(segments[0].id).toBe("good:0");
    expect(segments[0].congestion).toBe("heavy");
  });
});

describe("traffic congestion and density", () => {
  it("normalises congestion and closed states", () => {
    expect(normaliseCongestion("severe")).toBe("severe");
    expect(normaliseCongestion("moderate")).toBe("moderate");
    expect(normaliseCongestion("unknown")).toBeNull();
    expect(normaliseCongestion(undefined)).toBeNull();
    expect(normaliseCongestion("low", true)).toBe("closed");
  });

  it("maps congestion and road class into particle density", () => {
    const lowResidential = makeSegment("res-low", "low", "residential");
    const heavyMotorway = makeSegment("motor-heavy", "heavy", "motorway");

    expect(getSegmentParticleCount(lowResidential, 5.9)).toBe(0);
    expect(getSegmentParticleCount(lowResidential, 6.6)).toBeGreaterThanOrEqual(1);
    expect(getSegmentParticleCount(makeSegment("closed", "closed"), 14)).toBe(0);
    expect(getSegmentParticleCount(heavyMotorway, 14)).toBeGreaterThan(
      getSegmentParticleCount(lowResidential, 14),
    );
  });

  it("keeps generated particle counts inside the configured limit", () => {
    const segments = Array.from({ length: 120 }, (_, index) =>
      makeSegment(`segment-${index}`, index % 3 === 0 ? "severe" : "heavy", "motorway", [
        [147.2 + index * 0.001, -42.88],
        [147.25 + index * 0.001, -42.88],
      ]),
    );
    const engine = new TrafficParticleEngine();

    engine.rebuild(segments, 15);

    expect(engine.getParticleCount()).toBeLessThanOrEqual(
      TRAFFIC_FLOW_CONFIG.maxVisibleParticles,
    );
  });

  it("generates stable particle frames from the same segment seed", () => {
    const segment = makeSegment("stable-segment", "moderate", "primary");
    const firstEngine = new TrafficParticleEngine();
    const secondEngine = new TrafficParticleEngine();

    firstEngine.rebuild([segment], 14);
    secondEngine.rebuild([segment], 14);

    const firstFrame = firstEngine.frame(5, 14);
    const secondFrame = secondEngine.frame(5, 14);

    expect(firstFrame).toEqual(secondFrame);
  });
});
