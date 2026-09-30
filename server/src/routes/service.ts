import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { tx } from "../db";
import { badRequest, conflict, notFound, parse, requireUser } from "../http";
import { audit, getSettings, loadVehicle, newId, nextNumber, SERVICE_SELECT, toService, vehicleLabel } from "../repo/data";
import { serviceTotals } from "../../../shared/service";
import { serviceOrderSchema, serviceUpdateSchema } from "../../../shared/schemas";

const versionSchema = z.object({ version: z.number().int() });

export async function serviceRoutes(app: FastifyInstance) {
  const svc = requireUser("admin", "manager", "service");
  const uid = (req: FastifyRequest) => req.session!.user.id;

  const load = async (id: string) => {
    const { rows } = await app.db.query(`${SERVICE_SELECT} WHERE s.id = $1`, [id]);
    if (!rows[0]) throw notFound("Service order not found");
    return toService(rows[0]);
  };

  app.get<{ Querystring: { status?: string } }>("/service", { preHandler: svc }, async (req) => {
    const status = req.query.status ?? "open";
    const where =
      status === "open"
        ? "s.status IN ('open', 'in_progress', 'waiting_parts', 'done')"
        : status === "closed"
          ? "s.status IN ('closed', 'cancelled')"
          : status === "all"
            ? "TRUE"
            : null;
    if (!where) throw badRequest("Unknown status.");
    const { rows } = await app.db.query(`${SERVICE_SELECT} WHERE ${where} ORDER BY s.created_at DESC LIMIT 500`);
    return { items: rows.map(toService) };
  });

  app.get<{ Params: { id: string } }>("/service/:id", { preHandler: svc }, async (req) => load(req.params.id));

  app.post("/service", { preHandler: svc }, async (req, reply) => {
    const o = parse(serviceOrderSchema, req.body);
    const id = newId("s");
    const me = req.session!.user;
    await tx(app.db, async (c) => {
      let desc = o.vehicleDesc;
      let branch = me.branchId;
      if (o.stockVehicleId) {
        const v = await loadVehicle(c, o.stockVehicleId, app.config.TIMEZONE);
        if (!v) throw badRequest("Choose a stock vehicle.", { stockVehicleId: "Unknown vehicle" });
        if (v.status === "sold") throw conflict("That car is sold; reconditioning it can't change its cost now.");
        desc = `${vehicleLabel(v)} · stock ${v.stock_no}`;
        branch = v.branch_id;
      } else if (!(await c.query("SELECT 1 FROM customers WHERE id = $1", [o.customerId])).rowCount) {
        throw badRequest("Choose a customer.", { customerId: "Unknown customer" });
      }
      if (!desc) throw badRequest("Describe the customer's car.", { vehicleDesc: "Required" });
      branch ??= (await c.query<{ id: string }>("SELECT id FROM branches ORDER BY name LIMIT 1")).rows[0].id;
      const number = await nextNumber(c, "service", "RO");
      await c.query(
        `INSERT INTO service_orders (id, number, customer_id, stock_vehicle_id, vehicle_desc, plate, mileage, complaint, technician, promised_at, branch_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, number, o.customerId, o.stockVehicleId, desc, o.plate.toUpperCase(), o.mileage, o.complaint, o.technician, o.promisedAt, branch],
      );
      await audit(c, { userId: me.id, action: "service.create", entity: "service", entityId: id, details: { number, internal: !!o.stockVehicleId }, ip: req.ip });
    });
    return reply.status(201).send(await load(id));
  });

  app.put<{ Params: { id: string } }>("/service/:id", { preHandler: svc }, async (req) => {
    const u = parse(serviceUpdateSchema, req.body);
    const settings = await getSettings(app.db);
    const cur = await load(req.params.id);
    if (cur.status === "closed" || cur.status === "cancelled") throw conflict(`A ${cur.status} order can't be changed.`);
    const t = serviceTotals(u.lines, settings, !!cur.stockVehicleId);
    const r = await app.db.query(
      `UPDATE service_orders SET status = $2, complaint = $3, technician = $4, notes = $5, lines = $6, subtotal_cents = $7, tax_cents = $8, total_cents = $9,
              version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $10 AND status NOT IN ('closed', 'cancelled')`,
      [cur.id, u.status, u.complaint, u.technician, u.notes, JSON.stringify(u.lines), t.subtotalCents, t.taxCents, t.totalCents, u.version],
    );
    if (!r.rowCount) throw conflict("Someone else changed this order. Reload to see their changes.");
    await audit(app.db, { userId: uid(req), action: "service.update", entity: "service", entityId: cur.id, details: { status: u.status, totalCents: t.totalCents }, ip: req.ip });
    return load(cur.id);
  });

  /** Customer job: issue the invoice. Internal job: post the cost onto the stock car. Either way the order is then final. */
  app.post<{ Params: { id: string } }>("/service/:id/close", { preHandler: svc }, async (req) => {
    const { version } = parse(versionSchema, req.body);
    await tx(app.db, async (c) => {
      const { rows } = await c.query("SELECT * FROM service_orders WHERE id = $1 FOR UPDATE", [req.params.id]);
      const o = rows[0];
      if (!o) throw notFound("Service order not found");
      if (o.version !== version) throw conflict("Someone else changed this order. Reload to see their changes.");
      if (o.status !== "done") throw conflict("Mark the work as done before closing the order.");
      if (!(o.lines as unknown[]).length) throw badRequest("Add the labour and parts before closing.");
      let invoiceNo: string | null = null;
      if (o.stock_vehicle_id) {
        const v = await loadVehicle(c, o.stock_vehicle_id, app.config.TIMEZONE, true);
        if (v.status === "sold") throw conflict("The car was sold while this order was open; its cost can no longer change. Cancel the order instead.");
        await c.query("INSERT INTO vehicle_costs (id, vehicle_id, description, amount_cents, service_order_id, user_id) VALUES ($1, $2, $3, $4, $5, $6)", [
          newId("vc"),
          o.stock_vehicle_id,
          `Reconditioning ${o.number}`,
          Number(o.subtotal_cents),
          o.id,
          uid(req),
        ]);
      } else {
        invoiceNo = await nextNumber(c, "service-invoice", "SI");
      }
      await c.query("UPDATE service_orders SET status = 'closed', invoice_no = $2, closed_at = now(), version = version + 1, updated_at = now() WHERE id = $1", [o.id, invoiceNo]);
      await audit(c, { userId: uid(req), action: "service.close", entity: "service", entityId: o.id, details: { number: o.number, invoiceNo, totalCents: Number(o.total_cents) }, ip: req.ip });
    });
    return load(req.params.id);
  });

  app.post<{ Params: { id: string } }>("/service/:id/cancel", { preHandler: svc }, async (req) => {
    const { version } = parse(versionSchema, req.body);
    const r = await app.db.query(
      "UPDATE service_orders SET status = 'cancelled', closed_at = now(), version = version + 1, updated_at = now() WHERE id = $1 AND version = $2 AND status <> 'closed'",
      [req.params.id, version],
    );
    if (!r.rowCount) throw conflict("This order changed or is already closed. Reload to see it.");
    await audit(app.db, { userId: uid(req), action: "service.cancel", entity: "service", entityId: req.params.id, ip: req.ip });
    return load(req.params.id);
  });
}
