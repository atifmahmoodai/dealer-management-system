import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { todayIn } from "../config";
import { tx, type Queryable } from "../db";
import { badRequest, conflict, HttpError, notFound, parse, requireUser } from "../http";
import { audit, DEAL_SELECT, getSettings, loadVehicle, newId, nextNumber, seesCost, toDeal } from "../repo/data";
import { dealGross, dealTotals, worksheetProblems, type Worksheet } from "../../../shared/deal";
import { dealCreateSchema, dealUpdateSchema } from "../../../shared/schemas";
import type { Settings } from "../../../shared/types";

const versionSchema = z.object({ version: z.number().int(), reason: z.string().trim().max(500).default("") });

/** Keeps the car's status in line with its deals: sold, held for a deal in progress, or available. */
export async function syncVehicleStatus(c: Queryable, vehicleId: string) {
  await c.query(
    `UPDATE vehicles SET status = CASE
        WHEN EXISTS (SELECT 1 FROM deals WHERE vehicle_id = $1 AND status = 'closed') THEN 'sold'
        WHEN EXISTS (SELECT 1 FROM deals WHERE vehicle_id = $1 AND status IN ('pending_approval', 'approved')) THEN 'reserved'
        ELSE 'in_stock' END,
        updated_at = now()
      WHERE id = $1`,
    [vehicleId],
  );
}

function checkWorksheet(w: Worksheet, s: Settings) {
  const problems = worksheetProblems(w, s);
  if (Object.keys(problems).length) {
    throw badRequest(Object.values(problems)[0], Object.fromEntries(Object.entries(problems).map(([k, v]) => [`worksheet.${k}`, v])));
  }
}

