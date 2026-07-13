import { useEffect, useRef, useState } from "react";
import {
  Car,
  CarFront,
  Cloud,
  CloudRain,
  FlaskConical,
  Pause,
  Play,
  Square,
  Wind,
} from "lucide-react";
import type {
  CurrentDrivingConditions,
  CurrentWeather,
  DashboardDrivingState,
  DashboardLookaheadRisk,
  DriveLocation,
  DriveRiskSummary,
  WeatherState,
} from "../types/crash";
import { DashboardMapboxMap } from "./DashboardMapboxMap";

type DashboardModeProps = {
  isActive: boolean;
  isSimulation: boolean;
  isSimulationDriving: boolean;
  location: DriveLocation | null;
  driveRisk: DriveRiskSummary | null;
  speedLimitLabel: string;
  lookaheadRisk: DashboardLookaheadRisk | null;
  drivingState: DashboardDrivingState;
  currentConditions: CurrentDrivingConditions | null;
  currentWeather: CurrentWeather | null;
  weatherStatus: WeatherState["status"];
  error: string | null;
  onStartDrive: () => void;
  onStartSimulation: () => void;
  onToggleSimulationDrive: () => void;
  onStopDrive: () => void;
  onMapboxSpeedLimitChange: (speedLimitKmh: number | null) => void;
};

const CAR_LENGTH_METRES = 5;
const REACTION_TIME_SECONDS = 1.5;
const TRANSIENT_WARNING_DISPLAY_MS = 2400;

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

const getSteppedWarningDistance = (distanceMetres: number, maxDistanceMetres: number): number => {
  const clampedDistance = Math.max(10, Math.min(maxDistanceMetres, distanceMetres));
  const step = clampedDistance > 200 ? 100 : clampedDistance > 100 ? 20 : 10;
  return Math.max(10, Math.ceil(clampedDistance / step) * step);
};

