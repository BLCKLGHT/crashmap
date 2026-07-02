import type {
  CurrentDrivingConditions,
  CurrentWeather,
  NormalisedLightCondition,
  SurfaceCondition,
} from "../types/crash";

type OpenMeteoResponse = {
  current?: {
    time?: string;
    temperature_2m?: number;
    precipitation?: number;
    rain?: number;
    weather_code?: number;
    visibility?: number;
    wind_speed_10m?: number;
    is_day?: number;
  };
};

const WET_WEATHER_CODES = new Set([
  51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99,
]);

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

export const getCurrentDrivingConditions = (
  weather: CurrentWeather | null,
  currentDateTime = new Date(),
): CurrentDrivingConditions => {
  const weatherCode = weather?.weatherCode;
  const precipitation = Math.max(0, weather?.precipitation ?? 0, weather?.rain ?? 0);
  const wetByCode = typeof weatherCode === "number" && WET_WEATHER_CODES.has(weatherCode);
  const surfaceCondition: SurfaceCondition =
    precipitation > 0 || wetByCode ? "wet" : weather ? "dry" : "unknown";

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
    isRaining: precipitation > 0 || wetByCode,
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
    current: "temperature_2m,precipitation,rain,weather_code,wind_speed_10m,is_day",
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
    weatherCode: current.weather_code,
    temperature: current.temperature_2m,
    visibility: current.visibility,
    windSpeed: current.wind_speed_10m,
    isDay: typeof current.is_day === "number" ? current.is_day === 1 : undefined,
    observedAt: current.time ?? new Date().toISOString(),
  };
};
