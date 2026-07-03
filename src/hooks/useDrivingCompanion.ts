import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildVoiceWarningEvents,
  DEFAULT_DRIVING_COMPANION_SETTINGS,
} from "../voice/voiceWarnings";
import type {
  DrivingCompanionSettings,
  VoiceWarningContext,
  VoiceWarningEvent,
  VoiceWarningSettings,
  VoiceWarningType,
} from "../voice/voiceWarnings";

type VoiceDebugStatus =
  | "Voice ready"
  | "Waiting for user enable gesture"
  | "Generating message"
  | "Generating audio"
  | "Playing"
  | "Suppressed by cooldown"
  | "Failed to play"
  | "Offline / network error";

type DrivingContextJson = {
  speed?: number;
  speedLimit?: number;
  distanceToRiskMetres?: number;
  riskLevel: string;
  totalCrashesAhead: number;
  seriousCrashesAhead: number;
  fatalCrashesAhead: number;
  weatherNow?: string;
  weatherMatched: boolean;
  recommendedCarLengths: number;
  currentHeading?: number;
  timeOfDay?: string;
  roadContext?: string;
  roadHistoryDescription: string;
  dashboardDrivingState: VoiceWarningContext["dashboardDrivingState"];
  previousRoadEvents: string[];
  lastAcknowledgedDriverActions: string[];
  secondsSinceLastMessage?: number;
  driverHasSlowedDown: boolean;
  lastMessages: string[];
  trigger: {
    type: VoiceWarningType;
    priority: number;
    severity: string;
  };
};

type CompanionResponse = {
  text: string;
  mimeType: string;
  audioBase64?: string;
};

type NavigatorWithAudioSession = Navigator & {
  audioSession?: {
    type?: "auto" | "ambient" | "playback" | "transient" | "transient-solo" | "play-and-record";
  };
};

const MIN_REQUEST_INTERVAL_MS = 20000;
const MAX_LOCATION_AGE_MS = 3000;
const MAX_RISK_AGE_MS = 5000;
const MIN_HUMAN_DELAY_MS = 2000;
const MAX_HUMAN_DELAY_MS = 6000;
const SPEECH_SPEEDS: Record<DrivingCompanionSettings["speechSpeed"], number> = {
  normal: 1.12,
  fast: 1.25,
  faster: 1.4,
};
const SILENT_AUDIO_DATA_URI =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==";

const toVoiceWarningSettings = (
  settings: DrivingCompanionSettings,
): VoiceWarningSettings => ({
  enabled: settings.mode !== "off",
  volume: settings.volume,
  intensity:
    settings.mode === "minimal"
      ? "minimal"
      : settings.mode === "coaching"
        ? "detailed"
        : "normal",
  voiceURI: "",
  muteCalmReminders: settings.mode !== "coaching",
  muteSpeedWarnings: false,
  muteCrashHistoryWarnings: false,
});

const getPriorityThreshold = (mode: DrivingCompanionSettings["mode"]): number => {
  if (mode === "minimal") return 80;
  if (mode === "coaching") return 20;
  return 60;
};

