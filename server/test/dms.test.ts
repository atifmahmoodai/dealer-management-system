import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_USERS } from "../src/seed";
import type { Deal, Vehicle } from "../../shared/types";
import { login, makeApp, type Agent, type TestCtx } from "./helpers";

let ctx: TestCtx;
let admin: Agent;
let manager: Agent;
let sales: Agent;
let service: Agent;
beforeAll(async () => {
  ctx = await makeApp();
  [admin, manager, sales, service] = await Promise.all([login(ctx.app, DEMO_USERS.admin), login(ctx.app, DEMO_USERS.manager), login(ctx.app, DEMO_USERS.sales), login(ctx.app, DEMO_USERS.service)]);
});
afterAll(() => ctx.close());

let seq = 0;
const vin = () => {
  const s = String(++seq).padStart(5, "0");
  return `1HGCM82633A${s}`.slice(0, 12) + s;
};
const today = () => new Date().toISOString().slice(0, 10);
const newVehicle = async (patch: Record<string, unknown> = {}) => {
  const body = {
    stockNo: `T${Date.now().toString(36)}${++seq}`,
    vin: vin(),
    year: 2022,
    make: "Toyota",
    model: "Camry",
    trim: "SE",
    color: "White",
    mileage: 30_000,
    body: "Sedan",
    fuel: "Petrol",
    transmission: "Automatic",
    condition: "Used",
    branchId: "b-downtown",
    source: "auction",
    acquiredOn: today(),
    purchaseCostCents: 2_000_000,
    listPriceCents: 2_500_000,
    notes: "",
    ...patch,
  };
  const r = await manager.send("POST", "/api/vehicles", body);
  expect(r.statusCode, r.body).toBe(201);
  return { id: r.json().id as string, ...body };
};
const newCustomer = async (name = "Test Buyer") => {
  const r = await sales.send("POST", "/api/customers", { kind: "person", name, email: "", phone: "+1 555 100 2000" });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
};
const worksheet = (patch: Record<string, unknown> = {}) => ({
  salePriceCents: 2_500_000,
  discountCents: 0,
  docFeeCents: 49_900,
  addOns: [],
  tradeIn: null,
  depositCents: 100_000,
  finance: null,
  ...patch,
});
const newDeal = async (vehicleId: string, customerId: string, w = worksheet(), who = sales) => {
  const r = await who.send("POST", "/api/deals", { customerId, vehicleId, leadId: null, worksheet: w });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as Deal;
};
const act = (who: Agent, d: Deal, action: string, extra: Record<string, unknown> = {}) => who.send("POST", `/api/deals/${d.id}/${action}`, { version: d.version, ...extra });

