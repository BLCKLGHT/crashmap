import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { CrashMap } from "./components/CrashMap";
import { ErrorState } from "./components/ErrorState";
import { FilterPanel } from "./components/FilterPanel";
import { LoadingState } from "./components/LoadingState";
import {
  clearCachedCrashData,
  fetchAllTasCrashData,
  readCachedCrashData,
  writeCachedCrashData,
} from "./data/crashData";
import { defaultFilters, filterCrashes } from "./data/filterCrashes";
import {
  createCrashSpatialIndex,
  getDriveRiskSummary,
} from "./data/spatialIndex";
import type {
  CrashDataState,
  CrashFilters,
  CrashRecord,
  DriveLocation,
  TimelineState,
} from "./types/crash";
import { DriveModePanel } from "./components/DriveModePanel";

type DeviceOrientationEventWithCompass = DeviceOrientationEvent & {
  webkitCompassHeading?: number;
};

type DeviceOrientationEventConstructorWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const crashTimeCache = new WeakMap<CrashRecord, number | null>();
const COMPASS_UPDATE_INTERVAL_MS = 220;
const COMPASS_HEADING_EASING = 0.12;
const SIMULATION_STEP_MS = 250;
const SIMULATION_SPEED_MPS = 13.9;

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
  const [isDriveModeActive, setIsDriveModeActive] = useState(false);
  const [isSimulationMode, setIsSimulationMode] = useState(false);
  const [isSimulationDriving, setIsSimulationDriving] = useState(false);
  const [driveLocation, setDriveLocation] = useState<DriveLocation | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);
  const hasStartedInitialLoad = useRef(false);
  const playbackIntervalRef = useRef<number | null>(null);
  const geolocationWatchRef = useRef<number | null>(null);
  const simulationIntervalRef = useRef<number | null>(null);
  const simulationSegmentRef = useRef(0);
  const simulationSegmentMetresRef = useRef(0);
  const simulationLastTickRef = useRef(0);
  const lastGpsLocationRef = useRef<DriveLocation | null>(null);
  const compassHeadingRef = useRef<number | null>(null);
  const lastCompassUpdateRef = useRef(0);

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

  const attributeFilteredCrashes = useMemo(
    () => filterCrashes(dataState.crashes, filters),
    [dataState.crashes, filters],
  );

  const crashSpatialIndex = useMemo(
    () => createCrashSpatialIndex(dataState.crashes),
    [dataState.crashes],
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
        const gpsHeading =
          typeof position.coords.heading === "number" && Number.isFinite(position.coords.heading)
            ? position.coords.heading
            : undefined;
        const previous = lastGpsLocationRef.current;
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
        const heading = compassHeadingRef.current ?? gpsHeading ?? derivedHeading ?? previous?.heading;
        const headingSource =
          compassHeadingRef.current !== null
            ? "compass"
            : gpsHeading !== undefined
              ? "gps"
              : derivedHeading !== undefined
                ? "movement"
                : previous?.headingSource;
        const nextLocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          heading,
          headingSource,
          speed:
            typeof position.coords.speed === "number" && Number.isFinite(position.coords.speed)
              ? position.coords.speed
              : undefined,
          timestamp: position.timestamp,
        };

        lastGpsLocationRef.current = nextLocation;
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
      let segmentMetres = simulationSegmentMetresRef.current + elapsedSeconds * SIMULATION_SPEED_MPS;

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
        speed: SIMULATION_SPEED_MPS,
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

      setDriveLocation((currentLocation) =>
        currentLocation
          ? {
              ...currentLocation,
              heading: nextHeading,
              headingSource: "compass",
            }
          : currentLocation,
      );
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

  const startDriveMode = async () => {
    setDriveError(null);
    setIsSimulationMode(false);
    setIsSimulationDriving(false);
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
    setIsSimulationDriving(false);
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
    lastGpsLocationRef.current = null;
    compassHeadingRef.current = null;
    lastCompassUpdateRef.current = 0;
    setDriveError(null);
    if (geolocationWatchRef.current !== null) {
      navigator.geolocation.clearWatch(geolocationWatchRef.current);
      geolocationWatchRef.current = null;
    }
  };

  const mapCrashes =
    isDriveModeActive && driveRisk ? driveRisk.nearbyCrashes : filteredCrashes;

  return (
    <main
      className={`app ${isChromeHidden ? "app--chrome-hidden" : ""} ${
        isDriveModeActive ? "app--drive-active" : ""
      }`}
    >
      <CrashMap
        crashes={mapCrashes}
        heatmapCrashes={filteredCrashes}
        timePhase={timePhase}
        driveMode={{
          isActive: isDriveModeActive,
          isSimulation: isSimulationMode,
          location: driveLocation,
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

      <header className="top-bar app-chrome">
        <div>
          <p className="eyebrow">Public awareness map</p>
          <h1>Tasmania Crash Map</h1>
        </div>
        <p>
          Historical Tasmanian crash data. Use for awareness and planning, not real-time
          navigation.
        </p>
      </header>

      <FilterPanel
        crashes={dataState.crashes}
        filteredCount={filteredCrashes.length}
        filters={filters}
        isOpen={isFilterOpen}
        fetchedAt={dataState.fetchedAt}
        isRefreshing={isRefreshing}
        timeline={timeline}
        isTimeOfDayEnabled={isTimeOfDayEnabled}
        onChange={setFilters}
        onTimelineChange={setTimeline}
        onTimeOfDayToggle={() => setIsTimeOfDayEnabled((enabled) => !enabled)}
        onRefresh={() => void loadCrashData({ refresh: true })}
        onOpen={() => setIsFilterOpen(true)}
        onClose={() => setIsFilterOpen(false)}
      />

      <DriveModePanel
        isActive={isDriveModeActive}
        isSimulation={isSimulationMode}
        location={driveLocation}
        risk={driveRisk}
        error={driveError}
        onStart={startDriveMode}
        onStartSimulation={startSimulationMode}
        isSimulationDriving={isSimulationDriving}
        onToggleSimulationDrive={toggleSimulationDrive}
        onStop={stopDriveMode}
      />

      {timeline && (
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