const base64ToAudioUrl = (audioBase64: string, mimeType: string): string => {
  const byteCharacters = atob(audioBase64);
  const bytes = new Uint8Array(byteCharacters.length);
  for (let index = 0; index < byteCharacters.length; index += 1) {
    bytes[index] = byteCharacters.charCodeAt(index);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
};

const configureMusicFriendlyAudioSession = (): boolean => {
  const audioSession = (navigator as NavigatorWithAudioSession).audioSession;
  if (!audioSession || !("type" in audioSession)) return false;

  try {
    audioSession.type = "ambient";
    return audioSession.type === "ambient";
  } catch {
    return false;
  }
};

const getRoadHistoryDescription = (context: VoiceWarningContext): string => {
  if (context.riskLevel === "high") return "higher than normal";
  if (context.riskLevel === "medium") return "a little higher than usual";
  return "low";
};

const buildDrivingContextJson = (
  context: VoiceWarningContext,
  event: VoiceWarningEvent,
  lastMessages: string[],
  previousRoadEvents: string[],
  lastAcknowledgedDriverActions: string[],
  secondsSinceLastMessage: number | undefined,
  driverHasSlowedDown: boolean,
): DrivingContextJson => ({
  speed: context.speedKmh,
  speedLimit: context.speedLimitKmh,
  distanceToRiskMetres: context.lookaheadDistanceMetres,
  riskLevel: context.riskLevel,
  totalCrashesAhead: context.totalCrashCount,
  seriousCrashesAhead: context.seriousCount,
  fatalCrashesAhead: context.fatalCount,
  weatherNow: context.currentConditions?.surfaceCondition,
  weatherMatched: context.matchedCrashCount > 0,
  recommendedCarLengths: context.carLengths,
  timeOfDay: context.currentConditions?.lightCondition,
  roadContext: context.roadContext,
  roadHistoryDescription: getRoadHistoryDescription(context),
  dashboardDrivingState: context.dashboardDrivingState,
  previousRoadEvents,
  lastAcknowledgedDriverActions,
  secondsSinceLastMessage,
  driverHasSlowedDown,
  lastMessages,
  trigger: {
    type: event.type,
    priority: event.priority,
    severity: event.severity,
  },
});

const makeTestContext = (
  type: VoiceWarningType,
  lastMessages: string[],
): DrivingContextJson => {
  const base = {
    speed: 82,
    speedLimit: 80,
    distanceToRiskMetres: 280,
    riskLevel: "medium",
    totalCrashesAhead: 8,
    seriousCrashesAhead: 1,
    fatalCrashesAhead: 0,
    weatherNow: "dry",
    weatherMatched: false,
    recommendedCarLengths: 7,
    timeOfDay: "daylight",
    roadContext: "Macquarie Street near Murray Street",
    roadHistoryDescription: "a little higher than usual",
    dashboardDrivingState: {
      currentSpeed: 82,
      speedLimit: 80,
      recommendedCarLengths: 7,
      currentWarningLevel: "medium" as const,
      currentWarningColour: "orange" as const,
      upcomingWarningLevel: "medium" as const,
      upcomingWarningColour: "orange" as const,
      distanceToUpcomingWarningMetres: 280,
      upcomingZoneType: "section" as const,
      optionalLandmark: "Macquarie Street near Murray Street",
      heading: 180,
      locationTimestamp: Date.now(),
      riskTimestamp: Date.now(),
    },
    previousRoadEvents: ["Medium road history near Macquarie Street"],
    lastAcknowledgedDriverActions: ["Driver eased off after the last speed note"],
    secondsSinceLastMessage: 180,
    driverHasSlowedDown: false,
    lastMessages,
    trigger: { type, priority: 99, severity: "medium" },
  };

  if (type === "speed_warning") return { ...base, speed: 96, speedLimit: 80 };
  if (type === "fatal_history_warning") {
    return {
      ...base,
      riskLevel: "high",
      totalCrashesAhead: 14,
      seriousCrashesAhead: 4,
      fatalCrashesAhead: 1,
      roadHistoryDescription: "higher than normal",
    };
  }
  if (type === "wet_weather_match_warning") {
    return { ...base, weatherNow: "wet", weatherMatched: true };
  }
  if (type === "dark_condition_warning") {
    return { ...base, timeOfDay: "dark", weatherMatched: true };
  }
  if (type === "crash_history_warning") {
    return {
      ...base,
      riskLevel: "high",
      totalCrashesAhead: 18,
      seriousCrashesAhead: 5,
      roadHistoryDescription: "higher than normal",
    };
  }
  return base;
};

export function useDrivingCompanion(context: VoiceWarningContext) {
  const [settings, setSettings] = useState<DrivingCompanionSettings>(
    DEFAULT_DRIVING_COMPANION_SETTINGS,
  );
  const [lastSpoken, setLastSpoken] = useState("Driving companion idle");
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isAudioUnlocked, setIsAudioUnlocked] = useState(false);
  const [debugStatus, setDebugStatus] = useState<VoiceDebugStatus>("Waiting for user enable gesture");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastMessagesRef = useRef<string[]>([]);
  const previousRoadEventsRef = useRef<string[]>([]);
  const lastAcknowledgedDriverActionsRef = useRef<string[]>([]);
  const lastSpokenAtRef = useRef<number | null>(null);
  const lastSpeedDeltaRef = useRef<number | null>(null);
  const scheduledSpeechRef = useRef<{ key: string; priority: number; timeoutId: number } | null>(
    null,
  );
  const latestContextRef = useRef(context);
  const lastRequestRef = useRef<{ time: number; priority: number; contextKey: string } | null>(null);

  const isSupported = typeof Audio !== "undefined" && typeof URL !== "undefined";

  const revokeCurrentAudioUrl = useCallback(() => {
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  const warningSettings = useMemo(() => toVoiceWarningSettings(settings), [settings]);

  const logVoice = useCallback((message: string, payload?: unknown) => {
    if (import.meta.env.DEV) console.debug(`[voice] ${message}`, payload ?? "");
  }, []);

  const isContextFresh = useCallback((candidate: VoiceWarningContext): boolean => {
    const now = Date.now();
    const { locationTimestamp, riskTimestamp, distanceToUpcomingWarningMetres } =
      candidate.dashboardDrivingState;
    if (locationTimestamp && now - locationTimestamp > MAX_LOCATION_AGE_MS) return false;
    if (riskTimestamp && now - riskTimestamp > MAX_RISK_AGE_MS) return false;
    if (
      typeof distanceToUpcomingWarningMetres === "number" &&
      distanceToUpcomingWarningMetres <= 5 &&
      candidate.dashboardDrivingState.upcomingWarningLevel !== "high"
    ) {
      return false;
    }
    return true;
  }, []);

  const stopAudio = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (scheduledSpeechRef.current) {
      window.clearTimeout(scheduledSpeechRef.current.timeoutId);
      scheduledSpeechRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }
    revokeCurrentAudioUrl();
    setIsSpeaking(false);
  }, [revokeCurrentAudioUrl]);

  const unlockAudio = useCallback(async () => {
    if (!isSupported) {
      setError("Audio playback is unavailable in this browser.");
      return false;
    }

    configureMusicFriendlyAudioSession();

    const audio = audioRef.current ?? new Audio();
    audioRef.current = audio;
    audio.preload = "auto";
    audio.volume = 0;
    audio.src = SILENT_AUDIO_DATA_URI;

    try {
      // Mobile browsers require this to happen directly after a user tap.
      await audio.play();
      audio.pause();
      audio.currentTime = 0;
      audio.volume = settings.volume;
      setIsAudioUnlocked(true);
      setDebugStatus("Voice ready");
      setError(null);
      return true;
    } catch {
      audio.volume = settings.volume;
      setIsAudioUnlocked(false);
      setDebugStatus("Waiting for user enable gesture");
      setError("Audio playback was blocked. Tap Enable companion or Test voice while the app is open.");
      return false;
    }
  }, [isSupported, settings.volume]);

  const requestAndPlay = useCallback(
    async (drivingContext: DrivingContextJson, priority: number, ignoreTiming = false) => {
      if ((settings.mode === "off" && !ignoreTiming) || !isSupported) return;
      if (!ignoreTiming && !isContextFresh(latestContextRef.current)) {
        setDebugStatus("Suppressed by cooldown");
        logVoice("suppressed stale dashboard/location state", latestContextRef.current.dashboardDrivingState);
        return;
      }

      const now = Date.now();
      const companionMode = settings.mode === "off" ? "normal" : settings.mode;
      const isSpeedWarning = drivingContext.trigger.type === "speed_warning";
      const contextKey = JSON.stringify({
        trigger: drivingContext.trigger.type,
        risk: drivingContext.riskLevel,
        fatal: drivingContext.fatalCrashesAhead,
        serious: drivingContext.seriousCrashesAhead,
        weather: drivingContext.weatherNow,
        speedDelta:
          typeof drivingContext.speed === "number" &&
          typeof drivingContext.speedLimit === "number"
            ? Math.round(drivingContext.speed - drivingContext.speedLimit)
            : 0,
      });
      const lastRequest = lastRequestRef.current;

      if (
        !ignoreTiming &&
        lastRequest &&
        contextKey === lastRequest.contextKey &&
        now - lastRequest.time < 120000
      ) {
        setDebugStatus("Suppressed by cooldown");
        logVoice("suppressed duplicate context", { contextKey });
        return;
      }

      if (
        !ignoreTiming &&
        lastRequest &&
        priority <= lastRequest.priority + (isSpeedWarning ? 0 : 15) &&
        now - lastRequest.time < MIN_REQUEST_INTERVAL_MS
      ) {
        setDebugStatus("Suppressed by cooldown");
        logVoice("suppressed recent lower-priority event", { priority, lastRequest });
        return;
      }

      if (isSpeaking && lastRequest && priority <= lastRequest.priority) {
        setDebugStatus("Suppressed by cooldown");
        logVoice("suppressed overlapping lower-priority audio", { priority, lastRequest });
        return;
      }

      stopAudio();
      setError(null);
      setDebugStatus("Generating message");
      logVoice("calling OpenAI", drivingContext.dashboardDrivingState);

      const controller = new AbortController();
      abortRef.current = controller;
      lastRequestRef.current = { time: now, priority, contextKey };

      try {
        const response = await fetch("/api/driving-companion", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            context: drivingContext,
            mode: companionMode,
            voice: settings.voice,
            personality: settings.personality,
            speechSpeed: SPEECH_SPEEDS[settings.speechSpeed],
          }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error ?? `Driving companion failed with ${response.status}`);
        }

        const payload = (await response.json()) as CompanionResponse;
        if (!payload.audioBase64 || !payload.text.trim()) {
          setDebugStatus("Voice ready");
          setLastSpoken("Companion stayed quiet");
          logVoice("model returned silence");
          return;
        }
        setDebugStatus("Generating audio");
        logVoice("tts audio received", { text: payload.text });
        const audioUrl = base64ToAudioUrl(payload.audioBase64, payload.mimeType);
        const audio = audioRef.current ?? new Audio();
        configureMusicFriendlyAudioSession();
        audioRef.current = audio;
        audio.pause();
        revokeCurrentAudioUrl();
        audio.src = audioUrl;
        audioUrlRef.current = audioUrl;
        audio.volume = settings.volume;
        setIsSpeaking(true);
        setLastSpoken(payload.text);
        lastMessagesRef.current = [payload.text, ...lastMessagesRef.current].slice(0, 20);
        previousRoadEventsRef.current = [
          `${drivingContext.trigger.type}: ${drivingContext.roadContext ?? drivingContext.roadHistoryDescription}`,
          ...previousRoadEventsRef.current,
        ].slice(0, 10);
        if (drivingContext.driverHasSlowedDown) {
          lastAcknowledgedDriverActionsRef.current = [
            "Driver eased off after the previous speed note",
            ...lastAcknowledgedDriverActionsRef.current,
          ].slice(0, 10);
        }
        lastSpokenAtRef.current = Date.now();
        audio.onended = () => {
          revokeCurrentAudioUrl();
          setIsSpeaking(false);
          setDebugStatus("Voice ready");
          logVoice("playback finished");
        };
        audio.onerror = () => {
          revokeCurrentAudioUrl();
          setIsSpeaking(false);
          setDebugStatus("Failed to play");
          setError("Audio playback failed.");
        };
        try {
          await audio.play();
        } catch (playError) {
          logVoice("audio play failed, retrying once", playError);
          await new Promise((resolve) => window.setTimeout(resolve, 250));
          await audio.play();
        }
        setDebugStatus("Playing");
        logVoice("playback started");
      } catch (caughtError) {
        if ((caughtError as Error).name === "AbortError") return;
        setIsSpeaking(false);
        if ((caughtError as Error).name === "NotAllowedError") {
          setIsAudioUnlocked(false);
          setDebugStatus("Waiting for user enable gesture");
          if (import.meta.env.DEV) {
            setError("Audio playback was blocked. Tap Enable companion or Test voice while the app is open.");
          }
        } else if (!navigator.onLine) {
          setDebugStatus("Offline / network error");
          if (import.meta.env.DEV) setError("Offline / network error");
        } else {
          setDebugStatus("Failed to play");
          if (import.meta.env.DEV) {
            setError(caughtError instanceof Error ? caughtError.message : "Driving companion failed.");
          }
        }
        logVoice("voice failed", caughtError);
      }
    },
    [
      isContextFresh,
      isSpeaking,
      isSupported,
      logVoice,
      revokeCurrentAudioUrl,
      settings.mode,
      settings.personality,
      settings.speechSpeed,
      settings.voice,
      settings.volume,
      stopAudio,
    ],
  );

  useEffect(() => {
    latestContextRef.current = context;
    if (!context.isActive || settings.mode === "off") return;

    const [event] = buildVoiceWarningEvents(context, warningSettings);
    if (!event || event.priority < getPriorityThreshold(settings.mode)) return;
    logVoice("voice event created", event);
    if (!isContextFresh(context)) {
      setDebugStatus("Suppressed by cooldown");
      logVoice("suppressed stale event", context.dashboardDrivingState);
      return;
    }

    const speedDelta =
      typeof context.speedKmh === "number" && typeof context.speedLimitKmh === "number"
        ? context.speedKmh - context.speedLimitKmh
        : undefined;
    const driverHasSlowedDown =
      typeof speedDelta === "number" &&
      typeof lastSpeedDeltaRef.current === "number" &&
      lastSpeedDeltaRef.current >= 3 &&
      speedDelta < lastSpeedDeltaRef.current - 3;
    if (typeof speedDelta === "number") lastSpeedDeltaRef.current = speedDelta;

    const now = Date.now();
    const secondsSinceLastMessage = lastSpokenAtRef.current
      ? Math.round((now - lastSpokenAtRef.current) / 1000)
      : undefined;
    const contextKey = JSON.stringify({
      event: event.type,
      risk: context.riskLevel,
      road: context.roadContext,
      speedDelta: typeof speedDelta === "number" ? Math.round(speedDelta) : 0,
    });
    const scheduled = scheduledSpeechRef.current;
    if (scheduled?.key === contextKey) return;
    if (scheduled && event.priority <= scheduled.priority) return;
    if (scheduled) window.clearTimeout(scheduled.timeoutId);

    const delay =
      MIN_HUMAN_DELAY_MS +
      Math.round(Math.random() * (MAX_HUMAN_DELAY_MS - MIN_HUMAN_DELAY_MS));
    const drivingContext = buildDrivingContextJson(
      context,
      event,
      lastMessagesRef.current,
      previousRoadEventsRef.current,
      lastAcknowledgedDriverActionsRef.current,
      secondsSinceLastMessage,
      driverHasSlowedDown,
    );
    const timeoutId = window.setTimeout(() => {
      scheduledSpeechRef.current = null;
      if (!isContextFresh(latestContextRef.current)) {
        setDebugStatus("Suppressed by cooldown");
        logVoice("cancelled delayed event after vehicle moved on", latestContextRef.current.dashboardDrivingState);
        return;
      }
      void requestAndPlay(drivingContext, event.priority);
    }, delay);
    scheduledSpeechRef.current = { key: contextKey, priority: event.priority, timeoutId };
  }, [context, isContextFresh, logVoice, requestAndPlay, settings.mode, warningSettings]);

  useEffect(
    () => () => {
      if (scheduledSpeechRef.current) {
        window.clearTimeout(scheduledSpeechRef.current.timeoutId);
        scheduledSpeechRef.current = null;
      }
    },
    [],
  );

  const enableCompanion = useCallback(() => {
    setSettings((current) => ({ ...current, mode: current.mode === "off" ? "normal" : current.mode }));
    void unlockAudio();
  }, [unlockAudio]);

  const disableCompanion = useCallback(() => {
    setSettings((current) => ({ ...current, mode: "off" }));
    stopAudio();
  }, [stopAudio]);

  const testVoice = useCallback(() => {
    void (async () => {
      await unlockAudio();
      await requestAndPlay(
        {
          speed: 78,
          speedLimit: 80,
          distanceToRiskMetres: 400,
          riskLevel: "low",
          totalCrashesAhead: 0,
          seriousCrashesAhead: 0,
          fatalCrashesAhead: 0,
          weatherNow: "dry",
          weatherMatched: false,
          recommendedCarLengths: 6,
          timeOfDay: "daylight",
          roadContext: "Davey Street near the Southern Outlet",
          roadHistoryDescription: "low",
          dashboardDrivingState: {
            currentSpeed: 78,
            speedLimit: 80,
            recommendedCarLengths: 6,
            currentWarningLevel: "low",
            currentWarningColour: "blue",
            upcomingWarningLevel: "low",
            upcomingWarningColour: "blue",
            distanceToUpcomingWarningMetres: 400,
            upcomingZoneType: "section",
            optionalLandmark: "Davey Street near the Southern Outlet",
            heading: 180,
            locationTimestamp: Date.now(),
            riskTimestamp: Date.now(),
          },
          previousRoadEvents: previousRoadEventsRef.current,
          lastAcknowledgedDriverActions: lastAcknowledgedDriverActionsRef.current,
          secondsSinceLastMessage: lastSpokenAtRef.current
            ? Math.round((Date.now() - lastSpokenAtRef.current) / 1000)
            : undefined,
          driverHasSlowedDown: false,
          lastMessages: lastMessagesRef.current,
          trigger: { type: "calm_reminder", priority: 99, severity: "low" },
        },
        99,
        true,
      );
    })();
  }, [requestAndPlay, unlockAudio]);

  const testWarningType = useCallback(
    (type: VoiceWarningType) => {
      void (async () => {
        await unlockAudio();
        await requestAndPlay(makeTestContext(type, lastMessagesRef.current), 99, true);
      })();
    },
    [requestAndPlay, unlockAudio],
  );

  return {
    isSupported,
    isAudioUnlocked,
    settings,
    setSettings,
    enableCompanion,
    disableCompanion,
    testVoice,
    testWarningType,
    lastSpoken,
    error,
    isSpeaking,
    debugStatus,
  };
}
