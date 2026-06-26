export type CrashRecord = {
  id: string;
  latitude: number;
  longitude: number;
  dateTime?: string;
  severity?: string;
  speedZone?: string;
  surfaceType?: string;
  lightCondition?: string;
  locationDescription?: string;
};

export type CrashFilters = {
  severityMode: "all" | "seriousFatal" | "fatal";
  speedZone: string;
  lightCondition: string;
  surfaceType: string;
};

export type TimelineState = {
  minTime: number;
  maxTime: number;
  startTime: number;
  endTime: number;
  playheadTime: number;
  speed: 1 | 2 | 5 | 10;
  isPlaying: boolean;
  isPlaybackView: boolean;
};

export type DriveLocation = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  heading?: number;
  speed?: number;
  timestamp: number;
  isSimulated?: boolean;
};

export type DriveRiskSummary = {
  radiusMetres: number;
  totalCount: number;
  fatalCount: number;
  seriousCount: number;
  propertyDamageCount: number;
  aheadCount: number;
  closestSeriousOrFatalMetres?: number;
  warningTitle?: string;
  warningMessage?: string;
  nearbyCrashes: CrashRecord[];
};

export type CrashDataState = {
  crashes: CrashRecord[];
  fetchedAt?: string;
};
