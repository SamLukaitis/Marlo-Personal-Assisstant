// Manual live check against Google's Maps Grounding Lite MCP server — prints the raw upstream
// output for both tools so the field mapping in providers/maps.ts can be confirmed against reality.
// Not part of the test suite (needs a real key and spends real quota).
//   GOOGLE_MAPS_API_KEY=... npm run maps:probe
import "dotenv/config";
import { createMcpClient } from "../services/mcpClient.js";
import { MAPS_MCP_URL, searchPlaces, computeRoute } from "../providers/maps.js";

const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
if (!key) {
  console.error("Set GOOGLE_MAPS_API_KEY first.");
  process.exit(1);
}

const raw = createMcpClient({ name: "google-maps-probe", url: MAPS_MCP_URL, headers: { "X-Goog-Api-Key": key } });
console.log("tools:", await raw.listToolNames());
console.log(
  "raw search_places:",
  JSON.stringify(
    await raw.callTool("search_places", {
      text_query: "pharmacy",
      location_bias: { circle: { center: { latitude: 51.5308, longitude: -0.1238 }, radius_meters: 1500 } },
    }),
    null,
    2
  )
);
console.log(
  "raw compute_routes:",
  JSON.stringify(
    await raw.callTool("compute_routes", {
      origin: { address: "King's Cross Station, London" },
      destination: { address: "British Museum, London" },
      travel_mode: "WALK",
    }),
    null,
    2
  )
);
console.log("trimmed places:", JSON.stringify(await searchPlaces({ query: "pharmacy near King's Cross, London" }), null, 2));
console.log(
  "trimmed route:",
  JSON.stringify(await computeRoute({ origin: "King's Cross Station, London", destination: "British Museum, London", mode: "walk" }), null, 2)
);
await raw.close();
process.exit(0);
