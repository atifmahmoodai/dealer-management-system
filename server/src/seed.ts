import type { PoolClient } from "pg";
import { newId, nextNumber, saveSettings } from "./repo/data";
import { hashPassword } from "./security/password";
import { dealGross, dealTotals, type Worksheet } from "../../shared/deal";
import { DEFAULT_SETTINGS, serviceTotals } from "../../shared/service";
import type { ServiceLine } from "../../shared/types";

export const DEMO_USERS = {
  admin: "admin@demo.local",
  manager: "manager@demo.local",
  sales: "sales@demo.local",
  sales2: "sales2@demo.local",
  service: "service@demo.local",
};

const DAY = 86_400_000;

function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const MODELS: [string, string, string[], string, number][] = [
  ["Toyota", "Corolla", ["LE", "SE"], "Sedan", 24_000],
  ["Toyota", "RAV4", ["LE", "XLE"], "SUV", 32_000],
  ["Honda", "Civic", ["LX", "Sport"], "Sedan", 25_000],
  ["Honda", "CR-V", ["EX", "Touring"], "SUV", 33_000],
  ["Hyundai", "Tucson", ["SE", "SEL"], "SUV", 30_000],
  ["Kia", "Sportage", ["LX", "EX"], "SUV", 29_000],
  ["Ford", "F-150", ["XL", "XLT"], "Pickup", 45_000],
  ["Mazda", "CX-5", ["Sport", "Touring"], "SUV", 31_000],
  ["Nissan", "Altima", ["S", "SV"], "Sedan", 26_000],
  ["Tesla", "Model 3", ["RWD", "Long Range"], "Sedan", 42_000],
];
const FIRST = ["Sara", "Omar", "Emily", "Hassan", "Priya", "Daniel", "Ayesha", "James", "Fatima", "Lucas", "Zara", "Noah", "Olivia", "Ali", "Grace", "Ethan", "Mia", "Bilal", "Chloe", "Ryan"];
const LAST = ["Khan", "Clarke", "Patel", "Moore", "Malik", "Wilson", "Noor", "Brown", "Ahmed", "Davis", "Lee", "Garcia", "Hughes", "Shah", "Evans"];
const VIN_CHARS = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";

