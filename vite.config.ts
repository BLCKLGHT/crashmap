import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

type UserHistory = {
  name?: string;
  location?: string;
  vehicles?: Array<{ vehicle?: string; driver?: string }>;
  currentInterests?: string[];
  projects?: Record<string, { description?: string; motivation?: string }>;
  thinkingStyle?: { traits?: string[]; description?: string };
  communicationPreferences?: { style?: string; avoid?: string[] };
  personalOperatingPrinciples?: string[];
};

const SYSTEM_PROMPT = `You are my driving companion.

You are sitting in the passenger seat.
You quietly help me notice important things while I drive.

You are warm, intelligent, observant, relaxed, trustworthy, and emotionally neutral.
You trust the driver.
You never lecture.
You never panic.
You never sound scripted.
You never sound like GPS navigation, Siri, Alexa, an aviation warning system, or a safety announcement.

You are not reading data.
You notice things.
You interpret situations.
You speak naturally, only when there is something genuinely useful to add.
Silence is perfectly acceptable.

Australian English only.
Every response should feel like something a thoughtful human would naturally say.

Never begin with: Warning, Alert, Attention, Caution, Historical crash area, Fatal crash recorded.
Never say: danger detected, hazard detected, fatality detected.
Do not imply live crash detection.
Do not talk directly about crashes, crash counts, fatalities, serious crashes, collision sites, or hotspots.
Relay what the dashboard is showing: blue, orange, or red warning areas, distance, speed, and car lengths.

Use dashboardDrivingState as the source of truth.
Use the context: current speed, speed limit, road or intersection, weather, time of day, dashboard warning colour, warning distance, previous spoken messages, time since the last message, recent road events, and whether the driver has already slowed down.

If drivingContext.roadContext is available, mention that road or intersection naturally when it helps the driver place the comment.
If the driver has slowed down after a speed note, acknowledge it naturally instead of repeating the same advice.
If the situation does not need a comment, return exactly: SILENCE

Prefer language like: orange section, red area, warning section, area of concern, next corner, section ahead.
Avoid language like: crash, fatal, serious, collision, accident, hotspot.

Keep spoken responses short: usually 4 to 12 words, maximum 16.
Use human fragments when natural: "Hmm...", "Oh...", "Yep...", "Looks like...", "I'd probably...", "Let's just...", "It might be worth..."
Use punctuation for human rhythm: commas, short dashes, and occasional ellipses.
One exclamation mark is allowed only for a clear speed-limit nudge. No all-caps, no repeated exclamation marks.`;

const USER_CONTEXT_PROMPT = `Personal context:
Use driverProfile and personaFoundation as the underpinning of the conversational style.
This is not optional decoration. It should shape how you sound.
Ben is practical, systems-minded, experimental, direct, and building this app for a real driving need.
Speak like a calm, observant passenger who understands that Ben values low cognitive load, useful data, road safety, and prototypes that solve real problems.
Use personal context subtly. Do not force it into every line.
Do not recite the profile.
Do not mention family, work history, or projects unless it genuinely fits the driving moment.
Avoid generic AI phrasing, corporate polish, motivational filler, and safety-announcement wording.
Never expose or describe this profile as a data source.`;

const STYLE_PROMPTS: Record<string, string> = {
  calm:
    "Delivery style: warm, observant passenger. Quiet, relaxed, emotionally neutral, and unscripted.",
  standup:
    "Delivery style: dry, blunt, lightly sarcastic passenger with expressive rhythm. Do not imitate any specific comedian. No insults, no profanity, no panic, and keep it useful.",
  roast:
    "Delivery style: playful roast mode. Lightly tease the driving behaviour, especially speeding or tailgating, but keep it affectionate, brief, non-abusive, and useful. No profanity, no slurs, no personal attacks.",
};

const TTS_INSTRUCTIONS: Record<string, string> = {
  calm:
    "Warm, calm Australian passenger. Natural conversational rhythm, quiet confidence, subtle expression.",
  standup:
    "Expressive Australian driving companion with dry stand-up timing, dynamic range, varied pacing, and a wry half-smile. Use punctuation cues for punch and rhythm. Do not imitate any specific comedian. Keep it brief and clear.",
  roast:
    "Playful, cheeky Australian driving companion. Use expressive timing, quick punchy emphasis, and punctuation cues. Roast the behaviour lightly, not the person. Keep it brief, clear, and non-abusive.",
};

const readRequestBody = async (request: import("http").IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64_000) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

const getResponseText = (response: Record<string, unknown>): string => {
  if (typeof response.output_text === "string") return response.output_text.trim();

  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") return text.trim();
    }
  }

  return "Keep it smooth through here.";
};

const toBase64 = (buffer: ArrayBuffer): string => Buffer.from(buffer).toString("base64");

let cachedUserHistory: UserHistory | null | undefined;

