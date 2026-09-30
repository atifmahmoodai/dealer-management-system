import type { LeadStatus, Role } from "./schemas";
import type { DealTotals, Gross, Worksheet } from "./deal";

export interface Settings {
  companyName: string;
  currency: string;
  locale: string;
  taxPercent: number;
  taxTradeInCredit: boolean;
  docFeeCents: number;
  minGrossCents: number;
  labourRateCents: number;
  partsTaxable: boolean;
  distanceUnit: "mi" | "km";
}

export interface Branch {
  id: string;
  name: string;
  address: string;
  phone: string;
}

export interface UserRef {
  id: string;
  name: string;
  role: Role;
  branchId: string | null;
}

export interface Customer {
  id: string;
  kind: "person" | "company";
  name: string;
  email: string | null;
  phone: string;
  address: string;
  notes: string;
  createdAt: string;
}

export type VehicleStatus = "in_stock" | "reserved" | "sold";

export interface Vehicle {
  id: string;
  stockNo: string;
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
  branchId: string;
  source: string;
  acquiredOn: string;
  listPriceCents: number;
  status: VehicleStatus;
  soldAt: string | null;
  daysInStock: number;
  notes: string;
  version: number;
  /** Only for roles that may see costs (admin, manager). */
  purchaseCostCents?: number;
  totalCostCents?: number;
}

export interface VehicleCost {
  id: string;
  description: string;
  amountCents: number;
  at: string;
  byName: string | null;
}

export interface Lead {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  vehicleId: string | null;
  vehicleLabel: string | null;
  source: string;
  status: LeadStatus;
  interest: string;
  assignedTo: string | null;
  assignedName: string | null;
  nextFollowUpAt: string | null;
  lostReason: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface Activity {
  id: string;
  type: string;
  body: string;
  at: string;
  byName: string | null;
}

export type DealStatus = "draft" | "pending_approval" | "approved" | "closed" | "cancelled";

export interface Deal {
  id: string;
  number: string | null;
  status: DealStatus;
  customerId: string;
  customerName: string;
  vehicleId: string;
  vehicleLabel: string;
  stockNo: string;
  leadId: string | null;
  salespersonId: string | null;
  salespersonName: string | null;
  branchId: string;
  worksheet: Worksheet;
  totals: DealTotals;
  notes: string;
  createdAt: string;
  closedAt: string | null;
  approvedByName: string | null;
  version: number;
  /** Only for admin and manager. */
  gross?: Gross;
  needsApproval?: boolean;
}

export type ServiceStatus = "open" | "in_progress" | "waiting_parts" | "done" | "closed" | "cancelled";

export interface ServiceLine {
  kind: "labour" | "part";
  description: string;
  quantity: number;
  unitCents: number;
}

export interface ServiceOrder {
  id: string;
  number: string;
  status: ServiceStatus;
  customerId: string | null;
  customerName: string | null;
  stockVehicleId: string | null;
  stockVehicleLabel: string | null;
  vehicleDesc: string;
  plate: string;
  mileage: number | null;
  complaint: string;
  technician: string;
  notes: string;
  lines: ServiceLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  invoiceNo: string | null;
  promisedAt: string | null;
  createdAt: string;
  closedAt: string | null;
  branchId: string;
  version: number;
}

export interface DocumentMeta {
  id: string;
  entity: "customer" | "vehicle" | "deal";
  entityId: string;
  filename: string;
  mime: string;
  size: number;
  uploadedAt: string;
  uploadedBy: string | null;
}

export interface Meta {
  settings: Settings;
  branches: Branch[];
  users: UserRef[];
  timeZone: string;
}
