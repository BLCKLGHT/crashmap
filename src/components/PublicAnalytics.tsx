import type { CrashRecord } from "../types/crash";

type PublicAnalyticsProps = {
  crashes: CrashRecord[];
  totalCrashes: number;
};

type SeriesPoint = {
  label: string;
  value: number;
};

type CategoryPoint = {
  label: string;
  value: number;
  tone?: "fatal" | "serious" | "other";
};

const normalise = (value?: string): string => value?.trim().toLowerCase() ?? "";

const getCrashTime = (crash: CrashRecord): number | null => {
  if (!crash.dateTime) return null;
  const numericValue = Number(crash.dateTime);
  const time = Number.isFinite(numericValue)
    ? numericValue
    : new Date(crash.dateTime).getTime();
  return Number.isFinite(time) ? time : null;
};

const isFatalCrash = (crash: CrashRecord): boolean => normalise(crash.severity).includes("fatal");

const isSeriousOnlyCrash = (crash: CrashRecord): boolean => {
  const severity = normalise(crash.severity);
  return severity.includes("serious") && !severity.includes("fatal");
};

const isPropertyDamageCrash = (crash: CrashRecord): boolean =>
  normalise(crash.severity).includes("property");

const formatNumber = (value: number): string => value.toLocaleString("en-AU");

const getPercent = (value: number, total: number): string =>
  total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";

