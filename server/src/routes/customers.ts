import type { FastifyInstance, FastifyRequest } from "fastify";
import { notFound, parse, requireUser } from "../http";
import { audit, DEAL_SELECT, getSettings, LEAD_SELECT, newId, SERVICE_SELECT, seesCost, toDeal, toLead, toService } from "../repo/data";
import { customerSchema } from "../../../shared/schemas";
import type { Customer } from "../../../shared/types";

const toCustomer = (r: Record<string, unknown>): Customer => ({
  id: r.id as string,
  kind: r.kind as Customer["kind"],
  name: r.name as string,
  email: (r.email as string) ?? null,
  phone: r.phone as string,
  address: r.address as string,
  notes: r.notes as string,
  createdAt: (r.created_at as Date).toISOString(),
});

/** Escapes LIKE wildcards so a search for "50%" means the text "50%". */
export const likeTerm = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function customerRoutes(app: FastifyInstance) {
  const anyone = requireUser();
  const uid = (req: FastifyRequest) => req.session!.user.id;

  app.get<{ Querystring: { q?: string; page?: string } }>("/customers", { preHandler: anyone }, async (req) => {
    const q = (req.query.q ?? "").trim().slice(0, 100);
    const page = Math.max(1, Math.min(10_000, Number(req.query.page) || 1));
    const size = 50;
    const args: unknown[] = [];
    let where = "TRUE";
    if (q) {
      args.push(likeTerm(q), likeTerm(q.replace(/[^\d+]/g, "")));
      where = `(c.name ILIKE $1 OR c.email ILIKE $1 OR (length($2) > 3 AND regexp_replace(c.phone, '[^0-9+]', '', 'g') ILIKE $2))`;
    }
    const { rows } = await app.db.query(
      `SELECT c.*,
              (SELECT count(*)::int FROM deals d WHERE d.customer_id = c.id AND d.status = 'closed') AS purchases,
              (SELECT count(*)::int FROM leads l WHERE l.customer_id = c.id AND l.status NOT IN ('won', 'lost')) AS open_leads
         FROM customers c WHERE ${where}
        ORDER BY c.updated_at DESC, c.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, size + 1, (page - 1) * size],
    );
    return { items: rows.slice(0, size).map((r) => ({ ...toCustomer(r), purchases: r.purchases, openLeads: r.open_leads })), hasMore: rows.length > size };
  });

  app.get<{ Params: { id: string } }>("/customers/:id", { preHandler: anyone }, async (req) => {
    const { rows } = await app.db.query("SELECT * FROM customers WHERE id = $1", [req.params.id]);
    if (!rows[0]) throw notFound("Customer not found");
    const settings = await getSettings(app.db);
    const show = seesCost(req.session!.user.role);
    const [leads, deals, service] = await Promise.all([
      app.db.query(`${LEAD_SELECT} WHERE l.customer_id = $1 ORDER BY l.created_at DESC`, [req.params.id]),
      app.db.query(`${DEAL_SELECT} WHERE d.customer_id = $1 ORDER BY d.created_at DESC`, [req.params.id]),
      app.db.query(`${SERVICE_SELECT} WHERE s.customer_id = $1 ORDER BY s.created_at DESC`, [req.params.id]),
    ]);
    return {
      customer: toCustomer(rows[0]),
      leads: leads.rows.map(toLead),
      deals: deals.rows.map((d) => toDeal(d, settings, show)),
      service: service.rows.map(toService),
    };
  });

  app.post("/customers", { preHandler: anyone }, async (req, reply) => {
    const c = parse(customerSchema, req.body);
    const id = newId("c");
    await app.db.query("INSERT INTO customers (id, kind, name, email, phone, address, notes) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
      id,
      c.kind,
      c.name,
      c.email,
      c.phone,
      c.address,
      c.notes,
    ]);
    await audit(app.db, { userId: uid(req), action: "customer.create", entity: "customer", entityId: id, details: { name: c.name }, ip: req.ip });
    return reply.status(201).send({ id, ...c });
  });

  app.put<{ Params: { id: string } }>("/customers/:id", { preHandler: anyone }, async (req) => {
    const c = parse(customerSchema, req.body);
    const r = await app.db.query(
      "UPDATE customers SET kind = $2, name = $3, email = $4, phone = $5, address = $6, notes = $7, updated_at = now() WHERE id = $1",
      [req.params.id, c.kind, c.name, c.email, c.phone, c.address, c.notes],
    );
    if (!r.rowCount) throw notFound("Customer not found");
    await audit(app.db, { userId: uid(req), action: "customer.update", entity: "customer", entityId: req.params.id, ip: req.ip });
    return { id: req.params.id, ...c };
  });
}
