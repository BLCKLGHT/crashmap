import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { CrashMap } from "./components/CrashMap";
import { DashboardMode } from "./components/DashboardMode";
import { ErrorState } from "./components/ErrorState";
import { FilterPanel } from "./components/FilterPanel";
import { LoadingState } from "./components/LoadingState";
import { VoiceSettings } from "./components/VoiceSettings";
import vehicleTopImageUrl from "./assets/vehicle-top.png";
import {
  clearCachedCrashData,
  fetchAllTasCrashData,
  readCachedCrashData,
  writeCachedCrashData,
} from "./data/crashData";
import { defaultFilters, filterCrashes } from "./data/filterCrashes";
import {
  createCrashSpatialIndex,
  getDashboardLookaheadCrashes,
  getDashboardLookaheadRisk,
  getDriveRiskSummary,
} from "./data/spatialIndex";
import {
  compareHistoricalWeatherToCurrent,
  fetchCurrentWeather,
  getCurrentDrivingConditions,
  getHistoricalWeatherForCrash,
} from "./data/weather";
import { useDrivingCompanion } from "./hooks/useDrivingCompanion";
import type {
  CrashDataState,
  CrashFilters,
  CrashRecord,
  CurrentDrivingConditions,
  DashboardCrashRiskLevel,
  DashboardDrivingState,
  DashboardLookaheadRisk,
  DashboardWarningColour,
  DashboardZoneType,
  DriveLocation,
  HistoricalWeatherMatchState,
  TimelineState,
  WeatherMatchMode,
  WeatherState,
} from "./types/crash";
import { DriveModePanel } from "./components/DriveModePanel";
import type { VoiceWarningContext } from "./voice/voiceWarnings";

type DeviceOrientationEventWithCompass = DeviceOrientationEvent & {
  webkitCompassHeading?: number;
};

type DeviceOrientationEventConstructorWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

type AppViewMode = "map" | "dashboard";
type WeatherSimulationMode =
  | "live"
  | "wet"
  | "dry"
  | "daylight"
  | "dark"
  | "failure"
  | "historyFailure"
  | "historySlow";

type DashboardWarningCountdown = {
  status: "active" | "passed";
  remainingMetres: number;
  lastLatitude: number;
  lastLongitude: number;
  passedMetres?: number;
  risk: DashboardLookaheadRisk;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const crashTimeCache = new WeakMap<CrashRecord, number | null>();
const COMPASS_UPDATE_INTERVAL_MS = 220;
const COMPASS_HEADING_EASING = 0.12;
const GPS_MIN_UPDATE_INTERVAL_MS = 900;
const GPS_MAX_ACCURACY_METRES = 85;
const GPS_BOOTSTRAP_MAX_ACCURACY_METRES = 250;
const GPS_JITTER_METRES = 9;
const GPS_POSITION_EASING = 0.38;
const SIMULATION_STEP_MS = 250;
const SIMULATION_BASE_SPEED_MPS = 13.9;
const WEATHER_REFRESH_MS = 10 * 60 * 1000;
const WEATHER_MOVE_REFRESH_METRES = 10000;
const HISTORICAL_WEATHER_REFRESH_MS = 30000;
const HISTORICAL_WEATHER_MOVE_METRES = 100;
const HISTORICAL_WEATHER_LOOKAHEAD_LIMIT = 20;
const VOICE_REACTION_TIME_SECONDS = 1.5;
const VOICE_CAR_LENGTH_METRES = 5;
const DASHBOARD_WARNING_DISTANCE_METRES = 500;
const DASHBOARD_WARNING_REARM_METRES = 80;
const VOICE_PREDICTIVE_LOOKAHEAD_METRES = 800;

const SIMULATION_SPEED_SPIKES: Array<{
  segmentIndex: number;
  startProgress: number;
  endProgress: number;
  speedKmh: number;
}> = [
  { segmentIndex: 1, startProgress: 0.18, endProgress: 0.48, speedKmh: 59 },
  { segmentIndex: 3, startProgress: 0.28, endProgress: 0.6, speedKmh: 60 },
  { segmentIndex: 6, startProgress: 0.12, endProgress: 0.42, speedKmh: 64 },
];

const SIMULATION_ROUTE: Array<{ latitude: number; longitude: number }> = [
  { latitude: -42.8821, longitude: 147.3272 },
  { latitude: -42.8799, longitude: 147.3236 },
  { latitude: -42.8744, longitude: 147.3168 },
  { latitude: -42.8688, longitude: 147.3103 },
  { latitude: -42.8625, longitude: 147.3049 },
  { latitude: -42.8557, longitude: 147.3035 },
  { latitude: -42.8488, longitude: 147.3096 },
  { latitude: -42.8437, longitude: 147.3178 },
  { latitude: -42.8395, longitude: 147.3308 },
  { latitude: -42.8369, longitude: 147.3445 },
];

const TASMANIA_GPS_BOUNDS = {
  minLatitude: -44.1,
  maxLatitude: -39.2,
  minLongitude: 144.0,
  maxLongitude: 149.1,
};

const getCrashTime = (crash: CrashRecord): number | null => {
  if (crashTimeCache.has(crash)) return crashTimeCache.get(crash) ?? null;
  if (!crash.dateTime) return null;

  const numericValue = Number(crash.dateTime);
  const time = Number.isFinite(numericValue)
    ? numericValue
    : new Date(crash.dateTime).getTime();

  const parsedTime = Number.isFinite(time) ? time : null;
  crashTimeCache.set(crash, parsedTime);
  return parsedTime;
};

const getTimelineDomain = (crashes: CrashRecord[]): { minTime: number; maxTime: number } | null => {
  let minTime = Number.POSITIVE_INFINITY;
  let maxTime = Number.NEGATIVE_INFINITY;

  for (const crash of crashes) {
    const time = getCrashTime(crash);
    if (time === null) continue;
    minTime = Math.min(minTime, time);
    maxTime = Math.max(maxTime, time);
  }

  if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) return null;

  return {
    minTime: Math.floor(minTime / DAY_MS) * DAY_MS,
    maxTime,
  };
};

const getTimePhase = (time?: number): "day" | "dawn" | "dusk" | "night" => {
  if (!time) return "day";

  const hour = new Date(time).getHours();
  if (hour < 6 || hour >= 20) return "night";
  if (hour < 8) return "dawn";
  if (hour >= 17) return "dusk";
  return "day";
};

const getDistanceMetres = (
  fromLatitude: number,
  fromLongitude: number,
  toLatitude: number,
  toLongitude: number,
): number => {
  const earthRadius = 6371000;
  const fromLat = (fromLatitude * Math.PI) / 180;
  const toLat = (toLatitude * Math.PI) / 180;
  const deltaLat = ((toLatitude - fromLatitude) * Math.PI) / 180;
  const deltaLng = ((toLongitude - fromLongitude) * Math.PI) / 180;
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLng / 2) ** 2;

  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const getBearingDegrees = (
  fromLatitude: number,
  fromLongitude: number,
  toLatitude: number,
  toLongitude: number,
): number => {
  const fromLat = (fromLatitude * Math.PI) / 180;
  const toLat = (toLatitude * Math.PI) / 180;
  const deltaLng = ((toLongitude - fromLongitude) * Math.PI) / 180;
  const y = Math.sin(deltaLng) * Math.cos(toLat);
  const x =
    Math.cos(fromLat) * Math.sin(toLat) -
    Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLng);

  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

