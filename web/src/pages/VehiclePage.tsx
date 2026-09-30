import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { can, useLoadedMeta, useMe } from "../api/auth";
import { api, ApiError, errorText } from "../api/client";
import { DocumentsPanel, MoneyInput, Status } from "../components/ui";
import { fmtDate, fmtDateTime, fmtMoney, fmtMoney0, fmtNum } from "../lib/format";
import type { Deal, Vehicle, VehicleCost } from "../../../shared/types";
import { VehicleForm } from "./VehicleForm";

export function VehiclePage() {
  const { id = "" } = useParams();
  const me = useMe();
  const meta = useLoadedMeta();
  const nav = useNavigate();
  const role = me.data?.role;
  const q = useQuery({ queryKey: ["vehicle", id], queryFn: () => api<{ vehicle: Vehicle; costs: VehicleCost[]; deals: Deal[] }>(`/vehicles/${id}`) });
  const [editing, setEditing] = useState(false);
  if (q.isPending) return <div className="wrap muted">Loading…</div>;
  if (q.isError) return <div className="wrap"><div className="notice">{errorText(q.error)}</div></div>;
  const { vehicle: v, costs, deals } = q.data;
  const branch = meta.branches.find((b) => b.id === v.branchId)?.name;
  const liveDeal = deals.find((d) => ["pending_approval", "approved", "draft"].includes(d.status));
  return (
    <div className="wrap">
      <div className="page-head">
        <div>
          <Link to="/inventory" className="small">
            ← Inventory
          </Link>
          <h1>
            {v.year} {v.make} {v.model} {v.trim}
          </h1>
          <div className="muted">
            Stock {v.stockNo} {v.vin && <>· VIN {v.vin}</>} · {branch}
          </div>
        </div>
        <span className="spacer" />
        <Status value={v.status} />
        {can.manageStock(role) && v.status !== "sold" && (
          <button className="btn" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        {can.sell(role) && v.status !== "sold" && (
          <Link className="btn btn-primary" to={`/deals/new?vehicle=${v.id}`}>
            Start a deal
          </Link>
        )}
      </div>
      <section className="kpis">
        <div className="kpi">
          <div className="kpi-label">List price</div>
          <div className="kpi-value">{fmtMoney0(v.listPriceCents)}</div>
        </div>
        {v.totalCostCents !== undefined && (
          <div className="kpi">
            <div className="kpi-label">Total cost</div>
            <div className="kpi-value">{fmtMoney0(v.totalCostCents)}</div>
            <div className="kpi-sub">{fmtMoney0(v.listPriceCents - v.totalCostCents)} margin at list</div>
          </div>
        )}
        <div className={`kpi ${v.daysInStock > 60 && v.status !== "sold" ? "kpi-warn" : ""}`}>
          <div className="kpi-label">{v.status === "sold" ? "Days to sell" : "Days in stock"}</div>
          <div className="kpi-value">{v.daysInStock}</div>
          <div className="kpi-sub">acquired {fmtDate(v.acquiredOn)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Mileage</div>
          <div className="kpi-value">{fmtNum(v.mileage)}</div>
          <div className="kpi-sub">
            {v.condition} · {v.fuel} · {v.transmission}
          </div>
        </div>
      </section>
      {liveDeal && (
        <div className="notice">
          In a deal with {liveDeal.customerName} ({liveDeal.status.replace("_", " ")}). <Link to={`/deals/${liveDeal.id}`}>Open the deal</Link>
        </div>
      )}
      {v.notes && <div className="card small">{v.notes}</div>}
      <div className="grid2">
        {can.seeCost(role) && <Costs vehicle={v} costs={costs} />}
        <section className="card stack">
          <h2>Deals</h2>
          {deals.length === 0 && <p className="muted small">No deals on this car yet.</p>}
          <ul className="plain-list">
            {deals.map((d) => (
              <li key={d.id}>
                <Link to={`/deals/${d.id}`}>{d.number ?? "Deal"}</Link> · {d.customerName} · <Status value={d.status} kind="deal" /> ·{" "}
                <span className="muted small">{fmtDate(d.closedAt ?? d.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {can.seeCost(role) && <DocumentsPanel entity="vehicle" entityId={v.id} />}
      {editing && <VehicleForm vehicle={v} onClose={() => setEditing(false)} onSaved={() => void q.refetch()} />}
      {v.status === "sold" && <p className="muted small">Sold {fmtDateTime(v.soldAt)}. A sold vehicle can't be edited.</p>}
      <button className="btn btn-sm" style={{ justifySelf: "start" }} onClick={() => nav(-1)}>
        Back
      </button>
    </div>
  );
}

function Costs({ vehicle, costs }: { vehicle: Vehicle; costs: VehicleCost[] }) {
  const qc = useQueryClient();
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState(NaN);
  const add = useMutation({
    mutationFn: () => api(`/vehicles/${vehicle.id}/costs`, { method: "POST", body: { description: desc, amountCents: amount } }),
    onSuccess: () => {
      setDesc("");
      setAmount(NaN);
      void qc.invalidateQueries({ queryKey: ["vehicle", vehicle.id] });
      void qc.invalidateQueries({ queryKey: ["vehicles"] });
    },
  });
  const errs = add.error instanceof ApiError ? add.error.details : {};
  function submit(e: FormEvent) {
    e.preventDefault();
    add.mutate();
  }
  return (
    <section className="card stack">
      <h2>Costs</h2>
      <table>
        <tbody>
          <tr>
            <td>Purchase</td>
            <td className="muted small">{fmtDate(vehicle.acquiredOn)}</td>
            <td className="r">{fmtMoney(vehicle.purchaseCostCents)}</td>
          </tr>
          {costs.map((c) => (
            <tr key={c.id}>
              <td>{c.description}</td>
              <td className="muted small">
                {fmtDate(c.at)} · {c.byName}
              </td>
              <td className="r">{fmtMoney(c.amountCents)}</td>
            </tr>
          ))}
          <tr>
            <th colSpan={2}>Total cost</th>
            <th className="r">{fmtMoney(vehicle.totalCostCents)}</th>
          </tr>
        </tbody>
      </table>
      {vehicle.status !== "sold" && (
        <form className="form-grid" onSubmit={submit} noValidate aria-label="Add a cost">
          <label>
            Reconditioning, transport…
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. New tyres" />
            {errs.description && <div className="field-error">{errs.description}</div>}
          </label>
          <MoneyInput key={String(add.submittedAt)} label="Amount" cents={amount} onChange={setAmount} error={errs.amountCents} />
          {add.isError && !Object.keys(errs).length && <div className="field-error span2">{errorText(add.error)}</div>}
          <div>
            <button className="btn btn-sm" type="submit" disabled={add.isPending}>
              + Add cost
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
