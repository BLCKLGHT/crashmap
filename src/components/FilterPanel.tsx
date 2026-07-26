import type { Dispatch, SetStateAction } from "react";
import {
  Activity,
  Info,
  Layers,
  Moon,
  Pause,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Sun,
  X,
} from "lucide-react";
import type {
  CrashFilters,
  CrashRecord,
  CurrentDrivingConditions,
  CurrentWeather,
  TimelineState,
  ViewerLayerToggles,
  WeatherState,
} from "../types/crash";
import { defaultFilters, uniqueOptions } from "../data/filterCrashes";
import { Legend } from "./Legend";

type WeatherSimulationMode =
  | "live"
  | "wet"
  | "dry"
  | "daylight"
  | "dark"
  | "failure"
  | "historyFailure"
  | "historySlow";

type FilterPanelProps = {
  crashes: CrashRecord[];
  filteredCount: number;
  filters: CrashFilters;
  isOpen: boolean;
  fetchedAt?: string;
  isRefreshing: boolean;
  timeline: TimelineState | null;
  isTimeOfDayEnabled: boolean;
  currentConditions: CurrentDrivingConditions | null;
  currentWeather: CurrentWeather | null;
  weatherStatus: WeatherState["status"];
  weatherSimulationMode: WeatherSimulationMode;
  showWeatherControls?: boolean;
  showDeveloperWeatherSimulation?: boolean;
  showTimeOfDayControl?: boolean;
  showViewerLayerControls?: boolean;
  viewerLayers?: ViewerLayerToggles;
  onChange: (filters: CrashFilters) => void;
  onTimelineChange: Dispatch<SetStateAction<TimelineState | null>>;
  onTimeOfDayToggle: () => void;
  onWeatherSimulationChange: (mode: WeatherSimulationMode) => void;
  onViewerLayerChange?: (layers: ViewerLayerToggles) => void;
  onRefresh: () => void;
  onOpen: () => void;
  onClose: () => void;
};

const formatFetchedAt = (value?: string): string => {
  if (!value) return "Not loaded yet";
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const formatTimelineDate = (time?: number): string => {
  if (!time) return "Loading";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(time));
};

const formatTimelineDateTime = (time?: number): string => {
  if (!time) return "Loading";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(time));
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const formatConditionLabel = (
  conditions: CurrentDrivingConditions | null,
  status: WeatherState["status"],
): string => {
  if (!conditions) {
    if (status === "error") return "Weather unavailable";
    if (status === "loading" || status === "idle") return "checking weather";
    return "Weather unavailable";
  }
  const surface = conditions.surfaceCondition === "wet" ? "wet road" : conditions.surfaceCondition;
  const light = conditions.lightCondition.replace("_", "/");
  return `${status === "error" ? "estimated " : ""}${surface}, ${light}`;
};

const formatWeatherDetailLabel = (
  weather: CurrentWeather | null,
  conditions: CurrentDrivingConditions | null,
  status: WeatherState["status"],
): string => {
  if (!weather) {
    if (status === "simulated") return `simulated weather: ${conditions?.weatherLabel ?? "active"}`;
    if (status === "loading" || status === "idle") return "";
    if (status === "error") return "weather unavailable, using estimated conditions";
    return "waiting for current weather";
  }

  return [
    typeof weather.temperature === "number" ? `${Math.round(weather.temperature)}°C` : null,
    conditions?.weatherLabel,
    typeof weather.windSpeed === "number" ? `wind ${Math.round(weather.windSpeed)} km/h` : null,
  ]
    .filter(Boolean)
    .join(", ");
};

