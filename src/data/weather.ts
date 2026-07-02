import type {
  CrashRecord,
  CurrentDrivingConditions,
  CurrentWeather,
  HistoricalCrashWeather,
  HistoricalWeatherMatch,
  NormalisedLightCondition,
  SurfaceCondition,
  VisibilityCondition,
  WindCondition,
} from "../types/crash";

type OpenMeteoResponse = {
  current?: {
    time?: string;
    temperature_2m?: number;
    precipitation?: number;
    rain?: number;
    showers?: number;
    snowfall?: number;
    weather_code?: number;
    cloud_cover?: number;
    visibility?: number;
    wind_speed_10m?: number;
    is_day?: number;
  };
};

type OpenMeteoArchiveResponse = {
  hourly?: {
    time?: string[];
    precipitation?: Array<number | null>;
    rain?: Array<number | null>;
    snowfall?: Array<number | null>;
    weather_code?: Array<number | null>;
    cloud_cover?: Array<number | null>;
    visibility?: Array<number | null>;
    wind_speed_10m?: Array<number | null>;
    temperature_2m?: Array<number | null>;
  };
};

const WET_WEATHER_CODES = new Set([
  51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99,
]);

const SNOW_ICE_CODES = new Set([56, 57, 66, 67, 71, 73, 75, 77, 85, 86]);

const WEATHER_LABELS = new Map<number, string>([
  [0, "clear"],
  [1, "mostly clear"],
  [2, "partly cloudy"],
  [3, "cloudy"],
  [45, "fog"],
  [48, "fog"],
  [51, "drizzle"],
  [53, "drizzle"],
  [55, "drizzle"],
  [61, "rain"],
  [63, "rain"],
  [65, "heavy rain"],
  [80, "showers"],
  [81, "showers"],
  [82, "heavy showers"],
  [95, "storm"],
]);

const getFallbackLightCondition = (date: Date): NormalisedLightCondition => {
  const hour = date.getHours();
  if (hour >= 7 && hour < 17) return "daylight";
  if ((hour >= 5 && hour < 7) || (hour >= 17 && hour < 19)) return "dawn_dusk";
  return "dark";
};

const getVisibilityCondition = (visibility?: number): VisibilityCondition => {
  if (typeof visibility !== "number" || !Number.isFinite(visibility)) return "unknown";
  return visibility < 5000 ? "reduced" : "clear";
};

const getWindCondition = (windSpeed?: number): WindCondition => {
  if (typeof windSpeed !== "number" || !Number.isFinite(windSpeed)) return "unknown";
  return windSpeed >= 40 ? "windy" : "normal";
};

const getSurfaceCondition = (
  precipitation?: number,
  rain?: number,
  showers?: number,
  snowfall?: number,
  weatherCode?: number,
): SurfaceCondition => {
  const wetAmount = Math.max(0, precipitation ?? 0, rain ?? 0, showers ?? 0);
  const snowAmount = Math.max(0, snowfall ?? 0);
  if ((typeof weatherCode === "number" && SNOW_ICE_CODES.has(weatherCode)) || snowAmount > 0) {
    return "snow_ice";
  }
  if (wetAmount > 0 || (typeof weatherCode === "number" && WET_WEATHER_CODES.has(weatherCode))) {
    return "wet";
  }
  return "dry";
};

export const getCurrentDrivingConditions = (
  weather: CurrentWeather | null,
  currentDateTime = new Date(),
): CurrentDrivingConditions => {
  const weatherCode = weather?.weatherCode;
  const precipitation = Math.max(
    0,
    weather?.precipitation ?? 0,
    weather?.rain ?? 0,
    weather?.showers ?? 0,
  );
  const surfaceCondition: SurfaceCondition =
    weather
      ? getSurfaceCondition(
          weather.precipitation,
          weather.rain,
          weather.showers,
          weather.snowfall,
          weatherCode,
        )
      : "unknown";

  let lightCondition: NormalisedLightCondition = "unknown";
  if (typeof weather?.isDay === "boolean") {
    lightCondition = weather.isDay ? "daylight" : "dark";
  } else {
    lightCondition = getFallbackLightCondition(currentDateTime);
  }

  const weatherLabel =
    typeof weatherCode === "number"
      ? WEATHER_LABELS.get(weatherCode) ?? `weather code ${weatherCode}`
      : weather
        ? "current weather"
        : "weather unavailable";

  return {
    surfaceCondition,
    lightCondition,
    visibilityCondition: getVisibilityCondition(weather?.visibility),
    windCondition: getWindCondition(weather?.windSpeed),
    isRaining: precipitation > 0 || (typeof weatherCode === "number" && WET_WEATHER_CODES.has(weatherCode)),
    weatherLabel,
  };
};

