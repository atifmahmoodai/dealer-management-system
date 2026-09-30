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
};
