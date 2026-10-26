// Works out a person's trips from their saved bookings, and which country a trip is in. Marlo
// has no trip object of its own: a trip is a hotel stay or a run of flights close in time, derived
// each time it's needed. This never leaves Marlo; what may be shared with a family, and when, is
// decided by src/bridge/.
import Anthropic from "@anthropic-ai/sdk";
import { listEntities, recordApiUsage } from "../db/store.js";
import type { BookingData } from "./entityValidation.js";

// Bookings closer together than this belong to the same trip: a hotel check-out and a flight home
// a day later, or an outbound flight the day before check-in.
const TRIP_GAP_DAYS = 2;
// Flights with no stay around them are one trip only if the way back is within this many days.
const MAX_FLIGHT_TRIP_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DerivedTrip {
  /** The id of the earliest booking in the trip. Stable while the trip grows around it. */
  key: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD, inclusive
  /** What to ask about to learn the country: a hotel's name and place, or a flight's route. */
  destination: string;
}

interface Item {
  id: number;
  kind: "flight" | "hotel";
  name: string;
  start: string;
  end: string;
  /** A hotel with a check-out date. */
  hasEnd: boolean;
}

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

function destinationOf(items: Item[]): string {
  const hotel = items.find((i) => i.kind === "hotel" && i.hasEnd);
  if (hotel) return hotel.name;
  const flight = items.find((i) => i.kind === "flight");
  if (!flight) return items[0].name;
  const route = flight.name.split(/→|->|–|—| to /i);
  return route.length > 1 ? `the airport ${route[route.length - 1].trim()} (flight ${flight.name})` : flight.name;
}

/**
 * Trips still to come or under way, soonest first. A trip needs a known end: a hotel stay (with the
 * flights around it), or an outbound flight and the flight back. A lone one-way flight is not a trip.
 */
export function deriveTrips(bookings: { id: number; data: BookingData }[], today: string): DerivedTrip[] {
  const items: Item[] = bookings
    .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.data.startDate))
    .map((b) => {
      const endDate = b.data.endDate && b.data.endDate >= b.data.startDate ? b.data.endDate : null;
      return {
        id: b.id,
        kind: b.data.kind === "flight" ? "flight" : "hotel",
        name: b.data.name,
        start: b.data.startDate,
        end: endDate ?? b.data.startDate,
        hasEnd: b.data.kind !== "flight" && endDate !== null,
      } as Item;
    })
    .sort((a, b) => a.start.localeCompare(b.start) || a.id - b.id);

  const clusters: Item[][] = [];
  let clusterEnd = "";
  for (const item of items) {
    const current = clusters[clusters.length - 1];
    if (current && dayNumber(item.start) - dayNumber(clusterEnd) <= TRIP_GAP_DAYS) {
      current.push(item);
      if (item.end > clusterEnd) clusterEnd = item.end;
    } else {
      clusters.push([item]);
      clusterEnd = item.end;
    }
  }

  const trips: DerivedTrip[] = [];
  const looseFlights: Item[] = [];
  for (const cluster of clusters) {
    if (!cluster.some((i) => i.hasEnd)) {
      looseFlights.push(...cluster.filter((i) => i.kind === "flight"));
      continue;
    }
    trips.push({
      key: String(Math.min(...cluster.map((i) => i.id))),
      startDate: cluster[0].start,
      endDate: cluster.reduce((latest, i) => (i.end > latest ? i.end : latest), cluster[0].end),
      destination: destinationOf(cluster),
    });
  }

  // Flights with no stay around them: an outbound leg and the next leg back make a trip. Flights a
  // day or less apart are one leg (a connection), so a connecting outbound isn't read as a return.
  const legs: Item[][] = [];
  for (const flight of looseFlights) {
    const leg = legs[legs.length - 1];
    if (leg && dayNumber(flight.start) - dayNumber(leg[leg.length - 1].start) <= 1) leg.push(flight);
    else legs.push([flight]);
  }
  for (let i = 0; i + 1 < legs.length; ) {
    const out = legs[i];
    const back = legs[i + 1];
    if (dayNumber(back[0].start) - dayNumber(out[out.length - 1].start) > MAX_FLIGHT_TRIP_DAYS) {
      i += 1; // too long to be one trip: this outbound has no return we can see
      continue;
    }
    trips.push({
      key: String(Math.min(...[...out, ...back].map((f) => f.id))),
      startDate: out[0].start,
      endDate: back[back.length - 1].start,
      destination: destinationOf([out[out.length - 1]]),
    });
    i += 2;
  }

  return trips.filter((t) => t.endDate >= today).sort((a, b) => a.startDate.localeCompare(b.startDate));
}

/** The person's own trips from their active booking entities. */
export function tripsForOwner(ownerId: number, today: string): DerivedTrip[] {
  return deriveTrips(
    listEntities<BookingData>(ownerId, { type: "booking", status: "active" }).map((e) => ({ id: e.id, data: e.data })),
    today
  );
}

const COUNTRY_MODEL = process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

/** Keeps a model's answer only if it looks like a country name. */
export function parseCountry(text: string): string | null {
  const line = text.trim().split("\n")[0]?.trim().replace(/^["'*]+|["'*.]+$/g, "") ?? "";
  if (!line || line.length > 40 || /unknown|not sure|unclear/i.test(line) || /[0-9:]/.test(line)) return null;
  return line;
}

/**
 * The country a destination is in, or null when it can't be told. Only the destination text
 * (a hotel's name and place, or an airport) is sent, never a reference, price or name.
 * Not unit-tested past parseCountry: this repo doesn't mock the Anthropic SDK.
 */
export async function countryFor(ownerId: number, destination: string): Promise<string | null> {
  try {
    const response = await getClient().messages.create({
      model: COUNTRY_MODEL,
      max_tokens: 20,
      messages: [
        {
          role: "user",
          content:
            `Which country is this travel destination in: ${destination}\n` +
            "Reply with only the country's English name, or UNKNOWN if you are not sure.",
        },
      ],
    });
    recordApiUsage(
      ownerId,
      "background",
      COUNTRY_MODEL,
      "trip_country",
      response.usage?.input_tokens ?? 0,
      response.usage?.output_tokens ?? 0,
      response.usage?.cache_read_input_tokens ?? 0,
      response.usage?.cache_creation_input_tokens ?? 0
    );
    const text = response.content.find((b) => b.type === "text")?.text;
    return text ? parseCountry(text) : null;
  } catch (err) {
    console.error("tripDerivation: couldn't work out the country", err);
    return null;
  }
}