describe("roles and what they can see", () => {
  it("hides vehicle cost and deal gross from sales and service", async () => {
    const asSales = (await sales.get("/api/vehicles")).json().items as Vehicle[];
    expect(asSales.length).toBeGreaterThan(5);
    expect(asSales.every((v) => v.purchaseCostCents === undefined && v.totalCostCents === undefined)).toBe(true);
    const asManager = (await manager.get("/api/vehicles")).json().items as Vehicle[];
    expect(asManager.every((v) => typeof v.totalCostCents === "number")).toBe(true);
    const closedForSales = (await sales.get("/api/deals?status=closed")).json().items as Deal[];
    expect(closedForSales.length).toBeGreaterThan(5);
    expect(closedForSales.every((d) => d.gross === undefined)).toBe(true);
    expect(((await manager.get("/api/deals?status=closed")).json().items as Deal[]).every((d) => d.gross !== undefined)).toBe(true);
    const dash = (await sales.get("/api/dashboard")).json();
    expect(dash.salesMonth.grossCents).toBeUndefined();
    expect(dash.stock.costCents).toBeUndefined();
  });

  it("keeps each role to its own area", async () => {
    expect((await ctx.app.inject("/api/vehicles")).statusCode).toBe(401);
    expect((await sales.send("POST", "/api/vehicles", {})).statusCode).toBe(403);
    expect((await service.get("/api/leads")).statusCode).toBe(403);
    expect((await service.get("/api/deals")).statusCode).toBe(403);
    expect((await sales.get("/api/service")).statusCode).toBe(403);
    expect((await sales.get("/api/reports")).statusCode).toBe(403);
    expect((await manager.send("PUT", "/api/settings", {})).statusCode).toBe(403);
    const noCsrf = await ctx.app.inject({ method: "POST", url: "/api/customers", headers: { cookie: `sid=${sales.cookie}` }, payload: {} });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe("inventory", () => {
  it("validates and refuses duplicates", async () => {
    const bad = await manager.send("POST", "/api/vehicles", { stockNo: "", vin: "123", year: 1800, listPriceCents: 0 });
    expect(bad.statusCode).toBe(400);
    expect(Object.keys(bad.json().details)).toEqual(expect.arrayContaining(["stockNo", "vin", "year", "listPriceCents"]));
    const v = await newVehicle();
    const dupStock = await manager.send("POST", "/api/vehicles", { ...v, id: undefined, vin: vin() });
    expect(dupStock.statusCode).toBe(409);
    expect(dupStock.json().details.stockNo).toBeTruthy();
    const dupVin = await manager.send("POST", "/api/vehicles", { ...v, id: undefined, stockNo: `X${seq++}` });
    expect(dupVin.statusCode).toBe(409);
    expect(dupVin.json().details.vin).toBeTruthy();
  });

  it("tracks costs and refuses stale edits", async () => {
    const v = await newVehicle();
    expect((await manager.send("POST", `/api/vehicles/${v.id}/costs`, { description: "New tyres", amountCents: 48_000 })).statusCode).toBe(201);
    const detail = (await manager.get(`/api/vehicles/${v.id}`)).json();
    expect(detail.vehicle.totalCostCents).toBe(2_048_000);
    expect(detail.costs).toHaveLength(1);
    const { id, ...body } = v;
    expect((await manager.send("PUT", `/api/vehicles/${id}`, { ...body, listPriceCents: 2_450_000, version: 1 })).statusCode).toBe(200);
    expect((await admin.send("PUT", `/api/vehicles/${id}`, { ...body, listPriceCents: 2_400_000, version: 1 })).statusCode).toBe(409);
  });
});

describe("CRM", () => {
  it("needs a way to reach the customer", async () => {
    const r = await sales.send("POST", "/api/customers", { kind: "person", name: "No Contact", email: "", phone: "" });
    expect(r.statusCode).toBe(400);
  });

  it("runs a lead from new to lost, logging activity, with conflict detection", async () => {
    const customerId = await newCustomer("Lead Person");
    const created = await sales.send("POST", "/api/leads", { customerId, vehicleId: null, source: "website", interest: "Family SUV", assignedTo: null, nextFollowUpAt: new Date(Date.now() - 3_600_000).toISOString() });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    const overdue = (await sales.get("/api/leads?overdue=1&mine=1")).json().items;
    expect(overdue.some((l: { id: string }) => l.id === id)).toBe(true);
    expect((await sales.send("POST", `/api/leads/${id}/activities`, { type: "call", body: "Called, wants a test drive." })).statusCode).toBe(201);
    let { lead, activities } = (await sales.get(`/api/leads/${id}`)).json();
    expect(lead.status).toBe("contacted");
    expect(activities).toHaveLength(1);
    const update = { vehicleId: null, source: "website", interest: "Family SUV", assignedTo: lead.assignedTo, nextFollowUpAt: null, status: "lost", lostReason: "", version: lead.version };
    expect((await sales.send("PUT", `/api/leads/${id}`, update)).statusCode).toBe(400);
    expect((await sales.send("PUT", `/api/leads/${id}`, { ...update, lostReason: "Bought elsewhere" })).statusCode).toBe(200);
    expect((await manager.send("PUT", `/api/leads/${id}`, { ...update, status: "new", lostReason: "" })).statusCode).toBe(409);
    ({ lead } = (await sales.get(`/api/leads/${id}`)).json());
    expect(lead.status).toBe("lost");
  });
});

describe("deals", () => {
  it("closes a good deal: car sold, trade-in stocked at its real value, gapless number, lead won", async () => {
    const v = await newVehicle();
    const customerId = await newCustomer("Happy Buyer");
    const lead = await sales.send("POST", "/api/leads", { customerId, vehicleId: v.id, source: "walk_in", interest: "", assignedTo: null, nextFollowUpAt: null });
    const trade = { vin: vin(), year: 2016, make: "Honda", model: "Civic", mileage: 110_000, allowanceCents: 700_000, acvCents: 650_000, payoffCents: 0 };
    const created = await sales.send("POST", "/api/deals", { customerId, vehicleId: v.id, leadId: lead.json().id, worksheet: worksheet({ tradeIn: trade }) });
    let d = created.json() as Deal;
    expect(d.status).toBe("draft");
    // Front gross 25,000 − 20,000 − 500 over-allowance + doc fee: well above the minimum, so no approval needed.
    const sub = await act(sales, d, "submit");
    d = sub.json();
    expect(d.status).toBe("approved");
    expect((await manager.get(`/api/vehicles/${v.id}`)).json().vehicle.status).toBe("reserved");
    const closed = await act(sales, d, "close");
    expect(closed.statusCode, closed.body).toBe(200);
    d = closed.json();
    expect(d.status).toBe("closed");
    expect(d.number).toMatch(/^INV-\d{6}$/);
    const car = (await manager.get(`/api/vehicles/${v.id}`)).json().vehicle;
    expect(car.status).toBe("sold");
    const stocked = ((await manager.get("/api/vehicles?q=Civic")).json().items as Vehicle[]).find((x) => x.stockNo.startsWith("T-") && x.source === "trade_in" && x.mileage === 110_000);
    expect(stocked?.purchaseCostCents).toBe(650_000);
    expect((await sales.get(`/api/leads/${lead.json().id}`)).json().lead.status).toBe("won");
    // Sold is final: no second close, no new costs, no second deal.
    expect((await act(sales, d, "close")).statusCode).toBe(409);
    expect((await manager.send("POST", `/api/vehicles/${v.id}/costs`, { description: "Late bill", amountCents: 1000 })).statusCode).toBe(409);
    expect((await sales.send("POST", "/api/deals", { customerId, vehicleId: v.id, leadId: null, worksheet: worksheet() })).statusCode).toBe(409);
  });

  it("sends a thin deal to a manager, who must give a reason to send it back", async () => {
    const v = await newVehicle();
    const customerId = await newCustomer();
    // Front gross 25,000 − 5,000 − 20,000 = 0, plus the 499 doc fee: under the 500 minimum.
    let d = await newDeal(v.id, customerId, worksheet({ discountCents: 500_000 }));
    d = (await act(sales, d, "submit")).json();
    expect(d.status).toBe("pending_approval");
    expect((await act(sales, d, "close")).statusCode).toBe(409);
    expect((await act(sales, d, "approve")).statusCode).toBe(403);
    expect((await act(manager, d, "reject")).statusCode).toBe(400);
    d = (await act(manager, d, "reject", { reason: "Too much discount" })).json();
    expect(d.status).toBe("draft");
    expect((await manager.get(`/api/vehicles/${v.id}`)).json().vehicle.status).toBe("in_stock");
    d = (await act(sales, d, "submit")).json();
    const approved = await act(manager, d, "approve");
    expect(approved.json().status).toBe("approved");
    expect(approved.json().approvedByName).toBe("Morgan Manager");
    expect((await act(sales, approved.json(), "close")).json().status).toBe("closed");
  });

  it("editing a submitted deal returns it to draft and frees the car", async () => {
    const v = await newVehicle();
    let d = await newDeal(v.id, await newCustomer());
    d = (await act(sales, d, "submit")).json();
    const r = await sales.send("PUT", `/api/deals/${d.id}`, { worksheet: worksheet({ discountCents: 10_000 }), notes: "", version: d.version });
    expect(r.json().status).toBe("draft");
    expect((await manager.get(`/api/vehicles/${v.id}`)).json().vehicle.status).toBe("in_stock");
    expect((await sales.send("PUT", `/api/deals/${d.id}`, { worksheet: worksheet(), notes: "", version: d.version })).statusCode).toBe(409);
    const invalid = await sales.send("PUT", `/api/deals/${d.id}`, { worksheet: worksheet({ discountCents: 9_000_000 }), notes: "", version: r.json().version });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().details["worksheet.discountCents"]).toBeTruthy();
  });

  it("two salespeople racing for the same car: only one deal can hold it", async () => {
    const v = await newVehicle();
    const [a, b] = await Promise.all([newDeal(v.id, await newCustomer("Buyer A")), newDeal(v.id, await newCustomer("Buyer B"))]);
    const results = await Promise.all([act(sales, a, "submit"), act(sales, b, "submit")]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().message).toMatch(/already held/);
  });

  it("numbers invoices without gaps when deals close at the same moment", async () => {
    const deals: Deal[] = [];
    for (let i = 0; i < 4; i++) {
      const v = await newVehicle();
      deals.push((await act(sales, await newDeal(v.id, await newCustomer()), "submit")).json());
    }
    const closed = await Promise.all(deals.map((d) => act(sales, d, "close")));
    const nums = closed.map((r) => Number((r.json() as Deal).number!.slice(4))).sort((x, y) => x - y);
    expect(nums[3] - nums[0]).toBe(3);
  });

  it("freezes a closed deal: later tax changes don't rewrite history", async () => {
    const d = ((await sales.get("/api/deals?status=closed")).json().items as Deal[])[0];
    const s = (await admin.get("/api/meta")).json().settings;
    expect((await admin.send("PUT", "/api/settings", { ...s, taxPercent: 12 })).statusCode).toBe(200);
    const after = (await sales.get(`/api/deals/${d.id}`)).json() as Deal;
    expect(after.totals.taxCents).toBe(d.totals.taxCents);
    await admin.send("PUT", "/api/settings", s);
  });

  it("cancelling releases the car", async () => {
    const v = await newVehicle();
    let d = (await act(sales, await newDeal(v.id, await newCustomer()), "submit")).json();
    d = (await act(sales, d, "cancel", { reason: "Changed mind" })).json();
    expect(d.status).toBe("cancelled");
    expect((await manager.get(`/api/vehicles/${v.id}`)).json().vehicle.status).toBe("in_stock");
  });
});

describe("service", () => {
  it("invoices a customer job with tax and a service invoice number", async () => {
    const customerId = await newCustomer("Service Customer");
    const o = (await service.send("POST", "/api/service", { customerId, stockVehicleId: null, vehicleDesc: "2019 Honda Civic", plate: "abc-123", mileage: 60_000, complaint: "Brakes squeal", technician: "Jordan", promisedAt: null })).json();
    expect(o.number).toMatch(/^RO-/);
    expect(o.plate).toBe("ABC-123");
    const lines = [
      { kind: "labour", description: "Replace pads", quantity: 1.5, unitCents: 12_500 },
      { kind: "part", description: "Brake pads", quantity: 1, unitCents: 8_900 },
    ];
    let u = (await service.send("PUT", `/api/service/${o.id}`, { status: "in_progress", complaint: o.complaint, technician: "Jordan", notes: "", lines, version: o.version })).json();
    expect(u.subtotalCents).toBe(27_650);
    expect(u.taxCents).toBe(Math.round(27_650 * 0.07));
    expect((await service.send("POST", `/api/service/${o.id}/close`, { version: u.version })).statusCode).toBe(409);
    u = (await service.send("PUT", `/api/service/${o.id}`, { status: "done", complaint: o.complaint, technician: "Jordan", notes: "", lines, version: u.version })).json();
    const closed = (await service.send("POST", `/api/service/${o.id}/close`, { version: u.version })).json();
    expect(closed.status).toBe("closed");
    expect(closed.invoiceNo).toMatch(/^SI-/);
    expect((await service.send("PUT", `/api/service/${o.id}`, { status: "done", complaint: "x", technician: "", notes: "", lines, version: closed.version })).statusCode).toBe(409);
  });

  it("posts internal reconditioning onto the stock car's cost, without tax", async () => {
    const v = await newVehicle();
    const o = (await service.send("POST", "/api/service", { customerId: null, stockVehicleId: v.id, vehicleDesc: "", plate: "", mileage: null, complaint: "Pre-sale inspection", technician: "", promisedAt: null })).json();
    const lines = [{ kind: "labour", description: "Inspection", quantity: 2, unitCents: 12_500 }];
    const u = (await service.send("PUT", `/api/service/${o.id}`, { status: "done", complaint: o.complaint, technician: "", notes: "", lines, version: o.version })).json();
    expect(u.taxCents).toBe(0);
    const closed = (await service.send("POST", `/api/service/${o.id}/close`, { version: u.version })).json();
    expect(closed.invoiceNo).toBeNull();
    expect((await manager.get(`/api/vehicles/${v.id}`)).json().vehicle.totalCostCents).toBe(2_025_000);
  });

  it("needs either a customer or a stock car", async () => {
    const r = await service.send("POST", "/api/service", { customerId: null, stockVehicleId: null, vehicleDesc: "x", plate: "", mileage: null, complaint: "x", technician: "", promisedAt: null });
    expect(r.statusCode).toBe(400);
  });
});

describe("documents", () => {
  const upload = (who: Agent, entity: string, entityId: string, name: string, data: Buffer) => {
    const boundary = "----dms" + Math.random().toString(16).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="entity"\r\n\r\n${entity}\r\n--${boundary}\r\nContent-Disposition: form-data; name="entityId"\r\n\r\n${entityId}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return ctx.app.inject({ method: "POST", url: "/api/documents", headers: { cookie: `sid=${who.cookie}`, "x-csrf-token": who.csrf, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
  };

  it("stores real PDFs and images only, and serves them as downloads", async () => {
    const customerId = await newCustomer("Doc Owner");
    const pdf = Buffer.from("%PDF-1.4\n% test\n");
    const ok = await upload(sales, "customer", customerId, "../../licence scan.pdf", pdf);
    expect(ok.statusCode, ok.body).toBe(201);
    // Folder parts of the name are dropped; only a plain file name is kept.
    expect(ok.json().filename).toBe("licence scan.pdf");
    expect((await upload(sales, "customer", customerId, "virus.pdf", Buffer.from("MZ\x90\x00 not a pdf"))).statusCode).toBe(400);
    const list = (await sales.get(`/api/documents?entity=customer&entityId=${customerId}`)).json().items;
    expect(list).toHaveLength(1);
    const dl = await sales.get(`/api/documents/${list[0].id}/download`);
    expect(dl.headers["content-disposition"]).toMatch(/^attachment/);
    expect(dl.headers["content-type"]).toBe("application/pdf");
    expect(dl.rawPayload.equals(pdf)).toBe(true);
    // Service staff don't handle deal paperwork; files over 5 MB are refused.
    const deal = ((await sales.get("/api/deals?status=closed")).json().items as Deal[])[0];
    expect((await upload(service, "deal", deal.id, "x.pdf", pdf)).statusCode).toBe(403);
    const big = Buffer.concat([pdf, Buffer.alloc(5 * 1024 * 1024 + 10)]);
    expect([413, 400]).toContain((await upload(sales, "customer", customerId, "big.pdf", big)).statusCode);
  });
});

describe("reports", () => {
  it("adds up: the deals export matches the monthly report", async () => {
    const rep = (await manager.get("/api/reports?months=12")).json();
    expect(rep.monthly).toHaveLength(12);
    const csv = (await manager.get("/api/reports/deals.csv?months=12")).body.replace(/^﻿/, "").trim().split("\r\n");
    const rows = csv.slice(1).map((l) => l.split(","));
    const units = rep.monthly.reduce((s: number, m: { units: number }) => s + m.units, 0);
    expect(rows.length).toBe(units);
    const grossCol = csv[0].split(",").indexOf("TotalGross");
    const csvGross = Math.round(rows.reduce((s, r) => s + Number(r[grossCol]), 0) * 100);
    const repGross = rep.monthly.reduce((s: number, m: { frontCents: number; backCents: number }) => s + m.frontCents + m.backCents, 0);
    expect(csvGross).toBe(repGross);
    expect(rep.bySource.length).toBeGreaterThan(2);
    expect(rep.aged[0].days).toBeGreaterThanOrEqual(rep.aged[rep.aged.length - 1].days);
  });

  it("records who did what", async () => {
    const actions = new Set(((await admin.get("/api/audit")).json().items as { action: string }[]).map((a) => a.action));
    for (const a of ["deal.close", "deal.approve", "deal.reject", "vehicle.create", "service.close", "document.upload", "lead.create"]) expect(actions.has(a), a).toBe(true);
  });
});
