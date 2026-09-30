import type { FastifyInstance, FastifyRequest } from "fastify";
import { tx } from "../db";
import { conflict, HttpError, notFound, parse, requireUser } from "../http";
import { audit, DEAL_SELECT, getSettings, loadVehicle, newId, seesCost, toDeal, toVehicle, vehicleSelect } from "../repo/data";
import { likeTerm } from "./customers";
import { toCsv } from "../../../shared/csv";
import { vehicleCostSchema, vehicleSchema, vehicleUpdateSchema } from "../../../shared/schemas";

export async function inventoryRoutes(app: FastifyInstance) {
  const anyone = requireUser();
  const managers = requireUser("admin", "manager");
  const uid = (req: FastifyRequest) => req.session!.user.id;
  const tz = app.config.TIMEZONE;

  const duplicate = (e: unknown) => {
    const err = e as { code?: string; constraint?: string };
    if (err.code !== "23505") return e;
    if (err.constraint === "vehicles_stock_no_key") return new HttpError(409, "That stock number is already used.", "conflict", { stockNo: "Already used" });
    if (err.constraint === "vehicles_vin_in_stock") return new HttpError(409, "A car with that VIN is already in stock.", "conflict", { vin: "Already in stock" });
    return e;
  };

  interface ListQuery {
    status?: string;
    branch?: string;
    q?: string;
    aged?: string;
    sort?: string;
  }
  const listVehicles = async (qs: ListQuery, showCost: boolean) => {
    const where: string[] = [];
    const args: unknown[] = [tz];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replace("?", `$${args.length}`));
    };
    const status = qs.status ?? "available";
    if (status === "available") where.push("v.status IN ('in_stock', 'reserved')");
    else if (["in_stock", "reserved", "sold"].includes(status)) add("v.status = ?", status);
    if (qs.branch) add("v.branch_id = ?", qs.branch);
    const q = (qs.q ?? "").trim().slice(0, 100);
    if (q) add("(v.stock_no ILIKE ? OR v.vin ILIKE $X OR (v.year || ' ' || v.make || ' ' || v.model || ' ' || v.trim) ILIKE $X)".replaceAll("$X", `$${args.length + 1}`), likeTerm(q));
    if (qs.aged && /^\d+$/.test(qs.aged)) add(`(COALESCE(v.sold_at::date, (now() AT TIME ZONE $1)::date) - v.acquired_on) >= ?`, Number(qs.aged));
    const order = qs.sort === "age" ? "v.acquired_on ASC" : qs.sort === "price" ? "v.list_price_cents DESC" : "v.acquired_on DESC";
    const { rows } = await app.db.query(`${vehicleSelect(1)} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order}, v.stock_no LIMIT 1000`, args);
    return rows.map((r) => toVehicle(r, showCost));
  };

  app.get<{ Querystring: ListQuery }>("/vehicles", { preHandler: anyone }, async (req) => ({ items: await listVehicles(req.query, seesCost(req.session!.user.role)) }));

  app.get<{ Querystring: ListQuery }>("/vehicles.csv", { preHandler: managers }, async (req, reply) => {
    const items = await listVehicles({ ...req.query, status: req.query.status ?? "all" }, true);
    const csv = toCsv(
      ["StockNo", "VIN", "Year", "Make", "Model", "Trim", "Mileage", "Condition", "Branch", "Status", "Acquired", "DaysInStock", "ListPrice", "PurchaseCost", "TotalCost"],
      items.map((v) => [v.stockNo, v.vin, v.year, v.make, v.model, v.trim, v.mileage, v.condition, v.branchId, v.status, v.acquiredOn, v.daysInStock, v.listPriceCents / 100, (v.purchaseCostCents ?? 0) / 100, (v.totalCostCents ?? 0) / 100]),
    );
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="inventory.csv"').send("﻿" + csv);
  });

  app.get<{ Params: { id: string } }>("/vehicles/:id", { preHandler: anyone }, async (req) => {
    const show = seesCost(req.session!.user.role);
    const row = await loadVehicle(app.db, req.params.id, tz);
    if (!row) throw notFound("Vehicle not found");
    const settings = await getSettings(app.db);
    const [costs, deals] = await Promise.all([
      show
        ? app.db.query(
            `SELECT vc.id, vc.description, vc.amount_cents AS "amountCents", vc.at, u.name AS "byName"
               FROM vehicle_costs vc LEFT JOIN users u ON u.id = vc.user_id WHERE vc.vehicle_id = $1 ORDER BY vc.at`,
            [req.params.id],
          )
        : { rows: [] },
      app.db.query(`${DEAL_SELECT} WHERE d.vehicle_id = $1 ORDER BY d.created_at DESC`, [req.params.id]),
    ]);
    return {
      vehicle: toVehicle(row, show),
      costs: costs.rows.map((c) => ({ ...c, amountCents: Number(c.amountCents), at: (c.at as Date).toISOString() })),
      deals: deals.rows.map((d) => toDeal(d, settings, show)),
    };
  });

  app.post("/vehicles", { preHandler: managers }, async (req, reply) => {
    const v = parse(vehicleSchema, req.body);
    const id = newId("v");
    try {
      await app.db.query(
        `INSERT INTO vehicles (id, stock_no, vin, year, make, model, trim, color, mileage, body, fuel, transmission, condition, branch_id, source,
                               acquired_on, purchase_cost_cents, list_price_cents, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [id, v.stockNo, v.vin, v.year, v.make, v.model, v.trim, v.color, v.mileage, v.body, v.fuel, v.transmission, v.condition, v.branchId, v.source, v.acquiredOn, v.purchaseCostCents, v.listPriceCents, v.notes],
      );
    } catch (e) {
      throw duplicate(e);
    }
    await audit(app.db, { userId: uid(req), action: "vehicle.create", entity: "vehicle", entityId: id, details: { stockNo: v.stockNo }, ip: req.ip });
    return reply.status(201).send({ id });
  });

  app.put<{ Params: { id: string } }>("/vehicles/:id", { preHandler: managers }, async (req) => {
    const v = parse(vehicleUpdateSchema, req.body);
    try {
      await tx(app.db, async (c) => {
        const cur = await loadVehicle(c, req.params.id, tz, true);
        if (!cur) throw notFound("Vehicle not found");
        if (cur.version !== v.version) throw conflict("Someone else changed this vehicle. Reload to see their changes.");
        if (cur.status === "sold") throw conflict("A sold vehicle can't be edited.");
        await c.query(
          `UPDATE vehicles SET stock_no = $2, vin = $3, year = $4, make = $5, model = $6, trim = $7, color = $8, mileage = $9, body = $10, fuel = $11,
                  transmission = $12, condition = $13, branch_id = $14, source = $15, acquired_on = $16, purchase_cost_cents = $17,
                  list_price_cents = $18, notes = $19, version = version + 1, updated_at = now()
            WHERE id = $1`,
          [req.params.id, v.stockNo, v.vin, v.year, v.make, v.model, v.trim, v.color, v.mileage, v.body, v.fuel, v.transmission, v.condition, v.branchId, v.source, v.acquiredOn, v.purchaseCostCents, v.listPriceCents, v.notes],
        );
        const changed = Number(cur.list_price_cents) !== v.listPriceCents ? { listPriceFrom: Number(cur.list_price_cents), listPriceTo: v.listPriceCents } : {};
        await audit(c, { userId: uid(req), action: "vehicle.update", entity: "vehicle", entityId: req.params.id, details: { stockNo: v.stockNo, ...changed }, ip: req.ip });
      });
    } catch (e) {
      throw duplicate(e);
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/vehicles/:id/costs", { preHandler: managers }, async (req, reply) => {
    const cost = parse(vehicleCostSchema, req.body);
    const id = newId("vc");
    await tx(app.db, async (c) => {
      const v = await loadVehicle(c, req.params.id, tz, true);
      if (!v) throw notFound("Vehicle not found");
      if (v.status === "sold") throw conflict("Costs can't be added after the car is sold: the deal's gross is final.");
      await c.query("INSERT INTO vehicle_costs (id, vehicle_id, description, amount_cents, user_id) VALUES ($1, $2, $3, $4, $5)", [id, v.id, cost.description, cost.amountCents, uid(req)]);
      await audit(c, { userId: uid(req), action: "vehicle.cost", entity: "vehicle", entityId: v.id, details: cost, ip: req.ip });
    });
    return reply.status(201).send({ id });
  });
}
