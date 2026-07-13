import { useState } from "react";
import { Bot, Volume2, VolumeX } from "lucide-react";
import type {
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
  debugStatus: string;
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
  { type: "engineer_callout", label: "Engineer" },
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
  debugStatus,
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

              <label className="voice-settings__range">
                <span>
                  <strong>Conversation</strong>
                  <output>{settings.talkativeness <= 15 ? "Mostly silent" : settings.talkativeness >= 80 ? "Chatty" : "Balanced"}</output>
                </span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  value={settings.talkativeness}
                  onChange={(event) => updateSetting("talkativeness", Number(event.target.value))}
                  aria-label="Companion talkativeness"
                />
                <span className="voice-settings__range-labels">
                  <small>Silent</small>
                  <small>Chatty</small>
                </span>
              </label>

              <label className="voice-settings__buddy">
                <span>
                  <strong>Buddy Mode</strong>
                  <small>Occasional weather, headlines and observations on quiet stretches.</small>
                </span>
                <input
                  type="checkbox"
                  checked={settings.buddyMode}
                  onChange={(event) => updateSetting("buddyMode", event.target.checked)}
                />
              </label>

              <label className="voice-settings__buddy">
                <span>
                  <strong>Engineer Mode</strong>
                  <small>F1-style speed, corner, weather and driving rhythm advice.</small>
                </span>
                <input
                  type="checkbox"
                  checked={settings.engineerMode}
                  onChange={(event) => updateSetting("engineerMode", event.target.checked)}
                />
              </label>

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
              {import.meta.env.DEV && <small>Debug: {debugStatus}</small>}
              <small>Uses historical road information only. It does not detect live hazards.</small>
            </>
          )}
        </div>
      )}
    </section>
  );
}
