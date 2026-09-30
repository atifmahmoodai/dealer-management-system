import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { can, useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { Status } from "../components/ui";
import { fmtDate, fmtMoney0 } from "../lib/format";
import type { Deal } from "../../../shared/types";

const TABS: [string, string][] = [
  ["open", "In progress"],
  ["pending_approval", "Needs approval"],
  ["closed", "Sold"],
  ["cancelled", "Cancelled"],
];

export function Deals() {
  const me = useMe();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "open";
  const mine = params.get("mine") === "1";
  const q = useQuery({
    queryKey: ["deals", status, mine],
    queryFn: () => api<{ items: Deal[] }>(`/deals?${new URLSearchParams({ status, mine: mine ? "1" : "" })}`),
    placeholderData: keepPreviousData,
  });
  const showGross = can.seeCost(me.data?.role);
  const items = q.data?.items ?? [];
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };
  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Deals</h1>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={() => nav("/deals/new")}>
          + New deal
        </button>
      </div>
      <div className="row">
        <div className="tabs" role="tablist" aria-label="Deal status">
          {TABS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={status === k} onClick={() => set("status", k)}>
              {l}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={mine} onChange={(e) => set("mine", e.target.checked ? "1" : "")} /> Only mine
        </label>
      </div>
      {q.isError && <div className="notice">{errorText(q.error)}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Deal</th>
              <th>Date</th>
              <th>Customer</th>
              <th>Vehicle</th>
              <th>Salesperson</th>
              <th className="r">Total</th>
              {showGross && <th className="r">Gross</th>}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.id} className="clickable" tabIndex={0} onClick={() => nav(`/deals/${d.id}`)} onKeyDown={(e) => e.key === "Enter" && nav(`/deals/${d.id}`)}>
                <td>{d.number ?? <span className="muted">—</span>}</td>
                <td>{fmtDate(d.closedAt ?? d.createdAt)}</td>
                <td>{d.customerName}</td>
                <td>
                  {d.vehicleLabel} <span className="muted small">{d.stockNo}</span>
                </td>
                <td>{d.salespersonName}</td>
                <td className="r">{fmtMoney0(d.totals.totalCents)}</td>
                {showGross && <td className={`r ${d.needsApproval ? "warn-text" : ""}`}>{fmtMoney0(d.gross?.totalCents)}</td>}
                <td>
                  <Status value={d.status} kind="deal" />
                </td>
              </tr>
            ))}
            {!q.isPending && items.length === 0 && (
              <tr>
                <td colSpan={8} className="muted center">
                  No deals here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
