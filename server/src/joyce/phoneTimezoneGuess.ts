// A copy of Marlowe's services/phoneTimezoneGuess.ts, kept in step by hand — Joyce can't import
// Marlowe's modules (isolation.test.ts). Joyce uses it to guess a new family's timezone from the
// number of whoever started it. If you change the guessing rules in one, change the other.
//
// A best guess at someone's timezone from their WhatsApp number, for users who have never shared a
// location or picked a zone (userTimezone.ts uses it last, and anything better replaces it). Wrong
// only costs an hour or two on a schedule until they share a location, so it aims for the most
// likely zone rather than refusing to guess:
//   1. US/Canada numbers (+1): the area code names a region, so that region's zone.
//   2. Australia: landline area code 7 is Queensland (no daylight saving); everything else,
//      including all mobiles, which name no state, is Melbourne (the same clock as Sydney).
//   3. Other countries with several zones: the zone most people live in (DEFAULT_ZONE_BY_COUNTRY).
//   4. Any other country with one zone, or several that keep identical time all year.
//   5. Otherwise nothing.
import {
  parsePhoneNumberFromString,
  getCountries,
  getCountryCallingCode,
  type CountryCode,
} from "libphonenumber-js/min";
import { getTimezonesForCountry } from "countries-and-timezones";
import { DateTime } from "luxon";

// Calling codes several countries share, and the one most of their numbers belong to.
export const MAIN_COUNTRY_FOR_SHARED_CODE: Record<string, CountryCode> = {
  "1": "US",
  "7": "RU",
  "44": "GB",
  "47": "NO",
  "61": "AU",
  "39": "IT",
  "212": "MA",
  "262": "RE",
  "290": "SH",
  "358": "FI",
  "590": "GP",
  "599": "CW",
};

const countriesByCallingCode = new Map<string, CountryCode[]>();
for (const country of getCountries()) {
  const code = getCountryCallingCode(country);
  countriesByCallingCode.set(code, [...(countriesByCallingCode.get(code) ?? []), country]);
}

function mainCountryForCallingCode(code: string): CountryCode | undefined {
  const countries = countriesByCallingCode.get(code) ?? [];
  return countries.length === 1 ? countries[0] : MAIN_COUNTRY_FOR_SHARED_CODE[code];
}

export const AREA_CODES_BY_ZONE: Record<string, string[]> = {
  "America/New_York": [
    "212", "315", "332", "347", "516", "518", "585", "607", "631", "646", "680", "716", "718", "838", "845", "914", "917", "929", "934",
    "201", "551", "609", "640", "732", "848", "856", "862", "908", "973",
    "215", "223", "267", "272", "412", "445", "484", "570", "610", "717", "724", "814", "878",
    "339", "351", "413", "508", "617", "774", "781", "857", "978",
    "203", "475", "860", "959", "227", "240", "301", "410", "443", "667", "202", "771", "302",
    "276", "434", "540", "571", "703", "757", "804", "826", "948",
    "239", "305", "321", "352", "386", "407", "561", "689", "727", "754", "772", "786", "813", "863", "904", "941", "954",
    "229", "404", "470", "478", "678", "706", "762", "770", "912", "943",
    "252", "336", "704", "743", "828", "910", "919", "980", "984", "803", "839", "843", "854", "864",
    "216", "220", "234", "283", "330", "380", "419", "440", "513", "567", "614", "740", "937",
    "231", "248", "269", "313", "517", "586", "616", "734", "810", "906", "947", "989",
    "260", "317", "463", "574", "765", "812", "930", "423", "865",
    "270", "364", "502", "606", "859", "304", "681", "603", "802", "207", "401",
  ],
  "America/Chicago": [
    "210", "214", "254", "281", "325", "346", "361", "409", "430", "469", "512", "682", "713", "726", "737", "806", "817", "830", "832", "903", "936", "940", "956", "972", "979",
    "217", "224", "309", "312", "331", "447", "464", "618", "630", "708", "730", "773", "779", "815", "847", "872",
    "218", "320", "507", "612", "651", "763", "952", "262", "274", "414", "534", "608", "715", "920",
    "314", "417", "557", "573", "636", "660", "816", "975", "319", "515", "563", "641", "712",
    "225", "318", "337", "504", "985", "405", "539", "572", "580", "918", "316", "620", "785", "913", "308", "402", "531",
    "205", "251", "256", "334", "659", "938", "228", "601", "662", "769", "479", "501", "870",
    "615", "629", "731", "901", "931", "850", "448", "701", "605",
  ],
  "America/Denver": ["303", "719", "720", "970", "983", "385", "435", "801", "505", "575", "307", "406", "208", "986", "915"],
  "America/Phoenix": ["480", "520", "602", "623", "928"],
  "America/Los_Angeles": [
    "209", "213", "279", "310", "323", "341", "369", "408", "415", "424", "442", "510", "530", "559", "562", "619", "626", "628", "650", "657", "661", "669", "707", "714", "747", "760", "805", "818", "831", "840", "858", "909", "916", "925", "935", "949", "951",
    "206", "253", "360", "425", "509", "564", "458", "503", "541", "971", "702", "725", "775",
  ],
  "America/Anchorage": ["907"],
  "Pacific/Honolulu": ["808"],
  "America/Toronto": [
    "226", "249", "289", "343", "365", "416", "437", "519", "548", "613", "647", "705", "742", "807", "905",
    "367", "418", "438", "450", "514", "579", "581", "819", "873",
  ],
  "America/Vancouver": ["236", "250", "604", "672", "778"],
  "America/Edmonton": ["403", "587", "780", "825"],
  "America/Regina": ["306", "474", "639"],
  "America/Winnipeg": ["204", "431", "584"],
  "America/Halifax": ["902", "782", "506"],
  "America/St_Johns": ["709", "879"],
};

