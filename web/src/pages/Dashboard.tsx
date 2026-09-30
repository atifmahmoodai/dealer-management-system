import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { can, useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { Kpi } from "../components/ui";
import { fmtMoney0, fmtNum } from "../lib/format";

interface DashboardData {
  stock: { units: number; avgDays: number; aging: { band: string; units: number }[]; costCents?: number };
  salesMonth: { units: number; grossCents?: number };
  leads: { open: number; overdue: number };
  pendingApprovals?: number;
  service: { open: number; revenueMonthCents: number };
}

const axis = { stroke: "var(--grid)", tick: { fill: "var(--muted)", fontSize: 12 }, tickLine: false };
// Aging bands go from fine to worrying.
const BAND_COLORS = ["var(--series-1)", "var(--series-1)", "var(--series-4)", "var(--series-2)"];

export function Dashboard() {
  const me = useMe();
  const role = me.data?.role;
  const q = useQuery({ queryKey: ["dashboard"], queryFn: () => api<DashboardData>("/dashboard"), refetchInterval: 60_000 });
  if (q.isPending) return <div className="wrap muted">Loading…</div>;
  if (q.isError) return <div className="wrap"><div className="notice">{errorText(q.error)}</div></div>;
  const d = q.data;
  const perUnit = d.salesMonth.grossCents !== undefined && d.salesMonth.units ? d.salesMonth.grossCents / d.salesMonth.units : null;
  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Good {new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening"}, {me.data?.name.split(" ")[0]}</h1>
      </div>
      <section className="kpis">
        <Kpi label="Cars in stock" value={fmtNum(d.stock.units)} sub={`${d.stock.avgDays} days average in stock`} />
        {d.stock.costCents !== undefined && <Kpi label="Stock value at cost" value={fmtMoney0(d.stock.costCents)} sub="money tied up in inventory" />}
        <Kpi label="Sold this month" value={fmtNum(d.salesMonth.units)} sub={perUnit !== null ? `${fmtMoney0(perUnit)} gross per car` : "cars delivered"} />
        {d.salesMonth.grossCents !== undefined && <Kpi label="Gross this month" value={fmtMoney0(d.salesMonth.grossCents)} sub="front + back" />}
        {can.sell(role) && (
          <Kpi label="Open leads" value={fmtNum(d.leads.open)} sub={d.leads.overdue ? `${d.leads.overdue} follow-ups overdue${role === "sales" ? " (yours)" : ""}` : "no overdue follow-ups"} tone={d.leads.overdue ? "warn" : undefined} />
        )}
        {d.pendingApprovals !== undefined && <Kpi label="Deals to approve" value={fmtNum(d.pendingApprovals)} sub="below the minimum gross" tone={d.pendingApprovals ? "warn" : undefined} />}
        {can.service(role) && <Kpi label="Service" value={`${fmtNum(d.service.open)} open`} sub={`${fmtMoney0(d.service.revenueMonthCents)} invoiced this month`} />}
      </section>
      <section className="grid2">
        <div className="card">
          <h2>Stock by age</h2>
          <p className="muted small">Cars over 60 days cost money every day: price them to move.</p>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={d.stock.aging} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="band" {...axis} />
              <YAxis {...axis} axisLine={false} allowDecimals={false} />
              <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)" }} />
              <Bar dataKey="units" name="Cars" radius={[4, 4, 0, 0]} isAnimationActive={false} shape={(p: { x: number; y: number; width: number; height: number; index: number }) => <rect x={p.x} y={p.y} width={p.width} height={p.height} rx={4} fill={BAND_COLORS[p.index]} />} />
            </BarChart>
          </ResponsiveContainer>
          <Link to="/inventory?aged=61" className="small">
            See cars over 60 days →
          </Link>
        </div>
        <div className="card stack">
          <h2>Today</h2>
          <ul className="todo">
            {can.sell(role) && d.leads.overdue > 0 && (
              <li>
                <Link to="/leads?overdue=1">{d.leads.overdue === 1 ? "1 lead follow-up is overdue" : `${d.leads.overdue} lead follow-ups are overdue`}</Link>
              </li>
            )}
            {!!d.pendingApprovals && (
              <li>
                <Link to="/deals?status=pending_approval">{d.pendingApprovals === 1 ? "1 deal is" : `${d.pendingApprovals} deals are`} waiting for your approval</Link>
              </li>
            )}
            {can.service(role) && d.service.open > 0 && (
              <li>
                <Link to="/service">{d.service.open === 1 ? "1 service order is open" : `${d.service.open} service orders are open`}</Link>
              </li>
            )}
            {d.stock.aging[3].units > 0 && (
              <li>
                <Link to="/inventory?aged=91">{d.stock.aging[3].units === 1 ? "1 car has" : `${d.stock.aging[3].units} cars have`} been in stock over 90 days</Link>
              </li>
            )}
            <li className="muted">
              Quick start: {can.sell(role) && <Link to="/leads?new=1">new lead</Link>}
              {can.sell(role) && " · "}
              {can.service(role) && <Link to="/service?new=1">new service order</Link>}
              {can.service(role) && " · "}
              <Link to="/customers">find a customer</Link>
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
