import { describe, expect, it } from "vitest";
import { dealGross, dealTotals, monthlyPayment, worksheetProblems, type Worksheet } from "./deal";
import { serviceTotals } from "./service";

const base: Worksheet = { salePriceCents: 2_500_000, discountCents: 100_000, docFeeCents: 49_900, addOns: [], tradeIn: null, depositCents: 0, finance: null };
const tax = { taxPercent: 7, taxTradeInCredit: true };

describe("deal worksheet", () => {
  it("adds tax on price, fees and add-ons", () => {
    const t = dealTotals({ ...base, addOns: [{ description: "Warranty", priceCents: 150_000, costCents: 60_000 }] }, tax);
    expect(t.netPriceCents).toBe(2_400_000);
    expect(t.taxableCents).toBe(2_400_000 + 49_900 + 150_000);
    expect(t.taxCents).toBe(Math.round(2_599_900 * 0.07));
    expect(t.totalCents).toBe(2_599_900 + t.taxCents);
  });

  it("gives the trade-in tax credit only when the rules allow it, and adds the payoff", () => {
    const trade = { vin: "", year: 2018, make: "Honda", model: "Civic", mileage: 80_000, allowanceCents: 800_000, acvCents: 700_000, payoffCents: 300_000 };
    const withCredit = dealTotals({ ...base, tradeIn: trade }, tax);
    const without = dealTotals({ ...base, tradeIn: trade }, { ...tax, taxTradeInCredit: false });
    expect(withCredit.taxableCents).toBe(2_449_900 - 800_000);
    expect(without.taxableCents).toBe(2_449_900);
    expect(withCredit.totalCents).toBe(2_449_900 + withCredit.taxCents - 800_000 + 300_000);
    // Over-allowance is a hidden discount: it comes off front gross.
    const g = dealGross({ ...base, tradeIn: trade }, 2_000_000);
    expect(g.overAllowanceCents).toBe(100_000);
    expect(g.frontCents).toBe(2_400_000 - 2_000_000 - 100_000);
  });

  it("calculates finance payments like a lender does", () => {
    // $20,000 at 6% for 60 months = $386.66 (standard amortisation table).
    expect(monthlyPayment(2_000_000, 6, 60)).toBe(38_666);
    expect(monthlyPayment(1_200_000, 0, 48)).toBe(25_000);
    const t = dealTotals({ ...base, depositCents: 500_000, finance: { lender: "Bank", aprPercent: 6, termMonths: 60 } }, tax);
    expect(t.amountFinancedCents).toBe(t.totalCents - 500_000);
    expect(t.totalOfPaymentsCents).toBe((t.monthlyPaymentCents ?? 0) * 60);
  });

  it("splits front and back gross", () => {
    const g = dealGross({ ...base, addOns: [{ description: "Coating", priceCents: 90_000, costCents: 20_000 }] }, 2_100_000);
    expect(g.frontCents).toBe(300_000);
    expect(g.backCents).toBe(70_000 + 49_900);
    expect(g.totalCents).toBe(419_900);
  });

  it("flags impossible worksheets", () => {
    expect(worksheetProblems(base, tax)).toEqual({});
    expect(Object.keys(worksheetProblems({ ...base, salePriceCents: 0, discountCents: 5 }, tax))).toEqual(expect.arrayContaining(["salePriceCents", "discountCents"]));
    expect(worksheetProblems({ ...base, depositCents: 99_999_999 }, tax).depositCents).toBeTruthy();
  });
});

describe("service totals", () => {
  const lines = [
    { kind: "labour" as const, description: "Brake job", quantity: 1.5, unitCents: 12_500 },
    { kind: "part" as const, description: "Pads", quantity: 2, unitCents: 4_550 },
  ];
  it("taxes labour, and parts when set", () => {
    const t = serviceTotals(lines, { taxPercent: 10, partsTaxable: false }, false);
    expect(t.subtotalCents).toBe(18_750 + 9_100);
    expect(t.taxCents).toBe(1_875);
    expect(serviceTotals(lines, { taxPercent: 10, partsTaxable: true }, false).taxCents).toBe(2_785);
  });
  it("charges no tax on internal reconditioning", () => {
    expect(serviceTotals(lines, { taxPercent: 10, partsTaxable: true }, true).taxCents).toBe(0);
  });
});
