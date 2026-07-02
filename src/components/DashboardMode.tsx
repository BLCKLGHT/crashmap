import type { CSSProperties } from "react";
import { Car, CarFront, FlaskConical, Pause, Play, Square } from "lucide-react";
import type {
  CurrentDrivingConditions,
  CurrentWeather,
  DashboardLookaheadRisk,
  DriveLocation,
  DriveRiskSummary,
  HistoricalWeatherMatchState,
  WeatherState,
} from "../types/crash";

type DashboardModeProps = {
  isActive: boolean;
  isSimulation: boolean;
  isSimulationDriving: boolean;
  location: DriveLocation | null;
  driveRisk: DriveRiskSummary | null;
  lookaheadRisk: DashboardLookaheadRisk | null;
  currentConditions: CurrentDrivingConditions | null;
  currentWeather: CurrentWeather | null;
  weatherStatus: WeatherState["status"];
  weatherMatchStatus: HistoricalWeatherMatchState["status"];
  error: string | null;
  onStartDrive: () => void;
  onStartSimulation: () => void;
  onToggleSimulationDrive: () => void;
  onStopDrive: () => void;
};

const CAR_LENGTH_METRES = 5;
const REACTION_TIME_SECONDS = 1.5;

const formatSpeedKmh = (speedMetresPerSecond?: number): string => {
  if (typeof speedMetresPerSecond !== "number" || !Number.isFinite(speedMetresPerSecond)) {
    return "--";
  }

  return String(Math.round(Math.max(0, speedMetresPerSecond * 3.6)));
};

const formatSpeedZone = (speedZone?: string): string => speedZone || "--";

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

const getReactionDistanceMetres = (speedMetresPerSecond?: number): number | null => {
  if (typeof speedMetresPerSecond !== "number" || !Number.isFinite(speedMetresPerSecond)) {
    return null;
  }

  const speed = Math.max(0, speedMetresPerSecond);
  // Awareness-only visual cue assumptions:
  // - reaction distance only, not full stopping distance;
  // - 1.5s default reaction time;
  // - 5m assumed vehicle length for the car-length visual.
  return speed * REACTION_TIME_SECONDS;
};

const getCarLengths = (speedMetresPerSecond?: number): number => {
  const reactionDistance = getReactionDistanceMetres(speedMetresPerSecond);
  if (reactionDistance === null || reactionDistance <= 0) return 0;
  return Math.max(1, Math.round(reactionDistance / CAR_LENGTH_METRES));
};

const getVisibleCarCount = (carLengths: number): number => Math.min(carLengths, 10);

const getSpeedKmhNumber = (speedMetresPerSecond?: number): number => {
  if (typeof speedMetresPerSecond !== "number" || !Number.isFinite(speedMetresPerSecond)) return 0;
  return Math.max(0, speedMetresPerSecond * 3.6);
};

const getRoadFlowDurationSeconds = (speedMetresPerSecond?: number): number => {
  const speedKmh = getSpeedKmhNumber(speedMetresPerSecond);
  if (speedKmh <= 1) return 7.8;
  if (speedKmh >= 110) return 1.15;
  return 7.8 - (speedKmh / 110) * 6.65;
};

const getRoadFlowIntensity = (speedMetresPerSecond?: number): number => {
  const speedKmh = getSpeedKmhNumber(speedMetresPerSecond);
  return Math.min(1, Math.max(0.24, speedKmh / 100));
};

const getRoadHistoryDistanceLabel = (lookaheadRisk: DashboardLookaheadRisk | null): string => {
  if (!lookaheadRisk || !lookaheadRisk.hasHeading || lookaheadRisk.riskLevel === "low") {
    return `In next ${lookaheadRisk?.lookaheadDistanceMetres ?? 500} m`;
  }

  if (typeof lookaheadRisk.nearestCrashDistanceMetres !== "number") {
    return `In next ${lookaheadRisk.lookaheadDistanceMetres} m`;
  }

  const roundedDistance = Math.max(
    10,
    Math.min(
      lookaheadRisk.lookaheadDistanceMetres,
      Math.ceil(lookaheadRisk.nearestCrashDistanceMetres / 10) * 10,
    ),
  );
  return `In ${roundedDistance} m`;
};

const getConditionLabel = (
  conditions: CurrentDrivingConditions | null,
  status: WeatherState["status"],
): string => {
  if (!conditions) {
    if (status === "error") return "Weather unavailable";
    if (status === "loading" || status === "idle") return "checking weather";
    return "Weather unavailable";
  }
  const surface =
    conditions.surfaceCondition === "wet"
      ? "wet road"
      : conditions.surfaceCondition === "dry"
        ? "dry road"
        : "road unknown";
  const light = conditions.lightCondition.replace("_", "/");
  return `${status === "error" ? "estimated " : ""}${surface}, ${light}`;
};

