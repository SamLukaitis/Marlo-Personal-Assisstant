// Open-Meteo — free, keyless, no signup. Both the geocoding and forecast APIs are public, which
// is why this needs no env var (unlike Google/Microsoft) and works on a fresh deployment.
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

export interface ResolvedPlace {
  name: string;
  country: string | null;
  latitude: number;
  longitude: number;
}

export interface WeatherReport {
  place: string;
  tempC: number;
  highC: number;
  lowC: number;
  condition: string;
}

// WMO weather interpretation codes. Open-Meteo returns the numeric code only, so the wording is
// ours — kept short because these render inside a one-line briefing segment.
const WMO_CODES: Record<number, string> = {
  0: "Clear",
  1: "Mostly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Freezing fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  56: "Freezing drizzle",
  57: "Freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Showers",
  81: "Showers",
  82: "Heavy showers",
  85: "Snow showers",
  86: "Snow showers",
  95: "Thunderstorms",
  96: "Thunderstorms with hail",
  99: "Thunderstorms with hail",
};

interface GeocodeResponse {
  results?: Array<{
    name: string;
    country?: string;
    latitude: number;
    longitude: number;
  }>;
}

interface ForecastResponse {
  current?: { temperature_2m?: number; weather_code?: number };
  daily?: {
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    weather_code?: number[];
  };
}

// Place names don't move, so resolving "Lisbon" to coordinates is a permanently stable answer —
// caching it keeps the daily briefing to one API call instead of two.
const geocodeCache = new Map<string, ResolvedPlace | null>();

export async function geocodePlace(query: string): Promise<ResolvedPlace | null> {
  const key = query.trim().toLowerCase();
  if (!key) return null;
  const cached = geocodeCache.get(key);
  if (cached !== undefined) return cached;

  let resolved: ResolvedPlace | null = null;
  try {
    const url = `${GEOCODE_URL}?name=${encodeURIComponent(query.trim())}&count=1&language=en&format=json`;
    const res = await fetch(url);
    if (res.ok) {
      const data = (await res.json()) as GeocodeResponse;
      const hit = data.results?.[0];
      if (hit) {
        resolved = {
          name: hit.name,
          country: hit.country ?? null,
          latitude: hit.latitude,
          longitude: hit.longitude,
        };
      }
    }
  } catch (err) {
    console.warn("weather: geocode failed", err);
    // Deliberately not cached — a network blip shouldn't permanently poison this place name.
    return null;
  }

  geocodeCache.set(key, resolved);
  return resolved;
}

export async function fetchWeather(location: string): Promise<WeatherReport | null> {
  const place = await geocodePlace(location);
  if (!place) return null;

  try {
    const url =
      `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code` +
      `&timezone=auto&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as ForecastResponse;

    const tempC = data.current?.temperature_2m;
    const highC = data.daily?.temperature_2m_max?.[0];
    const lowC = data.daily?.temperature_2m_min?.[0];
    if (tempC === undefined || highC === undefined || lowC === undefined) return null;

    const code = data.current?.weather_code ?? data.daily?.weather_code?.[0];
    return {
      place: place.country ? `${place.name}, ${place.country}` : place.name,
      tempC: Math.round(tempC),
      highC: Math.round(highC),
      lowC: Math.round(lowC),
      condition: (code !== undefined ? WMO_CODES[code] : undefined) ?? "Unknown",
    };
  } catch (err) {
    console.warn("weather: forecast failed", err);
    return null;
  }
}
