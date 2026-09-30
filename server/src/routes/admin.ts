import type { FastifyInstance, FastifyRequest } from "fastify";
import { tx } from "../db";
import { badRequest, HttpError, notFound, parse, requireUser } from "../http";
import { audit, getSettings, newId, saveSettings } from "../repo/data";
import { hashPassword } from "../security/password";
import { deleteUserSessions } from "../security/sessions";
import { branchSchema, resetPasswordSchema, settingsSchema, userCreateSchema, userUpdateSchema, type Role } from "../../../shared/schemas";
import type { Meta } from "../../../shared/types";

export async function adminRoutes(app: FastifyInstance) {
  const anyone = requireUser();
  const admin = requireUser("admin");
  const uid = (req: FastifyRequest) => req.session!.user.id;

  /** What every screen needs: settings, branches and the staff list (for assigning leads). */
  app.get("/meta", { preHandler: anyone }, async (): Promise<Meta> => {
    const [settings, branches, users] = await Promise.all([
      getSettings(app.db),
      app.db.query("SELECT id, name, address, phone FROM branches ORDER BY name"),
      app.db.query(`SELECT id, name, role, branch_id AS "branchId" FROM users WHERE active ORDER BY name`),
    ]);
    return { settings, branches: branches.rows, users: users.rows, timeZone: app.config.TIMEZONE };
  });

  app.put("/settings", { preHandler: admin }, async (req) => {
    const s = parse(settingsSchema, req.body);
    try {
      new Intl.NumberFormat(s.locale, { style: "currency", currency: s.currency });
    } catch {
      throw badRequest("That currency / locale combination isn't valid.", { currency: "Not a valid currency" });
    }
    await saveSettings(app.db, s);
    await audit(app.db, { userId: uid(req), action: "settings.update", entity: "settings", entityId: "app", details: s, ip: req.ip });
    return s;
  });

  app.post("/branches", { preHandler: admin }, async (req, reply) => {
    const b = parse(branchSchema, req.body);
    const id = newId("b");
    await app.db.query("INSERT INTO branches (id, name, address, phone) VALUES ($1, $2, $3, $4)", [id, b.name, b.address, b.phone]);
    await audit(app.db, { userId: uid(req), action: "branch.create", entity: "branch", entityId: id, details: b, ip: req.ip });
    return reply.status(201).send({ id, ...b });
  });
  app.put<{ Params: { id: string } }>("/branches/:id", { preHandler: admin }, async (req) => {
    const b = parse(branchSchema, req.body);
    const r = await app.db.query("UPDATE branches SET name = $2, address = $3, phone = $4 WHERE id = $1", [req.params.id, b.name, b.address, b.phone]);
    if (!r.rowCount) throw notFound("Branch not found");
    await audit(app.db, { userId: uid(req), action: "branch.update", entity: "branch", entityId: req.params.id, details: b, ip: req.ip });
    return { id: req.params.id, ...b };
  });

  interface UserRow {
    id: string;
    email: string;
    name: string;
    role: Role;
    branchId: string | null;
    active: boolean;
    locked: boolean;
  }
  const USERS = `SELECT id, email, name, role, branch_id AS "branchId", active, (locked_until IS NOT NULL AND locked_until > now()) AS locked FROM users`;
  app.get("/users", { preHandler: admin }, async () => ({ items: (await app.db.query<UserRow>(`${USERS} ORDER BY active DESC, name`)).rows }));
  app.post("/users", { preHandler: admin }, async (req, reply) => {
    const u = parse(userCreateSchema, req.body);
    const id = newId("u");
    try {
      await app.db.query("INSERT INTO users (id, email, name, role, branch_id, password_hash) VALUES ($1, $2, $3, $4, $5, $6)", [
        id,
        u.email,
        u.name,
        u.role,
        u.branchId,
        await hashPassword(u.password),
      ]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new HttpError(409, "A user with that email already exists.", "conflict", { email: "Already has a login" });
      if ((e as { code?: string }).code === "23503") throw badRequest("That branch doesn't exist.", { branchId: "Unknown branch" });
      throw e;
    }
    await audit(app.db, { userId: uid(req), action: "user.create", entity: "user", entityId: id, details: { email: u.email, role: u.role }, ip: req.ip });
    return reply.status(201).send({ id });
  });
  app.put<{ Params: { id: string } }>("/users/:id", { preHandler: admin }, async (req) => {
    const u = parse(userUpdateSchema, req.body);
    if (req.params.id === uid(req) && (u.role !== "admin" || !u.active)) throw badRequest("You can't remove your own admin access.");
    await tx(app.db, async (c) => {
      const r = await c.query("UPDATE users SET name = $2, role = $3, branch_id = $4, active = $5, updated_at = now() WHERE id = $1", [req.params.id, u.name, u.role, u.branchId, u.active]);
      if (!r.rowCount) throw notFound("User not found");
      if ((await c.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active")).rows[0].n === 0) throw badRequest("There must be at least one active admin.");
      if (!u.active) await deleteUserSessions(c, req.params.id);
      await audit(c, { userId: uid(req), action: "user.update", entity: "user", entityId: req.params.id, details: u, ip: req.ip });
    });
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/users/:id/password", { preHandler: admin }, async (req) => {
    const { password } = parse(resetPasswordSchema, req.body);
    const r = await app.db.query("UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1", [req.params.id, await hashPassword(password)]);
    if (!r.rowCount) throw notFound("User not found");
    await deleteUserSessions(app.db, req.params.id);
    await audit(app.db, { userId: uid(req), action: "user.password_reset", entity: "user", entityId: req.params.id, ip: req.ip });
    return { ok: true };
  });

  app.get<{ Querystring: { before?: string } }>("/audit", { preHandler: admin }, async (req) => {
    const before = Number(req.query.before) || null;
    const { rows } = await app.db.query(
      `SELECT a.id, a.at, a.action, a.entity, a.entity_id AS "entityId", a.details, a.ip, u.name AS "userName"
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE ($1::bigint IS NULL OR a.id < $1) ORDER BY a.id DESC LIMIT 100`,
      [before],
    );
    return { items: rows, nextBefore: rows.length === 100 ? rows[rows.length - 1].id : null };
  });
}
