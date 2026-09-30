import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { can, useLoadedMeta, useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { Status } from "../components/ui";
import { fmtMoney0, fmtNum } from "../lib/format";
import { useDebounced } from "../lib/useDebounced";
import type { Vehicle } from "../../../shared/types";
import { VehicleForm } from "./VehicleForm";

export function Inventory() {
  const me = useMe();
  const meta = useLoadedMeta();
  const nav = useNavigate();
  const role = me.data?.role;
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "available";
  const branch = params.get("branch") ?? "";
  const aged = params.get("aged") ?? "";
  const [q, setQ] = useState(params.get("q") ?? "");
  const dq = useDebounced(q.trim(), 250);
  const [adding, setAdding] = useState(false);
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };
  const list = useQuery({
    queryKey: ["vehicles", status, branch, aged, dq],
    queryFn: () => api<{ items: Vehicle[] }>(`/vehicles?${new URLSearchParams({ status, branch, aged, q: dq, sort: aged ? "age" : "" })}`),
    placeholderData: keepPreviousData,
  });
  const items = list.data?.items ?? [];
  const branchName = (id: string) => meta.branches.find((b) => b.id === id)?.name ?? "?";
  const showCost = can.seeCost(role);
  const totalCost = items.reduce((s, v) => s + (v.totalCostCents ?? 0), 0);
  const totalList = items.reduce((s, v) => s + v.listPriceCents, 0);

  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Inventory</h1>
        <span className="spacer" />
        {showCost && (
          <a className="btn" href={`/api/vehicles.csv?${new URLSearchParams({ status, branch })}`} download>
            Export CSV
          </a>
        )}
        {can.manageStock(role) && (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            + Add vehicle
          </button>
        )}
      </div>
      <div className="filters">
        <label>
          Status
          <select value={status} onChange={(e) => set("status", e.target.value)}>
            <option value="available">For sale (in stock + reserved)</option>
            <option value="in_stock">In stock</option>
            <option value="reserved">Reserved</option>
            <option value="sold">Sold</option>
            <option value="all">All</option>
          </select>
        </label>
        <label>
          Branch
          <select value={branch} onChange={(e) => set("branch", e.target.value)}>
            <option value="">All branches</option>
            {meta.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Age
          <select value={aged} onChange={(e) => set("aged", e.target.value)}>
            <option value="">Any</option>
            <option value="31">Over 30 days</option>
            <option value="61">Over 60 days</option>
            <option value="91">Over 90 days</option>
          </select>
        </label>
        <label className="grow">
          Search
          <input type="search" placeholder="Stock no, VIN, make or model…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      <p className="muted small">
        {fmtNum(items.length)} vehicles · {fmtMoney0(totalList)} at list price{showCost && ` · ${fmtMoney0(totalCost)} at cost`}
      </p>
      {list.isError && <div className="notice">{errorText(list.error)}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Stock</th>
              <th>Vehicle</th>
              <th className="r">Mileage</th>
              <th>Branch</th>
              <th className="r">Days</th>
              <th className="r">List price</th>
              {showCost && <th className="r">Cost</th>}
              {showCost && <th className="r">Margin</th>}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((v) => (
              <tr key={v.id} className="clickable" tabIndex={0} onClick={() => nav(`/inventory/${v.id}`)} onKeyDown={(e) => e.key === "Enter" && nav(`/inventory/${v.id}`)}>
                <td>
                  <Link to={`/inventory/${v.id}`} onClick={(e) => e.stopPropagation()}>
                    {v.stockNo}
                  </Link>
                </td>
                <td>
                  {v.year} {v.make} {v.model} <span className="muted small">{v.trim}</span>
                </td>
                <td className="r">{fmtNum(v.mileage)}</td>
                <td>{branchName(v.branchId)}</td>
                <td className="r">{v.daysInStock > 60 && v.status !== "sold" ? <span className="badge badge-warn">{v.daysInStock}</span> : v.daysInStock}</td>
                <td className="r">{fmtMoney0(v.listPriceCents)}</td>
                {showCost && <td className="r">{fmtMoney0(v.totalCostCents)}</td>}
                {showCost && <td className="r">{fmtMoney0(v.listPriceCents - (v.totalCostCents ?? 0))}</td>}
                <td>
                  <Status value={v.status} />
                </td>
              </tr>
            ))}
            {!list.isPending && items.length === 0 && (
              <tr>
                <td colSpan={9} className="muted center">
                  No vehicles match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {adding && <VehicleForm onClose={() => setAdding(false)} onSaved={(id) => nav(`/inventory/${id}`)} />}
    </div>
  );
}
