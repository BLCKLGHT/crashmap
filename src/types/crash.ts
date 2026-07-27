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

export type SurfaceCondition = "dry" | "wet" | "snow_ice" | "unknown";
export type NormalisedLightCondition = "daylight" | "dark" | "dawn_dusk" | "unknown";
export type VisibilityCondition = "clear" | "reduced" | "unknown";
export type WindCondition = "normal" | "windy" | "unknown";

export type CurrentDrivingConditions = {
  surfaceCondition: SurfaceCondition;
  lightCondition: NormalisedLightCondition;
  visibilityCondition: VisibilityCondition;
  windCondition: WindCondition;
  isRaining: boolean;
  weatherLabel: string;
};

export type WeatherMatchMode = "all" | "similar" | "strict" | "weighted";
export type WeatherMatchSetting = "off" | "current" | "historical";

export type CurrentWeather = {
  precipitation?: number;
  rain?: number;
  showers?: number;
  snowfall?: number;
  weatherCode?: number;
  cloudCover?: number;
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
  weatherMode: WeatherMatchSetting;
};

export type HistoricalCrashWeather = {
  crashId: string;
  dateTime?: string;
  precipitation?: number;
  rain?: number;
  snowfall?: number;
  weatherCode?: number;
  isWet: boolean;
  isRain: boolean;
  isSnowOrIce: boolean;
  isWindy: boolean;
  isDarkEstimate: boolean;
  confidence: "high" | "medium" | "low";
  conditions: {
    surface: SurfaceCondition;
    visibility: VisibilityCondition;
    wind: WindCondition;
    light: NormalisedLightCondition;
  };
};

export type HistoricalWeatherMatch = {
  crashId: string;
  weatherMatch: boolean;
  wetMatch: boolean;
  lightMatch: boolean;
  windMatch: boolean;
  visibilityMatch: boolean;
  scoreMultiplier: number;
  confidence: HistoricalCrashWeather["confidence"];
};

export type HistoricalWeatherMatchState = {
  status: "off" | "idle" | "checking" | "ready" | "limited" | "error";
  matches: Record<string, HistoricalWeatherMatch>;
  matchedCrashIds: string[];
  checkedCrashCount: number;
  error?: string;
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
export type DashboardWarningColour = "blue" | "orange" | "red";
export type DashboardZoneType = "corner" | "section" | "straight" | "intersection" | "unknown";

export type WarningRoadSegment = {
  id: string;
  geometry: GeoJSON.LineString;
  warningLevel: DashboardCrashRiskLevel;
  warningColour: DashboardWarningColour;
  startDistanceMetres: number;
  endDistanceMetres: number;
  score: number;
  sourceTimestamp: number;
};

export type DashboardDrivingState = {
  currentSpeed?: number;
  speedLimit?: number;
  recommendedCarLengths: number;
  currentWarningLevel: DashboardCrashRiskLevel;
  currentWarningColour: DashboardWarningColour;
  upcomingWarningLevel: DashboardCrashRiskLevel;
  upcomingWarningColour: DashboardWarningColour;
  distanceToUpcomingWarningMetres?: number;
  upcomingZoneType: DashboardZoneType;
  optionalLandmark?: string;
  heading?: number;
  snappedPosition?: {
    latitude: number;
    longitude: number;
  };
  locationTimestamp?: number;
  riskTimestamp?: number;
  warningRoadSegments?: WarningRoadSegment[];
};

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
  weatherMatchStatus?: HistoricalWeatherMatchState["status"];
  riskLevel: DashboardCrashRiskLevel;
  label: string;
  message: string;
  roadContext?: string;
  hasHeading: boolean;
};

export type CrashDataState = {
  crashes: CrashRecord[];
  fetchedAt?: string;
};