const getRoadHistoryDistanceParts = (
  lookaheadRisk: DashboardLookaheadRisk | null,
): { prefix: string; value: string; unit: string } => {
  if (!lookaheadRisk || !lookaheadRisk.hasHeading || lookaheadRisk.riskLevel === "low") {
    return {
      prefix: "In next",
      value: String(lookaheadRisk?.lookaheadDistanceMetres ?? 500),
      unit: "m",
    };
  }

  if (typeof lookaheadRisk.nearestCrashDistanceMetres !== "number") {
    return { prefix: "In next", value: String(lookaheadRisk.lookaheadDistanceMetres), unit: "m" };
  }

  const roundedDistance = getSteppedWarningDistance(
    lookaheadRisk.nearestCrashDistanceMetres,
    lookaheadRisk.lookaheadDistanceMetres,
  );
  return { prefix: "In", value: String(roundedDistance), unit: "m" };
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

const renderDistanceDigits = (value: string) =>
  value.split("").map((character, index) => {
    const positionFromRight = value.length - index - 1;
    return (
      <i
        className="dashboard-odometer-digit"
        key={`${positionFromRight}-${character}`}
      >
        {character}
      </i>
    );
  });

export function DashboardMode({
  isActive,
  isSimulation,
  isSimulationDriving,
  location,
  driveRisk,
  speedLimitLabel,
  lookaheadRisk,
  drivingState,
  currentConditions,
  currentWeather,
  weatherStatus,
  error,
  onStartDrive,
  onStartSimulation,
  onToggleSimulationDrive,
  onStopDrive,
  onMapboxSpeedLimitChange,
}: DashboardModeProps) {
  const speedZone = formatSpeedZone(speedLimitLabel);
  const carLengths = drivingState.recommendedCarLengths;
  const visibleCars = getVisibleCarCount(carLengths);
  const hasMoreCarLengths = carLengths > 10;
  const risk = lookaheadRisk?.riskLevel ?? "low";
  const hasUpcomingWarning =
    isActive &&
    Boolean(lookaheadRisk?.hasHeading) &&
    risk !== "low" &&
    typeof lookaheadRisk?.nearestCrashDistanceMetres === "number" &&
    lookaheadRisk.nearestCrashDistanceMetres <= 500;
  const distanceParts = getRoadHistoryDistanceParts(lookaheadRisk);
  const steppedDistance = Number(distanceParts.value);
  const isCloseWarning = hasUpcomingWarning && Number.isFinite(steppedDistance) && steppedDistance <= 100;
  const [isTransientWarningVisible, setIsTransientWarningVisible] = useState(false);
  const transientTimeoutRef = useRef<number | null>(null);
  const distanceLabel = `${distanceParts.prefix} ${distanceParts.value} ${distanceParts.unit}`;
  const historyHeadline = getRoadHistoryHeadline(lookaheadRisk, currentConditions);
  const overspeedDelta = getOverspeedDeltaKmh(location?.speed, speedZone);
  const shouldShowWarning = hasUpcomingWarning && (isCloseWarning || isTransientWarningVisible);
  const warningStepKey = hasUpcomingWarning ? `${risk}:${distanceParts.value}` : "none";
  const conditionIndicators = (
    <>
      <span title={currentConditions?.weatherLabel ?? "Weather unavailable"}>
        {currentConditions?.isRaining ? (
          <CloudRain size={26} aria-hidden="true" />
        ) : (
          <Cloud size={26} aria-hidden="true" />
        )}
        {typeof currentWeather?.temperature === "number" && (
          <b>{Math.round(currentWeather.temperature)}°</b>
        )}
      </span>
      {typeof currentWeather?.windSpeed === "number" && (
        <span title={`Wind ${Math.round(currentWeather.windSpeed)} kilometres per hour`}>
          <Wind size={26} aria-hidden="true" />
          <b>{Math.round(currentWeather.windSpeed)}</b>
        </span>
      )}
    </>
  );

  useEffect(() => {
    if (transientTimeoutRef.current !== null) {
      window.clearTimeout(transientTimeoutRef.current);
      transientTimeoutRef.current = null;
    }

    if (!hasUpcomingWarning || isCloseWarning) {
      setIsTransientWarningVisible(false);
      return;
    }

    setIsTransientWarningVisible(true);
    transientTimeoutRef.current = window.setTimeout(() => {
      setIsTransientWarningVisible(false);
      transientTimeoutRef.current = null;
    }, TRANSIENT_WARNING_DISPLAY_MS);

    return () => {
      if (transientTimeoutRef.current !== null) {
        window.clearTimeout(transientTimeoutRef.current);
        transientTimeoutRef.current = null;
      }
    };
  }, [hasUpcomingWarning, isCloseWarning, warningStepKey]);

  return (
    <section className={`dashboard-mode dashboard-mode--${risk}`}>
      {!isActive && (
        <div className="dashboard-mode__controls" aria-label="Dashboard mode controls">
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
        </div>
      )}

      <div className="dashboard-mode__top">
        <div className="dashboard-speed-sign" aria-label={`Speed zone ${speedZone}`}>
          {speedZone}
        </div>
        <div className="dashboard-speed-readout">
          <span>Current</span>
          <strong>{formatSpeedKmh(location?.speed)}</strong>
          <small>km/h</small>
        </div>
      </div>

      <div
        className={`dashboard-overspeed ${overspeedDelta !== null ? "is-visible" : ""}`}
        role="status"
        aria-live="polite"
      >
        <span>Over limit</span>
        <strong>{overspeedDelta !== null ? `+${overspeedDelta}` : ""}</strong>
        <small>km/h</small>
      </div>

      <div
        className="dashboard-distance"
        aria-label={`Recommended space ${carLengths} car lengths`}
      >
        <strong className="dashboard-distance__number">{carLengths || "--"}</strong>
        <span className="dashboard-distance__unit">car lengths</span>
        <p>recommended space at current speed</p>
        <div className="dashboard-cars" aria-hidden="true">
          {Array.from({ length: visibleCars }).map((_, index) => (
            <Car key={index} size={44} strokeWidth={2.35} />
          ))}
          {hasMoreCarLengths && <span className="dashboard-cars__plus">+</span>}
        </div>
      </div>

      <div className={`dashboard-history ${shouldShowWarning ? "" : "dashboard-history--empty"}`}>
        <div
          className="dashboard-history__map is-visible"
          aria-hidden="true"
        >
          <DashboardMapboxMap
            location={location}
            drivingState={drivingState}
            isActive={isActive}
            onSpeedLimitChange={onMapboxSpeedLimitChange}
          />
        </div>
        <div className="dashboard-history__conditions dashboard-history__conditions--persistent" aria-label="Current driving conditions">
          {conditionIndicators}
        </div>
        <div
          className={`dashboard-history__warning ${
            shouldShowWarning ? "is-visible" : ""
          }`}
          aria-hidden={!shouldShowWarning}
        >
            <span>Road history ahead</span>
            <div className="dashboard-history__distance-row">
              <strong className="dashboard-history__distance" aria-label={distanceLabel}>
                <span>{distanceParts.prefix}</span>
                <b>
                  {renderDistanceDigits(distanceParts.value)}
                </b>
                <em>{distanceParts.unit}</em>
              </strong>
            </div>
            <h2>{historyHeadline}</h2>
        </div>
        {isActive && (
          <div className="dashboard-history__controls" aria-label="Dashboard driving controls">
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
          </div>
        )}
        {error && <small className="dashboard-error">{error}</small>}
      </div>
    </section>
  );
}