export function FilterPanel({
  crashes,
  filteredCount,
  filters,
  isOpen,
  fetchedAt,
  isRefreshing,
  timeline,
  isTimeOfDayEnabled,
  currentConditions,
  currentWeather,
  weatherStatus,
  weatherSimulationMode,
  showWeatherControls = true,
  showDeveloperWeatherSimulation = true,
  showTimeOfDayControl = true,
  showViewerLayerControls = false,
  viewerLayers,
  onChange,
  onTimelineChange,
  onTimeOfDayToggle,
  onWeatherSimulationChange,
  onViewerLayerChange,
  onRefresh,
  onOpen,
  onClose,
}: FilterPanelProps) {
  const speedZones = uniqueOptions(crashes, (crash) => crash.speedZone);
  const lightConditions = uniqueOptions(crashes, (crash) => crash.lightCondition);
  const surfaceTypes = uniqueOptions(crashes, (crash) => crash.surfaceType);
  const weatherDetailLabel = formatWeatherDetailLabel(
    currentWeather,
    currentConditions,
    weatherStatus,
  );

  const setFilter = <Key extends keyof CrashFilters>(
    key: Key,
    value: CrashFilters[Key],
  ) => {
    onChange({ ...filters, [key]: value });
  };

  const setViewerLayer = (key: keyof ViewerLayerToggles, value: boolean) => {
    if (!viewerLayers || !onViewerLayerChange) return;
    onViewerLayerChange({ ...viewerLayers, [key]: value });
  };

  const setTimelineRangeStart = (value: number) => {
    onTimelineChange((currentTimeline) => {
      if (!currentTimeline) return currentTimeline;

      const startTime = clamp(value, currentTimeline.minTime, currentTimeline.endTime);

      return {
        ...currentTimeline,
        startTime,
        playheadTime: currentTimeline.endTime,
        isPlaying: false,
        isPlaybackView: false,
      };
    });
  };

  const setTimelineRangeEnd = (value: number) => {
    onTimelineChange((currentTimeline) => {
      if (!currentTimeline) return currentTimeline;

      const endTime = clamp(value, currentTimeline.startTime, currentTimeline.maxTime);

      return {
        ...currentTimeline,
        endTime,
        playheadTime: endTime,
        isPlaying: false,
        isPlaybackView: false,
      };
    });
  };

  const setTimelinePlayhead = (value: number) => {
    onTimelineChange((currentTimeline) => {
      if (!currentTimeline) return currentTimeline;

      return {
        ...currentTimeline,
        playheadTime: clamp(value, currentTimeline.startTime, currentTimeline.endTime),
        isPlaying: false,
        isPlaybackView: true,
      };
    });
  };

  const togglePlayback = () => {
    onTimelineChange((currentTimeline) => {
      if (!currentTimeline) return currentTimeline;

      if (currentTimeline.isPlaying) {
        return { ...currentTimeline, isPlaying: false, isPlaybackView: true };
      }

      return {
        ...currentTimeline,
        playheadTime:
          currentTimeline.playheadTime >= currentTimeline.endTime
            ? currentTimeline.startTime
            : currentTimeline.playheadTime,
        isPlaying: true,
        isPlaybackView: true,
      };
    });
  };

  const setPlaybackSpeed = (speed: TimelineState["speed"]) => {
    onTimelineChange((currentTimeline) =>
      currentTimeline ? { ...currentTimeline, speed } : currentTimeline,
    );
  };

  return (
    <>
      <button className="filter-fab app-chrome" type="button" onClick={onOpen}>
        <SlidersHorizontal size={19} aria-hidden="true" />
        <span>Filters</span>
      </button>

      <aside className={`filter-panel app-chrome ${isOpen ? "filter-panel--open" : ""}`}>
        <div className="filter-panel__handle" aria-hidden="true" />
        <div className="filter-panel__header">
          <div>
            <p className="eyebrow">Tasmania Crash Map</p>
            <h1>Historical crash hotspots</h1>
          </div>
          <button
            className="icon-button filter-panel__close"
            type="button"
            onClick={onClose}
            aria-label="Close filters"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <p className="notice">
          Historical Tasmanian crash data. Use for awareness and planning, not real-time
          navigation.
        </p>

        <div className="summary-strip" aria-live="polite">
          <strong>{filteredCount.toLocaleString("en-AU")}</strong>
          <span>of {crashes.length.toLocaleString("en-AU")} crashes shown</span>
        </div>

        {showViewerLayerControls && viewerLayers && (
          <section className="viewer-layer-controls" aria-label="Viewer map layers">
            <div className="viewer-layer-controls__header">
              <span className="filter-label">Viewer layers</span>
              <span
                className="viewer-layer-tooltip"
                title="Indicative traffic flow based on current road congestion. Particles do not represent tracked vehicles."
                aria-label="Indicative traffic flow based on current road congestion. Particles do not represent tracked vehicles."
              >
                <Info size={15} aria-hidden="true" />
              </span>
            </div>
            <div className="viewer-layer-grid">
              <button
                className={`viewer-layer-toggle ${viewerLayers.crashMarkers ? "is-active" : ""}`}
                type="button"
                aria-pressed={viewerLayers.crashMarkers}
                onClick={() => setViewerLayer("crashMarkers", !viewerLayers.crashMarkers)}
              >
                <Layers size={16} aria-hidden="true" />
                <span>Crash markers</span>
              </button>
              <button
                className={`viewer-layer-toggle ${viewerLayers.heatmap ? "is-active" : ""}`}
                type="button"
                aria-pressed={viewerLayers.heatmap}
                onClick={() => setViewerLayer("heatmap", !viewerLayers.heatmap)}
              >
                <Activity size={16} aria-hidden="true" />
                <span>Heatmap</span>
              </button>
              <button
                className={`viewer-layer-toggle ${
                  viewerLayers.trafficConditions ? "is-active" : ""
                }`}
                type="button"
                aria-pressed={viewerLayers.trafficConditions}
                onClick={() =>
                  setViewerLayer("trafficConditions", !viewerLayers.trafficConditions)
                }
              >
                <Layers size={16} aria-hidden="true" />
                <span>Traffic conditions</span>
              </button>
              <button
                className={`viewer-layer-toggle ${
                  viewerLayers.trafficFlow ? "is-active" : ""
                }`}
                type="button"
                aria-pressed={viewerLayers.trafficFlow}
                onClick={() => setViewerLayer("trafficFlow", !viewerLayers.trafficFlow)}
              >
                <Activity size={16} aria-hidden="true" />
                <span>Traffic Flow</span>
              </button>
            </div>
            <p className="filter-note viewer-layer-note">
              Traffic Flow animates only visible roads and stops when hidden.
            </p>
          </section>
        )}

        {timeline && (
          <section className="timeline-panel" aria-label="Crash timeline controls">
            <div className="timeline-panel__header">
              <div>
                <span className="filter-label">Timeline</span>
                <strong>{formatTimelineDateTime(timeline.playheadTime)}</strong>
              </div>
              <button className="icon-button" type="button" onClick={togglePlayback}>
                {timeline.isPlaying ? (
                  <Pause size={18} aria-hidden="true" />
                ) : (
                  <Play size={18} aria-hidden="true" />
                )}
                <span className="sr-only">
                  {timeline.isPlaying ? "Pause timeline" : "Play timeline"}
                </span>
              </button>
            </div>

            <div className="range-pair">
              <label>
                <span>From {formatTimelineDate(timeline.startTime)}</span>
                <input
                  type="range"
                  min={timeline.minTime}
                  max={timeline.maxTime}
                  step={DAY_MS}
                  value={timeline.startTime}
                  onChange={(event) => setTimelineRangeStart(Number(event.target.value))}
                />
              </label>
              <label>
                <span>To {formatTimelineDate(timeline.endTime)}</span>
                <input
                  type="range"
                  min={timeline.minTime}
                  max={timeline.maxTime}
                  step={DAY_MS}
                  value={timeline.endTime}
                  onChange={(event) => setTimelineRangeEnd(Number(event.target.value))}
                />
              </label>
            </div>

            <label className="playhead-slider">
              <span>Frame</span>
              <input
                type="range"
                min={timeline.startTime}
                max={timeline.endTime}
                step={HOUR_MS}
                value={timeline.playheadTime}
                onChange={(event) => setTimelinePlayhead(Number(event.target.value))}
              />
            </label>

            <p className="timeline-hint">
              Playback advances one calendar day per frame. Speed changes how quickly
              daily frames advance.
            </p>

            <div className="speed-control" role="group" aria-label="Timeline speed">
              {[1, 2, 5, 10].map((speed) => (
                <button
                  key={speed}
                  className={timeline.speed === speed ? "is-active" : ""}
                  type="button"
                  onClick={() => setPlaybackSpeed(speed as TimelineState["speed"])}
                >
                  {speed}x
                </button>
              ))}
            </div>

            {showTimeOfDayControl && (
              <button
                className={`toggle-row ${isTimeOfDayEnabled ? "is-active" : ""}`}
                type="button"
                onClick={onTimeOfDayToggle}
              >
                {isTimeOfDayEnabled ? (
                  <Moon size={18} aria-hidden="true" />
                ) : (
                  <Sun size={18} aria-hidden="true" />
                )}
                <span>Time-of-day map colour</span>
                <strong>{isTimeOfDayEnabled ? "On" : "Off"}</strong>
              </button>
            )}
          </section>
        )}

        {showWeatherControls && (
          <div className="filter-group">
            <span className="filter-label">Weather matching</span>
            <div className="segmented-control" role="group" aria-label="Weather history filter">
              <button
                className={filters.weatherMode === "off" ? "is-active" : ""}
                type="button"
                onClick={() => setFilter("weatherMode", "off")}
              >
                Off
              </button>
              <button
                className={filters.weatherMode === "current" ? "is-active" : ""}
                type="button"
                onClick={() => setFilter("weatherMode", "current")}
              >
                Current
              </button>
              <button
                className={filters.weatherMode === "historical" ? "is-active" : ""}
                type="button"
                onClick={() => setFilter("weatherMode", "historical")}
              >
                Historical beta
              </button>
            </div>
            <p className="filter-note">
              Current condition: {formatConditionLabel(currentConditions, weatherStatus)}
              {weatherStatus === "loading" ? " · updating" : ""}
              {weatherDetailLabel ? ` · ${weatherDetailLabel}` : ""}
            </p>
          </div>
        )}

        {showDeveloperWeatherSimulation && (
          <label className="field">
            <span>Developer weather simulation</span>
            <select
              value={weatherSimulationMode}
              onChange={(event) =>
                onWeatherSimulationChange(event.target.value as WeatherSimulationMode)
              }
            >
              <option value="live">Live weather</option>
              <option value="wet">Simulate wet</option>
              <option value="dry">Simulate dry</option>
              <option value="daylight">Simulate daylight</option>
              <option value="dark">Simulate night</option>
              <option value="failure">Simulate weather failure</option>
              <option value="historyFailure">Simulate archive failure</option>
              <option value="historySlow">Simulate slow archive</option>
            </select>
          </label>
        )}

        <div className="filter-group">
          <span className="filter-label">Severity</span>
          <div className="segmented-control" role="group" aria-label="Severity filter">
            <button
              className={filters.severityMode === "all" ? "is-active" : ""}
              type="button"
              onClick={() => setFilter("severityMode", "all")}
            >
              All
            </button>
            <button
              className={filters.severityMode === "seriousFatal" ? "is-active" : ""}
              type="button"
              onClick={() => setFilter("severityMode", "seriousFatal")}
            >
              Serious + fatal
            </button>
            <button
              className={filters.severityMode === "fatal" ? "is-active" : ""}
              type="button"
              onClick={() => setFilter("severityMode", "fatal")}
            >
              Fatal
            </button>
          </div>
        </div>

        <label className="field">
          <span>Speed zone</span>
          <select
            value={filters.speedZone}
            onChange={(event) => setFilter("speedZone", event.target.value)}
          >
            <option value="all">All speed zones</option>
            {speedZones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Light condition</span>
          <select
            value={filters.lightCondition}
            onChange={(event) => setFilter("lightCondition", event.target.value)}
          >
            <option value="all">All light conditions</option>
            {lightConditions.map((condition) => (
              <option key={condition} value={condition}>
                {condition}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Surface condition</span>
          <select
            value={filters.surfaceType}
            onChange={(event) => setFilter("surfaceType", event.target.value)}
          >
            <option value="all">All surface conditions</option>
            {surfaceTypes.map((surface) => (
              <option key={surface} value={surface}>
                {surface}
              </option>
            ))}
          </select>
        </label>

        <div className="panel-actions">
          <button
            className="button"
            type="button"
            onClick={() => onChange(defaultFilters)}
          >
            Reset filters
          </button>
          <button
            className="button button--primary"
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw size={17} aria-hidden="true" />
            <span>{isRefreshing ? "Refreshing" : "Refresh crash data"}</span>
          </button>
        </div>

        <p className="cache-note">Data updated: {formatFetchedAt(fetchedAt)}</p>
        <Legend />
      </aside>

      {isOpen && (
        <button
          className="sheet-backdrop app-chrome"
          onClick={onClose}
          aria-label="Close filters"
        />
      )}
    </>
  );
}
