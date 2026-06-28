import { CarFront, FlaskConical, OctagonAlert, Pause, Play, Square } from "lucide-react";
import type { DriveLocation, DriveRiskSummary } from "../types/crash";

type DriveModePanelProps = {
  isActive: boolean;
  isSimulation: boolean;
  location: DriveLocation | null;
  risk: DriveRiskSummary | null;
  error: string | null;
  isSimulationDriving: boolean;
  onStart: () => void;
  onStartSimulation: () => void;
  onToggleSimulationDrive: () => void;
  onStop: () => void;
};

const formatSpeed = (speed?: number): string => {
  if (typeof speed !== "number" || !Number.isFinite(speed)) return "--";
  return `${Math.max(0, Math.round(speed * 3.6))} km/h`;
};

const formatDistance = (distance?: number): string => {
  if (typeof distance !== "number" || !Number.isFinite(distance)) return "Not nearby";
  if (distance >= 1000) return `${(distance / 1000).toFixed(1)} km`;
  return `${Math.round(distance)} m`;
};

const formatHeading = (heading?: number): string => {
  if (typeof heading !== "number" || !Number.isFinite(heading)) return "--";
  return `${Math.round(heading)}°`;
};

const formatHeadingSource = (source?: DriveLocation["headingSource"]): string => {
  if (source === "compass") return "Compass";
  if (source === "gps") return "GPS";
  if (source === "movement") return "Movement";
  if (source === "simulated") return "Sim";
  return "Heading";
};

export function DriveModePanel({
  isActive,
  isSimulation,
  location,
  risk,
  error,
  isSimulationDriving,
  onStart,
  onStartSimulation,
  onToggleSimulationDrive,
  onStop,
}: DriveModePanelProps) {
  return (
    <section className={`drive-panel ${isActive ? "drive-panel--active" : ""}`}>
      {!isActive ? (
        <div className="drive-panel__launch">
          <button className="drive-button" type="button" onClick={onStart}>
            <CarFront size={20} aria-hidden="true" />
            <span>Drive Mode</span>
          </button>
          <button className="drive-sim-button" type="button" onClick={onStartSimulation}>
            <FlaskConical size={17} aria-hidden="true" />
            <span>Simulation</span>
          </button>
        </div>
      ) : (
        <>
          {risk?.warningTitle && (
            <div className="drive-warning" role="status" aria-live="polite">
              <OctagonAlert size={18} aria-hidden="true" />
              <div>
                <strong>{risk.warningTitle}</strong>
                <span>
                  {risk.totalCount} nearby, {risk.seriousCount} serious, {risk.fatalCount} fatal.
                  Closest serious/fatal:{" "}
                  {formatDistance(risk.closestSeriousOrFatalMetres)}.
                </span>
              </div>
            </div>
          )}

          <div className="drive-panel__header">
            <div>
              <span>{isSimulation ? "Simulation Drive Mode" : "Drive Mode"}</span>
              <strong>{location ? "Following current position" : "Waiting for location"}</strong>
            </div>
            <button className="stop-drive-button" type="button" onClick={onStop}>
              <Square size={15} aria-hidden="true" />
              <span>Stop</span>
            </button>
          </div>

          <div className="drive-stats" aria-live="polite">
            <div>
              <span>Speed</span>
              <strong>{formatSpeed(location?.speed)}</strong>
            </div>
            <div>
              <span>Zone</span>
              <strong>{risk?.nearbySpeedZone ? `${risk.nearbySpeedZone} km/h` : "--"}</strong>
            </div>
            <div>
              <span>Nearby</span>
              <strong>{risk?.totalCount ?? 0}</strong>
            </div>
            <div>
              <span>Serious</span>
              <strong>{risk?.seriousCount ?? 0}</strong>
            </div>
            <div>
              <span>Fatal</span>
              <strong>{risk?.fatalCount ?? 0}</strong>
            </div>
            <div>
              <span>Property</span>
              <strong>{risk?.propertyDamageCount ?? 0}</strong>
            </div>
            <div>
              <span>{formatHeadingSource(location?.headingSource)}</span>
              <strong>{formatHeading(location?.heading)}</strong>
            </div>
          </div>

          <p className="drive-copy">
            Historical crash data only. Not live navigation or real-time hazard detection.
          </p>

          <p className="drive-copy">
            {location?.headingSource === "compass"
              ? "Phone compass is active for the direction marker."
              : typeof location?.heading === "number"
              ? "Direction marker is aligned to your travel bearing."
              : "Map will align when compass or GPS heading is available."}
          </p>

          {isSimulation && (
            <div className="simulation-controls">
              <button
                className="sim-drive-button"
                type="button"
                onClick={onToggleSimulationDrive}
              >
                {isSimulationDriving ? (
                  <Pause size={16} aria-hidden="true" />
                ) : (
                  <Play size={16} aria-hidden="true" />
                )}
                <span>{isSimulationDriving ? "Pause drive" : "Auto drive"}</span>
              </button>
              <p className="drive-copy">
                Auto drive follows a test route. Click or drag the map to take manual control.
              </p>
            </div>
          )}
        </>
      )}

      {error && <p className="drive-error">{error}</p>}
    </section>
  );
}
