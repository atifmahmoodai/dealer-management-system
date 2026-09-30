import type { FastifyInstance, FastifyRequest } from "fastify";
import { badRequest, HttpError, notFound, requireUser } from "../http";
import { audit, newId, seesCost } from "../repo/data";
import type { Role } from "../../../shared/schemas";
import type { DocumentMeta } from "../../../shared/types";

export const MAX_DOC_BYTES = 5 * 1024 * 1024;
const ENTITIES = { customer: "customers", vehicle: "vehicles", deal: "deals" } as const;
type Entity = keyof typeof ENTITIES;

/** The real type from the file's first bytes; the browser's claimed type and the extension are not trusted. */
export function sniff(buf: Buffer): string | null {
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

const EXT: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Who may attach files where: service staff don't handle deal paperwork, and vehicle files are management's. */
function mayUse(role: Role, entity: Entity) {
  if (entity === "vehicle") return seesCost(role);
  if (entity === "deal") return role !== "service";
  return true;
}

export async function documentRoutes(app: FastifyInstance) {
  const anyone = requireUser();
  const uid = (req: FastifyRequest) => req.session!.user.id;
  const check = (req: FastifyRequest, entity: string): Entity => {
    if (!(entity in ENTITIES)) throw badRequest("Unknown document type.");
    if (!mayUse(req.session!.user.role, entity as Entity)) throw new HttpError(403, "You don't have permission to do that.", "forbidden");
    return entity as Entity;
  };

  app.get<{ Querystring: { entity?: string; entityId?: string } }>("/documents", { preHandler: anyone }, async (req) => {
    const entity = check(req, req.query.entity ?? "");
    const { rows } = await app.db.query(
      `SELECT d.id, d.entity, d.entity_id AS "entityId", d.filename, d.mime, d.size, d.uploaded_at AS "uploadedAt", u.name AS "uploadedBy"
         FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
        WHERE d.entity = $1 AND d.entity_id = $2 ORDER BY d.uploaded_at DESC`,
      [entity, req.query.entityId ?? ""],
    );
    return { items: rows.map((r) => ({ ...r, uploadedAt: (r.uploadedAt as Date).toISOString() })) as DocumentMeta[] };
  });

  app.post("/documents", { preHandler: anyone, bodyLimit: MAX_DOC_BYTES + 64 * 1024 }, async (req, reply) => {
    const fields: Record<string, string> = {};
    let file: { filename: string; data: Buffer } | null = null;
    for await (const part of req.parts({ limits: { fileSize: MAX_DOC_BYTES, files: 1, fields: 5 } })) {
      if (part.type === "file") {
        const data = await part.toBuffer();
        if (part.file.truncated) throw new HttpError(413, "Files can be at most 5 MB.", "too_large");
        file = { filename: part.filename, data };
      } else {
        fields[part.fieldname] = String(part.value).slice(0, 100);
      }
    }
    const entity = check(req, fields.entity ?? "");
    if (!file || !file.data.length) throw badRequest("Choose a file.", { file: "Required" });
    const mime = sniff(file.data);
    if (!mime) throw badRequest("Upload a PDF or a JPEG, PNG or WebP image.", { file: "Unsupported file type" });
    const exists = await app.db.query(`SELECT 1 FROM ${ENTITIES[entity]} WHERE id = $1`, [fields.entityId ?? ""]);
    if (!exists.rowCount) throw notFound("That record doesn't exist.");
    // Keep a readable name, but only safe characters, with the extension of the real type.
    const base = file.filename.replace(/\.[^.]*$/, "").replace(/[^\w\- ]+/g, "_").trim().slice(0, 80) || "document";
    const filename = `${base}.${EXT[mime]}`;
    const id = newId("doc");
    await app.db.query("INSERT INTO documents (id, entity, entity_id, filename, mime, size, data, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
      id,
      entity,
      fields.entityId,
      filename,
      mime,
      file.data.length,
      file.data,
      uid(req),
    ]);
    await audit(app.db, { userId: uid(req), action: "document.upload", entity, entityId: fields.entityId, details: { filename, size: file.data.length }, ip: req.ip });
    return reply.status(201).send({ id, filename, mime, size: file.data.length });
  });

  app.get<{ Params: { id: string } }>("/documents/:id/download", { preHandler: anyone }, async (req, reply) => {
    const { rows } = await app.db.query<{ entity: string; filename: string; mime: string; data: Buffer }>("SELECT entity, filename, mime, data FROM documents WHERE id = $1", [req.params.id]);
    const d = rows[0];
    if (!d) throw notFound("Document not found");
    check(req, d.entity);
    return reply
      .header("content-type", d.mime)
      .header("content-disposition", `attachment; filename="${d.filename}"`)
      .header("cache-control", "private, no-store")
      .send(d.data);
  });

  app.delete<{ Params: { id: string } }>("/documents/:id", { preHandler: anyone }, async (req) => {
    const { rows } = await app.db.query<{ entity: string; entity_id: string; uploaded_by: string | null; filename: string }>(
      "SELECT entity, entity_id, uploaded_by, filename FROM documents WHERE id = $1",
      [req.params.id],
    );
    const d = rows[0];
    if (!d) throw notFound("Document not found");
    check(req, d.entity);
    if (!seesCost(req.session!.user.role) && d.uploaded_by !== uid(req)) throw new HttpError(403, "Only the uploader or a manager can delete this file.", "forbidden");
    await app.db.query("DELETE FROM documents WHERE id = $1", [req.params.id]);
    await audit(app.db, { userId: uid(req), action: "document.delete", entity: d.entity, entityId: d.entity_id, details: { filename: d.filename }, ip: req.ip });
    return { ok: true };
  });
}
