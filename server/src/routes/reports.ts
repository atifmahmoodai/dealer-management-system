import type { FastifyInstance } from "fastify";
import { requireUser } from "../http";
import { seesCost } from "../repo/data";
import { toCsv } from "../../../shared/csv";

export async function reportRoutes(app: FastifyInstance) {
  const anyone = requireUser();
  const managers = requireUser("admin", "manager");
  const tz = app.config.TIMEZONE;
  const num = (v: unknown) => Number(v ?? 0);

  app.get("/dashboard", { preHandler: anyone }, async (req) => {
    const me = req.session!.user;
    const show = seesCost(me.role);
    const stock = (
      await app.db.query(
        `WITH s AS (
           SELECT v.id, ((now() AT TIME ZONE $1)::date - v.acquired_on) AS days,
                  v.purchase_cost_cents + COALESCE((SELECT sum(amount_cents) FROM vehicle_costs vc WHERE vc.vehicle_id = v.id), 0) AS cost
             FROM vehicles v WHERE v.status <> 'sold')
         SELECT count(*)::int AS units, COALESCE(sum(cost), 0) AS cost, COALESCE(avg(days), 0) AS avg_days,
                count(*) FILTER (WHERE days <= 30)::int AS b0, count(*) FILTER (WHERE days BETWEEN 31 AND 60)::int AS b1,
                count(*) FILTER (WHERE days BETWEEN 61 AND 90)::int AS b2, count(*) FILTER (WHERE days > 90)::int AS b3
           FROM s`,
        [tz],
      )
    ).rows[0];
    const sales = (
      await app.db.query(
        `SELECT count(*)::int AS units, COALESCE(sum((gross->>'totalCents')::bigint), 0) AS gross
           FROM deals WHERE status = 'closed' AND date_trunc('month', closed_at AT TIME ZONE $1) = date_trunc('month', now() AT TIME ZONE $1)`,
        [tz],
      )
    ).rows[0];
    const leads = (
      await app.db.query(
        `SELECT count(*) FILTER (WHERE status NOT IN ('won', 'lost'))::int AS open,
                count(*) FILTER (WHERE status NOT IN ('won', 'lost') AND next_follow_up_at < now() AND ($1::text IS NULL OR assigned_to = $1))::int AS overdue
           FROM leads`,
        [me.role === "sales" ? me.id : null],
      )
    ).rows[0];
    const pending = (await app.db.query("SELECT count(*)::int AS n FROM deals WHERE status = 'pending_approval'")).rows[0].n;
    const service = (
      await app.db.query(
        `SELECT count(*) FILTER (WHERE status IN ('open', 'in_progress', 'waiting_parts', 'done'))::int AS open,
                COALESCE(sum(total_cents) FILTER (WHERE status = 'closed' AND customer_id IS NOT NULL
                  AND date_trunc('month', closed_at AT TIME ZONE $1) = date_trunc('month', now() AT TIME ZONE $1)), 0) AS revenue
           FROM service_orders`,
        [tz],
      )
    ).rows[0];
    return {
      stock: {
        units: stock.units,
        avgDays: Math.round(num(stock.avg_days)),
        aging: [
          { band: "0–30 days", units: stock.b0 },
          { band: "31–60", units: stock.b1 },
          { band: "61–90", units: stock.b2 },
          { band: "90+", units: stock.b3 },
        ],
        ...(show ? { costCents: num(stock.cost) } : {}),
      },
      salesMonth: { units: sales.units, ...(show ? { grossCents: num(sales.gross) } : {}) },
      leads: { open: leads.open, overdue: leads.overdue },
      pendingApprovals: show ? pending : undefined,
      service: { open: service.open, revenueMonthCents: num(service.revenue) },
    };
  });

  app.get<{ Querystring: { months?: string } }>("/reports", { preHandler: managers }, async (req) => {
    const months = Math.max(1, Math.min(36, Number(req.query.months) || 12));
    const window = `closed_at >= date_trunc('month', now() AT TIME ZONE $1) - make_interval(months => $2 - 1)`;
    const monthly = await app.db.query(
      `SELECT to_char(m, 'YYYY-MM') AS month,
              (SELECT count(*)::int FROM deals d WHERE d.status = 'closed' AND date_trunc('month', d.closed_at AT TIME ZONE $1) = m) AS units,
              (SELECT COALESCE(sum((gross->>'frontCents')::bigint), 0) FROM deals d WHERE d.status = 'closed' AND date_trunc('month', d.closed_at AT TIME ZONE $1) = m) AS front,
              (SELECT COALESCE(sum((gross->>'backCents')::bigint), 0) FROM deals d WHERE d.status = 'closed' AND date_trunc('month', d.closed_at AT TIME ZONE $1) = m) AS back,
              (SELECT COALESCE(sum(total_cents), 0) FROM service_orders s WHERE s.status = 'closed' AND s.customer_id IS NOT NULL
                 AND date_trunc('month', s.closed_at AT TIME ZONE $1) = m) AS service
         FROM generate_series(date_trunc('month', now() AT TIME ZONE $1) - make_interval(months => $2 - 1), date_trunc('month', now() AT TIME ZONE $1), interval '1 month') AS m
        ORDER BY m`,
      [tz, months],
    );
    const bySalesperson = await app.db.query(
      `SELECT COALESCE(u.name, 'Unassigned') AS name, count(*)::int AS units, COALESCE(sum((d.gross->>'totalCents')::bigint), 0) AS gross
         FROM deals d LEFT JOIN users u ON u.id = d.salesperson_id
        WHERE d.status = 'closed' AND d.${window}
        GROUP BY 1 ORDER BY gross DESC`,
      [tz, months],
    );
    const byBranch = await app.db.query(
      `SELECT b.name, count(d.id)::int AS units, COALESCE(sum((d.gross->>'totalCents')::bigint), 0) AS gross
         FROM branches b LEFT JOIN deals d ON d.branch_id = b.id AND d.status = 'closed' AND d.${window}
        GROUP BY b.name ORDER BY b.name`,
      [tz, months],
    );
    const bySource = await app.db.query(
      `SELECT source, count(*)::int AS leads, count(*) FILTER (WHERE status = 'won')::int AS won, count(*) FILTER (WHERE status = 'lost')::int AS lost
         FROM leads WHERE created_at >= date_trunc('month', now() AT TIME ZONE $1) - make_interval(months => $2 - 1)
        GROUP BY source ORDER BY leads DESC`,
      [tz, months],
    );
    const aged = await app.db.query(
      `SELECT v.id, v.stock_no AS "stockNo", v.year || ' ' || v.make || ' ' || v.model AS label, v.list_price_cents AS "listPriceCents",
              ((now() AT TIME ZONE $1)::date - v.acquired_on) AS days,
              v.purchase_cost_cents + COALESCE((SELECT sum(amount_cents) FROM vehicle_costs vc WHERE vc.vehicle_id = v.id), 0) AS "costCents"
         FROM vehicles v WHERE v.status <> 'sold' ORDER BY v.acquired_on ASC LIMIT 15`,
      [tz],
    );
    return {
      months,
      monthly: monthly.rows.map((r) => ({ month: r.month, units: r.units, frontCents: num(r.front), backCents: num(r.back), serviceCents: num(r.service) })),
      bySalesperson: bySalesperson.rows.map((r) => ({ name: r.name, units: r.units, grossCents: num(r.gross), perUnitCents: r.units ? Math.round(num(r.gross) / r.units) : 0 })),
      byBranch: byBranch.rows.map((r) => ({ name: r.name, units: r.units, grossCents: num(r.gross) })),
      bySource: bySource.rows.map((r) => ({ source: r.source, leads: r.leads, won: r.won, lost: r.lost, conversion: r.leads ? r.won / r.leads : 0 })),
      aged: aged.rows.map((r) => ({ ...r, days: num(r.days), listPriceCents: num(r.listPriceCents), costCents: num(r.costCents) })),
    };
  });

  app.get<{ Querystring: { months?: string } }>("/reports/deals.csv", { preHandler: managers }, async (req, reply) => {
    const months = Math.max(1, Math.min(120, Number(req.query.months) || 12));
    const { rows } = await app.db.query(
      `SELECT d.number, d.closed_at AT TIME ZONE $1 AS closed, c.name AS customer, v.stock_no, v.year, v.make, v.model, u.name AS salesperson, b.name AS branch,
              l.source, d.worksheet, d.totals, d.gross, d.vehicle_cost_cents
         FROM deals d JOIN customers c ON c.id = d.customer_id JOIN vehicles v ON v.id = d.vehicle_id JOIN branches b ON b.id = d.branch_id
         LEFT JOIN users u ON u.id = d.salesperson_id LEFT JOIN leads l ON l.id = d.lead_id
        WHERE d.status = 'closed' AND d.closed_at >= date_trunc('month', now() AT TIME ZONE $1) - make_interval(months => $2 - 1)
        ORDER BY d.closed_at`,
      [tz, months],
    );
    const $ = (c: unknown) => num(c) / 100;
    const csv = toCsv(
      ["DealNo", "ClosedDate", "Customer", "StockNo", "Year", "Make", "Model", "Salesperson", "Branch", "LeadSource", "SalePrice", "Discount", "NetPrice", "AddOns", "DocFee", "Tax", "TradeAllowance", "Total", "VehicleCost", "FrontGross", "BackGross", "TotalGross", "Financed"],
      rows.map((r) => [
        r.number,
        (r.closed as Date).toISOString().slice(0, 10),
        r.customer,
        r.stock_no,
        r.year,
        r.make,
        r.model,
        r.salesperson,
        r.branch,
        r.source ?? "",
        $(r.worksheet.salePriceCents),
        $(r.worksheet.discountCents),
        $(r.totals.netPriceCents),
        $(r.totals.addOnsCents),
        $(r.worksheet.docFeeCents),
        $(r.totals.taxCents),
        $(r.totals.tradeAllowanceCents),
        $(r.totals.totalCents),
        $(r.vehicle_cost_cents),
        $(r.gross.frontCents),
        $(r.gross.backCents),
        $(r.gross.totalCents),
        r.worksheet.finance ? 1 : 0,
      ]),
    );
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="deals-${months}m.csv"`).send("﻿" + csv);
  });
}
