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
  roadHistoryDescription: string;
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
  audioBase64: string;
};

const MIN_REQUEST_INTERVAL_MS = 20000;
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

const getRoadHistoryDescription = (context: VoiceWarningContext): string => {
  if (context.riskLevel === "high") return "higher than normal";
  if (context.riskLevel === "medium") return "a little higher than usual";
  return "low";
};

const buildDrivingContextJson = (
  context: VoiceWarningContext,
  event: VoiceWarningEvent,
  lastMessages: string[],
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
  roadHistoryDescription: getRoadHistoryDescription(context),
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
    roadHistoryDescription: "a little higher than usual",
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
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastMessagesRef = useRef<string[]>([]);
  const lastRequestRef = useRef<{ time: number; priority: number; contextKey: string } | null>(null);

  const isSupported = typeof Audio !== "undefined" && typeof URL !== "undefined";

  const revokeCurrentAudioUrl = useCallback(() => {
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  const warningSettings = useMemo(() => toVoiceWarningSettings(settings), [settings]);

  const stopAudio = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
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
      setError(null);
      return true;
    } catch {
      audio.volume = settings.volume;
      setIsAudioUnlocked(false);
      setError("Audio playback was blocked. Tap Enable companion or Test voice while the app is open.");
      return false;
    }
  }, [isSupported, settings.volume]);

  const requestAndPlay = useCallback(
    async (drivingContext: DrivingContextJson, priority: number, ignoreTiming = false) => {
      if ((settings.mode === "off" && !ignoreTiming) || !isSupported) return;

      const now = Date.now();
      const companionMode = settings.mode === "off" ? "normal" : settings.mode;
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
        return;
      }

      if (
        !ignoreTiming &&
        lastRequest &&
        priority <= lastRequest.priority + 15 &&
        now - lastRequest.time < MIN_REQUEST_INTERVAL_MS
      ) {
        return;
      }

      if (isSpeaking && lastRequest && priority <= lastRequest.priority) return;

      stopAudio();
      setError(null);

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
          }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error ?? `Driving companion failed with ${response.status}`);
        }

        const payload = (await response.json()) as CompanionResponse;
        const audioUrl = base64ToAudioUrl(payload.audioBase64, payload.mimeType);
        const audio = audioRef.current ?? new Audio();
        audioRef.current = audio;
        audio.pause();
        revokeCurrentAudioUrl();
        audio.src = audioUrl;
        audioUrlRef.current = audioUrl;
        audio.volume = settings.volume;
        setIsSpeaking(true);
        setLastSpoken(payload.text);
        lastMessagesRef.current = [payload.text, ...lastMessagesRef.current].slice(0, 5);
        audio.onended = () => {
          revokeCurrentAudioUrl();
          setIsSpeaking(false);
        };
        audio.onerror = () => {
          revokeCurrentAudioUrl();
          setIsSpeaking(false);
          setError("Audio playback failed.");
        };
        await audio.play();
      } catch (caughtError) {
        if ((caughtError as Error).name === "AbortError") return;
        setIsSpeaking(false);
        if ((caughtError as Error).name === "NotAllowedError") {
          setIsAudioUnlocked(false);
          setError("Audio playback was blocked. Tap Enable companion or Test voice while the app is open.");
        } else {
          setError(caughtError instanceof Error ? caughtError.message : "Driving companion failed.");
        }
      }
    },
    [isSpeaking, isSupported, revokeCurrentAudioUrl, settings.mode, settings.voice, settings.volume, stopAudio],
  );

  useEffect(() => {
    if (!context.isActive || settings.mode === "off") return;

    const [event] = buildVoiceWarningEvents(context, warningSettings);
    if (!event || event.priority < getPriorityThreshold(settings.mode)) return;

    void requestAndPlay(
      buildDrivingContextJson(context, event, lastMessagesRef.current),
      event.priority,
    );
  }, [context, requestAndPlay, settings.mode, warningSettings]);

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
          roadHistoryDescription: "low",
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
  };
}
