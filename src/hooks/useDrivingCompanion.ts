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

type CachedCompanionResponse = CompanionResponse & {
  createdAt: number;
  key: string;
};

type NavigatorWithAudioSession = Navigator & {
  audioSession?: {
    type?: "auto" | "ambient" | "playback" | "transient" | "transient-solo" | "play-and-record";
  };
};

type WindowWithWebAudio = Window & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};

const MIN_REQUEST_INTERVAL_MS = 20000;
const MAX_LOCATION_AGE_MS = 3000;
const MAX_RISK_AGE_MS = 5000;
const MIN_HUMAN_DELAY_MS = 150;
const MAX_HUMAN_DELAY_MS = 650;
const URGENT_WARNING_DISTANCE_METRES = 250;
const DEFAULT_VOICE_PIPELINE_LATENCY_MS = 1800;
const MIN_VOICE_PIPELINE_LATENCY_MS = 500;
const MAX_VOICE_PIPELINE_LATENCY_MS = 5000;
const VOICE_PREFETCH_MIN_DISTANCE_METRES = 500;
const VOICE_PREFETCH_MAX_DISTANCE_METRES = 820;
const VOICE_PREFETCH_SPOKEN_DISTANCE_METRES = 500;
const VOICE_PREFETCH_MAX_AGE_MS = 90000;
const SPEED_CUE_COOLDOWN_MS = 12000;
const SPEED_STRONG_CUE_COOLDOWN_MS = 18000;
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
    settings.talkativeness <= 25
      ? "minimal"
      : settings.talkativeness >= 70
        ? "detailed"
        : "normal",
  voiceURI: "",
  engineerMode: settings.engineerMode,
  muteCalmReminders: settings.talkativeness < 70 && !settings.buddyMode,
  muteSpeedWarnings: false,
  muteCrashHistoryWarnings: false,
});

const getPriorityThreshold = (talkativeness: number): number => {
  if (talkativeness <= 10) return 100;
  if (talkativeness <= 35) return 80;
  if (talkativeness <= 65) return 60;
  if (talkativeness <= 85) return 20;
  return 10;
};

const getDuplicateCooldownMs = (talkativeness: number, isBuddyObservation: boolean): number => {
  if (isBuddyObservation) return Math.round(420000 - talkativeness * 2400);
  return Math.round(240000 - talkativeness * 1800);
};

const base64ToAudioUrl = (
  audioBase64: string,
  mimeType: string,
): { url: string; byteLength: number } => {
  const byteCharacters = atob(audioBase64);
  const bytes = new Uint8Array(byteCharacters.length);
  for (let index = 0; index < byteCharacters.length; index += 1) {
    bytes[index] = byteCharacters.charCodeAt(index);
  }
  return {
    url: URL.createObjectURL(new Blob([bytes], { type: mimeType })),
    byteLength: bytes.byteLength,
  };
};

const configureReliableAudioSession = (): boolean => {
  const audioSession = (navigator as NavigatorWithAudioSession).audioSession;
  if (!audioSession || !("type" in audioSession)) return false;

  try {
    // iOS can make "ambient" audio obey the silent switch, which looks like
    // playback succeeded while producing no audible voice. "playback" is more
    // reliable for a driver-facing prompt.
    audioSession.type = "playback";
    return audioSession.type === "playback";
  } catch {
    return false;
  }
};

const waitForAudioReady = (audio: HTMLAudioElement, timeoutMs = 5000): Promise<void> =>
  new Promise((resolve, reject) => {
    if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      resolve();
      return;
    }

    let timeoutId: number | undefined;

    const cleanup = () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      audio.removeEventListener("loadeddata", handleReady);
      audio.removeEventListener("canplay", handleReady);
      audio.removeEventListener("error", handleError);
    };
    const handleReady = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Audio failed to load."));
    };

    timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Audio did not load in time."));
    }, timeoutMs);
    audio.addEventListener("loadeddata", handleReady, { once: true });
    audio.addEventListener("canplay", handleReady, { once: true });
    audio.addEventListener("error", handleError, { once: true });
  });

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
  distanceToRiskMetres:
    context.dashboardDrivingState.distanceToUpcomingWarningMetres ??
    context.lookaheadDistanceMetres,
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

