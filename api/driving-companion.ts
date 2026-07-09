import type { IncomingMessage, ServerResponse } from "http";
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

const BUDDY_PROMPT = `Buddy Mode may make an occasional conversational observation on a quiet road.
For a buddy_observation trigger, choose one genuinely useful or interesting detail from current weather or supplied headlines.
Never invent a headline, event, weather fact, or source.
Do not read a headline verbatim or sound like a newsreader. Mention it conversationally in one short sentence.
If nothing supplied is worth mentioning, return exactly: SILENCE
Buddy observations never override speed or dashboard warning information.`;

const TTS_INSTRUCTIONS =
  "Warm, calm Australian passenger. Natural conversational rhythm, quiet confidence, subtle expression. Keep it brief and clear.";

const HEADLINE_CACHE_MS = 15 * 60 * 1000;
const HEADLINE_FEED_URL =
  "https://news.google.com/rss/search?q=Tasmania&hl=en-AU&gl=AU&ceid=AU%3Aen";
let headlineCache: { expiresAt: number; headlines: string[] } | null = null;

const decodeXmlText = (value: string): string =>
  value
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+-\s+[^-]+$/, "")
    .trim();

const getCurrentHeadlines = async (): Promise<string[]> => {
  if (headlineCache && headlineCache.expiresAt > Date.now()) return headlineCache.headlines;

  try {
    const feedResponse = await fetch(HEADLINE_FEED_URL, {
      headers: { "user-agent": "Tasmania Crash Map driving companion" },
      signal: AbortSignal.timeout(2500),
    });
    if (!feedResponse.ok) return [];
    const xml = await feedResponse.text();
    const headlines = [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>/gi)]
      .slice(0, 6)
      .map((match) => decodeXmlText(match[1] ?? ""))
      .filter(Boolean);
    headlineCache = { expiresAt: Date.now() + HEADLINE_CACHE_MS, headlines };
    return headlines;
  } catch {
    return headlineCache?.headlines ?? [];
  }
};

let cachedUserHistory: UserHistory | null | undefined;

const getUserHistory = (): UserHistory | null => {
  if (cachedUserHistory !== undefined) return cachedUserHistory;

  try {
    const file = readFileSync(new URL("../userHistory.ben.json", import.meta.url), "utf8");
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

const readBody = async (request: IncomingMessage): Promise<string> =>
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

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
) => {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
};

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    sendJson(response, 503, { error: "OpenAI API key is not configured on the server." });
    return;
  }

  try {
    const body = JSON.parse(await readBody(request)) as {
      context: unknown;
      voice?: string;
      mode?: string;
      buddyMode?: boolean;
      talkativeness?: number;
      speechSpeed?: number;
    };
    const model = process.env.OPENAI_DRIVING_MODEL ?? "gpt-4.1-mini";
    const speechModel = process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts";
    const voice = body.voice ?? "alloy";
    const speechSpeed =
      typeof body.speechSpeed === "number"
        ? Math.min(1.5, Math.max(0.8, body.speechSpeed))
        : 1.12;
    const driverProfile = getUserHistory();
    const personaFoundation = getPersonaFoundation(driverProfile);
    const triggerType = (body.context as { trigger?: { type?: string } } | null)?.trigger?.type;
    const isBuddyObservation = body.buddyMode === true && triggerType === "buddy_observation";
    const currentHeadlines = isBuddyObservation ? await getCurrentHeadlines() : [];

    const textResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions: `${SYSTEM_PROMPT}\n\n${USER_CONTEXT_PROMPT}\n\n${personaFoundation}${body.buddyMode ? `\n\n${BUDDY_PROMPT}` : ""}`,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify(
                  {
                    mode: body.mode ?? "normal",
                    buddyMode: body.buddyMode === true,
                    talkativeness: body.talkativeness ?? 50,
                    currentHeadlines,
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
      sendJson(response, 200, { text: "", mimeType: "", audioBase64: "" });
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
        instructions: TTS_INSTRUCTIONS,
      }),
    });

    if (!audioResponse.ok) {
      throw new Error(`OpenAI speech request failed with ${audioResponse.status}`);
    }

    sendJson(response, 200, {
      text,
      mimeType: "audio/mpeg",
      audioBase64: Buffer.from(await audioResponse.arrayBuffer()).toString("base64"),
    });
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Driving companion request failed.",
    });
  }
}