const getWeatherDetailLabel = (
  weather: CurrentWeather | null,
  conditions: CurrentDrivingConditions | null,
  status: WeatherState["status"],
): string => {
  if (!weather) {
    if (status === "simulated") return `Simulated weather: ${conditions?.weatherLabel ?? "active"}`;
    if (status === "loading" || status === "idle") return "";
    if (status === "error") return "Weather unavailable, using time-of-day estimate";
    return "Weather: waiting for location";
  }

  const parts = [
    typeof weather.temperature === "number" ? `${Math.round(weather.temperature)}°C` : null,
    conditions?.weatherLabel,
    typeof weather.windSpeed === "number" ? `wind ${Math.round(weather.windSpeed)} km/h` : null,
  ].filter(Boolean);

  return parts.length ? parts.join(", ") : "Current weather loaded";
};

const getRoadHistoryHeadline = (
  lookaheadRisk: DashboardLookaheadRisk | null,
  currentConditions: CurrentDrivingConditions | null,
): string => {
  if (!lookaheadRisk?.hasHeading) return "Waiting for movement";
  if (lookaheadRisk.riskLevel === "low") return "No elevated history ahead";
  if (currentConditions?.surfaceCondition === "wet" && lookaheadRisk.matchedCrashCount > 0) {
    return "Wet-road crash history";
  }
  if (lookaheadRisk.fatalCount > 0) return "Fatal record ahead";
  if (lookaheadRisk.riskLevel === "high") return "High crash history";
  return lookaheadRisk.matchedCrashCount > 0
    ? "Similar-condition history"
    : "Medium crash history";
};

const getWeatherMatchLabel = (
  status: HistoricalWeatherMatchState["status"],
  lookaheadRisk: DashboardLookaheadRisk | null,
): string => {
  if (status === "off") return "Weather match: off";
  if (status === "checking") return "Weather match: checking";
  if (status === "error") return "Historical weather unavailable";
  if (status === "limited") return "Weather match: limited data";
  if ((lookaheadRisk?.matchedCrashCount ?? 0) > 0) {
    if ((lookaheadRisk?.wetCrashCount ?? 0) > 0) return "Weather match: wet-history match";
    return "Weather match: similar conditions";
  }
  return "Weather match: no strong match";
};

