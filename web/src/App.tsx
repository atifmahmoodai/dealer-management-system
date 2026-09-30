import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";

const Dashboard = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const Inventory = lazy(() => import("./pages/Inventory").then((m) => ({ default: m.Inventory })));
const VehiclePage = lazy(() => import("./pages/VehiclePage").then((m) => ({ default: m.VehiclePage })));
const Leads = lazy(() => import("./pages/Leads").then((m) => ({ default: m.Leads })));
const Customers = lazy(() => import("./pages/Customers").then((m) => ({ default: m.Customers })));
const CustomerPage = lazy(() => import("./pages/CustomerPage").then((m) => ({ default: m.CustomerPage })));
const Deals = lazy(() => import("./pages/Deals").then((m) => ({ default: m.Deals })));
const DealPage = lazy(() => import("./pages/DealPage").then((m) => ({ default: m.DealPage })));
const DealPrint = lazy(() => import("./pages/Print").then((m) => ({ default: m.DealPrint })));
const Service = lazy(() => import("./pages/Service").then((m) => ({ default: m.Service })));
const ServicePage = lazy(() => import("./pages/ServicePage").then((m) => ({ default: m.ServicePage })));
const ServicePrint = lazy(() => import("./pages/Print").then((m) => ({ default: m.ServicePrint })));
const Reports = lazy(() => import("./pages/Reports").then((m) => ({ default: m.Reports })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const AuditLog = lazy(() => import("./pages/AuditLog").then((m) => ({ default: m.AuditLog })));
const Account = lazy(() => import("./pages/Account").then((m) => ({ default: m.Account })));

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<div className="wrap muted">Loading…</div>}>
        <Routes>
          <Route path="login" element={<Login />} />
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="inventory" element={<Inventory />} />
            <Route path="inventory/:id" element={<VehiclePage />} />
            <Route path="leads" element={<Leads />} />
            <Route path="customers" element={<Customers />} />
            <Route path="customers/:id" element={<CustomerPage />} />
            <Route path="deals" element={<Deals />} />
            <Route path="deals/:id" element={<DealPage />} />
            <Route path="service" element={<Service />} />
            <Route path="service/:id" element={<ServicePage />} />
            <Route path="reports" element={<Reports />} />
            <Route path="settings" element={<Settings />} />
            <Route path="audit" element={<AuditLog />} />
            <Route path="account" element={<Account />} />
          </Route>
          <Route element={<Layout print />}>
            <Route path="deals/:id/print" element={<DealPrint />} />
            <Route path="service/:id/print" element={<ServicePrint />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
