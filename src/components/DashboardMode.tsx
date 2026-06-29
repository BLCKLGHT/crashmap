import { Car, CarFront, FlaskConical, Pause, Play, Square } from "lucide-react";
import type { DashboardLookaheadRisk, DriveLocation, DriveRiskSummary } from "../types/crash";

type DashboardModeProps = {
  isActive: boolean;
  isSimulation: boolean;
  isSimulationDriving: boolean;
  location: DriveLocation | null;
  driveRisk: DriveRiskSummary | null;
  lookaheadRisk: DashboardLookaheadRisk | null;
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

export function DashboardMode({
  isActive,
  isSimulation,
  isSimulationDriving,
  location,
  driveRisk,
  lookaheadRisk,
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
  const hasHeading = lookaheadRisk?.hasHeading ?? false;
  const distanceLabel = getRoadHistoryDistanceLabel(lookaheadRisk);
  const overspeedDelta = getOverspeedDeltaKmh(location?.speed, driveRisk?.nearbySpeedZone);

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
          {overspeedDelta !== null && (
            <em className="dashboard-overspeed">+{overspeedDelta}km/h</em>
          )}
          <small>km/h</small>
        </div>
      </div>

      <div className="dashboard-distance" aria-label={`Recommended space ${carLengths} car lengths`}>
        <div className="dashboard-road-depth" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="dashboard-cars" aria-hidden="true">
          {Array.from({ length: visibleCars }).map((_, index) => (
            <Car key={index} size={28} strokeWidth={2.4} />
          ))}
          {hasMoreCarLengths && <span className="dashboard-cars__plus">+</span>}
        </div>
        <p>Recommended space</p>
        <strong>{carLengths || "--"} car lengths</strong>
      </div>

      <div className="dashboard-history">
        <span>Road history ahead</span>
        <strong>{distanceLabel}</strong>
        <h2>{hasHeading ? lookaheadRisk?.label ?? "Low crash history ahead" : "Waiting for heading"}</h2>
        <p>{hasHeading ? lookaheadRisk?.message : "Move forward or use simulation to assess the road ahead."}</p>
        <div className="dashboard-history__stats">
          <div>
            <span>Crashes</span>
            <strong>{lookaheadRisk?.totalCrashCount ?? 0}</strong>
          </div>
          <div>
            <span>Serious</span>
            <strong>{lookaheadRisk?.seriousCount ?? 0}</strong>
          </div>
          <div>
            <span>Fatal</span>
            <strong>{lookaheadRisk?.fatalCount ?? 0}</strong>
          </div>
        </div>
        <small>Historical crash data only. Not live navigation or real-time hazard detection.</small>
        {error && <small className="dashboard-error">{error}</small>}
      </div>
    </section>
  );
}
