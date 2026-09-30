import type { FastifyInstance, FastifyRequest } from "fastify";
import { tx } from "../db";
import { badRequest, conflict, notFound, parse, requireUser } from "../http";
import { audit, LEAD_SELECT, newId, toLead } from "../repo/data";
import { likeTerm } from "./customers";
import { activitySchema, LEAD_STATUSES, leadSchema, leadUpdateSchema } from "../../../shared/schemas";

export async function crmRoutes(app: FastifyInstance) {
  const crm = requireUser("admin", "manager", "sales");
  const uid = (req: FastifyRequest) => req.session!.user.id;

  app.get<{ Querystring: { status?: string; mine?: string; overdue?: string; q?: string } }>("/leads", { preHandler: crm }, async (req) => {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replaceAll("?", `$${args.length}`));
    };
    const status = req.query.status ?? "open";
    if (status === "open") where.push("l.status NOT IN ('won', 'lost')");
    else if ((LEAD_STATUSES as readonly string[]).includes(status)) add("l.status = ?", status);
    else if (status !== "all") throw badRequest("Unknown status.");
    if (req.query.mine === "1") add("l.assigned_to = ?", uid(req));
    if (req.query.overdue === "1") where.push("l.next_follow_up_at < now() AND l.status NOT IN ('won', 'lost')");
    const q = (req.query.q ?? "").trim().slice(0, 100);
    if (q) add("(c.name ILIKE ? OR c.email ILIKE ? OR c.phone ILIKE ? OR l.interest ILIKE ?)", likeTerm(q));
    const { rows } = await app.db.query(
      `${LEAD_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY l.next_follow_up_at ASC NULLS LAST, l.created_at DESC LIMIT 500`,
      args,
    );
    return { items: rows.map(toLead) };
  });

  app.get<{ Params: { id: string } }>("/leads/:id", { preHandler: crm }, async (req) => {
    const { rows } = await app.db.query(`${LEAD_SELECT} WHERE l.id = $1`, [req.params.id]);
    if (!rows[0]) throw notFound("Lead not found");
    const acts = await app.db.query(
      `SELECT a.id, a.type, a.body, a.at, u.name AS "byName" FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.lead_id = $1 ORDER BY a.at DESC`,
      [req.params.id],
    );
    return { lead: toLead(rows[0]), activities: acts.rows.map((a) => ({ ...a, at: (a.at as Date).toISOString() })) };
  });

  app.post("/leads", { preHandler: crm }, async (req, reply) => {
    const l = parse(leadSchema, req.body);
    const id = newId("l");
    const me = req.session!.user;
    await tx(app.db, async (c) => {
      const cust = await c.query("SELECT 1 FROM customers WHERE id = $1", [l.customerId]);
      if (!cust.rowCount) throw badRequest("Choose a customer.", { customerId: "Unknown customer" });
      // The lead belongs to the branch of the car of interest, else the creator's branch, else the first branch.
      const branch = (
        await c.query<{ id: string }>(
          `SELECT COALESCE((SELECT branch_id FROM vehicles WHERE id = $1), $2, (SELECT id FROM branches ORDER BY name LIMIT 1)) AS id`,
          [l.vehicleId, me.branchId],
        )
      ).rows[0].id;
      await c.query(
        `INSERT INTO leads (id, customer_id, vehicle_id, source, interest, assigned_to, next_follow_up_at, branch_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, l.customerId, l.vehicleId, l.source, l.interest, l.assignedTo ?? me.id, l.nextFollowUpAt, branch],
      );
      await audit(c, { userId: me.id, action: "lead.create", entity: "lead", entityId: id, details: { source: l.source }, ip: req.ip });
    });
    return reply.status(201).send({ id });
  });

  app.put<{ Params: { id: string } }>("/leads/:id", { preHandler: crm }, async (req) => {
    const l = parse(leadUpdateSchema, req.body);
    if (l.status === "lost" && !l.lostReason) throw badRequest("Say why the lead was lost.", { lostReason: "Required" });
    const row = await app.db.query(
      `UPDATE leads SET vehicle_id = $2, source = $3, interest = $4, assigned_to = $5, next_follow_up_at = $6, status = $7, lost_reason = $8,
              closed_at = CASE WHEN $7 IN ('won', 'lost') THEN COALESCE(closed_at, now()) ELSE NULL END,
              version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $9 RETURNING id`,
      [req.params.id, l.vehicleId, l.source, l.interest, l.assignedTo, l.status === "won" || l.status === "lost" ? null : l.nextFollowUpAt, l.status, l.status === "lost" ? l.lostReason : "", l.version],
    );
    if (!row.rowCount) {
      if (!(await app.db.query("SELECT 1 FROM leads WHERE id = $1", [req.params.id])).rowCount) throw notFound("Lead not found");
      throw conflict("Someone else updated this lead. Reload to see their changes.");
    }
    await audit(app.db, { userId: uid(req), action: "lead.update", entity: "lead", entityId: req.params.id, details: { status: l.status }, ip: req.ip });
    const { rows } = await app.db.query(`${LEAD_SELECT} WHERE l.id = $1`, [req.params.id]);
    return toLead(rows[0]);
  });

  app.post<{ Params: { id: string } }>("/leads/:id/activities", { preHandler: crm }, async (req, reply) => {
    const a = parse(activitySchema, req.body);
    const id = newId("a");
    const lead = await app.db.query<{ customer_id: string; status: string }>("SELECT customer_id, status FROM leads WHERE id = $1", [req.params.id]);
    if (!lead.rows[0]) throw notFound("Lead not found");
    await tx(app.db, async (c) => {
      await c.query("INSERT INTO activities (id, lead_id, customer_id, user_id, type, body) VALUES ($1, $2, $3, $4, $5, $6)", [id, req.params.id, lead.rows[0].customer_id, uid(req), a.type, a.body]);
      // Any contact moves a brand-new lead on to "contacted".
      await c.query("UPDATE leads SET status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END, version = version + 1, updated_at = now() WHERE id = $1", [req.params.id]);
    });
    return reply.status(201).send({ id });
  });
}
