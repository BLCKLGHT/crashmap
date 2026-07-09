import type {
  CurrentDrivingConditions,
  DashboardCrashRiskLevel,
  DashboardDrivingState,
} from "../types/crash";

export type VoiceWarningType =
  | "speed_warning"
  | "following_distance_warning"
  | "crash_history_warning"
  | "fatal_history_warning"
  | "serious_crash_warning"
  | "wet_weather_match_warning"
  | "dark_condition_warning"
  | "buddy_observation"
  | "calm_reminder";

export type VoiceIntensity = "minimal" | "normal" | "detailed";
export type DrivingCompanionMode = "off" | "normal";
export type DrivingCompanionVoice = "alloy" | "ash" | "ballad" | "coral" | "echo" | "sage" | "shimmer" | "verse";
export type DrivingCompanionSpeechSpeed = "normal" | "fast" | "faster";

export type VoiceWarningSettings = {
  enabled: boolean;
  volume: number;
  intensity: VoiceIntensity;
  voiceURI: string;
  muteCalmReminders: boolean;
  muteSpeedWarnings: boolean;
  muteCrashHistoryWarnings: boolean;
};

export type DrivingCompanionSettings = {
  mode: DrivingCompanionMode;
  voice: DrivingCompanionVoice;
  speechSpeed: DrivingCompanionSpeechSpeed;
  volume: number;
  talkativeness: number;
  buddyMode: boolean;
};

export type VoiceWarningEvent = {
  type: VoiceWarningType;
  priority: number;
  severity: "low" | "medium" | "high";
  message: string;
  segmentKey: string;
};

export type VoiceWarningContext = {
  isActive: boolean;
  speedKmh?: number;
  speedLimitKmh?: number;
  carLengths: number;
  riskLevel: DashboardCrashRiskLevel;
  totalCrashCount: number;
  seriousCount: number;
  fatalCount: number;
  matchedCrashCount: number;
  wetCrashCount: number;
  darkCrashCount: number;
  currentConditions: CurrentDrivingConditions | null;
  dashboardDrivingState: DashboardDrivingState;
  lookaheadDistanceMetres: number;
  roadContext?: string;
  segmentKey: string;
};

export const DEFAULT_VOICE_WARNING_SETTINGS: VoiceWarningSettings = {
  enabled: false,
  volume: 0.85,
  intensity: "normal",
  voiceURI: "",
  muteCalmReminders: false,
  muteSpeedWarnings: false,
  muteCrashHistoryWarnings: false,
};

export const DEFAULT_DRIVING_COMPANION_SETTINGS: DrivingCompanionSettings = {
  mode: "normal",
  voice: "alloy",
  speechSpeed: "fast",
  volume: 0.9,
  talkativeness: 50,
  buddyMode: false,
};

export const VOICE_WARNING_COOLDOWNS: Record<VoiceWarningType, number> = {
  speed_warning: 30000,
  following_distance_warning: 60000,
  crash_history_warning: 90000,
  fatal_history_warning: 180000,
  serious_crash_warning: 120000,
  wet_weather_match_warning: 120000,
  dark_condition_warning: 120000,
  buddy_observation: 240000,
  calm_reminder: 300000,
};

const PHRASES: Record<VoiceWarningType, string[]> = {
  speed_warning: [
    "You’re just over the limit.",
    "You’re sitting a bit over the speed limit.",
    "Ease back. You’re well over the posted limit.",
  ],
  following_distance_warning: [
    "Give yourself a bit more room at this speed.",
    "At this speed, you’ll need more space to stop comfortably.",
    "Wet road. Leave more room than usual.",
  ],
  crash_history_warning: [
    "There’s an orange section coming up.",
    "Ease into this next warning section.",
    "The dashboard’s picking up a warning area ahead.",
  ],
  fatal_history_warning: [
    "There’s a red area just ahead.",
    "That red section is coming up now.",
  ],
  serious_crash_warning: [
    "That warning section is just ahead.",
    "Take this next section smoothly.",
  ],
  wet_weather_match_warning: [
    "Looks wet through this next section.",
    "I’d give yourself a bit more room here.",
    "Road’s probably a bit greasy through here.",
  ],
  dark_condition_warning: [
    "This next section’s darker than it looks.",
    "Ease into the next section.",
  ],
  buddy_observation: [
    "Quiet stretch. Anything interesting happening today?",
    "Nice bit of road through here.",
  ],
  calm_reminder: [
    "Road history looks low through here.",
    "Nothing significant showing ahead.",
    "Keep it smooth.",
  ],
};

const PRIORITY: Record<VoiceWarningType, number> = {
  speed_warning: 35,
  fatal_history_warning: 100,
  crash_history_warning: 80,
  wet_weather_match_warning: 70,
  serious_crash_warning: 65,
  following_distance_warning: 60,
  dark_condition_warning: 55,
  buddy_observation: 15,
  calm_reminder: 20,
};

