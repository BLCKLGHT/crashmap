const EARTH_RADIUS_METRES = 6_371_000;

export const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
export const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

export const normaliseBearing = (bearing: number): number => ((bearing % 360) + 360) % 360;

export const getDistanceMetres = (
  from: [number, number],
  to: [number, number],
): number => {
  const fromLat = toRadians(from[1]);
  const toLat = toRadians(to[1]);
  const deltaLat = toRadians(to[1] - from[1]);
  const deltaLng = toRadians(to[0] - from[0]);
  const value =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLng / 2) ** 2;
  return EARTH_RADIUS_METRES * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};

export const getLineLengthMetres = (coordinates: Array<[number, number]>): number =>
  coordinates.reduce((total, coordinate, index) => {
    if (index === 0) return total;
    return total + getDistanceMetres(coordinates[index - 1], coordinate);
  }, 0);

export const getBearingDegrees = (from: [number, number], to: [number, number]): number => {
  const fromLat = toRadians(from[1]);
  const toLat = toRadians(to[1]);
  const deltaLng = toRadians(to[0] - from[0]);
  const y = Math.sin(deltaLng) * Math.cos(toLat);
  const x =
    Math.cos(fromLat) * Math.sin(toLat) -
    Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLng);
  return normaliseBearing(toDegrees(Math.atan2(y, x)));
};

export const wrapProgress = (progressMetres: number, lengthMetres: number): number => {
  if (lengthMetres <= 0) return 0;
  return ((progressMetres % lengthMetres) + lengthMetres) % lengthMetres;
};

export const interpolateLineAtDistance = (
  coordinates: Array<[number, number]>,
  distanceMetres: number,
): { coordinate: [number, number]; bearing: number } | null => {
  if (coordinates.length < 2) return null;

  const lineLength = getLineLengthMetres(coordinates);
  const targetDistance = wrapProgress(distanceMetres, lineLength);
  let travelled = 0;

  for (let index = 1; index < coordinates.length; index += 1) {
    const from = coordinates[index - 1];
    const to = coordinates[index];
    const segmentLength = getDistanceMetres(from, to);
    if (segmentLength <= 0) continue;

    if (travelled + segmentLength >= targetDistance) {
      const ratio = (targetDistance - travelled) / segmentLength;
      return {
        coordinate: [
          from[0] + (to[0] - from[0]) * ratio,
          from[1] + (to[1] - from[1]) * ratio,
        ],
        bearing: getBearingDegrees(from, to),
      };
    }

    travelled += segmentLength;
  }

  const last = coordinates[coordinates.length - 1];
  const previous = coordinates[coordinates.length - 2];
  return {
    coordinate: last,
    bearing: getBearingDegrees(previous, last),
  };
};

export const offsetCoordinateByMetres = (
  coordinate: [number, number],
  bearing: number,
  lateralOffsetMetres: number,
): [number, number] => {
  const perpendicular = toRadians(bearing + 90);
  const eastMetres = Math.sin(perpendicular) * lateralOffsetMetres;
  const northMetres = Math.cos(perpendicular) * lateralOffsetMetres;
  const latitude = coordinate[1] + northMetres / 111_320;
  const longitude =
    coordinate[0] + eastMetres / (111_320 * Math.max(0.2, Math.cos(toRadians(coordinate[1]))));
  return [longitude, latitude];
};

