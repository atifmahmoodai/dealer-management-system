import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useLoadedMeta } from "../api/auth";
import { api, ApiError, errorText } from "../api/client";
import { Modal, MoneyInput } from "../components/ui";
import type { Vehicle } from "../../../shared/types";

const BODIES = ["Sedan", "Hatchback", "SUV", "Pickup", "Van", "Coupe", "Convertible", "Wagon"];
const today = () => new Date().toISOString().slice(0, 10);

/** Add a car to stock, or edit one (managers only: it includes the purchase cost). */
export function VehicleForm({ vehicle, onClose, onSaved }: { vehicle?: Vehicle; onClose: () => void; onSaved: (id: string) => void }) {
  const meta = useLoadedMeta();
  const qc = useQueryClient();
  const [f, setF] = useState({
    stockNo: vehicle?.stockNo ?? "",
    vin: vehicle?.vin ?? "",
    year: String(vehicle?.year ?? new Date().getFullYear() - 3),
    make: vehicle?.make ?? "",
    model: vehicle?.model ?? "",
    trim: vehicle?.trim ?? "",
    color: vehicle?.color ?? "",
    mileage: String(vehicle?.mileage ?? ""),
    body: vehicle?.body ?? "Sedan",
    fuel: vehicle?.fuel ?? "Petrol",
    transmission: vehicle?.transmission ?? "Automatic",
    condition: vehicle?.condition ?? "Used",
    branchId: vehicle?.branchId ?? meta.branches[0]?.id ?? "",
    source: vehicle?.source ?? "auction",
    acquiredOn: vehicle?.acquiredOn ?? today(),
    notes: vehicle?.notes ?? "",
  });
  const [cost, setCost] = useState(vehicle?.purchaseCostCents ?? NaN);
  const [price, setPrice] = useState(vehicle?.listPriceCents ?? NaN);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, year: Number(f.year), mileage: f.mileage.trim() === "" ? NaN : Number(f.mileage.replace(/[,\s]/g, "")), purchaseCostCents: cost, listPriceCents: price };
      return vehicle ? api<{ ok: true }>(`/vehicles/${vehicle.id}`, { method: "PUT", body: { ...body, version: vehicle.version } }).then(() => ({ id: vehicle.id })) : api<{ id: string }>("/vehicles", { method: "POST", body });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["vehicles"] });
      void qc.invalidateQueries({ queryKey: ["vehicle", r.id] });
      onSaved(r.id);
      onClose();
    },
  });
  const errs = save.error instanceof ApiError ? save.error.details : {};
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const text = (k: keyof typeof f, label: string, extra: Record<string, string> = {}) => (
    <label>
      {label}
      <input value={f[k]} onChange={(e) => set(k, e.target.value)} {...extra} />
      {errs[k] && <div className="field-error">{errs[k]}</div>}
    </label>
  );
  const select = (k: keyof typeof f, label: string, options: [string, string][]) => (
    <label>
      {label}
      <select value={f[k]} onChange={(e) => set(k, e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }
  return (
    <Modal title={vehicle ? `Edit ${vehicle.stockNo}` : "Add vehicle"} onClose={onClose} wide>
      <form className="stack" onSubmit={submit} noValidate>
        <div className="form-grid three">
          {text("stockNo", "Stock number")}
          {text("vin", "VIN", { placeholder: "17 characters" })}
          {text("year", "Year", { inputMode: "numeric" })}
          {text("make", "Make")}
          {text("model", "Model")}
          {text("trim", "Trim")}
          {text("color", "Colour")}
          {text("mileage", `Mileage (${meta.settings.distanceUnit})`, { inputMode: "numeric" })}
          {select("body", "Body", BODIES.map((b) => [b, b]))}
          {select("fuel", "Fuel", ["Petrol", "Diesel", "Hybrid", "Electric"].map((b) => [b, b]))}
          {select("transmission", "Gearbox", [["Automatic", "Automatic"], ["Manual", "Manual"]])}
          {select("condition", "Condition", [["Used", "Used"], ["New", "New"]])}
          {select("branchId", "Branch", meta.branches.map((b) => [b.id, b.name]))}
          {select("source", "Bought from", [["auction", "Auction"], ["purchase", "Private purchase"], ["trade_in", "Trade-in"], ["consignment", "Consignment"]])}
          <label>
            Date acquired
            <input type="date" value={f.acquiredOn} onChange={(e) => set("acquiredOn", e.target.value)} />
            {errs.acquiredOn && <div className="field-error">{errs.acquiredOn}</div>}
          </label>
          <MoneyInput label="Purchase cost" cents={cost} onChange={setCost} error={errs.purchaseCostCents} />
          <MoneyInput label="List price" cents={price} onChange={setPrice} error={errs.listPriceCents} />
        </div>
        <label>
          Notes
          <textarea rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} />
        </label>
        {save.isError && <div className="field-error">{errorText(save.error)}</div>}
        <div className="btn-row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save vehicle"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
