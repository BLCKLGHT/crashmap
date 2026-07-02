import type {
  CrashRecord,
  CurrentDrivingConditions,
  NormalisedLightCondition,
  SurfaceCondition,
  WeatherMatchMode,
} from "../types/crash";

const normalise = (value?: string): string => value?.trim().toLowerCase() ?? "";

export type CrashConditionMatch = {
  hasConditionData: boolean;
  surface: SurfaceCondition;
  light: NormalisedLightCondition;
  surfaceMatches: boolean;
  lightMatches: boolean;
  isMatch: boolean;
  weight: number;
};

export const normaliseCrashSurface = (crash: CrashRecord): SurfaceCondition => {
  const value = `${normalise(crash.surfaceType)} ${normalise(crash.weatherCondition)}`;

  if (!value.trim()) return "unknown";
  if (/(wet|rain|raining|drizzle|shower|storm|snow|ice|icy|slush|flood|water)/i.test(value)) {
    return "wet";
  }
  if (/(dry|clear)/i.test(value)) return "dry";

  return "unknown";
};

export const normaliseCrashLight = (crash: CrashRecord): NormalisedLightCondition => {
  const value = normalise(crash.lightCondition);

  if (!value) return "unknown";
  if (/(dark|night|street.*off|no street|unlit)/i.test(value)) return "dark";
  if (/(dawn|dusk|twilight)/i.test(value)) return "dawn_dusk";
  if (/(day|daylight|bright)/i.test(value)) return "daylight";

  return "unknown";
};

export const getCrashConditionMatch = (
  crash: CrashRecord,
  currentConditions: CurrentDrivingConditions | null,
): CrashConditionMatch => {
  const surface = normaliseCrashSurface(crash);
  const light = normaliseCrashLight(crash);
  const hasConditionData = surface !== "unknown" || light !== "unknown";

  if (!currentConditions) {
    return {
      hasConditionData,
      surface,
      light,
      surfaceMatches: false,
      lightMatches: false,
      isMatch: false,
      weight: 1,
    };
  }

  const surfaceKnown = surface !== "unknown" && currentConditions.surfaceCondition !== "unknown";
  const lightKnown = light !== "unknown" && currentConditions.lightCondition !== "unknown";
  const surfaceMatches = surfaceKnown && surface === currentConditions.surfaceCondition;
  const lightMatches = lightKnown && light === currentConditions.lightCondition;
  const comparableFields = Number(surfaceKnown) + Number(lightKnown);
  const matchedFields = Number(surfaceMatches) + Number(lightMatches);
  const isMatch = comparableFields > 0 && matchedFields > 0;

  // Weighted mode keeps the whole historical picture visible, but moves the road-history risk
  // toward crashes that happened under matching surface/light conditions.
  let weight = 1;
  if (isMatch) weight += matchedFields * 0.75;
  if (surfaceKnown && !surfaceMatches) weight -= 0.25;
  if (lightKnown && !lightMatches) weight -= 0.2;

  return {
    hasConditionData,
    surface,
    light,
    surfaceMatches,
    lightMatches,
    isMatch,
    weight: Math.max(0.45, weight),
  };
};

export const filterCrashesByCurrentConditions = (
  crashes: CrashRecord[],
  currentConditions: CurrentDrivingConditions | null,
  mode: WeatherMatchMode,
): CrashRecord[] => {
  if (mode === "all" || mode === "weighted" || !currentConditions) return crashes;

  return crashes.filter((crash) => {
    const match = getCrashConditionMatch(crash, currentConditions);

    if (mode === "strict") {
      return match.hasConditionData && match.isMatch;
    }

    if (match.isMatch) return true;
    return !match.hasConditionData;
  });
};

export const filterCrashesByWeatherPreset = (
  crashes: CrashRecord[],
  preset: "wet" | "dry" | "dark",
): CrashRecord[] =>
  crashes.filter((crash) => {
    if (preset === "dark") return normaliseCrashLight(crash) === "dark";
    return normaliseCrashSurface(crash) === preset;
  });

