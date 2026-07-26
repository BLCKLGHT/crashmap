const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

export const hashString = (value: string): number => {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
};

export const seededUnit = (seed: string): number => {
  let value = hashString(seed);
  value += 0x6d2b79f5;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};

export const seededRange = (seed: string, min: number, max: number): number =>
  min + seededUnit(seed) * (max - min);

export const temporalNoise = (
  timeSeconds: number,
  phaseOffset: number,
  amplitude = 0.075,
  frequency = 0.23,
): number => 1 + Math.sin(timeSeconds * frequency + phaseOffset) * amplitude;

