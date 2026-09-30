import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { can, useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { Kpi } from "../components/ui";
import { fmtMoney0, fmtNum, fmtPct, SOURCE_LABEL } from "../lib/format";

interface ReportData {
  months: number;
  monthly: { month: string; units: number; frontCents: number; backCents: number; serviceCents: number }[];
  bySalesperson: { name: string; units: number; grossCents: number; perUnitCents: number }[];
  byBranch: { name: string; units: number; grossCents: number }[];
  bySource: { source: string; leads: number; won: number; lost: number; conversion: number }[];
  aged: { id: string; stockNo: string; label: string; listPriceCents: number; days: number; costCents: number }[];
}

const axis = { stroke: "var(--grid)", tick: { fill: "var(--muted)", fontSize: 12 }, tickLine: false };
const tip = { contentStyle: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontSize: 13 } };
const monthLabel = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });

export function Reports() {
  const me = useMe();
  const [months, setMonths] = useState(12);
  const q = useQuery({ queryKey: ["reports", months], queryFn: () => api<ReportData>(`/reports?months=${months}`), enabled: can.seeCost(me.data?.role) });
  if (!can.seeCost(me.data?.role)) return <Navigate to="/" replace />;
  const d = q.data;
  const units = d?.monthly.reduce((s, m) => s + m.units, 0) ?? 0;
  const gross = d?.monthly.reduce((s, m) => s + m.frontCents + m.backCents, 0) ?? 0;
  const back = d?.monthly.reduce((s, m) => s + m.backCents, 0) ?? 0;
  const service = d?.monthly.reduce((s, m) => s + m.serviceCents, 0) ?? 0;
  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Reports</h1>
        <span className="spacer" />
        <label>
          Period
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            <option value={3}>Last 3 months</option>
            <option value={6}>Last 6 months</option>
            <option value={12}>Last 12 months</option>
            <option value={24}>Last 24 months</option>
          </select>
        </label>
        <a className="btn" href={`/api/reports/deals.csv?months=${months}`} download>
          Deals CSV (Excel / Power BI)
        </a>
      </div>
      {q.isError && <div className="notice">{errorText(q.error)}</div>}
      {d && (
        <>
          <section className="kpis">
            <Kpi label="Cars sold" value={fmtNum(units)} sub={`${(units / d.months).toFixed(1)} a month`} />
            <Kpi label="Total gross" value={fmtMoney0(gross)} sub={units ? `${fmtMoney0(gross / units)} per car` : "—"} />
            <Kpi label="Back-end share" value={gross ? fmtPct(back / gross) : "—"} sub="of gross from add-ons and fees" />
            <Kpi label="Service invoiced" value={fmtMoney0(service)} sub="customer jobs" />
          </section>
          <section className="card">
            <h2>Sales and gross by month</h2>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart
                data={d.monthly.map((m) => ({ ...m, label: monthLabel(m.month), front: m.frontCents / 100, back: m.backCents / 100 }))}
                margin={{ top: 8, right: 12, left: 8, bottom: 0 }}
              >
                <CartesianGrid vertical={false} stroke="var(--grid)" />
                <XAxis dataKey="label" {...axis} />
                <YAxis {...axis} axisLine={false} width={70} tickFormatter={(v: number) => fmtMoney0(v * 100)} />
                <Tooltip {...tip} formatter={(v, n) => [fmtMoney0(Number(v) * 100), n]} />
                <Legend />
                <Bar dataKey="front" name="Front gross" stackId="g" fill="var(--series-1)" isAnimationActive={false} />
                <Bar dataKey="back" name="Back gross" stackId="g" fill="var(--series-3)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
            <p className="muted small">Units: {d.monthly.map((m) => `${monthLabel(m.month)} ${m.units}`).join(" · ")}</p>
          </section>
          <div className="grid2">
            <section className="card">
              <h2>Salespeople</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th className="r">Cars</th>
                      <th className="r">Gross</th>
                      <th className="r">Per car</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.bySalesperson.map((r) => (
                      <tr key={r.name}>
                        <td>{r.name}</td>
                        <td className="r">{r.units}</td>
                        <td className="r">{fmtMoney0(r.grossCents)}</td>
                        <td className="r">{fmtMoney0(r.perUnitCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="card">
              <h2>Lead sources</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th className="r">Leads</th>
                      <th className="r">Won</th>
                      <th className="r">Conversion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.bySource.map((r) => (
                      <tr key={r.source}>
                        <td>{SOURCE_LABEL[r.source] ?? r.source}</td>
                        <td className="r">{r.leads}</td>
                        <td className="r">{r.won}</td>
                        <td className="r">{fmtPct(r.conversion)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="card">
              <h2>Branches</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Branch</th>
                      <th className="r">Cars</th>
                      <th className="r">Gross</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.byBranch.map((r) => (
                      <tr key={r.name}>
                        <td>{r.name}</td>
                        <td className="r">{r.units}</td>
                        <td className="r">{fmtMoney0(r.grossCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="card">
              <h2>Oldest stock</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Car</th>
                      <th className="r">Days</th>
                      <th className="r">Cost</th>
                      <th className="r">List</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.aged.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Link to={`/inventory/${r.id}`}>{r.stockNo}</Link> {r.label}
                        </td>
                        <td className="r">{r.days > 60 ? <span className="badge badge-warn">{r.days}</span> : r.days}</td>
                        <td className="r">{fmtMoney0(r.costCents)}</td>
                        <td className="r">{fmtMoney0(r.listPriceCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
