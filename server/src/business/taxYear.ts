// UK tax year: 6 April to 5 April. Dates are plain YYYY-MM-DD strings throughout the ledger.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function taxYearFor(dateISO: string): { label: string; start: string; end: string } {
  const m = ISO_DATE.exec(dateISO);
  if (!m) throw new Error(`Expected YYYY-MM-DD, got "${dateISO}"`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const startYear = mo > 4 || (mo === 4 && d >= 6) ? y : y - 1;
  return {
    label: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    start: `${startYear}-04-06`,
    end: `${startYear + 1}-04-05`,
  };
}
