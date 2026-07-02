import type { CrashFilters, CrashRecord } from "../types/crash";

const ALL_VALUE = "all";

const normalise = (value?: string): string => value?.trim().toLowerCase() ?? "";

export const defaultFilters: CrashFilters = {
  severityMode: "all",
  speedZone: ALL_VALUE,
  lightCondition: ALL_VALUE,
  surfaceType: ALL_VALUE,
  weatherMode: "off",
};

export const isFatalCrash = (crash: CrashRecord): boolean =>
  normalise(crash.severity).includes("fatal");

export const isSeriousCrash = (crash: CrashRecord): boolean => {
  const severity = normalise(crash.severity);
  return severity.includes("fatal") || severity.includes("serious");
};

export const filterCrashes = (
  crashes: CrashRecord[],
  filters: CrashFilters,
): CrashRecord[] =>
  crashes.filter((crash) => {
    if (filters.severityMode === "fatal" && !isFatalCrash(crash)) return false;
    if (filters.severityMode === "seriousFatal" && !isSeriousCrash(crash)) {
      return false;
    }
    if (filters.speedZone !== ALL_VALUE && crash.speedZone !== filters.speedZone) {
      return false;
    }
    if (
      filters.lightCondition !== ALL_VALUE &&
      crash.lightCondition !== filters.lightCondition
    ) {
      return false;
    }
    if (filters.surfaceType !== ALL_VALUE && crash.surfaceType !== filters.surfaceType) {
      return false;
    }

    return true;
  });

export const uniqueOptions = (
  crashes: CrashRecord[],
  getter: (crash: CrashRecord) => string | undefined,
): string[] =>
  Array.from(new Set(crashes.map(getter).filter(Boolean) as string[])).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
