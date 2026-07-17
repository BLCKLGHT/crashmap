import type { ReactNode } from "react";
import {
  AlertTriangle,
  BarChart3,
  Clock3,
  Gauge,
  Layers,
  Lightbulb,
  MapPinned,
  ShieldAlert,
  TrendingUp,
} from "lucide-react";
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

const isUnknownLabel = (value?: string): boolean => {
  const label = normalise(value);
  return (
    !label ||
    label === "unknown" ||
    label.includes("unknown") ||
    label === "not known" ||
    label.includes("not known") ||
    label === "not supplied" ||
    label === "not stated" ||
    label === "unspecified"
  );
};

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

const formatCompactNumber = (value: number): string =>
  new Intl.NumberFormat("en-AU", {
    notation: "compact",
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value);

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
  limit = 6,
): CategoryPoint[] => {
  const counts = new Map<string, number>();
  for (const crash of crashes) {
    const rawLabel = getter(crash)?.trim();
    if (isUnknownLabel(rawLabel)) continue;
    const label = rawLabel as string;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
};

const formatSpeedZoneLabel = (value?: string): string | undefined => {
  if (isUnknownLabel(value)) return undefined;

  const rawLabel = value?.trim();
  const numericMatch = rawLabel?.match(/\d+/);
  if (!numericMatch) return rawLabel;

  const speed = Number(numericMatch[0]);
  return Number.isFinite(speed) ? `${speed} km/h` : rawLabel;
};

const getSpeedZoneNumber = (value?: string): number | null => {
  if (isUnknownLabel(value)) return null;
  const numericMatch = value?.match(/\d+/);
  if (!numericMatch) return null;
  const speed = Number(numericMatch[0]);
  return Number.isFinite(speed) ? speed : null;
};

const classifyRoadSetting = (crash: CrashRecord): string => {
  const location = normalise(crash.locationDescription);
  const speedZone = getSpeedZoneNumber(crash.speedZone);

  if (
    /\b(intersection|junction|roundabout|crossing|traffic lights|traffic signal|signalised|give way)\b/.test(
      location,
    ) ||
    /\b(cnr|corner of|intersect|round about)\b/.test(location)
  ) {
    return "Intersections and junctions";
  }

  if (/\b(highway|hwy|motorway|freeway|expressway)\b/.test(location)) {
    return "Highways";
  }

  if ((speedZone ?? 0) >= 80) {
    return "Rural and open roads";
  }

  if (/\b(street|st|avenue|ave|drive|dr|crescent|cres|court|ct|lane|ln|road|rd)\b/.test(location)) {
    return "Local streets";
  }

  return "Other road settings";
};

const getPeak = (points: SeriesPoint[]): SeriesPoint | null => {
  if (!points.length) return null;
  return points.reduce((peak, point) => (point.value > peak.value ? point : peak), points[0]);
};

const BarChart = ({
  points,
  label,
  xAxisLabel,
}: {
  points: SeriesPoint[];
  label: string;
  xAxisLabel: string;
}) => {
  const max = Math.max(...points.map((point) => point.value), 1);
  const mid = Math.round(max / 2);

  return (
    <div className="analytics-chart" aria-label={label}>
      <div className="analytics-chart__y-axis" aria-hidden="true">
        <span>{formatCompactNumber(max)}</span>
        <span>{formatCompactNumber(mid)}</span>
        <span>0</span>
      </div>
      <div className="analytics-bars">
        {points.map((point) => (
          <div className="analytics-bars__item" key={point.label}>
            <i style={{ height: `${Math.max(4, (point.value / max) * 100)}%` }} />
            <span>{point.label}</span>
          </div>
        ))}
        <strong className="analytics-chart__x-axis">{xAxisLabel}</strong>
      </div>
    </div>
  );
};

const LineChart = ({
  points,
  label,
  xAxisLabel,
}: {
  points: SeriesPoint[];
  label: string;
  xAxisLabel: string;
}) => {
  const max = Math.max(...points.map((point) => point.value), 1);
  const width = 720;
  const height = 250;
  const paddingTop = 18;
  const paddingRight = 18;
  const paddingBottom = 48;
  const paddingLeft = 66;
  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;
  const yTicks = [max, Math.round(max / 2), 0];
  const xTickEvery = Math.max(1, Math.ceil(points.length / 6));
  const path = points
    .map((point, index) => {
      const x =
        points.length <= 1
          ? width / 2
          : paddingLeft + (index / (points.length - 1)) * chartWidth;
      const y = paddingTop + chartHeight - (point.value / max) * chartHeight;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg className="analytics-line" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      {yTicks.map((tick) => {
        const y = paddingTop + chartHeight - (tick / max) * chartHeight;
        return (
          <g className="analytics-line__axis" key={tick} aria-hidden="true">
            <line x1={paddingLeft} x2={width - paddingRight} y1={y} y2={y} />
            <text x={paddingLeft - 10} y={y + 4} textAnchor="end">
              {formatCompactNumber(tick)}
            </text>
          </g>
        );
      })}
      <path d={path} />
      {points.map((point, index) => {
        const x =
          points.length <= 1
            ? width / 2
            : paddingLeft + (index / (points.length - 1)) * chartWidth;
        const y = paddingTop + chartHeight - (point.value / max) * chartHeight;
        return <circle key={point.label} cx={x} cy={y} r="3.8" />;
      })}
      {points.map((point, index) => {
        if (index % xTickEvery !== 0 && index !== points.length - 1) return null;
        const x =
          points.length <= 1
            ? width / 2
            : paddingLeft + (index / (points.length - 1)) * chartWidth;
        return (
          <text className="analytics-line__x-label" key={point.label} x={x} y={height - 22} textAnchor="middle">
            {point.label}
          </text>
        );
      })}
      <text className="analytics-line__x-title" x={paddingLeft + chartWidth / 2} y={height - 4} textAnchor="middle">
        {xAxisLabel}
      </text>
    </svg>
  );
};

const CategoryBars = ({ points }: { points: CategoryPoint[] }) => {
  if (!points.length) {
    return <p className="analytics-empty">No labelled records in this selection.</p>;
  }

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

const PanelHeading = ({
  icon,
  label,
  title,
  children,
}: {
  icon: ReactNode;
  label: string;
  title: string;
  children?: ReactNode;
}) => (
  <div className="analytics-panel__heading">
    <span className="analytics-panel__icon" aria-hidden="true">
      {icon}
    </span>
    <div>
      <span className="filter-label">{label}</span>
      <h2>{title}</h2>
      {children}
    </div>
  </div>
);

const MetricIcon = ({ children }: { children: ReactNode }) => (
  <span className="analytics-metric-icon" aria-hidden="true">
    {children}
  </span>
);

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
  ];
  const surfacePoints = getTopCategories(crashes, (crash) => crash.surfaceType);
  const lightPoints = getTopCategories(crashes, (crash) => crash.lightCondition);
  const speedZonePoints = getTopCategories(crashes, (crash) =>
    formatSpeedZoneLabel(crash.speedZone),
  );
  const roadSettingPoints = getTopCategories(crashes, classifyRoadSetting, 5);
  const topSurface = surfacePoints[0];
  const topLight = lightPoints[0];
  const topRoadSetting = roadSettingPoints[0];

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
          <MetricIcon>
            <BarChart3 size={20} />
          </MetricIcon>
          <span>Shown records</span>
          <strong>{formatNumber(crashes.length)}</strong>
          <em>{getPercent(crashes.length, totalCrashes)} of loaded data</em>
        </article>
        <article>
          <MetricIcon>
            <AlertTriangle size={20} />
          </MetricIcon>
          <span>Fatal records</span>
          <strong>{formatNumber(fatalCount)}</strong>
          <em>{getPercent(fatalCount, crashes.length)} of selected records</em>
        </article>
        <article>
          <MetricIcon>
            <ShieldAlert size={20} />
          </MetricIcon>
          <span>Serious records</span>
          <strong>{formatNumber(seriousCount)}</strong>
          <em>{getPercent(seriousCount, crashes.length)} of selected records</em>
        </article>
        <article>
          <MetricIcon>
            <Layers size={20} />
          </MetricIcon>
          <span>Property damage</span>
          <strong>{formatNumber(propertyCount)}</strong>
          <em>{getPercent(propertyCount, crashes.length)} of selected records</em>
        </article>
      </div>

      <div className="analytics-grid">
        <article className="analytics-panel analytics-panel--wide">
          <PanelHeading icon={<TrendingUp size={20} />} label="Time series" title="Crashes by year">
            <p>
              {peakYear
                ? `${peakYear.label} has the highest selected count with ${formatNumber(peakYear.value)} records.`
                : "No dated records are available for this selection."}
            </p>
          </PanelHeading>
          <LineChart points={yearSeries} label="Crashes by year" xAxisLabel="Year" />
        </article>

        <article className="analytics-panel">
          <PanelHeading icon={<ShieldAlert size={20} />} label="Severity" title="Outcome mix" />
          <CategoryBars points={severityPoints} />
        </article>

        <article className="analytics-panel">
          <PanelHeading icon={<Clock3 size={20} />} label="Time of day" title="Records by hour">
            <p>
              {peakHour
                ? `The busiest selected hour starts at ${peakHour.label}:00.`
                : "No hourly pattern is available."}
            </p>
          </PanelHeading>
          <BarChart points={hourSeries} label="Crashes by hour of day" xAxisLabel="Hour of day" />
        </article>

        <article className="analytics-panel">
          <PanelHeading icon={<Layers size={20} />} label="Road surface" title="Surface conditions">
            <p>
              {topSurface
                ? `${topSurface.label} appears most often in the selected records.`
                : "No surface data is available."}
            </p>
          </PanelHeading>
          <CategoryBars points={surfacePoints} />
        </article>

        <article className="analytics-panel">
          <PanelHeading icon={<Lightbulb size={20} />} label="Light" title="Lighting conditions">
            <p>
              {topLight
                ? `${topLight.label} is the most common selected light condition.`
                : "No light data is available."}
            </p>
          </PanelHeading>
          <CategoryBars points={lightPoints} />
        </article>

        <article className="analytics-panel analytics-panel--wide">
          <PanelHeading
            icon={<Gauge size={20} />}
            label="Speed limits"
            title="Records by posted speed limit"
          >
            <p>
              This does not mean a speed zone is automatically unsafe. It shows where
              historical records are concentrated in the selected data.
            </p>
          </PanelHeading>
          <CategoryBars points={speedZonePoints} />
        </article>

        <article className="analytics-panel analytics-panel--wide">
          <PanelHeading
            icon={<MapPinned size={20} />}
            label="Road setting"
            title="Where records tend to occur"
          >
            <p>
              {topRoadSetting
                ? `${topRoadSetting.label} is the largest inferred setting in this selection.`
                : "No road setting pattern is available for this selection."}
            </p>
          </PanelHeading>
          <CategoryBars points={roadSettingPoints} />
        </article>
      </div>
    </section>
  );
}