export async function seedDemo(c: PoolClient, opts: { now: Date; timeZone: string; force: boolean; password: string }) {
  const existing = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM vehicles")).rows[0].n;
  if (existing && !opts.force) throw new Error(`The database already has ${existing} vehicles. Re-run with --force to replace everything with demo data.`);
  if (opts.force) {
    for (const t of ["documents", "vehicle_costs", "activities", "service_orders", "deals", "leads", "vehicles", "customers", "counters"]) await c.query(`DELETE FROM ${t}`);
    await c.query("UPDATE users SET branch_id = NULL");
    await c.query("DELETE FROM branches");
  }
  const r = rng(11);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const int = (a: number, b: number) => Math.floor(r() * (b - a + 1)) + a;
  const now = opts.now.getTime();
  const iso = (ms: number) => new Date(ms).toISOString();
  const date = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: opts.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

  await saveSettings(c, { ...DEFAULT_SETTINGS, companyName: "Demo Motor Group" });
  const branches = [
    { id: "b-downtown", name: "Downtown", address: "12 Market Street", phone: "+1 555 010 1000" },
    { id: "b-north", name: "Northside", address: "480 Ridge Road", phone: "+1 555 010 2000" },
  ];
  for (const b of branches) await c.query("INSERT INTO branches (id, name, address, phone) VALUES ($1, $2, $3, $4)", [b.id, b.name, b.address, b.phone]);

  const hash = await hashPassword(opts.password);
  const users = [
    ["u-demo-admin", DEMO_USERS.admin, "Alex Admin", "admin", "b-downtown"],
    ["u-demo-manager", DEMO_USERS.manager, "Morgan Manager", "manager", "b-downtown"],
    ["u-demo-sales", DEMO_USERS.sales, "Sam Sales", "sales", "b-downtown"],
    ["u-demo-sales2", DEMO_USERS.sales2, "Nina North", "sales", "b-north"],
    ["u-demo-service", DEMO_USERS.service, "Sid Service", "service", "b-downtown"],
  ] as const;
  for (const [id, email, name, role, branch] of users) {
    await c.query(
      `INSERT INTO users (id, email, name, role, branch_id, password_hash) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, role = EXCLUDED.role, branch_id = EXCLUDED.branch_id, password_hash = EXCLUDED.password_hash,
         active = true, failed_logins = 0, locked_until = NULL`,
      [id, email, name, role, branch, hash],
    );
  }
  const salespeople = ["u-demo-sales", "u-demo-sales2", "u-demo-manager"];

  // Customers.
  const customers: { id: string; name: string }[] = [];
  for (let i = 0; i < 60; i++) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const id = newId("c");
    customers.push({ id, name });
    const created = now - int(1, 200) * DAY;
    await c.query("INSERT INTO customers (id, kind, name, email, phone, address, created_at, updated_at) VALUES ($1, 'person', $2, $3, $4, $5, $6, $6)", [
      id,
      name,
      `${name.toLowerCase().replace(/[^a-z]+/g, ".")}${i}@example.com`,
      `+1 555 ${int(200, 899)} ${int(1000, 9999)}`,
      `${int(1, 999)} ${pick(["Oak", "Pine", "Lake", "Hill", "Park"])} Avenue`,
      iso(created),
    ]);
  }

  // Vehicles bought over the last ~7 months.
  interface V {
    id: string;
    stockNo: string;
    cost: number;
    list: number;
    acquired: number;
    branch: string;
    label: string;
  }
  const vehicles: V[] = [];
  for (let i = 0; i < 90; i++) {
    const [make, model, trims, body, base] = pick(MODELS);
    const year = 2026 - int(0, 7);
    const age = 2026 - year;
    const mileage = age === 0 ? int(5, 400) : int(8_000, 16_000) * age;
    const value = base * Math.pow(0.86, age) * (1 - Math.min(0.2, mileage / 600_000));
    const cost = Math.round(value * (0.82 + r() * 0.08)) * 100;
    const list = Math.round((value * (1.02 + r() * 0.06)) / 100) * 10_000 - 100;
    const acquired = now - int(1, 210) * DAY;
    const branch = r() < 0.6 ? "b-downtown" : "b-north";
    const v: V = { id: newId("v"), stockNo: `S${String(1000 + i)}`, cost, list, acquired, branch, label: `${year} ${make} ${model}` };
    vehicles.push(v);
    const vin = Array.from({ length: 17 }, () => pick(VIN_CHARS.split(""))).join("");
    await c.query(
      `INSERT INTO vehicles (id, stock_no, vin, year, make, model, trim, color, mileage, body, fuel, transmission, condition, branch_id, source, acquired_on,
                             purchase_cost_cents, list_price_cents, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'Automatic', $12, $13, $14, $15, $16, $17, $18)`,
      [v.id, v.stockNo, vin, year, make, model, pick(trims), pick(["White", "Black", "Silver", "Blue", "Red", "Grey"]), mileage, body, model.startsWith("Model") ? "Electric" : "Petrol", age === 0 ? "New" : "Used", branch, pick(["auction", "auction", "purchase", "trade_in"]), date(acquired), cost, list, iso(acquired)],
    );
    if (age > 0 && r() < 0.7) {
      await c.query("INSERT INTO vehicle_costs (id, vehicle_id, description, amount_cents, at, user_id) VALUES ($1, $2, $3, $4, $5, 'u-demo-manager')", [
        newId("vc"),
        v.id,
        pick(["Detailing and minor paint", "Tyres", "Brake service", "Transport from auction"]),
        int(15, 90) * 1000,
        iso(acquired + 2 * DAY),
      ]);
    }
  }

  // Leads, activities, and deals: older cars are more likely to have sold.
  const sources = ["walk_in", "phone", "website", "website", "marketplace", "marketplace", "referral", "repeat"] as const;
  let closed = 0;
  const closings: { at: number; dealId: string; vehicleId: string; w: Worksheet; leadId: string; cost: number }[] = [];
  const sorted = [...vehicles].sort((a, b) => a.acquired - b.acquired);
  for (const v of sorted) {
    const daysHeld = (now - v.acquired) / DAY;
    const sells = daysHeld > 20 && r() < 0.55 && closed < 48;
    const leadCount = sells ? int(1, 3) : r() < 0.35 ? 1 : 0;
    for (let k = 0; k < leadCount; k++) {
      const cust = pick(customers);
      const leadId = newId("l");
      const created = v.acquired + int(2, Math.max(3, Math.floor(daysHeld) - 1)) * DAY;
      const winner = sells && k === 0;
      const saleAt = Math.min(now - DAY, created + int(3, 25) * DAY);
      const status = winner ? "won" : daysHeld > 60 && r() < 0.6 ? "lost" : pick(["new", "contacted", "appointment", "negotiation"] as const);
      const assigned = pick(salespeople);
      const follow = status === "won" || status === "lost" ? null : iso(now + int(-4, 6) * DAY);
      await c.query(
        `INSERT INTO leads (id, customer_id, vehicle_id, source, status, interest, assigned_to, next_follow_up_at, lost_reason, branch_id, created_at, updated_at, closed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12)`,
        [leadId, cust.id, v.id, pick(sources), status, `Interested in the ${v.label}`, assigned, follow, status === "lost" ? pick(["Bought elsewhere", "Price", "Finance declined"]) : "", v.branch, iso(created), winner ? iso(saleAt) : status === "lost" ? iso(created + 10 * DAY) : null],
      );
      for (let a = 0; a < int(1, 3); a++) {
        await c.query("INSERT INTO activities (id, lead_id, customer_id, user_id, type, body, at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
          newId("a"),
          leadId,
          cust.id,
          assigned,
          pick(["call", "email", "sms", "test_drive"]),
          pick(["Discussed price and finance options.", "Booked a test drive.", "Sent the vehicle history report.", "Left a voicemail.", "Customer wants to think it over."]),
          iso(created + (a + 1) * DAY),
        ]);
      }
      if (winner) {
        const extraCost = (await c.query<{ s: number }>("SELECT COALESCE(sum(amount_cents), 0)::bigint AS s FROM vehicle_costs WHERE vehicle_id = $1", [v.id])).rows[0].s;
        const cost = v.cost + Number(extraCost);
        const discount = Math.round((v.list * int(0, 5)) / 100 / 100) * 100;
        const w: Worksheet = {
          salePriceCents: v.list,
          discountCents: discount,
          docFeeCents: DEFAULT_SETTINGS.docFeeCents,
          addOns: r() < 0.45 ? [{ description: "Extended warranty (3 years)", priceCents: 149_900, costCents: 62_000 }] : [],
          tradeIn: null,
          depositCents: 100_000 * int(5, 30),
          finance: r() < 0.6 ? { lender: pick(["First Auto Bank", "Metro Credit Union"]), aprPercent: pick([4.9, 6.9, 8.9]), termMonths: pick([48, 60, 72]) } : null,
        };
        const dealId = newId("d");
        await c.query(
          `INSERT INTO deals (id, customer_id, vehicle_id, lead_id, salesperson_id, branch_id, worksheet, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', $8, $8)`,
          [dealId, cust.id, v.id, leadId, assigned, v.branch, JSON.stringify(w), iso(saleAt - 2 * DAY)],
        );
        closings.push({ at: saleAt, dealId, vehicleId: v.id, w, leadId, cost });
        closed++;
      }
    }
  }
  // Close in date order, so invoice numbers go up with time as they would in real life.
  closings.sort((a, b) => a.at - b.at);
  for (const k of closings) {
    const totals = dealTotals(k.w, DEFAULT_SETTINGS);
    const gross = dealGross(k.w, k.cost);
    const number = await nextNumber(c, "deal", "INV");
    await c.query(
      `UPDATE deals SET status = 'closed', number = $2, totals = $3, vehicle_cost_cents = $4, gross = $5, closed_at = $6, updated_at = $6,
              approved_by = CASE WHEN $7 THEN 'u-demo-manager' END WHERE id = $1`,
      [k.dealId, number, JSON.stringify(totals), k.cost, JSON.stringify(gross), iso(k.at), gross.totalCents < DEFAULT_SETTINGS.minGrossCents],
    );
    await c.query("UPDATE vehicles SET status = 'sold', sold_at = $2 WHERE id = $1", [k.vehicleId, iso(k.at)]);
  }

  // A couple of deals in progress, one of them waiting for a manager.
  const available = sorted.filter((v) => !closings.some((k) => k.vehicleId === v.id)).slice(-6);
  for (const [i, v] of available.slice(0, 2).entries()) {
    const cust = customers[i];
    const w: Worksheet = { salePriceCents: v.list, discountCents: i === 0 ? Math.round(v.list * 0.09) : 50_000, docFeeCents: DEFAULT_SETTINGS.docFeeCents, addOns: [], tradeIn: null, depositCents: 100_000, finance: null };
    const status = i === 0 ? "pending_approval" : "draft";
    await c.query(
      `INSERT INTO deals (id, customer_id, vehicle_id, salesperson_id, branch_id, worksheet, status, notes) VALUES ($1, $2, $3, 'u-demo-sales', $4, $5, $6, $7)`,
      [newId("d"), cust.id, v.id, v.branch, JSON.stringify(w), status, i === 0 ? "Customer asks for a bigger discount to match a competitor." : ""],
    );
    if (status === "pending_approval") await c.query("UPDATE vehicles SET status = 'reserved' WHERE id = $1", [v.id]);
  }

  // Service: customer jobs (some invoiced) and internal reconditioning.
  const rate = DEFAULT_SETTINGS.labourRateCents;
  for (let i = 0; i < 24; i++) {
    const internal = i % 6 === 0;
    const v = available[available.length - 1 - (i % 3)];
    const created = now - int(0, 90) * DAY;
    const status = internal ? "open" : created < now - 5 * DAY ? "closed" : pick(["open", "in_progress", "waiting_parts", "done"] as const);
    const lines: ServiceLine[] = [
      { kind: "labour", description: pick(["Oil and filter service", "Brake inspection", "Diagnostics", "Tyre rotation"]), quantity: pick([0.5, 1, 1.5]), unitCents: rate },
      { kind: "part", description: pick(["Oil filter", "Brake pads", "Wiper blades", "Air filter"]), quantity: pick([1, 2]), unitCents: int(12, 90) * 100 },
    ];
    const t = serviceTotals(lines, DEFAULT_SETTINGS, internal);
    const cust = internal ? null : pick(customers);
    const number = await nextNumber(c, "service", "RO");
    const invoice = status === "closed" ? await nextNumber(c, "service-invoice", "SI") : null;
    await c.query(
      `INSERT INTO service_orders (id, number, status, customer_id, stock_vehicle_id, vehicle_desc, plate, mileage, complaint, technician, lines,
                                   subtotal_cents, tax_cents, total_cents, invoice_no, branch_id, created_at, updated_at, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'b-downtown', $16, $16, $17)`,
      [newId("s"), number, status, cust?.id ?? null, internal ? v.id : null, internal ? `${v.label} · stock ${v.stockNo}` : pick(["2019 Honda Civic", "2021 Toyota RAV4", "2017 Ford F-150", "2020 Kia Sportage"]), internal ? "" : `ABC-${int(100, 999)}`, int(20_000, 120_000), internal ? "Pre-sale inspection and detailing" : pick(["Routine service", "Squeaking brakes", "Check engine light", "Tyres worn"]), pick(["Jordan", "Casey", "Riley"]), JSON.stringify(lines), t.subtotalCents, t.taxCents, t.totalCents, invoice, iso(created), status === "closed" ? iso(created + DAY) : null],
    );
  }
  return { branches: branches.length, vehicles: vehicles.length, closedDeals: closings.length, customers: customers.length, logins: Object.values(DEMO_USERS) };
}