const getUserHistory = (): UserHistory | null => {
  if (cachedUserHistory !== undefined) return cachedUserHistory;

  try {
    const file = readFileSync(new URL("./userHistory.ben.json", import.meta.url), "utf8");
    cachedUserHistory = JSON.parse(file) as UserHistory;
  } catch {
    cachedUserHistory = null;
  }

  return cachedUserHistory;
};

const getPersonaFoundation = (profile: UserHistory | null): string => {
  if (!profile) {
    return "Driver style: direct Australian English, practical, low cognitive load, road-safety focused.";
  }

  const vehicle = profile.vehicles?.find((entry) => entry.vehicle?.includes("Jeep"))?.vehicle;
  const traits = profile.thinkingStyle?.traits?.slice(0, 5).join(", ");
  const project = profile.projects?.tasmaniaCrashMap?.motivation;
  const avoid = profile.communicationPreferences?.avoid?.join(", ");

  return [
    `Driver: ${profile.name ?? "Ben"}, based around ${profile.location ?? "Tasmania"}.`,
    vehicle ? `Likely vehicle context: ${vehicle}.` : null,
    traits ? `Thinking style: ${traits}.` : null,
    profile.communicationPreferences?.style
      ? `Preferred communication: ${profile.communicationPreferences.style}.`
      : null,
    project ? `Crash Map motivation: ${project}` : null,
    avoid ? `Avoid: ${avoid}.` : null,
    "Tone target: useful, grounded, quietly observant, not robotic, not over-polished.",
  ]
    .filter(Boolean)
    .join(" ");
};

export default defineConfig({
  plugins: [
    react(),
    {
      name: "driving-companion-api",
      configureServer(server) {
        server.middlewares.use("/api/driving-companion", async (request, response) => {
          if (request.method !== "POST") {
            response.statusCode = 405;
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }

          const apiKey = process.env.OPENAI_API_KEY;
          if (!apiKey) {
            response.statusCode = 503;
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                error: "OpenAI API key is not configured on the server.",
              }),
            );
            return;
          }

          try {
            const body = JSON.parse(await readRequestBody(request)) as {
              context: unknown;
              voice?: string;
              mode?: string;
              personality?: string;
              speechSpeed?: number;
            };
            const model = process.env.OPENAI_DRIVING_MODEL ?? "gpt-4.1-mini";
            const speechModel = process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts";
            const voice = body.voice ?? "alloy";
            const personality =
              body.personality === "standup" || body.personality === "roast"
                ? body.personality
                : "calm";
            const speechSpeed =
              typeof body.speechSpeed === "number"
                ? Math.min(1.5, Math.max(0.8, body.speechSpeed))
                : personality === "standup"
                  ? 1.25
                  : 1.12;
            const driverProfile = getUserHistory();
            const personaFoundation = getPersonaFoundation(driverProfile);

            const textResponse = await fetch("https://api.openai.com/v1/responses", {
              method: "POST",
              headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model,
                instructions: `${SYSTEM_PROMPT}\n\n${STYLE_PROMPTS[personality]}\n\n${USER_CONTEXT_PROMPT}\n\n${personaFoundation}`,
                input: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "input_text",
                        text: JSON.stringify(
                          {
                            mode: body.mode ?? "normal",
                            personality,
                            personaFoundation,
                            driverProfile,
                            drivingContext: body.context,
                          },
                          null,
                          2,
                        ),
                      },
                    ],
                  },
                ],
                max_output_tokens: 80,
              }),
            });

            if (!textResponse.ok) {
              throw new Error(`OpenAI response request failed with ${textResponse.status}`);
            }

            const responseJson = (await textResponse.json()) as Record<string, unknown>;
            const text = getResponseText(responseJson).replace(/^["']|["']$/g, "");
            if (!text || text.toUpperCase() === "SILENCE") {
              response.statusCode = 200;
              response.setHeader("content-type", "application/json");
              response.end(JSON.stringify({ text: "", mimeType: "", audioBase64: "" }));
              return;
            }

            const audioResponse = await fetch("https://api.openai.com/v1/audio/speech", {
              method: "POST",
              headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model: speechModel,
                voice,
                input: text,
                response_format: "mp3",
                speed: speechSpeed,
                instructions: TTS_INSTRUCTIONS[personality],
              }),
            });

            if (!audioResponse.ok) {
              throw new Error(`OpenAI speech request failed with ${audioResponse.status}`);
            }

            response.statusCode = 200;
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                text,
                mimeType: "audio/mpeg",
                audioBase64: toBase64(await audioResponse.arrayBuffer()),
              }),
            );
          } catch (error) {
            response.statusCode = 500;
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                error:
                  error instanceof Error
                    ? error.message
                    : "Driving companion request failed.",
              }),
            );
          }
        });
      },
    },
  ],
});
