import type { IncomingMessage, ServerResponse } from "http";

const getPublicMapboxToken = (): string | undefined =>
  process.env.VITE_MAPBOX_ACCESS_TOKEN ||
  process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN ||
  process.env.PUBLIC_MAPBOX_ACCESS_TOKEN ||
  process.env.MAPBOX_ACCESS_TOKEN;

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
) => {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "public, max-age=300, s-maxage=300");
  response.end(JSON.stringify(payload));
};

export default function handler(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const token = getPublicMapboxToken()?.trim();
  if (!token) {
    sendJson(response, 404, { error: "Mapbox token is not configured." });
    return;
  }

  if (!token.startsWith("pk.")) {
    sendJson(response, 400, {
      error: "Configured Mapbox token must be a public token beginning with pk.",
    });
    return;
  }

  sendJson(response, 200, { token });
}