export const fetchCurrentWeather = async (
  latitude: number,
  longitude: number,
): Promise<CurrentWeather> => {
  const params = new URLSearchParams({
    latitude: latitude.toFixed(5),
    longitude: longitude.toFixed(5),
    current: "temperature_2m,precipitation,rain,showers,weather_code,wind_speed_10m,is_day",
    timezone: "auto",
  });

  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Weather request failed with status ${response.status}`);
  }

  const data = (await response.json()) as OpenMeteoResponse;
  const current = data.current;
  if (!current) throw new Error("Weather response did not include current conditions.");

  return {
    precipitation: current.precipitation,
    rain: current.rain,
    showers: current.showers,
    weatherCode: current.weather_code,
    cloudCover: current.cloud_cover,
    temperature: current.temperature_2m,
    visibility: current.visibility,
    windSpeed: current.wind_speed_10m,
    isDay: typeof current.is_day === "number" ? current.is_day === 1 : undefined,
    observedAt: current.time ?? new Date().toISOString(),
  };
};

export const getCurrentWeatherForLocation = fetchCurrentWeather;

const roundToWeatherHour = (value?: string): Date | null => {
  if (!value) return null;
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return null;
  time.setMinutes(time.getMinutes() + 30, 0, 0);
  return time;
};

const weatherCacheKey = (latitude: number, longitude: number, date: Date): string =>
  `weather:${latitude.toFixed(2)}:${longitude.toFixed(2)}:${date.toISOString().slice(0, 10)}:${String(
    date.getHours(),
  ).padStart(2, "0")}`;

const readHistoricalWeatherCache = (key: string): HistoricalCrashWeather | null => {
  try {
    const value = window.localStorage.getItem(key);
    return value ? (JSON.parse(value) as HistoricalCrashWeather) : null;
  } catch {
    return null;
  }
};

const writeHistoricalWeatherCache = (key: string, value: HistoricalCrashWeather): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Cache failure should never affect Drive Mode.
  }
};

export const getHistoricalWeatherCacheKeyForCrash = (crash: CrashRecord): string | null => {
  const roundedHour = roundToWeatherHour(crash.dateTime);
  if (!roundedHour) return null;
  return weatherCacheKey(
    Math.round(crash.latitude * 100) / 100,
    Math.round(crash.longitude * 100) / 100,
    roundedHour,
  );
};

export const getHistoricalWeatherForCrash = async (
  crash: CrashRecord,
): Promise<HistoricalCrashWeather | null> => {
  const roundedHour = roundToWeatherHour(crash.dateTime);
  if (!roundedHour) return null;

  const roundedLatitude = Math.round(crash.latitude * 100) / 100;
  const roundedLongitude = Math.round(crash.longitude * 100) / 100;
  const cacheKey = weatherCacheKey(roundedLatitude, roundedLongitude, roundedHour);
  const cached = readHistoricalWeatherCache(cacheKey);
  if (cached) return { ...cached, crashId: crash.id, dateTime: crash.dateTime };

  const date = roundedHour.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    latitude: roundedLatitude.toFixed(2),
    longitude: roundedLongitude.toFixed(2),
    start_date: date,
    end_date: date,
    hourly:
      "temperature_2m,precipitation,rain,snowfall,weather_code,cloud_cover,wind_speed_10m",
    timezone: "auto",
  });

  const response = await fetch(`https://archive-api.open-meteo.com/v1/archive?${params.toString()}`);
  if (!response.ok) throw new Error(`Historical weather request failed with ${response.status}`);

  const data = (await response.json()) as OpenMeteoArchiveResponse;
  const times = data.hourly?.time ?? [];
  const targetHour = roundedHour.toISOString().slice(0, 13);
  const index = times.findIndex((time) => time.startsWith(targetHour));
  if (index < 0) return null;

  const precipitation = data.hourly?.precipitation?.[index] ?? undefined;
  const rain = data.hourly?.rain?.[index] ?? undefined;
  const snowfall = data.hourly?.snowfall?.[index] ?? undefined;
  const weatherCode = data.hourly?.weather_code?.[index] ?? undefined;
  const windSpeed = data.hourly?.wind_speed_10m?.[index] ?? undefined;
  const visibility = data.hourly?.visibility?.[index] ?? undefined;
  const surface = getSurfaceCondition(precipitation, rain, 0, snowfall, weatherCode);
  const light = getFallbackLightCondition(roundedHour);

  const result: HistoricalCrashWeather = {
    crashId: crash.id,
    dateTime: crash.dateTime,
    precipitation,
    rain,
    snowfall,
    weatherCode,
    isWet: surface === "wet" || surface === "snow_ice",
    isRain: Math.max(0, rain ?? 0, precipitation ?? 0) > 0,
    isSnowOrIce: surface === "snow_ice",
    isWindy: getWindCondition(windSpeed) === "windy",
    isDarkEstimate: light === "dark",
    confidence: "medium",
    conditions: {
      surface,
      visibility: getVisibilityCondition(visibility),
      wind: getWindCondition(windSpeed),
      light,
    },
  };

  writeHistoricalWeatherCache(cacheKey, result);
  return result;
};

export const compareHistoricalWeatherToCurrent = (
  historicalWeather: HistoricalCrashWeather,
  currentConditions: CurrentDrivingConditions,
): HistoricalWeatherMatch => {
  const wetMatch =
    currentConditions.surfaceCondition === "wet" && historicalWeather.conditions.surface === "wet";
  const dryMatch =
    currentConditions.surfaceCondition === "dry" && historicalWeather.conditions.surface === "dry";
  const snowIceMatch =
    currentConditions.surfaceCondition === "snow_ice" &&
    historicalWeather.conditions.surface === "snow_ice";
  const lightMatch =
    currentConditions.lightCondition === "dark" && historicalWeather.conditions.light === "dark";
  const windMatch =
    currentConditions.windCondition === "windy" && historicalWeather.conditions.wind === "windy";
  const visibilityMatch =
    currentConditions.visibilityCondition === "reduced" &&
    historicalWeather.conditions.visibility === "reduced";
  const weatherMatch = wetMatch || dryMatch || snowIceMatch;

  let scoreMultiplier = weatherMatch ? 1.5 : 1;
  if (wetMatch || snowIceMatch) scoreMultiplier *= 1.75;
  if (lightMatch) scoreMultiplier *= 1.4;
  if (visibilityMatch) scoreMultiplier *= 1.5;

  return {
    crashId: historicalWeather.crashId,
    weatherMatch,
    wetMatch: wetMatch || snowIceMatch,
    lightMatch,
    windMatch,
    visibilityMatch,
    scoreMultiplier,
    confidence: historicalWeather.confidence,
  };
};
