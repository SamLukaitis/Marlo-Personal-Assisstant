interface NominatimResponse {
  address?: {
    country?: string;
    city?: string;
    town?: string;
    village?: string;
  };
}

export async function reverseGeocode(
  latitude: number,
  longitude: number
): Promise<{ country: string | null; city: string | null }> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10&accept-language=en`;
  const res = await fetch(url, {
    // Nominatim's usage policy requires a descriptive User-Agent identifying the app.
    headers: { "User-Agent": "personal-assistant-hub (self-hosted, single user)" },
  });
  if (!res.ok) return { country: null, city: null };
  const data = (await res.json()) as NominatimResponse;
  return {
    country: data.address?.country ?? null,
    city: data.address?.city ?? data.address?.town ?? data.address?.village ?? null,
  };
}
