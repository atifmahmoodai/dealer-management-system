import { z } from "zod";

// Input rules shared by the API (enforced) and the web app (early feedback).

const text = (max: number) => z.string().trim().max(max);
const cents = z.number().int().min(0).max(1_000_000_000);
const id = z.string().trim().min(1).max(64);
const optionalEmail = z.union([z.literal(""), z.string().trim().toLowerCase().email().max(200)]).transform((v) => v || null);

export const ROLES = ["admin", "manager", "sales", "service"] as const;
export type Role = (typeof ROLES)[number];

export const loginSchema = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) });
export const passwordSchema = z
  .string()
  .min(10, "At least 10 characters")
  .max(200)
  .refine((p) => /[a-z]/i.test(p) && /\d/.test(p), "Use letters and at least one number");
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema });
export const userCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: text(120).min(2),
  role: z.enum(ROLES),
  branchId: id.nullable(),
  password: passwordSchema,
});
export const userUpdateSchema = z.object({ name: text(120).min(2), role: z.enum(ROLES), branchId: id.nullable(), active: z.boolean() });
export const resetPasswordSchema = z.object({ password: passwordSchema });

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  branchId: string | null;
}

export const branchSchema = z.object({ name: text(80).min(2), address: text(200), phone: text(40) });

export const settingsSchema = z.object({
  companyName: text(120).min(1),
  currency: z.string().regex(/^[A-Z]{3}$/, "3-letter code like USD"),
  locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "Like en-US"),
  taxPercent: z.number().min(0).max(30),
  taxTradeInCredit: z.boolean(),
  docFeeCents: cents,
  /** Deals below this front + back gross need a manager's approval. */
  minGrossCents: z.number().int().min(-10_000_000).max(10_000_000),
  labourRateCents: cents,
  partsTaxable: z.boolean(),
  distanceUnit: z.enum(["mi", "km"]),
});

// ---- customers ----
export const customerSchema = z.object({
  kind: z.enum(["person", "company"]).default("person"),
  name: text(120).min(2, "Enter the customer's name"),
  email: optionalEmail,
  phone: text(40).refine((p) => p === "" || /^[\d\s+()\-.]{6,40}$/.test(p), "Enter a phone number with digits"),
  address: text(300).default(""),
  notes: text(4000).default(""),
}).refine((c) => c.email || c.phone, { message: "Give an email or a phone number", path: ["phone"] });

// ---- inventory ----
const vin = z
  .string()
  .trim()
  .toUpperCase()
  .refine((v) => v === "" || /^[A-HJ-NPR-Z0-9]{17}$/.test(v), "A VIN is 17 letters and digits (no I, O or Q)");
const year = z.number().int().min(1950).max(new Date().getFullYear() + 2);

export const vehicleSchema = z.object({
  stockNo: text(20).min(1, "Required").toUpperCase(),
  vin,
  year,
  make: text(40).min(1, "Required"),
  model: text(60).min(1, "Required"),
  trim: text(60).default(""),
  color: text(40).default(""),
  mileage: z.number().int().min(0).max(2_000_000),
  body: z.enum(["Sedan", "Hatchback", "SUV", "Pickup", "Van", "Coupe", "Convertible", "Wagon"]),
  fuel: z.enum(["Petrol", "Diesel", "Hybrid", "Electric"]),
  transmission: z.enum(["Automatic", "Manual"]),
  condition: z.enum(["New", "Used"]),
  branchId: id,
  source: z.enum(["purchase", "auction", "trade_in", "consignment"]),
  acquiredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  purchaseCostCents: cents,
  listPriceCents: cents.min(1, "Enter the list price"),
  notes: text(4000).default(""),
});
export const vehicleUpdateSchema = vehicleSchema.extend({ version: z.number().int() });
export const vehicleCostSchema = z.object({ description: text(200).min(2), amountCents: cents.min(1) });

// ---- CRM ----
export const LEAD_SOURCES = ["walk_in", "phone", "website", "marketplace", "referral", "repeat"] as const;
export const LEAD_STATUSES = ["new", "contacted", "appointment", "negotiation", "won", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const leadSchema = z.object({
  customerId: id,
  vehicleId: id.nullable(),
  source: z.enum(LEAD_SOURCES),
  interest: text(300).default(""),
  assignedTo: id.nullable(),
  nextFollowUpAt: z.string().datetime({ offset: true }).nullable(),
});
export const leadUpdateSchema = leadSchema.omit({ customerId: true }).extend({
  status: z.enum(LEAD_STATUSES),
  lostReason: text(300).default(""),
  version: z.number().int(),
});
export const activitySchema = z.object({
  type: z.enum(["call", "email", "sms", "meeting", "test_drive", "note"]),
  body: text(4000).min(1, "Write what happened"),
});

// ---- deals ----
const addOn = z.object({ description: text(120).min(1), priceCents: cents, costCents: cents });
const tradeIn = z.object({
  vin,
  year,
  make: text(40).min(1, "Required"),
  model: text(60).min(1, "Required"),
  mileage: z.number().int().min(0).max(2_000_000),
  allowanceCents: cents,
  acvCents: cents,
  payoffCents: cents,
});
const finance = z.object({ lender: text(80).min(1, "Required"), aprPercent: z.number().min(0).max(40), termMonths: z.number().int().min(6).max(96) });

export const worksheetSchema = z.object({
  salePriceCents: cents,
  discountCents: cents,
  docFeeCents: cents,
  addOns: z.array(addOn).max(10),
  tradeIn: tradeIn.nullable(),
  depositCents: cents,
  finance: finance.nullable(),
});
export const dealCreateSchema = z.object({ customerId: id, vehicleId: id, leadId: id.nullable(), worksheet: worksheetSchema });
export const dealUpdateSchema = z.object({ worksheet: worksheetSchema, notes: text(4000).default(""), version: z.number().int() });

// ---- service ----
export const serviceLineSchema = z.object({
  kind: z.enum(["labour", "part"]),
  description: text(200).min(1),
  quantity: z.number().positive().max(1000),
  unitCents: cents,
});
export const serviceOrderSchema = z
  .object({
    customerId: id.nullable(),
    /** Internal reconditioning of a stock vehicle: the cost goes onto the vehicle, no invoice. */
    stockVehicleId: id.nullable(),
    vehicleDesc: text(120).default(""),
    plate: text(20).default(""),
    mileage: z.number().int().min(0).max(2_000_000).nullable(),
    complaint: text(2000).min(1, "Describe the work"),
    technician: text(80).default(""),
    promisedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .refine((o) => !!o.customerId !== !!o.stockVehicleId, { message: "Choose a customer or a stock vehicle", path: ["customerId"] });
export const serviceUpdateSchema = z.object({
  status: z.enum(["open", "in_progress", "waiting_parts", "done"]),
  complaint: text(2000).min(1),
  technician: text(80).default(""),
  notes: text(4000).default(""),
  lines: z.array(serviceLineSchema).max(60),
  version: z.number().int(),
});
