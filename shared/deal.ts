// Deal worksheet maths, used by the server (authoritative) and the web app (live preview).
// All money is integer cents.

export interface AddOn {
  description: string;
  /** What the customer pays. */
  priceCents: number;
  /** What it costs the dealer (warranty premium, coating supplies…). */
  costCents: number;
}

export interface TradeIn {
  vin: string;
  year: number;
  make: string;
  model: string;
  mileage: number;
  /** Credited to the customer. */
  allowanceCents: number;
  /** What the car is really worth to the dealer (appraisal). It enters stock at this cost. */
  acvCents: number;
  /** Loan still owed on the trade, paid off by the dealer and added to the deal. */
  payoffCents: number;
}

export interface Finance {
  lender: string;
  aprPercent: number;
  termMonths: number;
}

export interface Worksheet {
  salePriceCents: number;
  discountCents: number;
  docFeeCents: number;
  addOns: AddOn[];
  tradeIn: TradeIn | null;
  depositCents: number;
  finance: Finance | null;
}

export interface TaxRules {
  taxPercent: number;
  /** Many states tax only the difference between the new car and the trade-in. */
  taxTradeInCredit: boolean;
}

export interface DealTotals {
  netPriceCents: number;
  addOnsCents: number;
  taxableCents: number;
  taxCents: number;
  tradeAllowanceCents: number;
  tradePayoffCents: number;
  totalCents: number;
  balanceDueCents: number;
  amountFinancedCents: number;
  monthlyPaymentCents: number | null;
  totalOfPaymentsCents: number | null;
}

export interface Gross {
  /** Vehicle profit: net price − vehicle cost − trade over-allowance. */
  frontCents: number;
  /** Add-on profit plus the documentation fee. */
  backCents: number;
  totalCents: number;
  /** Allowance above the trade's real value: a hidden discount. */
  overAllowanceCents: number;
}

const round = (n: number) => Math.round(n);

/** Standard amortised loan payment. 0% APR is simply principal ÷ months. */
export function monthlyPayment(principalCents: number, aprPercent: number, termMonths: number): number {
  if (principalCents <= 0 || termMonths <= 0) return 0;
  const r = aprPercent / 100 / 12;
  if (r === 0) return round(principalCents / termMonths);
  return round((principalCents * r) / (1 - Math.pow(1 + r, -termMonths)));
}

export function dealTotals(w: Worksheet, tax: TaxRules): DealTotals {
  const netPriceCents = w.salePriceCents - w.discountCents;
  const addOnsCents = w.addOns.reduce((s, a) => s + a.priceCents, 0);
  const tradeAllowanceCents = w.tradeIn?.allowanceCents ?? 0;
  const tradePayoffCents = w.tradeIn?.payoffCents ?? 0;
  const taxableCents = Math.max(0, netPriceCents + w.docFeeCents + addOnsCents - (tax.taxTradeInCredit ? tradeAllowanceCents : 0));
  const taxCents = round((taxableCents * tax.taxPercent) / 100);
  const totalCents = netPriceCents + w.docFeeCents + addOnsCents + taxCents - tradeAllowanceCents + tradePayoffCents;
  const balanceDueCents = totalCents - w.depositCents;
  const amountFinancedCents = w.finance ? Math.max(0, balanceDueCents) : 0;
  const monthlyPaymentCents = w.finance ? monthlyPayment(amountFinancedCents, w.finance.aprPercent, w.finance.termMonths) : null;
  return {
    netPriceCents,
    addOnsCents,
    taxableCents,
    taxCents,
    tradeAllowanceCents,
    tradePayoffCents,
    totalCents,
    balanceDueCents,
    amountFinancedCents,
    monthlyPaymentCents,
    totalOfPaymentsCents: w.finance && monthlyPaymentCents !== null ? monthlyPaymentCents * w.finance.termMonths : null,
  };
}

export function dealGross(w: Worksheet, vehicleCostCents: number): Gross {
  const overAllowanceCents = w.tradeIn ? Math.max(0, w.tradeIn.allowanceCents - w.tradeIn.acvCents) : 0;
  const frontCents = w.salePriceCents - w.discountCents - vehicleCostCents - overAllowanceCents;
  const backCents = w.addOns.reduce((s, a) => s + a.priceCents - a.costCents, 0) + w.docFeeCents;
  return { frontCents, backCents, totalCents: frontCents + backCents, overAllowanceCents };
}

/** Problems that stop a deal from being saved or closed, as field → message. */
export function worksheetProblems(w: Worksheet, tax: TaxRules): Record<string, string> {
  const p: Record<string, string> = {};
  if (w.salePriceCents <= 0) p.salePriceCents = "Enter the selling price";
  if (w.discountCents < 0 || w.discountCents > w.salePriceCents) p.discountCents = "Discount must be between 0 and the price";
  const t = dealTotals(w, tax);
  if (w.depositCents > Math.max(0, t.totalCents)) p.depositCents = "Deposit is more than the deal total";
  if (w.tradeIn && w.tradeIn.allowanceCents < 0) p["tradeIn.allowanceCents"] = "Can't be negative";
  if (t.totalCents < 0) p.tradeIn = "The trade-in is worth more than the whole deal; refund the difference outside the deal";
  return p;
}
