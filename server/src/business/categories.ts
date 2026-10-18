// The expense boxes on HMRC's short self-employment form (SA103S). Hints are what the categoriser
// and the assistant read; keep them in plain English.
export const SA103_CATEGORIES = [
  { key: "cost_of_goods", label: "Cost of goods", hints: "materials, stock or parts bought to resell or build into a job you charge for" },
  { key: "car_van_travel", label: "Car, van and travel", hints: "fuel, parking, train/bus fares, van repairs, hotels on work trips (not commuting to a regular workplace)" },
  { key: "staff", label: "Staff costs", hints: "wages or subcontractor payments to people working for you" },
  { key: "premises", label: "Rent, rates, power and insurance", hints: "workshop/office rent, business rates, electricity, business insurance" },
  { key: "repairs", label: "Repairs and maintenance", hints: "repairing tools, equipment or premises; small tools and consumables (e.g. Screwfix, Toolstation)" },
  { key: "phone_office", label: "Phone, stationery and office", hints: "phone and broadband bills, software subscriptions, postage, printing, stationery" },
  { key: "advertising", label: "Advertising", hints: "ads, website hosting, business cards, listings (NOT client entertainment, which isn't allowable)" },
  { key: "finance_charges", label: "Bank and finance charges", hints: "bank fees, card processing fees (Stripe, SumUp fees), loan interest" },
  { key: "professional_fees", label: "Accountancy and legal", hints: "accountant, bookkeeper, solicitor, professional memberships" },
  { key: "other", label: "Other allowable expenses", hints: "anything else wholly for the business that fits none of the above" },
] as const;

export type CategoryKey = (typeof SA103_CATEGORIES)[number]["key"];

export function isCategoryKey(x: unknown): x is CategoryKey {
  return typeof x === "string" && SA103_CATEGORIES.some((c) => c.key === x);
}

export function categoryLabel(key: string | null): string {
  return SA103_CATEGORIES.find((c) => c.key === key)?.label ?? "Uncategorised";
}

export function formatPence(pence: number): string {
  return `£${(pence / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
