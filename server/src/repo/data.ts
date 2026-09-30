import { randomUUID } from "node:crypto";
import type { Queryable } from "../db";
import { dealGross, dealTotals, type DealTotals, type Gross, type Worksheet } from "../../../shared/deal";
import { DEFAULT_SETTINGS } from "../../../shared/service";
import type { Role } from "../../../shared/schemas";
import type { Deal, Lead, ServiceOrder, Settings, Vehicle } from "../../../shared/types";

export const newId = (prefix: string) => `${prefix}-${randomUUID()}`;

/** Vehicle cost and deal gross are management information; salespeople and service staff don't see them. */
export const seesCost = (role: Role) => role === "admin" || role === "manager";

// ---- settings, audit, numbering ----

export async function getSettings(c: Queryable): Promise<Settings> {
  const { rows } = await c.query<{ value: Partial<Settings> }>("SELECT value FROM settings WHERE key = 'app'");
  return { ...DEFAULT_SETTINGS, ...(rows[0]?.value ?? {}) };
}

export async function saveSettings(c: Queryable, s: Settings) {
  await c.query("INSERT INTO settings (key, value) VALUES ('app', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [JSON.stringify(s)]);
}

export async function audit(
  c: Queryable,
  e: { userId: string | null; action: string; entity: string; entityId?: string | null; details?: Record<string, unknown>; ip?: string | null },
) {
  await c.query("INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip) VALUES ($1, $2, $3, $4, $5, $6)", [
    e.userId,
    e.action,
    e.entity,
    e.entityId ?? null,
    JSON.stringify(e.details ?? {}),
    e.ip ?? null,
  ]);
}

/**
 * Next number in a gapless series (e.g. INV-000123). Must run inside the transaction that uses it:
 * the row lock serialises concurrent callers, and a rollback gives the number back.
 */
export async function nextNumber(c: Queryable, series: string, prefix: string): Promise<string> {
  const { rows } = await c.query<{ value: number }>(
    `INSERT INTO counters (name, value) VALUES ($1, 1)
     ON CONFLICT (name) DO UPDATE SET value = counters.value + 1
     RETURNING value`,
    [series],
  );
  return `${prefix}-${String(rows[0].value).padStart(6, "0")}`;
}

// ---- vehicles ----

export const VEHICLE_SELECT = `
  SELECT v.*,
         v.purchase_cost_cents + COALESCE((SELECT sum(amount_cents) FROM vehicle_costs vc WHERE vc.vehicle_id = v.id), 0) AS total_cost_cents,
         (COALESCE(v.sold_at::date, (now() AT TIME ZONE $TZ)::date) - v.acquired_on) AS days_in_stock
    FROM vehicles v`;

/** The vehicle query with the time zone bound to parameter $argIndex (used for days in stock). */
export const vehicleSelect = (argIndex: number) => VEHICLE_SELECT.replace("$TZ", `$${argIndex}`);

interface VehicleRow {
  id: string;
  stock_no: string;
  vin: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  color: string;
  mileage: number;
  body: string;
  fuel: string;
  transmission: string;
  condition: "New" | "Used";
  branch_id: string;
  source: string;
  acquired_on: string;
  purchase_cost_cents: number;
  list_price_cents: number;
  status: Vehicle["status"];
  sold_at: Date | null;
  notes: string;
  version: number;
  total_cost_cents: number;
  days_in_stock: number;
}

export function toVehicle(r: VehicleRow, showCost: boolean): Vehicle {
  const v: Vehicle = {
    id: r.id,
    stockNo: r.stock_no,
    vin: r.vin,
    year: r.year,
    make: r.make,
    model: r.model,
    trim: r.trim,
    color: r.color,
    mileage: r.mileage,
    body: r.body,
    fuel: r.fuel,
    transmission: r.transmission,
    condition: r.condition,
    branchId: r.branch_id,
    source: r.source,
    acquiredOn: r.acquired_on,
    listPriceCents: Number(r.list_price_cents),
    status: r.status,
    soldAt: r.sold_at?.toISOString() ?? null,
    daysInStock: Math.max(0, Number(r.days_in_stock)),
    notes: r.notes,
    version: r.version,
  };
  if (showCost) {
    v.purchaseCostCents = Number(r.purchase_cost_cents);
    v.totalCostCents = Number(r.total_cost_cents);
  }
  return v;
}

export async function loadVehicle(c: Queryable, id: string, tz: string, lock = false) {
  const { rows } = await c.query<VehicleRow>(`${vehicleSelect(2)} WHERE v.id = $1${lock ? " FOR UPDATE OF v" : ""}`, [id, tz]);
  return rows[0];
}

export const vehicleLabel = (v: { year: number; make: string; model: string; trim?: string }) => `${v.year} ${v.make} ${v.model}${v.trim ? ` ${v.trim}` : ""}`;

// ---- leads ----

export const LEAD_SELECT = `
  SELECT l.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, u.name AS assigned_name,
         CASE WHEN v.id IS NULL THEN NULL ELSE v.year || ' ' || v.make || ' ' || v.model || ' (' || v.stock_no || ')' END AS vehicle_label
    FROM leads l
    JOIN customers c ON c.id = l.customer_id
    LEFT JOIN users u ON u.id = l.assigned_to
    LEFT JOIN vehicles v ON v.id = l.vehicle_id`;

export function toLead(r: Record<string, unknown>): Lead {
  return {
    id: r.id as string,
    customerId: r.customer_id as string,
    customerName: r.customer_name as string,
    customerPhone: r.customer_phone as string,
    customerEmail: (r.customer_email as string) ?? null,
    vehicleId: (r.vehicle_id as string) ?? null,
    vehicleLabel: (r.vehicle_label as string) ?? null,
    source: r.source as string,
    status: r.status as Lead["status"],
    interest: r.interest as string,
    assignedTo: (r.assigned_to as string) ?? null,
    assignedName: (r.assigned_name as string) ?? null,
    nextFollowUpAt: r.next_follow_up_at ? (r.next_follow_up_at as Date).toISOString() : null,
    lostReason: r.lost_reason as string,
    createdAt: (r.created_at as Date).toISOString(),
    updatedAt: (r.updated_at as Date).toISOString(),
    version: r.version as number,
  };
}

// ---- deals ----

export const DEAL_SELECT = `
  SELECT d.*, c.name AS customer_name, v.year, v.make, v.model, v.trim, v.stock_no, u.name AS salesperson_name, a.name AS approved_by_name,
         v.purchase_cost_cents + COALESCE((SELECT sum(amount_cents) FROM vehicle_costs vc WHERE vc.vehicle_id = v.id), 0) AS live_cost_cents
    FROM deals d
    JOIN customers c ON c.id = d.customer_id
    JOIN vehicles v ON v.id = d.vehicle_id
    LEFT JOIN users u ON u.id = d.salesperson_id
    LEFT JOIN users a ON a.id = d.approved_by`;

export function toDeal(r: Record<string, unknown>, settings: Settings, showGross: boolean): Deal {
  const w = r.worksheet as Worksheet;
  const closed = r.status === "closed";
  // A closed deal shows what was frozen at closing; an open one is recalculated with today's settings.
  const totals = closed && r.totals ? (r.totals as DealTotals) : dealTotals(w, settings);
  const cost = closed && r.vehicle_cost_cents !== null ? Number(r.vehicle_cost_cents) : Number(r.live_cost_cents);
  const gross = closed && r.gross ? (r.gross as Gross) : dealGross(w, cost);
  const d: Deal = {
    id: r.id as string,
    number: (r.number as string) ?? null,
    status: r.status as Deal["status"],
    customerId: r.customer_id as string,
    customerName: r.customer_name as string,
    vehicleId: r.vehicle_id as string,
    vehicleLabel: vehicleLabel(r as unknown as { year: number; make: string; model: string; trim: string }),
    stockNo: r.stock_no as string,
    leadId: (r.lead_id as string) ?? null,
    salespersonId: (r.salesperson_id as string) ?? null,
    salespersonName: (r.salesperson_name as string) ?? null,
    branchId: r.branch_id as string,
    worksheet: w,
    totals,
    notes: r.notes as string,
    createdAt: (r.created_at as Date).toISOString(),
    closedAt: r.closed_at ? (r.closed_at as Date).toISOString() : null,
    approvedByName: (r.approved_by_name as string) ?? null,
    version: r.version as number,
  };
  if (showGross) {
    d.gross = gross;
    d.needsApproval = gross.totalCents < settings.minGrossCents;
  }
  return d;
}

// ---- service ----

export const SERVICE_SELECT = `
  SELECT s.*, c.name AS customer_name,
         CASE WHEN v.id IS NULL THEN NULL ELSE v.year || ' ' || v.make || ' ' || v.model || ' (' || v.stock_no || ')' END AS stock_vehicle_label
    FROM service_orders s
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN vehicles v ON v.id = s.stock_vehicle_id`;

export function toService(r: Record<string, unknown>): ServiceOrder {
  return {
    id: r.id as string,
    number: r.number as string,
    status: r.status as ServiceOrder["status"],
    customerId: (r.customer_id as string) ?? null,
    customerName: (r.customer_name as string) ?? null,
    stockVehicleId: (r.stock_vehicle_id as string) ?? null,
    stockVehicleLabel: (r.stock_vehicle_label as string) ?? null,
    vehicleDesc: r.vehicle_desc as string,
    plate: r.plate as string,
    mileage: (r.mileage as number) ?? null,
    complaint: r.complaint as string,
    technician: r.technician as string,
    notes: r.notes as string,
    lines: r.lines as ServiceOrder["lines"],
    subtotalCents: Number(r.subtotal_cents),
    taxCents: Number(r.tax_cents),
    totalCents: Number(r.total_cents),
    invoiceNo: (r.invoice_no as string) ?? null,
    promisedAt: r.promised_at ? (r.promised_at as Date).toISOString() : null,
    createdAt: (r.created_at as Date).toISOString(),
    closedAt: r.closed_at ? (r.closed_at as Date).toISOString() : null,
    branchId: r.branch_id as string,
    version: r.version as number,
  };
}