const projectContextForVoiceLatency = (
  drivingContext: DrivingContextJson,
  latencyMs: number,
): DrivingContextJson => {
  const speedMetresPerSecond = Math.max(0, drivingContext.speed ?? 0) / 3.6;
  const locationAgeMs = drivingContext.dashboardDrivingState.locationTimestamp
    ? Math.max(0, Date.now() - drivingContext.dashboardDrivingState.locationTimestamp)
    : 0;
  const projectedTravelMetres =
    speedMetresPerSecond * ((latencyMs + locationAgeMs) / 1000);
  const projectDistance = (distance: number | undefined) =>
    typeof distance === "number"
      ? Math.max(0, Math.round(distance - projectedTravelMetres))
      : undefined;
  const projectedDistance = projectDistance(
    drivingContext.dashboardDrivingState.distanceToUpcomingWarningMetres,
  );

  return {
    ...drivingContext,
    distanceToRiskMetres:
      projectDistance(drivingContext.distanceToRiskMetres) ?? drivingContext.distanceToRiskMetres,
    dashboardDrivingState: {
      ...drivingContext.dashboardDrivingState,
      distanceToUpcomingWarningMetres: projectedDistance,
    },
  };
};

const getCompanionCacheKey = (drivingContext: DrivingContextJson): string =>
  JSON.stringify({
    trigger: drivingContext.trigger.type,
    severity: drivingContext.trigger.severity,
    risk: drivingContext.riskLevel,
    road: drivingContext.roadContext ?? "",
    colour: drivingContext.dashboardDrivingState.upcomingWarningColour,
    weather: drivingContext.weatherNow ?? "",
    speedLimit: drivingContext.speedLimit ?? 0,
    // Keep distance coarse so a prefetched "about 500 metres" line can be
    // reused when the vehicle reaches the dashboard's 500m warning window.
    distance:
      typeof drivingContext.dashboardDrivingState.distanceToUpcomingWarningMetres === "number"
        ? Math.round(drivingContext.dashboardDrivingState.distanceToUpcomingWarningMetres / 100) * 100
        : 0,
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

export function useDrivingCompanion(
  context: VoiceWarningContext,
  predictiveContext: VoiceWarningContext | null = null,
) {
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
  const cueAudioContextRef = useRef<AudioContext | null>(null);
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
  const pipelineLatencyMsRef = useRef(DEFAULT_VOICE_PIPELINE_LATENCY_MS);
  const cachedCompanionResponsesRef = useRef(new Map<string, CachedCompanionResponse>());
  const pendingPrefetchKeysRef = useRef(new Set<string>());
  const lastSpeedCueRef = useRef<{ band: "none" | "over" | "strong"; time: number }>({
    band: "none",
    time: 0,
  });

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

  const getCueAudioContext = useCallback(() => {
    if (typeof window === "undefined") return null;
    if (cueAudioContextRef.current) return cueAudioContextRef.current;
    const AudioContextConstructor =
      window.AudioContext ?? (window as WindowWithWebAudio).webkitAudioContext;
    if (!AudioContextConstructor) return null;
    cueAudioContextRef.current = new AudioContextConstructor();
    return cueAudioContextRef.current;
  }, []);

  const playSpeedCue = useCallback(
    (band: "over" | "strong") => {
      const audioContext = getCueAudioContext();
      if (!audioContext) return;

      const play = () => {
        const now = audioContext.currentTime;
        const masterGain = audioContext.createGain();
        masterGain.gain.setValueAtTime(0.0001, now);
        masterGain.gain.exponentialRampToValueAtTime(settings.volume * (band === "strong" ? 0.28 : 0.18), now + 0.015);
        masterGain.gain.exponentialRampToValueAtTime(0.0001, now + (band === "strong" ? 0.42 : 0.22));
        masterGain.connect(audioContext.destination);

        const tones = band === "strong" ? [740, 980] : [660];
        tones.forEach((frequency, index) => {
          const oscillator = audioContext.createOscillator();
          oscillator.type = band === "strong" ? "triangle" : "sine";
          oscillator.frequency.setValueAtTime(frequency, now + index * 0.11);
          oscillator.connect(masterGain);
          oscillator.start(now + index * 0.11);
          oscillator.stop(now + index * 0.11 + 0.16);
        });
      };

      if (audioContext.state === "suspended") {
        void audioContext.resume().then(play).catch((caughtError) => {
          logVoice("speed cue blocked", caughtError);
        });
        return;
      }
      play();
    },
    [getCueAudioContext, logVoice, settings.volume],
  );

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

    configureReliableAudioSession();

    const audio = audioRef.current ?? new Audio();
    audioRef.current = audio;
    audio.preload = "auto";
    audio.muted = false;
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
      const cueAudioContext = getCueAudioContext();
      if (cueAudioContext?.state === "suspended") {
        await cueAudioContext.resume().catch(() => undefined);
      }
      return true;
    } catch {
      audio.volume = settings.volume;
      setIsAudioUnlocked(false);
      setDebugStatus("Waiting for user enable gesture");
      setError("Audio playback was blocked. Tap Enable companion or Test voice while the app is open.");
      return false;
    }
  }, [getCueAudioContext, isSupported, settings.volume]);

  const fetchCompanionPayload = useCallback(
    async (drivingContext: DrivingContextJson, signal?: AbortSignal): Promise<CompanionResponse> => {
      const companionMode = settings.mode === "off" ? "normal" : settings.mode;
      const response = await fetch("/api/driving-companion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          context: drivingContext,
          mode: companionMode,
          voice: settings.voice,
          buddyMode: settings.buddyMode,
          engineerMode: settings.engineerMode,
          talkativeness: settings.talkativeness,
          speechSpeed: SPEECH_SPEEDS[settings.speechSpeed],
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Driving companion failed with ${response.status}`);
      }

      return (await response.json()) as CompanionResponse;
    },
    [
      settings.buddyMode,
      settings.engineerMode,
      settings.mode,
      settings.speechSpeed,
      settings.talkativeness,
      settings.voice,
    ],
  );

  const requestAndPlay = useCallback(
    async (drivingContext: DrivingContextJson, priority: number, ignoreTiming = false) => {
      if ((settings.mode === "off" && !ignoreTiming) || !isSupported) return;
      if (!ignoreTiming && !isContextFresh(latestContextRef.current)) {
        setDebugStatus("Suppressed by cooldown");
        logVoice("suppressed stale dashboard/location state", latestContextRef.current.dashboardDrivingState);
        return;
      }

      const now = Date.now();
      const projectedDrivingContext = ignoreTiming
        ? drivingContext
        : projectContextForVoiceLatency(drivingContext, pipelineLatencyMsRef.current);
      const isSpeedWarning = projectedDrivingContext.trigger.type === "speed_warning";
      const contextKey = JSON.stringify({
        trigger: projectedDrivingContext.trigger.type,
        risk: projectedDrivingContext.riskLevel,
        fatal: projectedDrivingContext.fatalCrashesAhead,
        serious: projectedDrivingContext.seriousCrashesAhead,
        weather: projectedDrivingContext.weatherNow,
        speedDelta:
          typeof projectedDrivingContext.speed === "number" &&
          typeof projectedDrivingContext.speedLimit === "number"
            ? Math.round(projectedDrivingContext.speed - projectedDrivingContext.speedLimit)
            : 0,
      });
      const audioCacheKey = getCompanionCacheKey(projectedDrivingContext);
      const lastRequest = lastRequestRef.current;

      if (
        !ignoreTiming &&
        lastRequest &&
        contextKey === lastRequest.contextKey &&
        now - lastRequest.time <
          getDuplicateCooldownMs(
            settings.talkativeness,
            projectedDrivingContext.trigger.type === "buddy_observation",
          )
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
      logVoice("calling OpenAI", {
        dashboard: projectedDrivingContext.dashboardDrivingState,
        compensatedLatencyMs: pipelineLatencyMsRef.current,
      });

      const controller = new AbortController();
      abortRef.current = controller;
      lastRequestRef.current = { time: now, priority, contextKey };
      const pipelineStartedAt = performance.now();

      try {
        const cachedPayload = cachedCompanionResponsesRef.current.get(audioCacheKey);
        const payload =
          cachedPayload && now - cachedPayload.createdAt < VOICE_PREFETCH_MAX_AGE_MS
            ? cachedPayload
            : await fetchCompanionPayload(projectedDrivingContext, controller.signal);

        if (cachedPayload && payload === cachedPayload) {
          cachedCompanionResponsesRef.current.delete(audioCacheKey);
          logVoice("using prefetched voice audio", {
            key: audioCacheKey,
            ageMs: now - cachedPayload.createdAt,
          });
        } else if (payload.audioBase64 && payload.text.trim()) {
          cachedCompanionResponsesRef.current.set(audioCacheKey, {
            ...payload,
            key: audioCacheKey,
            createdAt: Date.now(),
          });
        }

        if (!payload.audioBase64 || !payload.text.trim()) {
          setDebugStatus("Voice ready");
          setLastSpoken("Companion stayed quiet");
          logVoice("model returned silence");
          return;
        }
        setDebugStatus("Generating audio");
        logVoice("tts audio received", { text: payload.text });
        const { url: audioUrl, byteLength } = base64ToAudioUrl(
          payload.audioBase64,
          payload.mimeType,
        );
        const audio = audioRef.current ?? new Audio();
        configureReliableAudioSession();
        audioRef.current = audio;
        audio.pause();
        revokeCurrentAudioUrl();
        audio.preload = "auto";
        audio.autoplay = false;
        audio.muted = false;
        audio.src = audioUrl;
        audioUrlRef.current = audioUrl;
        audio.volume = settings.volume;
        audio.currentTime = 0;
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
        audio.onloadeddata = () => {
          logVoice("audio loaded", {
            bytes: byteLength,
            duration: Number.isFinite(audio.duration) ? audio.duration : undefined,
            readyState: audio.readyState,
          });
        };
        audio.onplaying = () => {
          setIsSpeaking(true);
          setDebugStatus("Playing");
          logVoice("playback started", {
            currentTime: audio.currentTime,
            readyState: audio.readyState,
            volume: audio.volume,
            muted: audio.muted,
          });
        };
        audio.onwaiting = () => logVoice("audio waiting", { readyState: audio.readyState });
        audio.onstalled = () => logVoice("audio stalled", { readyState: audio.readyState });
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
        audio.load();
        await waitForAudioReady(audio);
        const measuredPipelineLatencyMs = performance.now() - pipelineStartedAt;
        pipelineLatencyMsRef.current = Math.min(
          MAX_VOICE_PIPELINE_LATENCY_MS,
          Math.max(
            MIN_VOICE_PIPELINE_LATENCY_MS,
            pipelineLatencyMsRef.current * 0.35 + measuredPipelineLatencyMs * 0.65,
          ),
        );
        if (!ignoreTiming && !isContextFresh(latestContextRef.current)) {
          logVoice("cancelled audio because vehicle moved beyond current warning", {
            measuredPipelineLatencyMs,
            latest: latestContextRef.current.dashboardDrivingState,
          });
          stopAudio();
          return;
        }
        try {
          await audio.play();
        } catch (playError) {
          logVoice("audio play failed, retrying once", playError);
          await new Promise((resolve) => window.setTimeout(resolve, 250));
          await audio.play();
        }
        if (audio.paused) {
          throw new Error("Audio playback did not start.");
        }
        if (!isSpeaking) {
          setIsSpeaking(true);
          setDebugStatus("Playing");
        }
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
      fetchCompanionPayload,
      isContextFresh,
      isSpeaking,
      isSupported,
      logVoice,
      revokeCurrentAudioUrl,
      settings.mode,
      settings.talkativeness,
      settings.volume,
      stopAudio,
    ],
  );

  useEffect(() => {
    if (
      !predictiveContext?.isActive ||
      settings.mode === "off" ||
      !isSupported ||
      !isContextFresh(predictiveContext)
    ) {
      return;
    }

    const distance = predictiveContext.dashboardDrivingState.distanceToUpcomingWarningMetres;
    if (
      typeof distance !== "number" ||
      distance < VOICE_PREFETCH_MIN_DISTANCE_METRES ||
      distance > VOICE_PREFETCH_MAX_DISTANCE_METRES
    ) {
      return;
    }

    const [event] = buildVoiceWarningEvents(predictiveContext, warningSettings).filter(
      (candidate) =>
        candidate.type !== "speed_warning" &&
        candidate.type !== "following_distance_warning" &&
        candidate.type !== "calm_reminder" &&
        candidate.type !== "buddy_observation" &&
        candidate.priority >= getPriorityThreshold(settings.talkativeness),
    );
    if (!event) return;

    const drivingContext = buildDrivingContextJson(
      {
        ...predictiveContext,
        dashboardDrivingState: {
          ...predictiveContext.dashboardDrivingState,
          distanceToUpcomingWarningMetres: VOICE_PREFETCH_SPOKEN_DISTANCE_METRES,
        },
      },
      event,
      lastMessagesRef.current,
      previousRoadEventsRef.current,
      lastAcknowledgedDriverActionsRef.current,
      lastSpokenAtRef.current
        ? Math.round((Date.now() - lastSpokenAtRef.current) / 1000)
        : undefined,
      false,
    );
    drivingContext.distanceToRiskMetres = VOICE_PREFETCH_SPOKEN_DISTANCE_METRES;

    const cacheKey = getCompanionCacheKey(drivingContext);
    const existing = cachedCompanionResponsesRef.current.get(cacheKey);
    if (existing && Date.now() - existing.createdAt < VOICE_PREFETCH_MAX_AGE_MS) return;
    if (pendingPrefetchKeysRef.current.has(cacheKey)) return;

    pendingPrefetchKeysRef.current.add(cacheKey);
    logVoice("prefetching upcoming voice warning", {
      key: cacheKey,
      realDistanceMetres: distance,
      spokenDistanceMetres: VOICE_PREFETCH_SPOKEN_DISTANCE_METRES,
      event,
    });

    const controller = new AbortController();
    void fetchCompanionPayload(drivingContext, controller.signal)
      .then((payload) => {
        if (!payload.audioBase64 || !payload.text.trim()) return;
        cachedCompanionResponsesRef.current.set(cacheKey, {
          ...payload,
          key: cacheKey,
          createdAt: Date.now(),
        });
        logVoice("prefetched voice warning ready", { key: cacheKey, text: payload.text });
      })
      .catch((caughtError) => {
        if ((caughtError as Error).name !== "AbortError") {
          logVoice("voice prefetch failed", caughtError);
        }
      })
      .finally(() => {
        pendingPrefetchKeysRef.current.delete(cacheKey);
      });

    return () => {
      controller.abort();
      pendingPrefetchKeysRef.current.delete(cacheKey);
    };
  }, [
    fetchCompanionPayload,
    isContextFresh,
    isSupported,
    logVoice,
    predictiveContext,
    settings.mode,
    settings.talkativeness,
    warningSettings,
  ]);

  useEffect(() => {
    latestContextRef.current = context;
    if (!context.isActive || settings.mode === "off" || !isAudioUnlocked) {
      lastSpeedCueRef.current.band = "none";
      return;
    }

    const speedDelta =
      typeof context.speedKmh === "number" && typeof context.speedLimitKmh === "number"
        ? context.speedKmh - context.speedLimitKmh
        : 0;

    if (speedDelta <= 0) {
      lastSpeedCueRef.current.band = "none";
      return;
    }

    const band = speedDelta >= 7 ? "strong" : "over";
    const now = Date.now();
    const lastCue = lastSpeedCueRef.current;
    const cooldown = band === "strong" ? SPEED_STRONG_CUE_COOLDOWN_MS : SPEED_CUE_COOLDOWN_MS;
    const crossedIntoOverLimit = lastCue.band === "none";
    const escalatedToStrongCue = band === "strong" && lastCue.band !== "strong";

    if (crossedIntoOverLimit || escalatedToStrongCue || now - lastCue.time >= cooldown) {
      playSpeedCue(band);
      lastSpeedCueRef.current = { band, time: now };
      logVoice("speed cue played", { band, speedDelta: Math.round(speedDelta) });
    }
  }, [
    context,
    isAudioUnlocked,
    logVoice,
    playSpeedCue,
    settings.mode,
  ]);

  useEffect(() => {
    latestContextRef.current = context;
    if (!context.isActive || settings.mode === "off") return;

    let [event] = buildVoiceWarningEvents(context, warningSettings);
    if (
      event?.type === "calm_reminder" &&
      settings.buddyMode &&
      settings.talkativeness >= 35
    ) {
      event = {
        ...event,
        type: "buddy_observation",
        priority: 15,
        message: "Quiet-road companion observation",
      };
    }
    if (
      !event &&
      settings.engineerMode &&
      settings.talkativeness >= 25 &&
      (context.dashboardDrivingState.currentSpeed ||
        context.dashboardDrivingState.upcomingZoneType !== "section" ||
        context.currentConditions?.surfaceCondition === "wet")
    ) {
      event = {
        type: "engineer_callout",
        priority: 68,
        severity: context.riskLevel === "high" ? "high" : "medium",
        message: "Engineer driving callout",
        segmentKey: context.segmentKey,
      };
    }
    if (
      !event &&
      settings.buddyMode &&
      settings.talkativeness >= 35 &&
      context.riskLevel === "low"
    ) {
      event = {
        type: "buddy_observation",
        priority: 15,
        severity: "low",
        message: "Quiet-road companion observation",
        segmentKey: context.segmentKey,
      };
    }
    if (
      !event ||
      (event.type !== "speed_warning" &&
        event.priority < getPriorityThreshold(settings.talkativeness))
    ) return;
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

    const distanceToWarning = context.dashboardDrivingState.distanceToUpcomingWarningMetres;
    const isUrgent =
      event.type === "speed_warning" ||
      (typeof distanceToWarning === "number" &&
        distanceToWarning <= URGENT_WARNING_DISTANCE_METRES);
    const delay = isUrgent
      ? 0
      : MIN_HUMAN_DELAY_MS +
        Math.round(Math.random() * (MAX_HUMAN_DELAY_MS - MIN_HUMAN_DELAY_MS));
    const timeoutId = window.setTimeout(() => {
      scheduledSpeechRef.current = null;
      if (!isContextFresh(latestContextRef.current)) {
        setDebugStatus("Suppressed by cooldown");
        logVoice("cancelled delayed event after vehicle moved on", latestContextRef.current.dashboardDrivingState);
        return;
      }
      void requestAndPlay(
        buildDrivingContextJson(
          latestContextRef.current,
          event,
          lastMessagesRef.current,
          previousRoadEventsRef.current,
          lastAcknowledgedDriverActionsRef.current,
          secondsSinceLastMessage,
          driverHasSlowedDown,
        ),
        event.priority,
      );
    }, delay);
    scheduledSpeechRef.current = { key: contextKey, priority: event.priority, timeoutId };
  }, [
    context,
    isContextFresh,
    logVoice,
    requestAndPlay,
    settings.buddyMode,
    settings.engineerMode,
    settings.mode,
    settings.talkativeness,
    warningSettings,
  ]);

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
