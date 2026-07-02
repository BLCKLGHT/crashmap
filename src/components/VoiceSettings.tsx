import { useState } from "react";
import { Bot, Volume2, VolumeX } from "lucide-react";
import type {
  DrivingCompanionMode,
  DrivingCompanionPersonality,
  DrivingCompanionSettings,
  DrivingCompanionSpeechSpeed,
  DrivingCompanionVoice,
  VoiceWarningType,
} from "../voice/voiceWarnings";

type VoiceSettingsProps = {
  isSupported: boolean;
  settings: DrivingCompanionSettings;
  lastSpoken: string;
  error: string | null;
  isSpeaking: boolean;
  isAudioUnlocked: boolean;
  onSettingsChange: (settings: DrivingCompanionSettings) => void;
  onEnable: () => void;
  onDisable: () => void;
  onTestVoice: () => void;
  onTestWarningType: (type: VoiceWarningType) => void;
};

const VOICES: DrivingCompanionVoice[] = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
];

const TEST_TYPES: Array<{ type: VoiceWarningType; label: string }> = [
  { type: "speed_warning", label: "Speeding" },
  { type: "fatal_history_warning", label: "Fatal ahead" },
  { type: "wet_weather_match_warning", label: "Heavy rain" },
  { type: "wet_weather_match_warning", label: "Wet match" },
  { type: "crash_history_warning", label: "High history" },
  { type: "calm_reminder", label: "Quiet road" },
];

export function VoiceSettings({
  isSupported,
  settings,
  lastSpoken,
  error,
  isSpeaking,
  isAudioUnlocked,
  onSettingsChange,
  onEnable,
  onDisable,
  onTestVoice,
  onTestWarningType,
}: VoiceSettingsProps) {
  const [isOpen, setIsOpen] = useState(false);

  const updateSetting = <Key extends keyof DrivingCompanionSettings>(
    key: Key,
    value: DrivingCompanionSettings[Key],
  ) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  const isEnabled = settings.mode !== "off";

  return (
    <section className={`voice-settings ${isOpen ? "voice-settings--open" : ""}`}>
      <button
        className={`voice-settings__toggle ${isEnabled ? "is-active" : ""}`}
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
      >
        {isEnabled ? <Volume2 size={17} aria-hidden="true" /> : <VolumeX size={17} aria-hidden="true" />}
        <span>Companion</span>
      </button>

      {isOpen && (
        <div className="voice-settings__panel">
          {!isSupported ? (
            <p>AI Driving Companion is unavailable in this browser.</p>
          ) : (
            <>
              <div className="voice-settings__header">
                <Bot size={18} aria-hidden="true" />
                <strong>Driving Companion</strong>
                <span>{isSpeaking ? "Speaking" : "Ready"}</span>
              </div>

              <div className="voice-settings__mode" role="radiogroup" aria-label="Driving companion mode">
                {(["off", "minimal", "normal", "coaching"] as DrivingCompanionMode[]).map((mode) => (
                  <button
                    key={mode}
                    className={settings.mode === mode ? "is-active" : ""}
                    type="button"
                    onClick={() => updateSetting("mode", mode)}
                  >
                    {mode === "off" ? "Off" : mode[0].toUpperCase() + mode.slice(1)}
                  </button>
                ))}
              </div>

              <div className="voice-settings__actions">
                <button
                  className="button button--primary"
                  type="button"
                  onClick={isEnabled ? onDisable : onEnable}
                >
                  {isEnabled ? "Turn off" : "Enable companion"}
                </button>
                <button className="button" type="button" onClick={onTestVoice}>
                  Test voice
                </button>
              </div>

              <div className="voice-settings__mode" role="radiogroup" aria-label="Driving companion personality">
                {([
                  ["calm", "Calm"],
                  ["standup", "Edgy comic"],
                ] as Array<[DrivingCompanionPersonality, string]>).map(([personality, label]) => (
                  <button
                    key={personality}
                    className={settings.personality === personality ? "is-active" : ""}
                    type="button"
                    onClick={() => updateSetting("personality", personality)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="voice-settings__mode" role="radiogroup" aria-label="Driving companion voice speed">
                {([
                  ["normal", "Normal"],
                  ["fast", "Fast"],
                  ["faster", "Faster"],
                ] as Array<[DrivingCompanionSpeechSpeed, string]>).map(([speechSpeed, label]) => (
                  <button
                    key={speechSpeed}
                    className={settings.speechSpeed === speechSpeed ? "is-active" : ""}
                    type="button"
                    onClick={() => updateSetting("speechSpeed", speechSpeed)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <label className="field">
                <span>OpenAI voice</span>
                <select
                  value={settings.voice}
                  onChange={(event) =>
                    updateSetting("voice", event.target.value as DrivingCompanionVoice)
                  }
                >
                  {VOICES.map((voice) => (
                    <option key={voice} value={voice}>
                      {voice}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Volume</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={settings.volume}
                  onChange={(event) => updateSetting("volume", Number(event.target.value))}
                />
              </label>

              <div className="voice-settings__tests" aria-label="Developer companion tests">
                {TEST_TYPES.map((test, index) => (
                  <button
                    key={`${test.type}-${index}`}
                    className="button"
                    type="button"
                    onClick={() => onTestWarningType(test.type)}
                  >
                    {test.label}
                  </button>
                ))}
              </div>

              <small>
                {error ??
                  (isAudioUnlocked
                    ? lastSpoken
                    : "Tap Enable companion or Test voice once to allow mobile audio playback.")}
              </small>
              <small>Uses historical road information only. It does not detect live hazards.</small>
            </>
          )}
        </div>
      )}
    </section>
  );
}
