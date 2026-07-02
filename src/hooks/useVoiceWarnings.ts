import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildVoiceWarningEvents,
  DEFAULT_VOICE_WARNING_SETTINGS,
  pickVoicePhrase,
  VOICE_WARNING_COOLDOWNS,
} from "../voice/voiceWarnings";
import type {
  VoiceWarningContext,
  VoiceWarningEvent,
  VoiceWarningSettings,
  VoiceWarningType,
} from "../voice/voiceWarnings";

type SpokenWarningState = {
  type: VoiceWarningType;
  priority: number;
  severity: VoiceWarningEvent["severity"];
  segmentKey: string;
  spokenAt: number;
};

const chooseDefaultVoiceURI = (voices: SpeechSynthesisVoice[]): string => {
  const preferred =
    voices.find((voice) => voice.lang.toLowerCase() === "en-au") ??
    voices.find((voice) => voice.lang.toLowerCase().startsWith("en-au")) ??
    voices.find((voice) => voice.lang.toLowerCase().startsWith("en-gb")) ??
    voices.find((voice) => voice.lang.toLowerCase().startsWith("en")) ??
    voices[0];

  return preferred?.voiceURI ?? "";
};

export function useVoiceWarnings(context: VoiceWarningContext) {
  const isSupported =
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof window.SpeechSynthesisUtterance !== "undefined";
  const [settings, setSettings] = useState<VoiceWarningSettings>(
    DEFAULT_VOICE_WARNING_SETTINGS,
  );
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [lastSpoken, setLastSpoken] = useState<string>("Voice warnings idle");
  const lastByTypeRef = useRef<Partial<Record<VoiceWarningType, SpokenWarningState>>>({});
  const currentWarningRef = useRef<SpokenWarningState | null>(null);

  useEffect(() => {
    if (!isSupported) return;

    const loadVoices = () => {
      const nextVoices = window.speechSynthesis.getVoices();
      setVoices(nextVoices);
      setSettings((current) =>
        current.voiceURI || !nextVoices.length
          ? current
          : { ...current, voiceURI: chooseDefaultVoiceURI(nextVoices) },
      );
    };

    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
  }, [isSupported]);

  const selectedVoice = useMemo(
    () => voices.find((voice) => voice.voiceURI === settings.voiceURI) ?? null,
    [settings.voiceURI, voices],
  );

  const speak = useCallback(
    (event: VoiceWarningEvent, ignoreCooldown = false) => {
      if (!isSupported || !settings.enabled) return false;

      const now = Date.now();
      const lastForType = lastByTypeRef.current[event.type];
      const cooldown = VOICE_WARNING_COOLDOWNS[event.type];
      const sameSegment = lastForType?.segmentKey === event.segmentKey;
      const isMoreSevere = event.priority > (lastForType?.priority ?? 0);

      if (
        !ignoreCooldown &&
        lastForType &&
        sameSegment &&
        !isMoreSevere &&
        now - lastForType.spokenAt < cooldown
      ) {
        return false;
      }

      if (
        window.speechSynthesis.speaking &&
        currentWarningRef.current &&
        event.priority <= currentWarningRef.current.priority
      ) {
        return false;
      }

      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
      }

      const utterance = new SpeechSynthesisUtterance(event.message);
      utterance.voice = selectedVoice;
      utterance.volume = settings.volume;
      utterance.rate = 0.95;
      utterance.pitch = 1;
      utterance.lang = selectedVoice?.lang ?? "en-AU";

      const spokenState = {
        type: event.type,
        priority: event.priority,
        severity: event.severity,
        segmentKey: event.segmentKey,
        spokenAt: now,
      };

      currentWarningRef.current = spokenState;
      lastByTypeRef.current[event.type] = spokenState;
      utterance.onend = () => {
        currentWarningRef.current = null;
      };
      utterance.onerror = () => {
        currentWarningRef.current = null;
      };

      setLastSpoken(event.message);
      window.speechSynthesis.speak(utterance);
      return true;
    },
    [isSupported, selectedVoice, settings.enabled, settings.volume],
  );

  useEffect(() => {
    if (!context.isActive || !settings.enabled) return;
    const [event] = buildVoiceWarningEvents(context, settings);
    if (event) speak(event);
  }, [context, settings, speak]);

  const enableVoiceWarnings = useCallback(() => {
    setSettings((current) => ({ ...current, enabled: true }));
    if (!isSupported) return;

    // iOS usually requires speech to start from a user gesture; this short phrase unlocks it.
    const event: VoiceWarningEvent = {
      type: "calm_reminder",
      priority: 1,
      severity: "low",
      message: "Voice warnings are on.",
      segmentKey: "voice-enabled",
    };
    window.setTimeout(() => speak(event, true), 0);
  }, [isSupported, speak]);

  const disableVoiceWarnings = useCallback(() => {
    setSettings((current) => ({ ...current, enabled: false }));
    if (isSupported) window.speechSynthesis.cancel();
  }, [isSupported]);

  const testVoice = useCallback(() => {
    const event: VoiceWarningEvent = {
      type: "calm_reminder",
      priority: 99,
      severity: "low",
      message:
        "Just a heads up. Voice warnings will use historical road information only.",
      segmentKey: "test-voice",
    };
    speak(event, true);
  }, [speak]);

  const testWarningType = useCallback(
    (type: VoiceWarningType) => {
      const event: VoiceWarningEvent = {
        type,
        priority: 99,
        severity: type === "fatal_history_warning" ? "high" : "medium",
        message: pickVoicePhrase(type),
        segmentKey: `test-${type}`,
      };
      speak(event, true);
    },
    [speak],
  );

  return {
    isSupported,
    voices,
    settings,
    setSettings,
    enableVoiceWarnings,
    disableVoiceWarnings,
    testVoice,
    testWarningType,
    lastSpoken,
  };
}

