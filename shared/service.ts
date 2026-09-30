import type { ServiceLine, Settings } from "./types";

// Service order totals. Labour is always taxable; parts follow the partsTaxable setting.
export function serviceTotals(lines: ServiceLine[], s: Pick<Settings, "taxPercent" | "partsTaxable">, internal: boolean) {
  const line = (l: ServiceLine) => Math.round(l.quantity * l.unitCents);
  const subtotalCents = lines.reduce((sum, l) => sum + line(l), 0);
  // Internal reconditioning isn't sold to anyone, so no tax.
  const taxable = internal ? 0 : lines.reduce((sum, l) => sum + (l.kind === "labour" || s.partsTaxable ? line(l) : 0), 0);
  const taxCents = Math.round((taxable * s.taxPercent) / 100);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents, lineTotal: line };
}

export const DEFAULT_SETTINGS: Settings = {
  companyName: "My Dealership",
  currency: "USD",
  locale: "en-US",
  taxPercent: 7,
  taxTradeInCredit: true,
  docFeeCents: 49_900,
  minGrossCents: 50_000,
  labourRateCents: 12_500,
  partsTaxable: true,
  distanceUnit: "mi",
  products: [
    { description: "Extended warranty (3 years)", priceCents: 149_900, costCents: 62_000 },
    { description: "Paint and fabric protection", priceCents: 69_900, costCents: 15_000 },
    { description: "GAP insurance", priceCents: 59_900, costCents: 25_000 },
    { description: "Window tint", priceCents: 29_900, costCents: 9_000 },
  ],
};
