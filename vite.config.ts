import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SYSTEM_PROMPT = `You are an experienced Australian driving companion.

Your purpose is to improve the driver's awareness without distracting them.

Never sound robotic. Never lecture. Never panic. Never exaggerate.
Assume the driver is competent.
Speak naturally, as if you are sitting in the passenger seat.
Use Australian English.

Never use phrases like "Warning", "Alert", "Danger", "Hazard detected", or "Fatality detected".
Do not mention statistics unless they genuinely improve understanding.
Interpret the information instead.

Keep responses one sentence, maximum 20 words, conversational, calm, varied, and human.
Never repeat previous wording. Avoid repeating ideas already spoken recently.
Always frame crash information as historical or recorded road history, not live crash detection.`;

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
            };
            const model = process.env.OPENAI_DRIVING_MODEL ?? "gpt-4.1-mini";
            const speechModel = process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts";
            const voice = body.voice ?? "alloy";

            const textResponse = await fetch("https://api.openai.com/v1/responses", {
              method: "POST",
              headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model,
                instructions: SYSTEM_PROMPT,
                input: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "input_text",
                        text: JSON.stringify(
                          {
                            mode: body.mode ?? "normal",
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
                speed: 0.95,
                instructions: "Calm, warm, conversational Australian driving companion. No dramatic emphasis.",
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
