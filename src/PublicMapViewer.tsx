import { useEffect, useMemo, useRef, useState } from "react";
import { CrashMap } from "./components/CrashMap";
import { ErrorState } from "./components/ErrorState";
import { FilterPanel } from "./components/FilterPanel";
import { LoadingState } from "./components/LoadingState";
import { PublicAnalytics } from "./components/PublicAnalytics";
import { fetchAllTasCrashData } from "./data/crashData";
import { defaultFilters, filterCrashes } from "./data/filterCrashes";
import type { CrashDataState, CrashFilters, CrashRecord, TimelineState } from "./types/crash";

const DAY_MS = 24 * 60 * 60 * 1000;
const crashTimeCache = new WeakMap<CrashRecord, number | null>();

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

type PublicViewerMode = "map" | "analytics";

export function PublicMapViewer() {
  const [dataState, setDataState] = useState<CrashDataState>({ crashes: [] });
  const [filters, setFilters] = useState<CrashFilters>({ ...defaultFilters });
  const [timeline, setTimeline] = useState<TimelineState | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isTimeOfDayEnabled, setIsTimeOfDayEnabled] = useState(false);
  const [viewerMode, setViewerMode] = useState<PublicViewerMode>("map");
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadedCount, setLoadedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const hasStartedInitialLoad = useRef(false);
  const playbackIntervalRef = useRef<number | null>(null);

  const loadCrashData = async ({ refresh = false } = {}) => {
    setError(null);
    if (refresh) setIsRefreshing(true);
    else setIsLoading(true);

    try {
      setLoadedCount(0);
      const crashes = await fetchAllTasCrashData(setLoadedCount);
      setDataState({ crashes, fetchedAt: new Date().toISOString() });
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "The Tasmanian Government crash data service did not respond.",
      );
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

  const analyticsCrashes = useMemo(() => {
    if (!timeline) return attributeFilteredCrashes;

    return attributeFilteredCrashes.filter((crash) => {
      const time = getCrashTime(crash);
      return time !== null && time >= timeline.startTime && time <= timeline.endTime;
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

  return (
    <main className="app public-viewer">
      {viewerMode === "map" ? (
        <CrashMap
          crashes={filteredCrashes}
          heatmapCrashes={filteredCrashes}
          currentConditions={null}
          weatherMode="off"
          weatherMatchedCrashIds={[]}
          timePhase={timePhase}
        />
      ) : (
        <PublicAnalytics crashes={analyticsCrashes} totalCrashes={dataState.crashes.length} />
      )}

      <header className="public-viewer__header app-chrome">
        <p className="eyebrow">Tasmania Crash Map</p>
        <h1>{viewerMode === "map" ? "Historical crash data viewer" : "Crash data analytics"}</h1>
        <p>
          {viewerMode === "map"
            ? "Explore Tasmanian crash records by location, severity, road condition and time."
            : "Charts and summaries to help make historical road patterns easier to understand."}
        </p>
      </header>

      <div className="public-viewer__mode-toggle app-chrome" role="tablist" aria-label="Viewer mode">
        <button
          type="button"
          role="tab"
          aria-selected={viewerMode === "map"}
          className={viewerMode === "map" ? "is-active" : ""}
          onClick={() => setViewerMode("map")}
        >
          Map
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={viewerMode === "analytics"}
          className={viewerMode === "analytics" ? "is-active" : ""}
          onClick={() => setViewerMode("analytics")}
        >
          Analytics
        </button>
      </div>

      <FilterPanel
        crashes={dataState.crashes}
        filteredCount={filteredCrashes.length}
        filters={filters}
        isOpen={isFilterOpen}
        fetchedAt={dataState.fetchedAt}
        isRefreshing={isRefreshing}
        timeline={timeline}
        isTimeOfDayEnabled={isTimeOfDayEnabled}
        currentConditions={null}
        currentWeather={null}
        weatherStatus="idle"
        weatherSimulationMode="live"
        showWeatherControls={false}
        showDeveloperWeatherSimulation={false}
        showTimeOfDayControl={false}
        onChange={setFilters}
        onTimelineChange={setTimeline}
        onTimeOfDayToggle={() => setIsTimeOfDayEnabled((enabled) => !enabled)}
        onWeatherSimulationChange={() => undefined}
        onRefresh={() => void loadCrashData({ refresh: true })}
        onOpen={() => setIsFilterOpen(true)}
        onClose={() => setIsFilterOpen(false)}
      />

      {viewerMode === "map" && timeline && (
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

      {isLoading && (
        <LoadingState
          message={
            loadedCount > 0
              ? `Loaded ${loadedCount.toLocaleString("en-AU")} records. Preparing the map.`
              : "Loading historical crash data from the map CDN."
          }
        />
      )}
      {error && !isLoading && (
        <ErrorState message={error} onRetry={() => void loadCrashData({ refresh: true })} />
      )}
    </main>
  );
}