export function DashboardMode({
  isActive,
  isSimulation,
  isSimulationDriving,
  location,
  driveRisk,
  lookaheadRisk,
  currentConditions,
  currentWeather,
  weatherStatus,
  weatherMatchStatus,
  error,
  onStartDrive,
  onStartSimulation,
  onToggleSimulationDrive,
  onStopDrive,
}: DashboardModeProps) {
  const speedZone = formatSpeedZone(driveRisk?.nearbySpeedZone);
  const carLengths = getCarLengths(location?.speed);
  const visibleCars = getVisibleCarCount(carLengths);
  const hasMoreCarLengths = carLengths > 10;
  const risk = lookaheadRisk?.riskLevel ?? "low";
  const distanceLabel = getRoadHistoryDistanceLabel(lookaheadRisk);
  const historyHeadline = getRoadHistoryHeadline(lookaheadRisk, currentConditions);
  const conditionLabel = getConditionLabel(currentConditions, weatherStatus);
  const weatherDetailLabel = getWeatherDetailLabel(currentWeather, currentConditions, weatherStatus);
  const hasConditionData = lookaheadRisk?.conditionDataAvailable ?? false;
  const matchedCrashCount = lookaheadRisk?.matchedCrashCount ?? 0;
  const showMatchedStats = currentConditions !== null && hasConditionData;
  const weatherMatchLabel = getWeatherMatchLabel(weatherMatchStatus, lookaheadRisk);
  const overspeedDelta = getOverspeedDeltaKmh(location?.speed, driveRisk?.nearbySpeedZone);
  const roadFlowStyle = {
    "--road-flow-duration": `${getRoadFlowDurationSeconds(location?.speed).toFixed(2)}s`,
    "--road-flow-opacity": (0.42 + getRoadFlowIntensity(location?.speed) * 0.36).toFixed(2),
    "--road-lane-opacity": (0.35 + getRoadFlowIntensity(location?.speed) * 0.34).toFixed(2),
    "--road-dark-opacity": (0.34 + getRoadFlowIntensity(location?.speed) * 0.3).toFixed(2),
  } as CSSProperties;
  const isWetRoad = currentConditions?.surfaceCondition === "wet";
  const isRaining =
    currentConditions?.isRaining ||
    (typeof currentWeather?.precipitation === "number" && currentWeather.precipitation > 0) ||
    (typeof currentWeather?.rain === "number" && currentWeather.rain > 0) ||
    (typeof currentWeather?.showers === "number" && currentWeather.showers > 0);
  const isDarkRoad = currentConditions?.lightCondition === "dark";
  const skyClass =
    currentConditions?.lightCondition === "dark"
      ? "dashboard-distance--sky-night"
      : currentConditions?.lightCondition === "dawn_dusk"
        ? "dashboard-distance--sky-dusk"
        : isWetRoad || isRaining
          ? "dashboard-distance--sky-rain"
          : "dashboard-distance--sky-day";

  return (
    <section className={`dashboard-mode dashboard-mode--${risk}`}>
      <div className="dashboard-mode__controls" aria-label="Dashboard mode controls">
        {!isActive ? (
          <>
            <button type="button" onClick={onStartDrive}>
              <CarFront size={18} aria-hidden="true" />
              <span>Start</span>
            </button>
            <button type="button" onClick={onStartSimulation}>
              <FlaskConical size={17} aria-hidden="true" />
              <span>Sim</span>
            </button>
          </>
        ) : (
          <>
            {isSimulation && (
              <button type="button" onClick={onToggleSimulationDrive}>
                {isSimulationDriving ? (
                  <Pause size={17} aria-hidden="true" />
                ) : (
                  <Play size={17} aria-hidden="true" />
                )}
                <span>{isSimulationDriving ? "Pause" : "Auto"}</span>
              </button>
            )}
            <button type="button" onClick={onStopDrive}>
              <Square size={15} aria-hidden="true" />
              <span>Stop</span>
            </button>
          </>
        )}
      </div>

      <div className="dashboard-mode__top">
        <div className="dashboard-speed-sign" aria-label={`Speed zone ${speedZone}`}>
          {speedZone}
        </div>
        <div className="dashboard-speed-readout">
          <span>Current</span>
          <strong>{formatSpeedKmh(location?.speed)}</strong>
          <small>km/h</small>
          <em className={`dashboard-overspeed ${overspeedDelta !== null ? "is-visible" : ""}`}>
            {overspeedDelta !== null ? `+${overspeedDelta}km/h` : "+0km/h"}
          </em>
        </div>
      </div>

      <div
        className={`dashboard-distance ${skyClass} ${isWetRoad ? "dashboard-distance--wet" : ""} ${
          isDarkRoad ? "dashboard-distance--dark" : ""
        } ${isRaining ? "dashboard-distance--rain" : ""}`}
        style={roadFlowStyle}
        aria-label={`Recommended space ${carLengths} car lengths`}
      >
        <div className="dashboard-road-motion" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="dashboard-cars" aria-hidden="true">
          {Array.from({ length: visibleCars }).map((_, index) => (
            <Car key={index} size={44} strokeWidth={2.35} />
          ))}
          {hasMoreCarLengths && <span className="dashboard-cars__plus">+</span>}
        </div>
        <p>Recommended space</p>
        <strong>{carLengths || "--"} car lengths</strong>
      </div>

      <div className="dashboard-history">
        <span>Road history ahead</span>
        <strong>{distanceLabel}</strong>
        <p className="dashboard-history__condition">{weatherMatchLabel}</p>
        <p className="dashboard-history__condition">Current condition: {conditionLabel}</p>
        {weatherDetailLabel && <p className="dashboard-history__condition">{weatherDetailLabel}</p>}
        <h2>{historyHeadline}</h2>
        <div className="dashboard-history__stats">
          <div>
            <span>{showMatchedStats ? "Matched" : "Crashes"}</span>
            <strong>{showMatchedStats ? matchedCrashCount : lookaheadRisk?.totalCrashCount ?? 0}</strong>
          </div>
          <div>
            <span>Serious</span>
            <strong>
              {showMatchedStats
                ? lookaheadRisk?.matchedSeriousCount ?? 0
                : lookaheadRisk?.seriousCount ?? 0}
            </strong>
          </div>
          <div>
            <span>Fatal</span>
            <strong>
              {showMatchedStats
                ? lookaheadRisk?.matchedFatalCount ?? 0
                : lookaheadRisk?.fatalCount ?? 0}
            </strong>
          </div>
        </div>
        {!hasConditionData && currentConditions && (
          <small>Limited weather-condition data available.</small>
        )}
        {weatherStatus === "error" && <small>Weather unavailable. Showing all crash history.</small>}
        <small>Historical crash data only. Weather matching is approximate.</small>
        {error && <small className="dashboard-error">{error}</small>}
      </div>
    </section>
  );
}
