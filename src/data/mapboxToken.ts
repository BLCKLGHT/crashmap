export const getMapboxToken = (): string | undefined => {
  const meta = import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  };

  return (
    meta.env?.VITE_MAPBOX_ACCESS_TOKEN ||
    meta.env?.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN ||
    meta.env?.PUBLIC_MAPBOX_ACCESS_TOKEN ||
    meta.env?.MAPBOX_ACCESS_TOKEN
  )?.trim();
};

export const fetchRuntimeMapboxToken = async (): Promise<string | null> => {
  const response = await fetch("/api/mapbox-token", {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { token?: string };
  return payload.token?.startsWith("pk.") ? payload.token : null;
};