const getYearSeries = (crashes: CrashRecord[]): SeriesPoint[] => {
  const counts = new Map<number, number>();
  for (const crash of crashes) {
    const time = getCrashTime(crash);
    if (time === null) continue;
    const year = new Date(time).getFullYear();
    counts.set(year, (counts.get(year) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort(([a], [b]) => a - b)
    .map(([year, value]) => ({ label: String(year), value }));
};

const getHourSeries = (crashes: CrashRecord[]): SeriesPoint[] => {
  const counts = Array.from({ length: 24 }, (_, hour) => ({ label: String(hour), value: 0 }));
  for (const crash of crashes) {
    const time = getCrashTime(crash);
    if (time === null) continue;
    counts[new Date(time).getHours()].value += 1;
  }
  return counts;
};

const getTopCategories = (
  crashes: CrashRecord[],
  getter: (crash: CrashRecord) => string | undefined,
  fallback: string,
  limit = 6,
): CategoryPoint[] => {
  const counts = new Map<string, number>();
  for (const crash of crashes) {
    const label = getter(crash)?.trim() || fallback;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
};

const getPeak = (points: SeriesPoint[]): SeriesPoint | null => {
  if (!points.length) return null;
  return points.reduce((peak, point) => (point.value > peak.value ? point : peak), points[0]);
};

const BarChart = ({ points, label }: { points: SeriesPoint[]; label: string }) => {
  const max = Math.max(...points.map((point) => point.value), 1);

  return (
    <div className="analytics-bars" aria-label={label}>
      {points.map((point) => (
        <div className="analytics-bars__item" key={point.label}>
          <span>{point.label}</span>
          <i style={{ height: `${Math.max(4, (point.value / max) * 100)}%` }} />
          <strong>{formatNumber(point.value)}</strong>
        </div>
      ))}
    </div>
  );
};

const LineChart = ({ points, label }: { points: SeriesPoint[]; label: string }) => {
  const max = Math.max(...points.map((point) => point.value), 1);
  const width = 720;
  const height = 210;
  const padding = 22;
  const path = points
    .map((point, index) => {
      const x =
        points.length <= 1
          ? width / 2
          : padding + (index / (points.length - 1)) * (width - padding * 2);
      const y = height - padding - (point.value / max) * (height - padding * 2);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg className="analytics-line" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <path d={path} />
      {points.map((point, index) => {
        const x =
          points.length <= 1
            ? width / 2
            : padding + (index / (points.length - 1)) * (width - padding * 2);
        const y = height - padding - (point.value / max) * (height - padding * 2);
        return <circle key={point.label} cx={x} cy={y} r="3.8" />;
      })}
    </svg>
  );
};

const CategoryBars = ({ points }: { points: CategoryPoint[] }) => {
  const max = Math.max(...points.map((point) => point.value), 1);

  return (
    <div className="analytics-category-bars">
      {points.map((point) => (
        <div className={`analytics-category-bars__row ${point.tone ? `is-${point.tone}` : ""}`} key={point.label}>
          <span>{point.label}</span>
          <i>
            <b style={{ width: `${Math.max(2, (point.value / max) * 100)}%` }} />
          </i>
          <strong>{formatNumber(point.value)}</strong>
        </div>
      ))}
    </div>
  );
};

export function PublicAnalytics({ crashes, totalCrashes }: PublicAnalyticsProps) {
  const fatalCount = crashes.filter(isFatalCrash).length;
  const seriousCount = crashes.filter(isSeriousOnlyCrash).length;
  const propertyCount = crashes.filter(isPropertyDamageCrash).length;
  const yearSeries = getYearSeries(crashes);
  const hourSeries = getHourSeries(crashes);
  const peakYear = getPeak(yearSeries);
  const peakHour = getPeak(hourSeries);
  const severityPoints: CategoryPoint[] = [
    { label: "Fatal", value: fatalCount, tone: "fatal" },
    { label: "Serious", value: seriousCount, tone: "serious" },
    { label: "Property damage", value: propertyCount, tone: "other" },
    {
      label: "Other / unspecified",
      value: Math.max(0, crashes.length - fatalCount - seriousCount - propertyCount),
      tone: "other",
    },
  ];
  const surfacePoints = getTopCategories(crashes, (crash) => crash.surfaceType, "Unknown surface");
  const lightPoints = getTopCategories(crashes, (crash) => crash.lightCondition, "Unknown light");
  const speedZonePoints = getTopCategories(crashes, (crash) => crash.speedZone, "Unknown speed zone");
  const topSurface = surfacePoints[0];
  const topLight = lightPoints[0];

  return (
    <section className="public-analytics" aria-label="Crash data analytics">
      <div className="public-analytics__intro">
        <p className="eyebrow">Crash analytics</p>
        <h1>Road history, in plain English</h1>
        <p>
          These charts summarise the currently selected public crash records. Use the
          filter panel to narrow the story by severity, surface, light, speed zone, and time.
        </p>
      </div>

      <div className="analytics-metrics" aria-label="Summary metrics">
        <article>
          <span>Shown records</span>
          <strong>{formatNumber(crashes.length)}</strong>
          <em>{getPercent(crashes.length, totalCrashes)} of loaded data</em>
        </article>
        <article>
          <span>Fatal records</span>
          <strong>{formatNumber(fatalCount)}</strong>
          <em>{getPercent(fatalCount, crashes.length)} of selected records</em>
        </article>
        <article>
          <span>Serious records</span>
          <strong>{formatNumber(seriousCount)}</strong>
          <em>{getPercent(seriousCount, crashes.length)} of selected records</em>
        </article>
        <article>
          <span>Property damage</span>
          <strong>{formatNumber(propertyCount)}</strong>
          <em>{getPercent(propertyCount, crashes.length)} of selected records</em>
        </article>
      </div>

      <div className="analytics-grid">
        <article className="analytics-panel analytics-panel--wide">
          <div>
            <span className="filter-label">Time series</span>
            <h2>Crashes by year</h2>
            <p>
              {peakYear
                ? `${peakYear.label} has the highest selected count with ${formatNumber(peakYear.value)} records.`
                : "No dated records are available for this selection."}
            </p>
          </div>
          <LineChart points={yearSeries} label="Crashes by year" />
        </article>

        <article className="analytics-panel">
          <div>
            <span className="filter-label">Severity</span>
            <h2>Outcome mix</h2>
          </div>
          <CategoryBars points={severityPoints} />
        </article>

        <article className="analytics-panel">
          <div>
            <span className="filter-label">Time of day</span>
            <h2>Crash records by hour</h2>
            <p>
              {peakHour
                ? `The busiest selected hour starts at ${peakHour.label}:00.`
                : "No hourly pattern is available."}
            </p>
          </div>
          <BarChart points={hourSeries} label="Crashes by hour of day" />
        </article>

        <article className="analytics-panel">
          <div>
            <span className="filter-label">Road surface</span>
            <h2>Surface conditions</h2>
            <p>
              {topSurface
                ? `${topSurface.label} appears most often in the selected records.`
                : "No surface data is available."}
            </p>
          </div>
          <CategoryBars points={surfacePoints} />
        </article>

        <article className="analytics-panel">
          <div>
            <span className="filter-label">Light</span>
            <h2>Lighting conditions</h2>
            <p>
              {topLight
                ? `${topLight.label} is the most common selected light condition.`
                : "No light data is available."}
            </p>
          </div>
          <CategoryBars points={lightPoints} />
        </article>

        <article className="analytics-panel analytics-panel--wide">
          <div>
            <span className="filter-label">Speed zones</span>
            <h2>Where records cluster by posted speed</h2>
            <p>
              This does not mean a speed zone is automatically unsafe. It shows where
              historical records are concentrated in the selected data.
            </p>
          </div>
          <CategoryBars points={speedZonePoints} />
        </article>
      </div>
    </section>
  );
}
