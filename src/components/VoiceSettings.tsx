import { useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import type {
  VoiceIntensity,
  VoiceWarningSettings,
  VoiceWarningType,
} from "../voice/voiceWarnings";

type VoiceSettingsProps = {
  isSupported: boolean;
  voices: SpeechSynthesisVoice[];
  settings: VoiceWarningSettings;
  lastSpoken: string;
  onSettingsChange: (settings: VoiceWarningSettings) => void;
  onEnable: () => void;
  onDisable: () => void;
  onTestVoice: () => void;
  onTestWarningType: (type: VoiceWarningType) => void;
};

const TEST_TYPES: Array<{ type: VoiceWarningType; label: string }> = [
  { type: "speed_warning", label: "Speed" },
  { type: "crash_history_warning", label: "History" },
  { type: "fatal_history_warning", label: "Fatal" },
  { type: "wet_weather_match_warning", label: "Wet" },
  { type: "dark_condition_warning", label: "Dark" },
  { type: "following_distance_warning", label: "Distance" },
];

export function VoiceSettings({
  isSupported,
  voices,
  settings,
  lastSpoken,
  onSettingsChange,
  onEnable,
  onDisable,
  onTestVoice,
  onTestWarningType,
}: VoiceSettingsProps) {
  const [isOpen, setIsOpen] = useState(false);

  const updateSetting = <Key extends keyof VoiceWarningSettings>(
    key: Key,
    value: VoiceWarningSettings[Key],
  ) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  return (
    <section className={`voice-settings ${isOpen ? "voice-settings--open" : ""}`}>
      <button
        className={`voice-settings__toggle ${settings.enabled ? "is-active" : ""}`}
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
      >
        {settings.enabled ? <Volume2 size={17} aria-hidden="true" /> : <VolumeX size={17} aria-hidden="true" />}
        <span>Voice</span>
      </button>

      {isOpen && (
        <div className="voice-settings__panel">
          {!isSupported ? (
            <p>Speech synthesis is unavailable in this browser.</p>
          ) : (
            <>
              <div className="voice-settings__actions">
                <button
                  className="button button--primary"
                  type="button"
                  onClick={settings.enabled ? onDisable : onEnable}
                >
                  {settings.enabled ? "Disable voice" : "Enable voice warnings"}
                </button>
                <button className="button" type="button" onClick={onTestVoice}>
                  Test voice
                </button>
              </div>

              <label className="field">
                <span>Voice intensity</span>
                <select
                  value={settings.intensity}
                  onChange={(event) =>
                    updateSetting("intensity", event.target.value as VoiceIntensity)
                  }
                >
                  <option value="minimal">Minimal</option>
                  <option value="normal">Normal</option>
                  <option value="detailed">Detailed</option>
                </select>
              </label>

              <label className="field">
                <span>Voice type</span>
                <select
                  value={settings.voiceURI}
                  onChange={(event) => updateSetting("voiceURI", event.target.value)}
                >
                  <option value="">Browser default</option>
                  {voices.map((voice) => (
                    <option key={voice.voiceURI} value={voice.voiceURI}>
                      {voice.name} ({voice.lang})
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

              <div className="voice-settings__checks">
                <label>
                  <input
                    type="checkbox"
                    checked={settings.muteSpeedWarnings}
                    onChange={(event) => updateSetting("muteSpeedWarnings", event.target.checked)}
                  />
                  <span>Mute speed warnings</span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.muteCrashHistoryWarnings}
                    onChange={(event) =>
                      updateSetting("muteCrashHistoryWarnings", event.target.checked)
                    }
                  />
                  <span>Mute crash-history warnings</span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.muteCalmReminders}
                    onChange={(event) => updateSetting("muteCalmReminders", event.target.checked)}
                  />
                  <span>Mute calm reminders</span>
                </label>
              </div>

              <div className="voice-settings__tests" aria-label="Developer voice tests">
                {TEST_TYPES.map((test) => (
                  <button
                    key={test.type}
                    className="button"
                    type="button"
                    onClick={() => onTestWarningType(test.type)}
                  >
                    {test.label}
                  </button>
                ))}
              </div>

              <small>{lastSpoken}</small>
              <small>Historical crash data only. Voice warnings are approximate.</small>
            </>
          )}
        </div>
      )}
    </section>
  );
}

