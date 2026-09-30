import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError, errorText } from "../api/client";
import { CustomerPicker, Modal, Status, VehiclePicker } from "../components/ui";
import { fmtDate, fmtMoney0 } from "../lib/format";
import type { Customer, ServiceOrder, Vehicle } from "../../../shared/types";

export function Service() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "open";
  const [adding, setAdding] = useState(params.get("new") === "1");
  const q = useQuery({ queryKey: ["service", status], queryFn: () => api<{ items: ServiceOrder[] }>(`/service?status=${status}`), placeholderData: keepPreviousData });
  const items = q.data?.items ?? [];
  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Service</h1>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          + New order
        </button>
      </div>
      <div className="tabs" role="tablist" aria-label="Order status">
        {[
          ["open", "Open"],
          ["closed", "Closed"],
          ["all", "All"],
        ].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={status === k} onClick={() => setParams({ status: k }, { replace: true })}>
            {l}
          </button>
        ))}
      </div>
      {q.isError && <div className="notice">{errorText(q.error)}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Opened</th>
              <th>For</th>
              <th>Vehicle</th>
              <th>Work</th>
              <th>Technician</th>
              <th className="r">Total</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((o) => (
              <tr key={o.id} className="clickable" tabIndex={0} onClick={() => nav(`/service/${o.id}`)} onKeyDown={(e) => e.key === "Enter" && nav(`/service/${o.id}`)}>
                <td>{o.number}</td>
                <td>{fmtDate(o.createdAt)}</td>
                <td>{o.customerName ?? <span className="badge badge-brand">Recon</span>}</td>
                <td>
                  {o.vehicleDesc} <span className="muted small">{o.plate}</span>
                </td>
                <td className="clip">{o.complaint}</td>
                <td>{o.technician}</td>
                <td className="r">{fmtMoney0(o.totalCents)}</td>
                <td>
                  <Status value={o.status} kind="service" />
                </td>
              </tr>
            ))}
            {!q.isPending && items.length === 0 && (
              <tr>
                <td colSpan={8} className="muted center">
                  No orders here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {adding && <NewOrder customerId={params.get("customer")} onClose={() => setAdding(false)} onCreated={(id) => nav(`/service/${id}`)} />}
    </div>
  );
}

function NewOrder({ customerId, onClose, onCreated }: { customerId: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<"customer" | "recon">("customer");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [f, setF] = useState({ vehicleDesc: "", plate: "", mileage: "", complaint: "", technician: "" });
  useQuery({
    queryKey: ["prefill-customer", customerId],
    enabled: !!customerId,
    queryFn: async () => {
      const r = await api<{ customer: Customer }>(`/customers/${customerId}`);
      setCustomer((c) => c ?? r.customer);
      return r.customer;
    },
  });
  const save = useMutation({
    mutationFn: () =>
      api<ServiceOrder>("/service", {
        method: "POST",
        body: {
          customerId: kind === "customer" ? (customer?.id ?? null) : null,
          stockVehicleId: kind === "recon" ? (vehicle?.id ?? null) : null,
          vehicleDesc: f.vehicleDesc,
          plate: f.plate,
          mileage: f.mileage.trim() ? Number(f.mileage.replace(/[,\s]/g, "")) : null,
          complaint: f.complaint,
          technician: f.technician,
          promisedAt: null,
        },
      }),
    onSuccess: (o) => {
      void qc.invalidateQueries({ queryKey: ["service"] });
      onCreated(o.id);
    },
  });
  const errs = save.error instanceof ApiError ? save.error.details : {};
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }
  return (
    <Modal title="New service order" onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        <div className="tabs" role="tablist" aria-label="Order for">
          <button type="button" role="tab" aria-selected={kind === "customer"} onClick={() => setKind("customer")}>
            Customer's car
          </button>
          <button type="button" role="tab" aria-selected={kind === "recon"} onClick={() => setKind("recon")}>
            Reconditioning a stock car
          </button>
        </div>
        {kind === "customer" ? (
          <>
            <CustomerPicker value={customer} onPick={setCustomer} />
            <div className="form-grid three">
              <label>
                Car
                <input value={f.vehicleDesc} placeholder="2019 Honda Civic" onChange={(e) => set("vehicleDesc", e.target.value)} />
                {errs.vehicleDesc && <div className="field-error">{errs.vehicleDesc}</div>}
              </label>
              <label>
                Plate
                <input value={f.plate} onChange={(e) => set("plate", e.target.value)} />
              </label>
              <label>
                Mileage
                <input inputMode="numeric" value={f.mileage} onChange={(e) => set("mileage", e.target.value)} />
                {errs.mileage && <div className="field-error">{errs.mileage}</div>}
              </label>
            </div>
          </>
        ) : (
          <>
            <VehiclePicker value={vehicle} onPick={setVehicle} />
            <p className="muted small">The work's cost (before tax) is added to the car's cost when the order is closed; no invoice is issued.</p>
          </>
        )}
        <label>
          Work requested
          <textarea rows={2} value={f.complaint} onChange={(e) => set("complaint", e.target.value)} />
          {errs.complaint && <div className="field-error">{errs.complaint}</div>}
        </label>
        <label>
          Technician
          <input value={f.technician} onChange={(e) => set("technician", e.target.value)} />
        </label>
        {save.isError && <div className="field-error">{errs.customerId ? "Choose the customer (or the stock car)." : errorText(save.error)}</div>}
        <div className="btn-row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? "Creating…" : "Create order"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