const phraseCursor = new Map<VoiceWarningType, number>();

export const pickVoicePhrase = (type: VoiceWarningType, preferredIndex?: number): string => {
  const phrases = PHRASES[type];
  if (preferredIndex !== undefined) return phrases[Math.min(preferredIndex, phrases.length - 1)];

  const cursor = phraseCursor.get(type) ?? Math.floor(Math.random() * phrases.length);
  phraseCursor.set(type, (cursor + 1) % phrases.length);
  return phrases[cursor];
};

const canSpeakTypeForSettings = (
  type: VoiceWarningType,
  settings: VoiceWarningSettings,
  severity: VoiceWarningEvent["severity"],
): boolean => {
  if (settings.muteSpeedWarnings && type === "speed_warning") return false;
  if (
    settings.muteCrashHistoryWarnings &&
    type !== "speed_warning" &&
      type !== "following_distance_warning" &&
      type !== "buddy_observation" &&
      type !== "calm_reminder"
  ) {
    return false;
  }
  if (settings.muteCalmReminders && type === "calm_reminder") return false;
  if (settings.muteCalmReminders && type === "buddy_observation") return false;

  if (settings.intensity === "minimal") {
    return (
      type === "fatal_history_warning" ||
      (type === "crash_history_warning" && severity === "high") ||
      (type === "speed_warning" && severity === "high")
    );
  }

  if (settings.intensity === "normal") {
    return (
      type === "speed_warning" ||
      type === "fatal_history_warning" ||
      type === "crash_history_warning" ||
      type === "wet_weather_match_warning"
    );
  }

  return true;
};

const makeEvent = (
  type: VoiceWarningType,
  segmentKey: string,
  severity: VoiceWarningEvent["severity"],
  message?: string,
): VoiceWarningEvent => ({
  type,
  priority:
    type === "speed_warning" && severity === "high"
      ? 125
      : type === "speed_warning" && severity === "medium"
        ? 115
        : type === "speed_warning"
          ? 105
          : PRIORITY[type],
  severity,
  message: message ?? pickVoicePhrase(type),
  segmentKey,
});

export const buildVoiceWarningEvents = (
  context: VoiceWarningContext,
  settings: VoiceWarningSettings,
): VoiceWarningEvent[] => {
  if (!context.isActive) return [];

  const events: VoiceWarningEvent[] = [];
  const segmentKey = context.segmentKey;
  const speedDelta =
    typeof context.speedKmh === "number" && typeof context.speedLimitKmh === "number"
      ? context.speedKmh - context.speedLimitKmh
      : 0;

  if (speedDelta >= 12) {
    events.push(makeEvent("speed_warning", segmentKey, "high", pickVoicePhrase("speed_warning", 2)));
  } else if (speedDelta >= 7) {
    events.push(makeEvent("speed_warning", segmentKey, "medium", pickVoicePhrase("speed_warning", 1)));
  } else if (speedDelta >= 3) {
    events.push(makeEvent("speed_warning", segmentKey, "low", pickVoicePhrase("speed_warning", 0)));
  }

  if (context.fatalCount >= 1) {
    events.push(makeEvent("fatal_history_warning", segmentKey, "high"));
  }

  if (context.riskLevel === "high") {
    events.push(makeEvent("crash_history_warning", segmentKey, "high"));
  } else if (context.riskLevel === "medium") {
    events.push(makeEvent("crash_history_warning", segmentKey, "medium"));
  }

  if (context.seriousCount >= 2) {
    events.push(makeEvent("serious_crash_warning", segmentKey, "medium"));
  }

  if (
    context.currentConditions?.surfaceCondition === "wet" &&
    (context.matchedCrashCount > 0 || context.wetCrashCount > 0)
  ) {
    events.push(makeEvent("wet_weather_match_warning", segmentKey, "medium"));
  }

  if (
    context.currentConditions?.lightCondition === "dark" &&
    (context.matchedCrashCount > 0 || context.darkCrashCount > 0)
  ) {
    events.push(makeEvent("dark_condition_warning", segmentKey, "medium"));
  }

  if (context.carLengths >= 8) {
    const phrase =
      context.currentConditions?.surfaceCondition === "wet"
        ? "Wet road. Leave more room than usual."
        : undefined;
    events.push(makeEvent("following_distance_warning", segmentKey, "low", phrase));
  }

  if (context.riskLevel === "low" && context.totalCrashCount === 0) {
    events.push(makeEvent("calm_reminder", segmentKey, "low"));
  }

  return events
    .filter((event) => canSpeakTypeForSettings(event.type, settings, event.severity))
    .sort((a, b) => b.priority - a.priority);
};