const ZONE_BY_AREA_CODE = new Map<string, string>(
  Object.entries(AREA_CODES_BY_ZONE).flatMap(([zone, codes]) => codes.map((code) => [code, zone] as const))
);

// Where most people in a multi-timezone country live. Used when nothing narrower is known.
const DEFAULT_ZONE_BY_COUNTRY: Record<string, string> = {
  US: "America/New_York",
  CA: "America/Toronto",
  AU: "Australia/Melbourne",
  BR: "America/Sao_Paulo",
  RU: "Europe/Moscow",
  MX: "America/Mexico_City",
  ID: "Asia/Jakarta",
  CN: "Asia/Shanghai",
  KZ: "Asia/Almaty",
  NZ: "Pacific/Auckland",
  ES: "Europe/Madrid",
  PT: "Europe/Lisbon",
  AR: "America/Argentina/Buenos_Aires",
  CL: "America/Santiago",
  UA: "Europe/Kyiv",
  CD: "Africa/Kinshasa",
  MN: "Asia/Ulaanbaatar",
  EC: "America/Guayaquil",
  PG: "Pacific/Port_Moresby",
};

// The tz database lists some zones under a country that keep exactly the same time as its main one
// (Germany's list includes Zurich). Only a country whose zones agree all year — checked in January
// and July, so daylight saving counts — is treated as having one zone.
const singleZoneByCountry = new Map<string, string | null>();
function singleZoneForCountry(country: string): string | null {
  const known = singleZoneByCountry.get(country);
  if (known !== undefined) return known;
  // An alias (Guernsey's zone is London's) counts as the zone it points to, not as nothing.
  const zones = [...new Set((getTimezonesForCountry(country) ?? []).map((t) => t.aliasOf ?? t.name))];
  const year = DateTime.utc().year;
  const offsets = (zone: string) =>
    [DateTime.utc(year, 1, 15), DateTime.utc(year, 7, 15)].map((d) => d.setZone(zone).offset).join(",");
  const agree = zones.length > 0 && zones.every((z) => offsets(z) === offsets(zones[0]));
  const result = agree ? zones[0] : null;
  singleZoneByCountry.set(country, result);
  return result;
}

// `phone` is the number's digits with the country code, no "+" (how numbers are stored).
export function guessTimezoneFromPhone(phone: string): string | null {
  const parsed = parsePhoneNumberFromString(`+${phone}`);
  if (!parsed) return null;
  // The library only names the country for a number in a range it knows is allocated; otherwise
  // fall back to the calling code's main country (+44 is the UK, +1 the US), which is right for
  // almost everyone who shares it.
  const country = parsed.country ?? mainCountryForCallingCode(parsed.countryCallingCode);
  if (!country) return null;

  if (parsed.countryCallingCode === "1") {
    const byAreaCode = ZONE_BY_AREA_CODE.get(parsed.nationalNumber.slice(0, 3));
    if (byAreaCode) return byAreaCode;
  }
  if (country === "US" || country === "CA") return DEFAULT_ZONE_BY_COUNTRY[country];
  if (country === "AU" && parsed.nationalNumber.startsWith("7")) return "Australia/Brisbane";
  return DEFAULT_ZONE_BY_COUNTRY[country] ?? singleZoneForCountry(country);
}