const getInterpolatedPoint = (
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
  progress: number,
): { latitude: number; longitude: number } => ({
  latitude: from.latitude + (to.latitude - from.latitude) * progress,
  longitude: from.longitude + (to.longitude - from.longitude) * progress,
});

const normaliseHeading = (heading: number): number =>
  ((heading % 360) + 360) % 360;

const getSmoothedHeading = (currentHeading: number | null, nextHeading: number): number => {
  if (currentHeading === null) return normaliseHeading(nextHeading);

  const delta = ((((nextHeading - currentHeading) % 360) + 540) % 360) - 180;
  return normaliseHeading(currentHeading + delta * COMPASS_HEADING_EASING);
};

const isWithinTasmaniaGpsBounds = (latitude: number, longitude: number): boolean =>
  latitude >= TASMANIA_GPS_BOUNDS.minLatitude &&
  latitude <= TASMANIA_GPS_BOUNDS.maxLatitude &&
  longitude >= TASMANIA_GPS_BOUNDS.minLongitude &&
  longitude <= TASMANIA_GPS_BOUNDS.maxLongitude;

const formatSpeedKmh = (speedMetresPerSecond?: number): string => {
  if (typeof speedMetresPerSecond !== "number" || !Number.isFinite(speedMetresPerSecond)) {
    return "--";
  }

  const speedKmh = Math.max(0, speedMetresPerSecond * 3.6);
  return speedKmh >= 10 ? speedKmh.toFixed(0) : speedKmh.toFixed(1);
};

const formatSpeedZone = (speedZone?: string): string => {
  if (!speedZone) return "--";
  return speedZone;
};

const parseSpeedLimitKmh = (speedZone?: string): number | null => {
  if (!speedZone) return null;
  const numericValue = Number(speedZone.match(/\d+/)?.[0]);
  return Number.isFinite(numericValue) ? numericValue : null;
};

const getOverspeedDeltaKmh = (
  speedMetresPerSecond?: number,
  speedZone?: string,
): number | null => {
  if (typeof speedMetresPerSecond !== "number" || !Number.isFinite(speedMetresPerSecond)) {
    return null;
  }

  const speedLimit = parseSpeedLimitKmh(speedZone);
  if (speedLimit === null) return null;

  const currentSpeed = Math.round(Math.max(0, speedMetresPerSecond * 3.6));
  const delta = currentSpeed - speedLimit;
  return delta > 0 ? delta : null;
};

const getReactionCarLengths = (speedMetresPerSecond?: number): number => {
  if (typeof speedMetresPerSecond !== "number" || !Number.isFinite(speedMetresPerSecond)) {
    return 0;
  }

  const reactionDistance = Math.max(0, speedMetresPerSecond) * VOICE_REACTION_TIME_SECONDS;
  if (reactionDistance <= 0) return 0;
  return Math.max(1, Math.round(reactionDistance / VOICE_CAR_LENGTH_METRES));
};

const getVoiceSegmentKey = (location: DriveLocation | null, riskLevel: string): string => {
  if (!location) return `no-location:${riskLevel}`;
  return `${Math.round(location.latitude * 500)}:${Math.round(location.longitude * 500)}:${riskLevel}`;
};

const getWarningColour = (level: DashboardCrashRiskLevel): DashboardWarningColour => {
  if (level === "high") return "red";
  if (level === "medium") return "orange";
  return "blue";
};

const getZoneType = (roadContext?: string): DashboardZoneType => {
  if (!roadContext) return "section";
  if (/(intersection|junction|roundabout| at | near )/i.test(roadContext)) return "intersection";
  if (/(bend|corner|curve)/i.test(roadContext)) return "corner";
  return "section";
};

const getOptionalLandmark = (roadContext?: string): string | undefined => {
  if (!roadContext || !/( at | near |intersection|junction|roundabout)/i.test(roadContext)) return undefined;
  return roadContext.length > 64 ? `${roadContext.slice(0, 61).trim()}...` : roadContext;
};

const getSimulationSpeedMps = (segmentIndex: number, progress: number): number => {
  const spike = SIMULATION_SPEED_SPIKES.find(
    (candidate) =>
      candidate.segmentIndex === segmentIndex &&
      progress >= candidate.startProgress &&
      progress <= candidate.endProgress,
  );

  return spike ? spike.speedKmh / 3.6 : SIMULATION_BASE_SPEED_MPS;
};

const getSimulatedDrivingConditions = (
  mode: WeatherSimulationMode,
  baseConditions: CurrentDrivingConditions | null,
): CurrentDrivingConditions | null => {
  if (mode === "live") return baseConditions;
  if (mode === "failure") return null;
  if (mode === "historyFailure" || mode === "historySlow") return baseConditions;

  const base: CurrentDrivingConditions = baseConditions ?? {
    surfaceCondition: "dry",
    lightCondition: "daylight",
    visibilityCondition: "clear",
    windCondition: "normal",
    isRaining: false,
    weatherLabel: "simulated conditions",
  };

  if (mode === "wet") {
    return {
      ...base,
      surfaceCondition: "wet",
      isRaining: true,
      weatherLabel: "simulated wet conditions",
    };
  }

  if (mode === "dry") {
    return {
      ...base,
      surfaceCondition: "dry",
      isRaining: false,
      weatherLabel: "simulated dry conditions",
    };
  }

  return {
    ...base,
    lightCondition: mode === "dark" ? "dark" : "daylight",
    weatherLabel: mode === "dark" ? "simulated night conditions" : "simulated daylight",
  };
};