export async function dealRoutes(app: FastifyInstance) {
  const sales = requireUser("admin", "manager", "sales");
  const managers = requireUser("admin", "manager");
  const uid = (req: FastifyRequest) => req.session!.user.id;
  const show = (req: FastifyRequest) => seesCost(req.session!.user.role);

  const load = async (c: Queryable, id: string, lock = false) => {
    const { rows } = await c.query(`${DEAL_SELECT} WHERE d.id = $1${lock ? " FOR UPDATE OF d" : ""}`, [id]);
    if (!rows[0]) throw notFound("Deal not found");
    return rows[0];
  };
  const respond = async (req: FastifyRequest, id: string) => toDeal(await load(app.db, id), await getSettings(app.db), show(req));
  const holdConflict = async (e: unknown, vehicleId: string) => {
    if ((e as { code?: string; constraint?: string }).constraint !== "deals_one_live_per_vehicle") return e;
    const other = await app.db.query<{ id: string; status: string; name: string }>(
      `SELECT d.id, d.status, c.name FROM deals d JOIN customers c ON c.id = d.customer_id
        WHERE d.vehicle_id = $1 AND d.status IN ('pending_approval', 'approved', 'closed') LIMIT 1`,
      [vehicleId],
    );
    const o = other.rows[0];
    return conflict(o?.status === "closed" ? "This car has already been sold." : `This car is already held for ${o?.name ?? "another customer"}'s deal.`);
  };

  app.get<{ Querystring: { status?: string; mine?: string } }>("/deals", { preHandler: sales }, async (req) => {
    const where: string[] = [];
    const args: unknown[] = [];
    const status = req.query.status ?? "open";
    if (status === "open") where.push("d.status IN ('draft', 'pending_approval', 'approved')");
    else if (["draft", "pending_approval", "approved", "closed", "cancelled"].includes(status)) {
      args.push(status);
      where.push(`d.status = $${args.length}`);
    } else if (status !== "all") throw badRequest("Unknown status.");
    if (req.query.mine === "1") {
      args.push(uid(req));
      where.push(`d.salesperson_id = $${args.length}`);
    }
    const { rows } = await app.db.query(`${DEAL_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(d.closed_at, d.updated_at) DESC LIMIT 500`, args);
    const settings = await getSettings(app.db);
    return { items: rows.map((r) => toDeal(r, settings, show(req))) };
  });

  app.get<{ Params: { id: string } }>("/deals/:id", { preHandler: sales }, async (req) => respond(req, req.params.id));

  app.post("/deals", { preHandler: sales }, async (req, reply) => {
    const d = parse(dealCreateSchema, req.body);
    const settings = await getSettings(app.db);
    checkWorksheet(d.worksheet, settings);
    const id = newId("d");
    await tx(app.db, async (c) => {
      const v = await loadVehicle(c, d.vehicleId, app.config.TIMEZONE);
      if (!v) throw badRequest("Choose a vehicle.", { vehicleId: "Unknown vehicle" });
      if (v.status === "sold") throw conflict("This car has already been sold.");
      if (!(await c.query("SELECT 1 FROM customers WHERE id = $1", [d.customerId])).rowCount) throw badRequest("Choose a customer.", { customerId: "Unknown customer" });
      await c.query(
        `INSERT INTO deals (id, customer_id, vehicle_id, lead_id, salesperson_id, branch_id, worksheet) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, d.customerId, d.vehicleId, d.leadId, uid(req), v.branch_id, JSON.stringify(d.worksheet)],
      );
      if (d.leadId) await c.query("UPDATE leads SET status = 'negotiation', version = version + 1, updated_at = now() WHERE id = $1 AND status NOT IN ('won', 'lost')", [d.leadId]);
      await audit(c, { userId: uid(req), action: "deal.create", entity: "deal", entityId: id, details: { vehicle: v.stock_no }, ip: req.ip });
    });
    return reply.status(201).send(await respond(req, id));
  });

  app.put<{ Params: { id: string } }>("/deals/:id", { preHandler: sales }, async (req) => {
    const u = parse(dealUpdateSchema, req.body);
    const settings = await getSettings(app.db);
    checkWorksheet(u.worksheet, settings);
    await tx(app.db, async (c) => {
      const d = await load(c, req.params.id, true);
      if (d.version !== u.version) throw conflict("Someone else changed this deal. Reload to see their changes.");
      if (d.status === "closed" || d.status === "cancelled") throw conflict(`A ${d.status} deal can't be changed.`);
      // Changing the numbers after submission needs a fresh submission (and approval, if the gross is low).
      await c.query("UPDATE deals SET worksheet = $2, notes = $3, status = 'draft', approved_by = NULL, approved_at = NULL, version = version + 1, updated_at = now() WHERE id = $1", [
        d.id,
        JSON.stringify(u.worksheet),
        u.notes,
      ]);
      if (d.status !== "draft") await syncVehicleStatus(c, d.vehicle_id);
      await audit(c, { userId: uid(req), action: "deal.update", entity: "deal", entityId: d.id, ip: req.ip });
    });
    return respond(req, req.params.id);
  });

  app.post<{ Params: { id: string } }>("/deals/:id/submit", { preHandler: sales }, async (req) => {
    const { version } = parse(versionSchema, req.body);
    const settings = await getSettings(app.db);
    let vehicleId = "";
    try {
      await tx(app.db, async (c) => {
        const d = await load(c, req.params.id, true);
        vehicleId = d.vehicle_id;
        if (d.version !== version) throw conflict("Someone else changed this deal. Reload to see their changes.");
        if (d.status !== "draft") throw conflict("Only a draft deal can be submitted.");
        await loadVehicle(c, d.vehicle_id, app.config.TIMEZONE, true);
        const gross = dealGross(d.worksheet, Number(d.live_cost_cents));
        const next = gross.totalCents >= settings.minGrossCents ? "approved" : "pending_approval";
        await c.query("UPDATE deals SET status = $2, version = version + 1, updated_at = now() WHERE id = $1", [d.id, next]);
        await syncVehicleStatus(c, d.vehicle_id);
        await audit(c, { userId: uid(req), action: "deal.submit", entity: "deal", entityId: d.id, details: { result: next }, ip: req.ip });
      });
    } catch (e) {
      throw await holdConflict(e, vehicleId);
    }
    return respond(req, req.params.id);
  });

  app.post<{ Params: { id: string } }>("/deals/:id/approve", { preHandler: managers }, async (req) => {
    const { version } = parse(versionSchema, req.body);
    await tx(app.db, async (c) => {
      const d = await load(c, req.params.id, true);
      if (d.version !== version) throw conflict("Someone else changed this deal. Reload to see their changes.");
      if (d.status !== "pending_approval") throw conflict("This deal isn't waiting for approval.");
      await c.query("UPDATE deals SET status = 'approved', approved_by = $2, approved_at = now(), version = version + 1, updated_at = now() WHERE id = $1", [d.id, uid(req)]);
      await audit(c, { userId: uid(req), action: "deal.approve", entity: "deal", entityId: d.id, ip: req.ip });
    });
    return respond(req, req.params.id);
  });

  app.post<{ Params: { id: string } }>("/deals/:id/reject", { preHandler: managers }, async (req) => {
    const { version, reason } = parse(versionSchema, req.body);
    if (!reason) throw badRequest("Say why, so the salesperson can rework the deal.", { reason: "Required" });
    await tx(app.db, async (c) => {
      const d = await load(c, req.params.id, true);
      if (d.version !== version) throw conflict("Someone else changed this deal. Reload to see their changes.");
      if (d.status !== "pending_approval") throw conflict("This deal isn't waiting for approval.");
      const notes = `${d.notes ? `${d.notes}\n` : ""}Sent back: ${reason}`;
      await c.query("UPDATE deals SET status = 'draft', notes = $2, version = version + 1, updated_at = now() WHERE id = $1", [d.id, notes]);
      await syncVehicleStatus(c, d.vehicle_id);
      await audit(c, { userId: uid(req), action: "deal.reject", entity: "deal", entityId: d.id, details: { reason }, ip: req.ip });
    });
    return respond(req, req.params.id);
  });

  app.post<{ Params: { id: string } }>("/deals/:id/close", { preHandler: sales }, async (req) => {
    const { version } = parse(versionSchema, req.body);
    const settings = await getSettings(app.db);
    try {
      await tx(app.db, async (c) => {
        const d = await load(c, req.params.id, true);
        if (d.version !== version) throw conflict("Someone else changed this deal. Reload to see their changes.");
        if (d.status !== "approved") throw conflict(d.status === "pending_approval" ? "A manager must approve this deal first." : "Only an approved deal can be closed.");
        const v = await loadVehicle(c, d.vehicle_id, app.config.TIMEZONE, true);
        const w = d.worksheet as Worksheet;
        const cost = Number(v.total_cost_cents);
        const totals = dealTotals(w, settings);
        const gross = dealGross(w, cost);
        // Costs added after approval can push the gross under the limit; that needs a new look.
        if (gross.totalCents < settings.minGrossCents && !d.approved_by) throw conflict("The gross is now below the minimum (costs changed). Resubmit for approval.");
        const number = await nextNumber(c, "deal", "INV");
        let tradeVehicleId: string | null = null;
        if (w.tradeIn) {
          tradeVehicleId = newId("v");
          const stockNo = await nextNumber(c, "trade", "T");
          const t = w.tradeIn;
          await c.query(
            `INSERT INTO vehicles (id, stock_no, vin, year, make, model, mileage, body, fuel, transmission, condition, branch_id, source, acquired_on,
                                   purchase_cost_cents, list_price_cents, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'Sedan', 'Petrol', 'Automatic', 'Used', $8, 'trade_in', $9, $10, $11, $12)`,
            [tradeVehicleId, stockNo, t.vin, t.year, t.make, t.model, t.mileage, d.branch_id, todayIn(app.config.TIMEZONE), t.acvCents, Math.max(100, Math.round((t.acvCents * 1.2) / 10_000) * 10_000), `Traded in on ${number}. Check body, fuel and gearbox before pricing.`],
          );
        }
        await c.query(
          `UPDATE deals SET status = 'closed', number = $2, totals = $3, vehicle_cost_cents = $4, gross = $5, trade_vehicle_id = $6,
                  closed_at = now(), version = version + 1, updated_at = now()
            WHERE id = $1`,
          [d.id, number, JSON.stringify(totals), cost, JSON.stringify(gross), tradeVehicleId],
        );
        await c.query("UPDATE vehicles SET sold_at = now() WHERE id = $1", [d.vehicle_id]);
        await syncVehicleStatus(c, d.vehicle_id);
        if (d.lead_id) await c.query("UPDATE leads SET status = 'won', closed_at = now(), next_follow_up_at = NULL, version = version + 1, updated_at = now() WHERE id = $1", [d.lead_id]);
        await audit(c, { userId: uid(req), action: "deal.close", entity: "deal", entityId: d.id, details: { number, stockNo: v.stock_no, totalCents: totals.totalCents }, ip: req.ip });
      });
    } catch (e) {
      const err = e as { code?: string; constraint?: string };
      if (err.constraint === "vehicles_vin_in_stock") throw new HttpError(409, "The trade-in's VIN is already in stock. Check the VIN.", "conflict", { "worksheet.tradeIn.vin": "Already in stock" });
      throw e;
    }
    return respond(req, req.params.id);
  });

  app.post<{ Params: { id: string } }>("/deals/:id/cancel", { preHandler: sales }, async (req) => {
    const { version, reason } = parse(versionSchema, req.body);
    await tx(app.db, async (c) => {
      const d = await load(c, req.params.id, true);
      if (d.version !== version) throw conflict("Someone else changed this deal. Reload to see their changes.");
      if (d.status === "closed") throw conflict("A closed deal can't be cancelled.");
      if (d.status === "cancelled") return;
      await c.query("UPDATE deals SET status = 'cancelled', notes = notes || $2, version = version + 1, updated_at = now() WHERE id = $1", [d.id, reason ? `\nCancelled: ${reason}` : ""]);
      await syncVehicleStatus(c, d.vehicle_id);
      await audit(c, { userId: uid(req), action: "deal.cancel", entity: "deal", entityId: d.id, details: { reason }, ip: req.ip });
    });
    return respond(req, req.params.id);
  });
}
