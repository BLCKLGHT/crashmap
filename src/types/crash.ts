export type CrashRecord = {
  id: string;
  latitude: number;
  longitude: number;
  dateTime?: string;
  severity?: string;
  speedZone?: string;
  surfaceType?: string;
  lightCondition?: string;
  weatherCondition?: string;
  locationDescription?: string;
};

export type SurfaceCondition = "dry" | "wet" | "unknown";
export type NormalisedLightCondition = "daylight" | "dark" | "dawn_dusk" | "unknown";

export type CurrentDrivingConditions = {
  surfaceCondition: SurfaceCondition;
  lightCondition: NormalisedLightCondition;
  isRaining: boolean;
  weatherLabel: string;
};

export type WeatherMatchMode = "all" | "similar" | "strict" | "weighted";
export type WeatherMapFilterMode = "weighted" | "all" | "wet" | "dry" | "dark";

export type CurrentWeather = {
  precipitation?: number;
  rain?: number;
  weatherCode?: number;
  temperature?: number;
  visibility?: number;
  windSpeed?: number;
  isDay?: boolean;
  observedAt: string;
};

export type WeatherState = {
  weather: CurrentWeather | null;
  conditions: CurrentDrivingConditions | null;
  fetchedAt?: number;
  latitude?: number;
  longitude?: number;
  status: "idle" | "loading" | "ready" | "error" | "simulated";
  error?: string;
};

export type CrashFilters = {
  severityMode: "all" | "seriousFatal" | "fatal";
  speedZone: string;
  lightCondition: string;
  surfaceType: string;
  weatherMode: WeatherMapFilterMode;
};

export type TimelineState = {
  minTime: number;
  maxTime: number;
  startTime: number;
  endTime: number;
  playheadTime: number;
  speed: 1 | 2 | 5 | 10;
  isPlaying: boolean;
  isPlaybackView: boolean;
};

export type DriveLocation = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  heading?: number;
  headingSource?: "compass" | "gps" | "movement" | "simulated";
  speed?: number;
  timestamp: number;
  isSimulated?: boolean;
};

export type DriveRiskSummary = {
  radiusMetres: number;
  totalCount: number;
  fatalCount: number;
  seriousCount: number;
  propertyDamageCount: number;
  aheadCount: number;
  nearbySpeedZone?: string;
  closestFatalMetres?: number;
  closestSeriousOrFatalMetres?: number;
  warningTitle?: string;
  warningMessage?: string;
  nearbyCrashes: CrashRecord[];
};

export type DashboardCrashRiskLevel = "low" | "medium" | "high";

export type DashboardLookaheadRisk = {
  lookaheadDistanceMetres: number;
  corridorWidthMetres: number;
  totalCrashCount: number;
  seriousCount: number;
  fatalCount: number;
  propertyDamageCount: number;
  nearestCrashDistanceMetres?: number;
  matchedCrashCount: number;
  matchedSeriousCount: number;
  matchedFatalCount: number;
  wetCrashCount: number;
  darkCrashCount: number;
  conditionMatchScore: number;
  conditionLabel?: string;
  conditionDataAvailable: boolean;
  riskLevel: DashboardCrashRiskLevel;
  label: string;
  message: string;
  hasHeading: boolean;
};

export type CrashDataState = {
  crashes: CrashRecord[];
  fetchedAt?: string;
};