function App() {
  const [dataState, setDataState] = useState<CrashDataState>({ crashes: [] });
  const [filters, setFilters] = useState<CrashFilters>(defaultFilters);
  const [timeline, setTimeline] = useState<TimelineState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadedCount, setLoadedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isTimeOfDayEnabled, setIsTimeOfDayEnabled] = useState(true);
  const [isChromeHidden, setIsChromeHidden] = useState(false);
  const [viewMode, setViewMode] = useState<AppViewMode>("map");
  const [isDriveModeActive, setIsDriveModeActive] = useState(false);
  const [isSimulationMode, setIsSimulationMode] = useState(false);
  const [isSimulationDriving, setIsSimulationDriving] = useState(false);
  const [driveLocation, setDriveLocation] = useState<DriveLocation | null>(null);
  const [mapboxSpeedLimitKmh, setMapboxSpeedLimitKmh] = useState<number | null>(null);
  const [dashboardWarningCountdown, setDashboardWarningCountdown] =
    useState<DashboardWarningCountdown | null>(null);
  const [compassHeading, setCompassHeading] = useState<number | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [weatherState, setWeatherState] = useState<WeatherState>({
    weather: null,
    conditions: null,
    status: "idle",
  });
  const [historicalWeatherMatchState, setHistoricalWeatherMatchState] =
    useState<HistoricalWeatherMatchState>({
      status: "off",
      matches: {},
      matchedCrashIds: [],
      checkedCrashCount: 0,
    });
  const [weatherSimulationMode, setWeatherSimulationMode] =
    useState<WeatherSimulationMode>("live");
  const hasStartedInitialLoad = useRef(false);
  const playbackIntervalRef = useRef<number | null>(null);
  const geolocationWatchRef = useRef<number | null>(null);
  const simulationIntervalRef = useRef<number | null>(null);
  const simulationSegmentRef = useRef(0);
  const simulationSegmentMetresRef = useRef(0);
  const simulationLastTickRef = useRef(0);
  const lastGpsLocationRef = useRef<DriveLocation | null>(null);
  const lastGpsUpdateRef = useRef(0);
  const compassHeadingRef = useRef<number | null>(null);
  const lastCompassUpdateRef = useRef(0);
  const historicalWeatherLastRunRef = useRef<{
    time: number;
    latitude: number;
    longitude: number;
    heading?: number;
    crashKey: string;
  } | null>(null);

  const loadCrashData = async ({ refresh = false } = {}) => {
    setError(null);
    if (refresh) setIsRefreshing(true);
    else setIsLoading(true);

    try {
      setLoadedCount(0);
      if (!refresh) {
        const cached = await readCachedCrashData();
        if (cached) {
          setDataState({ crashes: cached.crashes, fetchedAt: cached.fetchedAt });
          setIsLoading(false);
          return;
        }
      }

      if (refresh) await clearCachedCrashData();

      const crashes = await fetchAllTasCrashData(setLoadedCount);
      const cached = await writeCachedCrashData(crashes);
      setDataState({ crashes: cached.crashes, fetchedAt: cached.fetchedAt });
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "The Tasmanian Government crash data service did not respond.";
      setError(message);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    if (hasStartedInitialLoad.current) return;
    hasStartedInitialLoad.current = true;
    void loadCrashData();
  }, []);

  const timelineDomain = useMemo(
    () => getTimelineDomain(dataState.crashes),
    [dataState.crashes],
  );

  useEffect(() => {
    if (!timelineDomain) return;

    setTimeline((currentTimeline) => {
      if (
        currentTimeline &&
        currentTimeline.minTime === timelineDomain.minTime &&
        currentTimeline.maxTime === timelineDomain.maxTime
      ) {
        return currentTimeline;
      }

      return {
        minTime: timelineDomain.minTime,
        maxTime: timelineDomain.maxTime,
        startTime: timelineDomain.minTime,
        endTime: timelineDomain.maxTime,
        playheadTime: timelineDomain.maxTime,
        speed: currentTimeline?.speed ?? 1,
        isPlaying: false,
        isPlaybackView: false,
      };
    });
  }, [timelineDomain]);

  useEffect(() => {
    if (!timeline?.isPlaying) {
      if (playbackIntervalRef.current) {
        window.clearInterval(playbackIntervalRef.current);
        playbackIntervalRef.current = null;
      }
      return;
    }

    playbackIntervalRef.current = window.setInterval(() => {
      setTimeline((currentTimeline) => {
        if (!currentTimeline?.isPlaying) return currentTimeline;

        const nextPlayhead = currentTimeline.playheadTime + DAY_MS;

        if (nextPlayhead >= currentTimeline.endTime) {
          return {
            ...currentTimeline,
            playheadTime: currentTimeline.endTime,
            isPlaying: false,
            isPlaybackView: true,
          };
        }

        return {
          ...currentTimeline,
          playheadTime: nextPlayhead,
          isPlaybackView: true,
        };
      });
    }, Math.max(100, 1000 / timeline.speed));

    return () => {
      if (playbackIntervalRef.current) {
        window.clearInterval(playbackIntervalRef.current);
        playbackIntervalRef.current = null;
      }
    };
  }, [timeline?.isPlaying, timeline?.speed]);

  const activeDrivingConditions = useMemo(
    () => getSimulatedDrivingConditions(weatherSimulationMode, weatherState.conditions),
    [weatherSimulationMode, weatherState.conditions],
  );

  const attributeFilteredCrashes = useMemo(
    () => filterCrashes(dataState.crashes, filters),
    [dataState.crashes, filters],
  );

  const filteredCrashes = useMemo(() => {
    if (!timeline) return attributeFilteredCrashes;

    const frameStart = Math.floor(timeline.playheadTime / DAY_MS) * DAY_MS;
    const lowerTime = timeline.isPlaybackView ? frameStart : timeline.startTime;
    const upperTime = timeline.isPlaybackView
      ? Math.min(frameStart + DAY_MS, timeline.endTime + 1)
      : timeline.endTime;

    return attributeFilteredCrashes.filter((crash) => {
      const time = getCrashTime(crash);
      return time !== null && time >= lowerTime && time < upperTime;
    });
  }, [attributeFilteredCrashes, timeline]);

  const crashSpatialIndex = useMemo(
    () => createCrashSpatialIndex(filteredCrashes),
    [filteredCrashes],
  );

  const dashboardLookaheadCrashes = useMemo(
    () =>
      getDashboardLookaheadCrashes(
        crashSpatialIndex,
        isDriveModeActive ? driveLocation : null,
        500,
        80,
      ),
    [crashSpatialIndex, driveLocation, isDriveModeActive],
  );

  const displayTime = useMemo(() => {
    if (!timeline?.isPlaybackView || !filteredCrashes.length) return timeline?.playheadTime;

    let earliestTime = Number.POSITIVE_INFINITY;
    for (const crash of filteredCrashes) {
      const time = getCrashTime(crash);
      if (time !== null) earliestTime = Math.min(earliestTime, time);
    }

    return Number.isFinite(earliestTime) ? earliestTime : timeline.playheadTime;
  }, [filteredCrashes, timeline]);

  const timePhase = isTimeOfDayEnabled ? getTimePhase(displayTime) : "day";

  useEffect(() => {
    if (!isDriveModeActive || isSimulationMode) {
      if (geolocationWatchRef.current !== null) {
        navigator.geolocation.clearWatch(geolocationWatchRef.current);
        geolocationWatchRef.current = null;
      }
      return;
    }

    if (!navigator.geolocation) {
      setDriveError("Location is not available in this browser.");
      setIsDriveModeActive(false);
      return;
    }

    setDriveError(null);
    geolocationWatchRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const now = Date.now();
        const accuracy =
          typeof position.coords.accuracy === "number" && Number.isFinite(position.coords.accuracy)
            ? position.coords.accuracy
            : undefined;
        const previous = lastGpsLocationRef.current;

        if (
          !Number.isFinite(position.coords.latitude) ||
          !Number.isFinite(position.coords.longitude) ||
          !isWithinTasmaniaGpsBounds(position.coords.latitude, position.coords.longitude)
        ) {
          setDriveError("Waiting for a Tasmanian GPS fix before following location.");
          return;
        }

        if (
          accuracy !== undefined &&
          accuracy > (previous ? GPS_MAX_ACCURACY_METRES : GPS_BOOTSTRAP_MAX_ACCURACY_METRES)
        ) {
          setDriveError("Waiting for a more accurate GPS fix before following location.");
          return;
        }

        if (
          previous !== null &&
          now - lastGpsUpdateRef.current < GPS_MIN_UPDATE_INTERVAL_MS
        ) {
          return;
        }

        const gpsHeading =
          typeof position.coords.heading === "number" && Number.isFinite(position.coords.heading)
            ? position.coords.heading
            : undefined;
        const movedMetres = previous
          ? getDistanceMetres(
              previous.latitude,
              previous.longitude,
              position.coords.latitude,
              position.coords.longitude,
            )
          : 0;
        const derivedHeading =
          gpsHeading === undefined && previous && movedMetres > 4
            ? getBearingDegrees(
                previous.latitude,
                previous.longitude,
                position.coords.latitude,
                position.coords.longitude,
              )
            : undefined;
        const heading = gpsHeading ?? derivedHeading ?? previous?.heading;
        const headingSource =
          gpsHeading !== undefined
              ? "gps"
              : derivedHeading !== undefined
                ? "movement"
                : previous?.headingSource;
        const shouldSmooth =
          previous !== null &&
          movedMetres > GPS_JITTER_METRES &&
          movedMetres < 180;
        const shouldHoldPosition =
          previous !== null && movedMetres <= Math.max(GPS_JITTER_METRES, (accuracy ?? 0) * 0.25);
        const latitude = shouldHoldPosition
          ? previous.latitude
          : shouldSmooth
            ? previous.latitude +
              (position.coords.latitude - previous.latitude) * GPS_POSITION_EASING
            : position.coords.latitude;
        const longitude = shouldHoldPosition
          ? previous.longitude
          : shouldSmooth
            ? previous.longitude +
              (position.coords.longitude - previous.longitude) * GPS_POSITION_EASING
            : position.coords.longitude;

        const nextLocation = {
          latitude,
          longitude,
          accuracy,
          heading,
          headingSource,
          speed:
            typeof position.coords.speed === "number" && Number.isFinite(position.coords.speed)
              ? position.coords.speed
              : undefined,
          timestamp: position.timestamp,
        };

        lastGpsLocationRef.current = nextLocation;
        lastGpsUpdateRef.current = now;
        setDriveError(null);
        setDriveLocation(nextLocation);
      },
      (geoError) => {
        setDriveError(geoError.message || "Location permission was not granted.");
        setIsDriveModeActive(false);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10000,
      },
    );

    return () => {
      if (geolocationWatchRef.current !== null) {
        navigator.geolocation.clearWatch(geolocationWatchRef.current);
        geolocationWatchRef.current = null;
      }
    };
  }, [isDriveModeActive, isSimulationMode]);

  useEffect(() => {
    if (!isDriveModeActive || !driveLocation) return;
    if (weatherState.status === "loading") return;

    const now = Date.now();
    const lastFetchAge = weatherState.fetchedAt ? now - weatherState.fetchedAt : Infinity;
    const distanceFromLastWeather =
      typeof weatherState.latitude === "number" && typeof weatherState.longitude === "number"
        ? getDistanceMetres(
            driveLocation.latitude,
            driveLocation.longitude,
            weatherState.latitude,
            weatherState.longitude,
          )
        : Infinity;

    if (
      lastFetchAge < WEATHER_REFRESH_MS &&
      distanceFromLastWeather < WEATHER_MOVE_REFRESH_METRES
    ) {
      return;
    }

    setWeatherState((current) => ({ ...current, status: "loading", error: undefined }));

    void fetchCurrentWeather(driveLocation.latitude, driveLocation.longitude)
      .then((weather) => {
        setWeatherState({
          weather,
          conditions: getCurrentDrivingConditions(weather, new Date()),
          fetchedAt: now,
          latitude: driveLocation.latitude,
          longitude: driveLocation.longitude,
          status: "ready",
        });
      })
      .catch((caughtError) => {
        setWeatherState({
          weather: null,
          conditions: getCurrentDrivingConditions(null, new Date()),
          fetchedAt: now,
          latitude: driveLocation.latitude,
          longitude: driveLocation.longitude,
          status: "error",
          error:
            caughtError instanceof Error
              ? caughtError.message
              : "Weather unavailable",
        });
      });
  }, [
    driveLocation,
    isDriveModeActive,
    weatherState.fetchedAt,
    weatherState.latitude,
    weatherState.longitude,
    weatherState.status,
  ]);

  useEffect(() => {
    if (
      !isDriveModeActive ||
      filters.weatherMode !== "historical" ||
      !driveLocation ||
      !activeDrivingConditions
    ) {
      setHistoricalWeatherMatchState((current) =>
        current.status === "off"
          ? current
          : { status: "off", matches: {}, matchedCrashIds: [], checkedCrashCount: 0 },
      );
      return;
    }

    const topLookaheadCrashes = dashboardLookaheadCrashes
      .filter((item) => item.crash.dateTime)
      .slice(0, HISTORICAL_WEATHER_LOOKAHEAD_LIMIT);
    const crashKey = topLookaheadCrashes.map((item) => item.crash.id).join("|");
    const now = Date.now();
    const lastRun = historicalWeatherLastRunRef.current;
    const movedMetres = lastRun
      ? getDistanceMetres(
          driveLocation.latitude,
          driveLocation.longitude,
          lastRun.latitude,
          lastRun.longitude,
        )
      : Infinity;
    const headingDelta =
      typeof driveLocation.heading === "number" && typeof lastRun?.heading === "number"
        ? Math.abs(((((driveLocation.heading - lastRun.heading) % 360) + 540) % 360) - 180)
        : Infinity;

    if (
      lastRun &&
      crashKey === lastRun.crashKey &&
      movedMetres < HISTORICAL_WEATHER_MOVE_METRES &&
      headingDelta < 18 &&
      now - lastRun.time < HISTORICAL_WEATHER_REFRESH_MS
    ) {
      return;
    }

    if (!topLookaheadCrashes.length) {
      setHistoricalWeatherMatchState({
        status: "idle",
        matches: {},
        matchedCrashIds: [],
        checkedCrashCount: 0,
      });
      return;
    }

    historicalWeatherLastRunRef.current = {
      time: now,
      latitude: driveLocation.latitude,
      longitude: driveLocation.longitude,
      heading: driveLocation.heading,
      crashKey,
    };

    let isCancelled = false;
    setHistoricalWeatherMatchState((current) => ({
      ...current,
      status: "checking",
      error: undefined,
      checkedCrashCount: topLookaheadCrashes.length,
    }));

    const runLookup = async () => {
      if (weatherSimulationMode === "historySlow") {
        await new Promise((resolve) => window.setTimeout(resolve, 1800));
      }
      if (weatherSimulationMode === "historyFailure") {
        throw new Error("Simulated historical weather failure");
      }

      const entries = await Promise.all(
        topLookaheadCrashes.map(async ({ crash }) => {
          const weather = await getHistoricalWeatherForCrash(crash);
          if (!weather) return null;
          return [
            crash.id,
            compareHistoricalWeatherToCurrent(weather, activeDrivingConditions),
          ] as const;
        }),
      );

      return Object.fromEntries(entries.filter(Boolean) as Array<[string, NonNullable<(typeof entries)[number]>[1]]>);
    };

    void runLookup()
      .then((matches) => {
        if (isCancelled) return;
        const matchedCrashIds = Object.values(matches)
          .filter(
            (match) =>
              match.weatherMatch ||
              match.wetMatch ||
              match.lightMatch ||
              match.visibilityMatch ||
              match.windMatch,
          )
          .map((match) => match.crashId);

        setHistoricalWeatherMatchState({
          status: matchedCrashIds.length ? "ready" : "limited",
          matches,
          matchedCrashIds,
          checkedCrashCount: topLookaheadCrashes.length,
        });
      })
      .catch((caughtError) => {
        if (isCancelled) return;
        setHistoricalWeatherMatchState({
          status: "error",
          matches: {},
          matchedCrashIds: [],
          checkedCrashCount: topLookaheadCrashes.length,
          error:
            caughtError instanceof Error
              ? caughtError.message
              : "Historical weather unavailable",
        });
      });

    return () => {
      isCancelled = true;
    };
  }, [
    activeDrivingConditions,
    dashboardLookaheadCrashes,
    driveLocation,
    filters.weatherMode,
    isDriveModeActive,
    weatherSimulationMode,
  ]);

  useEffect(() => {
    if (!isSimulationMode || !isSimulationDriving) {
      if (simulationIntervalRef.current !== null) {
        window.clearInterval(simulationIntervalRef.current);
        simulationIntervalRef.current = null;
      }
      simulationLastTickRef.current = 0;
      return;
    }

    simulationLastTickRef.current = Date.now();
    simulationIntervalRef.current = window.setInterval(() => {
      const now = Date.now();
      const elapsedSeconds = Math.max(
        SIMULATION_STEP_MS / 1000,
        (now - simulationLastTickRef.current) / 1000,
      );
      simulationLastTickRef.current = now;

      let segmentIndex = simulationSegmentRef.current;
      const currentSegment = SIMULATION_ROUTE[segmentIndex];
      const nextSegment = SIMULATION_ROUTE[segmentIndex + 1] ?? currentSegment;
      const currentSegmentLength = getDistanceMetres(
        currentSegment.latitude,
        currentSegment.longitude,
        nextSegment.latitude,
        nextSegment.longitude,
      );
      const currentProgress =
        currentSegmentLength > 0 ? simulationSegmentMetresRef.current / currentSegmentLength : 0;
      const simulationSpeed = getSimulationSpeedMps(segmentIndex, currentProgress);
      let segmentMetres = simulationSegmentMetresRef.current + elapsedSeconds * simulationSpeed;

      while (segmentIndex < SIMULATION_ROUTE.length - 1) {
        const from = SIMULATION_ROUTE[segmentIndex];
        const to = SIMULATION_ROUTE[segmentIndex + 1];
        const segmentLength = getDistanceMetres(
          from.latitude,
          from.longitude,
          to.latitude,
          to.longitude,
        );

        if (segmentMetres <= segmentLength) break;

        segmentMetres -= segmentLength;
        segmentIndex += 1;
      }

      if (segmentIndex >= SIMULATION_ROUTE.length - 1) {
        segmentIndex = 0;
        segmentMetres = 0;
      }

      const from = SIMULATION_ROUTE[segmentIndex];
      const to = SIMULATION_ROUTE[segmentIndex + 1];
      const segmentLength = getDistanceMetres(
        from.latitude,
        from.longitude,
        to.latitude,
        to.longitude,
      );
      const progress = segmentLength > 0 ? Math.min(segmentMetres / segmentLength, 1) : 0;
      const point = getInterpolatedPoint(from, to, progress);

      simulationSegmentRef.current = segmentIndex;
      simulationSegmentMetresRef.current = segmentMetres;
      setDriveLocation({
        latitude: point.latitude,
        longitude: point.longitude,
        heading: getBearingDegrees(from.latitude, from.longitude, to.latitude, to.longitude),
        headingSource: "simulated",
        speed: getSimulationSpeedMps(segmentIndex, progress),
        timestamp: now,
        isSimulated: true,
      });
    }, SIMULATION_STEP_MS);

    return () => {
      if (simulationIntervalRef.current !== null) {
        window.clearInterval(simulationIntervalRef.current);
        simulationIntervalRef.current = null;
      }
    };
  }, [isSimulationDriving, isSimulationMode]);

  useEffect(() => {
    if (!isDriveModeActive || isSimulationMode) return;

    const handleOrientation = (event: DeviceOrientationEventWithCompass) => {
      const rawHeading =
        typeof event.webkitCompassHeading === "number" && Number.isFinite(event.webkitCompassHeading)
          ? event.webkitCompassHeading
          : event.absolute && typeof event.alpha === "number" && Number.isFinite(event.alpha)
            ? 360 - event.alpha
            : undefined;

      if (rawHeading === undefined) return;

      const now = window.performance.now();
      if (now - lastCompassUpdateRef.current < COMPASS_UPDATE_INTERVAL_MS) return;
      lastCompassUpdateRef.current = now;

      const nextHeading = getSmoothedHeading(compassHeadingRef.current, rawHeading);
      const previousHeading = compassHeadingRef.current;
      compassHeadingRef.current = nextHeading;

      if (
        previousHeading !== null &&
        Math.abs(((((nextHeading - previousHeading) % 360) + 540) % 360) - 180) < 3
      ) {
        return;
      }

      setCompassHeading(nextHeading);
    };

    window.addEventListener("deviceorientationabsolute", handleOrientation);
    window.addEventListener("deviceorientation", handleOrientation);

    return () => {
      window.removeEventListener("deviceorientationabsolute", handleOrientation);
      window.removeEventListener("deviceorientation", handleOrientation);
    };
  }, [isDriveModeActive, isSimulationMode]);

  const driveRisk = useMemo(
    () =>
      getDriveRiskSummary(
        crashSpatialIndex,
        isDriveModeActive ? driveLocation : null,
        750,
      ),
    [crashSpatialIndex, driveLocation, isDriveModeActive],
  );

  const dashboardWeatherMode: WeatherMatchMode = filters.weatherMode === "current" ? "weighted" : "all";

  const calculatedDashboardLookaheadRisk = useMemo(
    () =>
      getDashboardLookaheadRisk(
        crashSpatialIndex,
        isDriveModeActive ? driveLocation : null,
        500,
        80,
        activeDrivingConditions,
        dashboardWeatherMode,
        filters.weatherMode === "historical" ? historicalWeatherMatchState.matches : {},
      ),
    [
      activeDrivingConditions,
      crashSpatialIndex,
      dashboardWeatherMode,
      driveLocation,
      filters.weatherMode,
      historicalWeatherMatchState.matches,
      isDriveModeActive,
    ],
  );

  const predictiveVoiceLookaheadRisk = useMemo(
    () =>
      getDashboardLookaheadRisk(
        crashSpatialIndex,
        isDriveModeActive ? driveLocation : null,
        VOICE_PREDICTIVE_LOOKAHEAD_METRES,
        80,
        activeDrivingConditions,
        dashboardWeatherMode,
        filters.weatherMode === "historical" ? historicalWeatherMatchState.matches : {},
      ),
    [
      activeDrivingConditions,
      crashSpatialIndex,
      dashboardWeatherMode,
      driveLocation,
      filters.weatherMode,
      historicalWeatherMatchState.matches,
      isDriveModeActive,
    ],
  );

  useEffect(() => {
    if (
      !isDriveModeActive ||
      !driveLocation ||
      !calculatedDashboardLookaheadRisk
    ) {
      setDashboardWarningCountdown(null);
      return;
    }

    setDashboardWarningCountdown((current) => {
      if (current?.status === "passed") {
        if (calculatedDashboardLookaheadRisk.riskLevel === "low") return null;

        const travelledMetres = getDistanceMetres(
          current.lastLatitude,
          current.lastLongitude,
          driveLocation.latitude,
          driveLocation.longitude,
        );
        const passedMetres = (current.passedMetres ?? 0) + travelledMetres;

        if (passedMetres < DASHBOARD_WARNING_REARM_METRES) {
          return {
            ...current,
            lastLatitude: driveLocation.latitude,
            lastLongitude: driveLocation.longitude,
            passedMetres,
          };
        }

        return {
          status: "active",
          remainingMetres: DASHBOARD_WARNING_DISTANCE_METRES,
          lastLatitude: driveLocation.latitude,
          lastLongitude: driveLocation.longitude,
          risk: calculatedDashboardLookaheadRisk,
        };
      }
      if (!current) {
        if (calculatedDashboardLookaheadRisk.riskLevel === "low") return null;
        return {
          status: "active",
          remainingMetres: DASHBOARD_WARNING_DISTANCE_METRES,
          lastLatitude: driveLocation.latitude,
          lastLongitude: driveLocation.longitude,
          risk: calculatedDashboardLookaheadRisk,
        };
      }
      if (calculatedDashboardLookaheadRisk.riskLevel === "low") return null;

      const travelledMetres = getDistanceMetres(
        current.lastLatitude,
        current.lastLongitude,
        driveLocation.latitude,
        driveLocation.longitude,
      );
      const remainingMetres = Math.max(0, current.remainingMetres - travelledMetres);

      return {
        status: remainingMetres <= 0 ? "passed" : current.status,
        remainingMetres,
        lastLatitude: driveLocation.latitude,
        lastLongitude: driveLocation.longitude,
        passedMetres: remainingMetres <= 0 ? 0 : current.passedMetres,
        risk: current.risk,
      };
    });
  }, [calculatedDashboardLookaheadRisk, driveLocation, isDriveModeActive]);

  const dashboardLookaheadRisk = useMemo<DashboardLookaheadRisk | null>(() => {
    if (!calculatedDashboardLookaheadRisk) return null;
    if (dashboardWarningCountdown?.status === "passed") {
      return {
        ...calculatedDashboardLookaheadRisk,
        riskLevel: "low",
        label: "Low crash history ahead",
        message: "No elevated history ahead",
        nearestCrashDistanceMetres: undefined,
      };
    }
    if (dashboardWarningCountdown?.status === "active") {
      return {
        ...dashboardWarningCountdown.risk,
        nearestCrashDistanceMetres: dashboardWarningCountdown.remainingMetres,
      };
    }
    if (calculatedDashboardLookaheadRisk.riskLevel !== "low") {
      return {
        ...calculatedDashboardLookaheadRisk,
        nearestCrashDistanceMetres: DASHBOARD_WARNING_DISTANCE_METRES,
      };
    }
    return calculatedDashboardLookaheadRisk;
  }, [calculatedDashboardLookaheadRisk, dashboardWarningCountdown]);

  const startDriveMode = async () => {
    setDriveError(null);
    setIsSimulationMode(false);
    setIsSimulationDriving(false);
    setCompassHeading(null);
    compassHeadingRef.current = null;
    lastCompassUpdateRef.current = 0;

    const DeviceOrientation =
      window.DeviceOrientationEvent as DeviceOrientationEventConstructorWithPermission | undefined;

    if (DeviceOrientation?.requestPermission) {
      try {
        const permission = await DeviceOrientation.requestPermission();
        if (permission !== "granted") {
          setDriveError("Compass permission was not granted. Using GPS heading where available.");
        }
      } catch {
        setDriveError("Compass permission is unavailable. Using GPS heading where available.");
      }
    }

    setIsDriveModeActive(true);
  };

  const startSimulationMode = () => {
    setDriveError(null);
    setIsSimulationMode(true);
    setIsDriveModeActive(true);
    setIsSimulationDriving(true);
    setCompassHeading(null);
    simulationSegmentRef.current = 0;
    simulationSegmentMetresRef.current = 0;
    setDriveLocation((currentLocation) => ({
      latitude: currentLocation?.latitude ?? -42.8821,
      longitude: currentLocation?.longitude ?? 147.3272,
      heading: currentLocation?.heading ?? 0,
      headingSource: "simulated",
      speed: 0,
      timestamp: Date.now(),
      isSimulated: true,
    }));
  };

  const toggleSimulationDrive = () => {
    if (!isSimulationMode) return;
    setIsSimulationDriving((isDriving) => !isDriving);
  };

  const stopDriveMode = () => {
    setIsDriveModeActive(false);
    setIsSimulationMode(false);
    setIsSimulationDriving(false);
    setDriveLocation(null);
    setMapboxSpeedLimitKmh(null);
    setCompassHeading(null);
    lastGpsLocationRef.current = null;
    lastGpsUpdateRef.current = 0;
    compassHeadingRef.current = null;
    lastCompassUpdateRef.current = 0;
    setDriveError(null);
    if (geolocationWatchRef.current !== null) {
      navigator.geolocation.clearWatch(geolocationWatchRef.current);
      geolocationWatchRef.current = null;
    }
  };

  const mapCrashes = filteredCrashes;

  const displayedDriveLocation = useMemo<DriveLocation | null>(() => {
    if (!driveLocation) return null;
    if (isSimulationMode || compassHeading === null) return driveLocation;
    if (
      (driveLocation.headingSource === "gps" || driveLocation.headingSource === "movement") &&
      typeof driveLocation.heading === "number" &&
      (driveLocation.speed ?? 0) >= 1.8
    ) {
      return driveLocation;
    }

    return {
      ...driveLocation,
      heading: compassHeading,
      headingSource: "compass",
    };
  }, [compassHeading, driveLocation, isSimulationMode]);

  const currentSpeedLabel = formatSpeedKmh(displayedDriveLocation?.speed);
  const currentSpeedZoneLabel =
    typeof mapboxSpeedLimitKmh === "number"
      ? String(mapboxSpeedLimitKmh)
      : formatSpeedZone(driveRisk?.nearbySpeedZone);
  const overspeedDelta = getOverspeedDeltaKmh(
    displayedDriveLocation?.speed,
    currentSpeedZoneLabel,
  );
  const weatherMatchStatus =
    filters.weatherMode === "off"
      ? "off"
      : filters.weatherMode === "current"
        ? activeDrivingConditions
          ? "ready"
          : "limited"
        : historicalWeatherMatchState.status;
  const dashboardDrivingState = useMemo<DashboardDrivingState>(() => {
    const currentSpeed =
      typeof displayedDriveLocation?.speed === "number"
        ? Math.round(Math.max(0, displayedDriveLocation.speed * 3.6))
        : undefined;
    const speedLimit = mapboxSpeedLimitKmh ?? parseSpeedLimitKmh(driveRisk?.nearbySpeedZone) ?? undefined;
    const level = dashboardLookaheadRisk?.riskLevel ?? "low";
    const distance =
      typeof dashboardLookaheadRisk?.nearestCrashDistanceMetres === "number"
        ? Math.max(0, Math.round(dashboardLookaheadRisk.nearestCrashDistanceMetres))
        : dashboardLookaheadRisk?.lookaheadDistanceMetres;

    return {
      currentSpeed,
      speedLimit,
      recommendedCarLengths: getReactionCarLengths(displayedDriveLocation?.speed),
      currentWarningLevel: level,
      currentWarningColour: getWarningColour(level),
      upcomingWarningLevel: level,
      upcomingWarningColour: getWarningColour(level),
      distanceToUpcomingWarningMetres: distance,
      upcomingZoneType: getZoneType(dashboardLookaheadRisk?.roadContext),
      optionalLandmark: getOptionalLandmark(dashboardLookaheadRisk?.roadContext),
      heading: displayedDriveLocation?.heading,
      locationTimestamp: displayedDriveLocation?.timestamp,
      riskTimestamp: dashboardLookaheadRisk ? Date.now() : undefined,
    };
  }, [dashboardLookaheadRisk, displayedDriveLocation, driveRisk?.nearbySpeedZone, mapboxSpeedLimitKmh]);
  const voiceContext = useMemo<VoiceWarningContext>(
    () => ({
      isActive: isDriveModeActive,
      speedKmh: dashboardDrivingState.currentSpeed,
      speedLimitKmh: dashboardDrivingState.speedLimit,
      carLengths: dashboardDrivingState.recommendedCarLengths,
      riskLevel: dashboardLookaheadRisk?.riskLevel ?? "low",
      totalCrashCount: dashboardLookaheadRisk?.totalCrashCount ?? 0,
      seriousCount: dashboardLookaheadRisk?.seriousCount ?? 0,
      fatalCount: dashboardLookaheadRisk?.fatalCount ?? 0,
      matchedCrashCount: dashboardLookaheadRisk?.matchedCrashCount ?? 0,
      wetCrashCount: dashboardLookaheadRisk?.wetCrashCount ?? 0,
      darkCrashCount: dashboardLookaheadRisk?.darkCrashCount ?? 0,
      currentConditions: activeDrivingConditions,
      dashboardDrivingState,
      lookaheadDistanceMetres: dashboardLookaheadRisk?.lookaheadDistanceMetres ?? 500,
      roadContext: dashboardLookaheadRisk?.roadContext,
      segmentKey: getVoiceSegmentKey(
        displayedDriveLocation,
        dashboardLookaheadRisk?.riskLevel ?? "low",
      ),
    }),
    [
      activeDrivingConditions,
      dashboardDrivingState,
      dashboardLookaheadRisk,
      displayedDriveLocation,
      isDriveModeActive,
    ],
  );
  const predictiveVoiceContext = useMemo<VoiceWarningContext | null>(() => {
    if (!predictiveVoiceLookaheadRisk || predictiveVoiceLookaheadRisk.riskLevel === "low") {
      return null;
    }

    const distance =
      typeof predictiveVoiceLookaheadRisk.nearestCrashDistanceMetres === "number"
        ? Math.max(0, Math.round(predictiveVoiceLookaheadRisk.nearestCrashDistanceMetres))
        : predictiveVoiceLookaheadRisk.lookaheadDistanceMetres;
    const predictiveDrivingState: DashboardDrivingState = {
      ...dashboardDrivingState,
      currentWarningLevel: predictiveVoiceLookaheadRisk.riskLevel,
      currentWarningColour: getWarningColour(predictiveVoiceLookaheadRisk.riskLevel),
      upcomingWarningLevel: predictiveVoiceLookaheadRisk.riskLevel,
      upcomingWarningColour: getWarningColour(predictiveVoiceLookaheadRisk.riskLevel),
      distanceToUpcomingWarningMetres: distance,
      upcomingZoneType: getZoneType(predictiveVoiceLookaheadRisk.roadContext),
      optionalLandmark: getOptionalLandmark(predictiveVoiceLookaheadRisk.roadContext),
      riskTimestamp: Date.now(),
    };

    return {
      isActive: isDriveModeActive,
      speedKmh: predictiveDrivingState.currentSpeed,
      speedLimitKmh: predictiveDrivingState.speedLimit,
      carLengths: predictiveDrivingState.recommendedCarLengths,
      riskLevel: predictiveVoiceLookaheadRisk.riskLevel,
      totalCrashCount: predictiveVoiceLookaheadRisk.totalCrashCount,
      seriousCount: predictiveVoiceLookaheadRisk.seriousCount,
      fatalCount: predictiveVoiceLookaheadRisk.fatalCount,
      matchedCrashCount: predictiveVoiceLookaheadRisk.matchedCrashCount,
      wetCrashCount: predictiveVoiceLookaheadRisk.wetCrashCount,
      darkCrashCount: predictiveVoiceLookaheadRisk.darkCrashCount,
      currentConditions: activeDrivingConditions,
      dashboardDrivingState: predictiveDrivingState,
      lookaheadDistanceMetres: predictiveVoiceLookaheadRisk.lookaheadDistanceMetres,
      roadContext: predictiveVoiceLookaheadRisk.roadContext,
      segmentKey: getVoiceSegmentKey(
        displayedDriveLocation,
        predictiveVoiceLookaheadRisk.riskLevel,
      ),
    };
  }, [
    activeDrivingConditions,
    dashboardDrivingState,
    displayedDriveLocation,
    isDriveModeActive,
    predictiveVoiceLookaheadRisk,
  ]);
  const drivingCompanion = useDrivingCompanion(voiceContext, predictiveVoiceContext);

  return (
    <main
      className={`app ${isChromeHidden ? "app--chrome-hidden" : ""} ${
        isDriveModeActive ? "app--drive-active" : ""
      } ${viewMode === "dashboard" ? "app--dashboard-mode" : ""}`}
    >
      {viewMode === "map" ? (
        <CrashMap
          crashes={mapCrashes}
          heatmapCrashes={filteredCrashes}
          currentConditions={activeDrivingConditions}
          weatherMode={filters.weatherMode}
          weatherMatchedCrashIds={historicalWeatherMatchState.matchedCrashIds}
          timePhase={timePhase}
          isFullscreen={isChromeHidden}
          driveMode={{
            isActive: isDriveModeActive,
            isSimulation: isSimulationMode,
            location: displayedDriveLocation,
            nearbyCrashes: driveRisk?.nearbyCrashes ?? [],
            onSimulatedLocationChange: (location) => {
              if (!isSimulationMode) return;
              setIsSimulationDriving(false);
              setDriveLocation({
                ...location,
                speed: 0,
                headingSource: "simulated",
                timestamp: Date.now(),
                isSimulated: true,
              });
            },
          }}
        />
      ) : (
        <DashboardMode
          isActive={isDriveModeActive}
          isSimulation={isSimulationMode}
          isSimulationDriving={isSimulationDriving}
          location={displayedDriveLocation}
          driveRisk={driveRisk}
          speedLimitLabel={currentSpeedZoneLabel}
          lookaheadRisk={dashboardLookaheadRisk}
          drivingState={dashboardDrivingState}
          currentConditions={activeDrivingConditions}
          currentWeather={weatherState.weather}
          weatherStatus={
            weatherSimulationMode === "failure" ? "error" : weatherSimulationMode === "live" ? weatherState.status : "simulated"
          }
          error={driveError}
          onStartDrive={startDriveMode}
          onStartSimulation={startSimulationMode}
          onToggleSimulationDrive={toggleSimulationDrive}
          onStopDrive={stopDriveMode}
          onMapboxSpeedLimitChange={setMapboxSpeedLimitKmh}
        />
      )}

      <div className="view-toggle" role="tablist" aria-label="View mode">
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === "map"}
          className={viewMode === "map" ? "is-active" : ""}
          onClick={() => setViewMode("map")}
        >
          Map Mode
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === "dashboard"}
          className={viewMode === "dashboard" ? "is-active" : ""}
          onClick={() => {
            setViewMode("dashboard");
            setIsFilterOpen(false);
          }}
        >
          Dashboard Mode
        </button>
      </div>

      {viewMode === "dashboard" && (
        <div
          className="dashboard-root-car-overlay"
          aria-hidden="true"
          style={{
            position: "fixed",
            top: "86vh",
            left: "50%",
            zIndex: 2147483647,
            width: "6.6rem",
            height: "8.8rem",
            pointerEvents: "none",
            transform: "translate(-50%, -50%)",
            display: "grid",
            placeItems: "center",
            background: "transparent",
            mixBlendMode: "normal",
            isolation: "isolate",
            opacity: 1,
          }}
        >
          <img
            src={vehicleTopImageUrl}
            alt=""
            draggable="false"
            style={{
              display: "block",
              width: "100%",
              height: "100%",
              objectFit: "contain",
              objectPosition: "center",
              opacity: 1,
              mixBlendMode: "normal",
              filter: "none",
            }}
          />
        </div>
      )}

      {isDriveModeActive && (
        <VoiceSettings
          isSupported={drivingCompanion.isSupported}
          settings={drivingCompanion.settings}
          lastSpoken={drivingCompanion.lastSpoken}
          error={drivingCompanion.error}
          isSpeaking={drivingCompanion.isSpeaking}
          isAudioUnlocked={drivingCompanion.isAudioUnlocked}
          debugStatus={drivingCompanion.debugStatus}
          onSettingsChange={drivingCompanion.setSettings}
          onEnable={drivingCompanion.enableCompanion}
          onDisable={drivingCompanion.disableCompanion}
          onTestVoice={drivingCompanion.testVoice}
          onTestWarningType={drivingCompanion.testWarningType}
        />
      )}

      {viewMode === "map" && (
        <FilterPanel
          crashes={dataState.crashes}
          filteredCount={filteredCrashes.length}
          filters={filters}
          isOpen={isFilterOpen}
          fetchedAt={dataState.fetchedAt}
          isRefreshing={isRefreshing}
          timeline={timeline}
          isTimeOfDayEnabled={isTimeOfDayEnabled}
          currentConditions={activeDrivingConditions}
          currentWeather={weatherState.weather}
          weatherStatus={
            weatherSimulationMode === "failure" ? "error" : weatherSimulationMode === "live" ? weatherState.status : "simulated"
          }
          weatherSimulationMode={weatherSimulationMode}
          onChange={setFilters}
          onTimelineChange={setTimeline}
          onTimeOfDayToggle={() => setIsTimeOfDayEnabled((enabled) => !enabled)}
          onWeatherSimulationChange={setWeatherSimulationMode}
          onRefresh={() => void loadCrashData({ refresh: true })}
          onOpen={() => setIsFilterOpen(true)}
          onClose={() => setIsFilterOpen(false)}
        />
      )}

      {viewMode === "map" && (
        <DriveModePanel
          isActive={isDriveModeActive}
          isSimulation={isSimulationMode}
          location={displayedDriveLocation}
          risk={driveRisk}
          error={driveError}
          onStart={startDriveMode}
          onStartSimulation={startSimulationMode}
          isSimulationDriving={isSimulationDriving}
          onToggleSimulationDrive={toggleSimulationDrive}
          onStop={stopDriveMode}
        />
      )}

      {viewMode === "map" && timeline && (
        <div className={`timeline-counter timeline-counter--${timePhase}`} aria-live="polite">
          <span>{timeline.isPlaybackView ? "Timeline frame" : "Selected range"}</span>
          <strong>
            {new Intl.DateTimeFormat("en-AU", {
              day: "2-digit",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }).format(new Date(displayTime ?? timeline.playheadTime))}
          </strong>
        </div>
      )}

      {viewMode === "map" && isDriveModeActive && (
        <div className="speed-overlay" aria-live="polite">
          <div>
            <span>Speed</span>
            <strong>{currentSpeedLabel}</strong>
            <small>km/h</small>
            <em className={`speed-overspeed ${overspeedDelta !== null ? "is-visible" : ""}`}>
              {overspeedDelta !== null ? `+${overspeedDelta}km/h` : ""}
            </em>
          </div>
          <div>
            <span>Zone</span>
            <strong
              className="speed-sign"
              aria-label={
                driveRisk?.nearbySpeedZone
                  ? `Nearby recorded speed zone ${currentSpeedZoneLabel} kilometres per hour`
                  : "Nearby recorded speed zone unavailable"
              }
            >
              {currentSpeedZoneLabel}
            </strong>
          </div>
        </div>
      )}

      <button
        className="fullscreen-toggle"
        type="button"
        onClick={() => {
          setIsChromeHidden((hidden) => !hidden);
          setIsFilterOpen(false);
        }}
        aria-label={isChromeHidden ? "Show menus" : "Hide menus"}
      >
        {isChromeHidden ? (
          <Minimize2 size={18} aria-hidden="true" />
        ) : (
          <Maximize2 size={18} aria-hidden="true" />
        )}
        <span>{isChromeHidden ? "Show menus" : "Full screen"}</span>
      </button>

      {isLoading && (
        <LoadingState
          message={
            loadedCount > 0
              ? `Loaded ${loadedCount.toLocaleString("en-AU")} records. Caching after download completes.`
              : "Loading historical crash data. The first download is large and will be cached."
          }
        />
      )}
      {error && !isLoading && (
        <ErrorState message={error} onRetry={() => void loadCrashData({ refresh: true })} />
      )}
    </main>
  );
}

export default App;
