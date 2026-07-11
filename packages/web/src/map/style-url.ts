/**
 * MapTiler style URL for MapLibre. Key is the referrer-restricted browser key
 * from runtime `/config.json` (`mapTilerApiKey`).
 */
export function mapTilerStyleUrl(apiKey: string): string {
  const key = apiKey.trim();
  return `https://api.maptiler.com/maps/streets-v2-dark/style.json?key=${encodeURIComponent(key)}`;
}

export function hasMapTilerKey(apiKey: string): boolean {
  return apiKey.trim().length > 0;
}
