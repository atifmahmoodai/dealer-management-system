// End-to-end smoke test of the whole stack: a fresh PostgreSQL database with demo data, the built
// API server serving the built web app, and each role's daily work driven in Chromium.
//   npm run build && npm run smoke        (from the project root)
// Uses SMOKE_DATABASE_URL (default postgres://postgres:postgres@localhost:5432/dms_smoke).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { chromium } from "playwright-core";

const PORT = 4189;
const BASE = `http://localhost:${PORT}/`;
const SHOTS = "test-results/screenshots";
const DB_URL = process.env.SMOKE_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/dms_smoke";
const executablePath = process.env.CHROMIUM_PATH || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
mkdirSync(SHOTS, { recursive: true });
if (!existsSync("../server/dist/server.js") || !existsSync("dist/index.html")) throw new Error("Build first: npm run build (from the project root)");

{
  const name = new URL(DB_URL).pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(name) || !name.includes("smoke")) throw new Error("SMOKE_DATABASE_URL must name a database containing 'smoke'");
  const adminUrl = new URL(DB_URL);
  adminUrl.pathname = "/postgres";
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
}
const env = { ...process.env, NODE_ENV: "production", DATABASE_URL: DB_URL, PORT: String(PORT), PUBLIC_URL: BASE, COOKIE_SECURE: "false", WEB_DIST: join(process.cwd(), "dist"), LOG_LEVEL: "warn", ALLOW_DEMO_SEED: "1" };
const seeded = spawnSync("node", ["../server/dist/cli/seed-demo.js"], { env, encoding: "utf8" });
if (seeded.status !== 0) throw new Error(`demo seed failed: ${seeded.stderr}`);
const server = spawn("node", ["../server/dist/server.js"], { env, stdio: ["ignore", "inherit", "inherit"] });

let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "✓" : "✗"} ${msg}`);
  if (!ok) failures++;
};
const money = (s) => Number(s.replace(/[^\d.-]/g, ""));
const signIn = async (p, email) => {
  await p.goto(`${BASE}login`);
  await p.fill("input[type=email]", email);
  await p.fill("input[type=password]", "demo-password-1");
  await p.click("button:has-text('Sign in')");
  await p.waitForSelector(".appbar");
};
const signOut = async (p) => {
  await p.click("button:has-text('Sign out')");
  await p.waitForURL(/\/login/);
};
const pickCustomer = async (p, scope, name) => {
  await p.fill(`${scope} input[aria-label='Search customers']`, name.slice(0, 5));
  await p.locator(`${scope} .pick-list button:has-text('${name}')`).first().click();
};

let page;
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}readyz`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch({ executablePath });
  const errors = [];
  const watch = (p) => {
    p.on("pageerror", (e) => {
      errors.push(e.stack || e.message);
      console.log(`  ! ${e.stack || e.message}`);
    });
    // 4xx answers are expected here (refused actions, validation); any 5xx or script error is a failure.
    p.on("console", (m) => m.type() === "error" && !/status of 4\d\d/.test(m.text()) && errors.push(`${p.url()}: ${m.text()}`));
    p.on("dialog", (d) => (d.type() === "prompt" ? d.accept("Needs a bigger margin") : d.accept()));
  };
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  page = await ctx.newPage();
  watch(page);

  console.log("Access");
  await page.goto(BASE);
  await page.waitForURL(/\/login/);
  check(true, "signed-out visitors are sent to sign-in");
  check((await fetch(`${BASE}api/vehicles`)).status === 401, "the API refuses anonymous requests");

  console.log("Sales: dashboard, stock and a lead");
  await signIn(page, "sales@demo.local");
  await page.waitForSelector(".kpi-value");
  const kpis = (await page.locator(".kpi-value").allTextContents()).join(" | ");
  check(!/NaN|undefined|Infinity/.test(kpis), `dashboard: ${kpis}`);
  check(!(await page.locator(".kpi-label:has-text('Gross this month')").isVisible()), "salespeople don't see gross");
  check(!(await page.locator(".nav >> text=Reports").isVisible()) && !(await page.locator(".nav >> text=Service").isVisible()), "salespeople don't see reports or service");
  await page.goto(`${BASE}inventory`);
  await page.waitForSelector("tbody tr.clickable");
  check(!(await page.locator("th:has-text('Cost')").isVisible()), "no cost column for salespeople");
  await page.fill("input[type=search]", "RAV4");
  await page.waitForFunction(() => [...document.querySelectorAll("tbody tr.clickable")].every((r) => r.textContent.includes("RAV4")));
  check(true, "inventory search");

  await page.goto(`${BASE}leads`);
  await page.click("button:has-text('+ New lead')");
  await page.click(".modal button:has-text('+ New customer')");
  await page.fill(".modal [aria-label='New customer'] label:has-text('Name') input", "Smoke Shopper");
  await page.fill(".modal [aria-label='New customer'] label:has-text('Phone') input", "+1 555 777 0101");
  await page.click(".modal button:has-text('Add customer')");
  await page.waitForSelector(".modal .picked >> text=Smoke Shopper");
  await page.fill(".modal label:has-text('Looking for') input", "Family SUV with finance");
  await page.click(".modal button:has-text('Create lead')");
  await page.waitForSelector(".modal[aria-label='Smoke Shopper'], [role=dialog][aria-label='Smoke Shopper']");
  check(true, "lead created with a new customer");
  await page.fill("[aria-label='What happened']", "Called; booked a test drive for Saturday.");
  await page.click("button:has-text('Log')");
  await page.waitForSelector(".timeline >> text=booked a test drive");
  await page.click("[role=dialog] button[aria-label=Close]");
  await page.waitForSelector("[aria-label=Contacted] >> text=Smoke Shopper");
  check(true, "logging a call moves the lead to Contacted");

  console.log("Sales: a deal from worksheet to sold");
  await page.goto(`${BASE}inventory`);
  await page.locator("tbody tr.clickable:has(.badge-good)").first().click();
  await page.waitForSelector("a:has-text('Start a deal')");
  const stockNo = (await page.locator(".page-head .muted").innerText()).match(/Stock (\S+)/)[1];
  await page.click("a:has-text('Start a deal')");
  await pickCustomer(page, "section:has(h2:has-text('Customer'))", "Smoke Shopper");
  await page.waitForSelector("[aria-label='Deal summary']");
  const total0 = money(await page.locator("[data-testid=deal-total]").innerText());
  await page.selectOption("[aria-label='Product to add']", { index: 1 });
  await page.click("[aria-label='Add-ons'] button:has-text('+ Add')");
  const total1 = money(await page.locator("[data-testid=deal-total]").innerText());
  check(total1 > total0, `add-on and its tax added live (${total0} → ${total1})`);
  await page.locator("[aria-label=Payment] label.check:has-text('Financed') input").check();
  await page.fill("[aria-label=Payment] label:has-text('Lender') input", "First Auto Bank");
  check(money(await page.locator("[data-testid=monthly]").innerText()) > 0, "monthly payment calculated");
  check(!(await page.locator("[data-testid=gross]").isVisible()), "no gross on a salesperson's worksheet");
  await page.click("button:has-text('Create deal')");
  await page.waitForURL(/\/deals\/d-/);
  await page.click("button:has-text('Submit deal')");
  await page.waitForSelector(".page-head >> text=Approved");
  check(true, "a healthy deal is approved automatically");
  await page.click("button:has-text('Close deal (sold)')");
  await page.waitForSelector(".page-head >> text=Sold");
  const dealNo = (await page.locator("h1").innerText()).match(/INV-\d{6}/)?.[0];
  check(!!dealNo, `deal closed with invoice ${dealNo}`);
  const dealUrl = page.url();
  await page.goto(`${dealUrl}/print`);
  await page.waitForSelector("h2:has-text('Bill of sale')");
  check(await page.locator(`text=${stockNo}`).isVisible(), "bill of sale prints the car and buyer");
  await page.goto(`${BASE}inventory?status=sold&q=${stockNo}`);
  await page.waitForSelector(`tbody tr:has-text('${stockNo}') >> text=Sold`);
  check(true, "the car shows as sold");

  // A thin deal for the manager to approve.
  await page.goto(`${BASE}inventory`);
  await page.locator("tbody tr.clickable:has(.badge-good)").nth(1).click();
  await page.click("a:has-text('Start a deal')");
  await pickCustomer(page, "section:has(h2:has-text('Customer'))", "Smoke Shopper");
  const price = money(await page.locator("[aria-label=Price] label:has-text('Selling price') input").inputValue());
  await page.fill("[aria-label=Price] label:has-text('Discount') input", String(Math.round(price * 0.3)));
  await page.click("button:has-text('Create deal')");
  await page.waitForURL(/\/deals\/d-/);
  await page.click("button:has-text('Submit deal')");
  await page.waitForSelector(".page-head >> text=Needs approval");
  check(await page.locator("text=a manager must approve").isVisible(), "a heavily discounted deal needs approval");
  const thinUrl = page.url();
  await signOut(page);

  console.log("Manager: approvals, stock and reports");
  await signIn(page, "manager@demo.local");
  await page.goto(thinUrl);
  await page.waitForSelector("[data-testid=gross].gross-low");
  check(true, "manager sees the low gross highlighted");
  await page.click("button:has-text('Send back')");
  await page.waitForSelector(".page-head >> text=Draft");
  check(await page.locator(".card.pre >> text=Needs a bigger margin").isVisible(), "sent back with a reason the salesperson can read");
  await page.goto(`${BASE}inventory`);
  await page.click("button:has-text('+ Add vehicle')");
  await page.fill(".modal label:has-text('Stock number') input", "S1000");
  await page.fill(".modal label:has-text('Make') input", "Kia");
  await page.fill(".modal label:has-text('Model') input", "Picanto");
  await page.fill(".modal label:has-text('Mileage') input", "12000");
  await page.fill(".modal label:has-text('Purchase cost') input", "9000");
  await page.fill(".modal label:has-text('List price') input", "11990");
  await page.click(".modal button:has-text('Save vehicle')");
  await page.waitForSelector(".modal >> text=already used");
  check(true, "duplicate stock number refused");
  await page.fill(".modal label:has-text('Stock number') input", "SMOKE1");
  await page.click(".modal button:has-text('Save vehicle')");
  await page.waitForURL(/\/inventory\/v-/);
  await page.fill("[aria-label='Add a cost'] input >> nth=0", "New tyres");
  await page.fill("[aria-label='Add a cost'] label:has-text('Amount') input", "480");
  await page.click("button:has-text('+ Add cost')");
  await page.waitForSelector("td:has-text('New tyres')");
  check(!(await page.locator("input[type=file]").isVisible()), "the file picker stays hidden behind its Upload button");
  const totalCost = await page.locator(".kpi:has-text('Total cost') .kpi-value").innerText();
  check(money(totalCost) === 9480, `costs add up (${totalCost})`);
  await page.goto(`${BASE}reports`);
  await page.waitForSelector(".recharts-surface");
  const rk = (await page.locator(".kpi-value").allTextContents()).join(" | ");
  check(!/NaN|undefined/.test(rk), `reports: ${rk}`);
  const csv = await page.evaluate(async () => {
    const r = await fetch("/api/reports/deals.csv?months=12");
    return { status: r.status, head: (await r.text()).slice(0, 30) };
  });
  check(csv.status === 200 && csv.head.includes("DealNo"), "deals export for Power BI");
  await signOut(page);

  console.log("Service advisor: a repair order to invoice");
  await signIn(page, "service@demo.local");
  await page.goto(`${BASE}service`);
  await page.click("button:has-text('+ New order')");
  await pickCustomer(page, ".modal", "Smoke Shopper");
  await page.fill(".modal label:has-text('Car') input", "2018 Honda Civic");
  await page.fill(".modal label:has-text('Work requested') textarea", "Brakes squeal");
  await page.click(".modal button:has-text('Create order')");
  await page.waitForURL(/\/service\/s-/);
  await page.click("button:has-text('+ Labour')");
  await page.fill(".service-line input[aria-label=Description]", "Replace front pads");
  await page.fill(".service-line input[aria-label=Hours]", "1.5");
  await page.click("button:has-text('+ Part')");
  await page.locator(".service-line input[aria-label=Description]").nth(1).fill("Brake pads");
  await page.locator(".service-line label:has-text('Unit price') input").fill("89");
  const svcTotal = money(await page.locator("[data-testid=service-total]").innerText());
  check(Math.abs(svcTotal - (187.5 + 89) * 1.07) < 0.02, `service total with tax: ${svcTotal}`);
  await page.selectOption("label:has-text('Status') select", "done");
  await page.click("button:has-text('Save')");
  await page.waitForSelector(".page-head >> text=Work done");
  await page.click("button:has-text('Close and invoice')");
  await page.waitForSelector(".page-head >> text=Closed");
  check(await page.locator(".page-head >> text=/invoice SI-\\d{6}/").isVisible(), "invoice number issued");
  await signOut(page);

  console.log("Admin");
  await signIn(page, "admin@demo.local");
  await page.goto(`${BASE}settings`);
  await page.fill("label:has-text('Company name') input", "Smoke Motor Group");
  await page.click("button:has-text('Save settings')");
  await page.waitForSelector("text=Saved.");
  await page.waitForSelector(".brand >> text=Smoke Motor Group");
  check(true, "settings saved and applied");
  await page.goto(`${BASE}audit`);
  await page.waitForSelector("tbody tr");
  const actions = (await page.locator("tbody td:nth-child(3)").allTextContents()).join(",");
  check(/Closed deal/.test(actions) && /Sent deal back/.test(actions) && /Closed service order/.test(actions), "activity log records the day's work");

  console.log("Phone + dark");
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  const m = await mobile.newPage();
  watch(m);
  await signIn(m, "manager@demo.local");
  for (const r of ["", "inventory", "leads", "customers", "deals", "service", "reports", dealUrl.replace(BASE, "")]) {
    await m.goto(`${BASE}${r}`);
    await m.waitForTimeout(600);
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `no page-level horizontal scroll on phone at "/${r}" (${overflow}px)`);
  }
  await m.goto(dealUrl);
  await m.waitForSelector("[aria-label='Deal summary']");
  await m.screenshot({ path: `${SHOTS}/deal-mobile-dark.png`, fullPage: true });
  await page.goto(BASE);
  await page.waitForSelector(".recharts-surface");
  await page.screenshot({ path: `${SHOTS}/dashboard.png`, fullPage: true });

  console.log("Server");
  const res = await fetch(`${BASE}deals/abc`);
  check(res.ok && (await res.text()).includes('id="root"'), "deep links serve the app");
  check(!!res.headers.get("content-security-policy"), "security headers set");
  const nf = await fetch(`${BASE}api/nope`);
  check(nf.status === 404 && (nf.headers.get("content-type") ?? "").includes("json"), "unknown API paths are JSON 404s");

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await browser.close();
} catch (e) {
  failures++;
  console.error(e);
  if (page) {
    console.error("URL at failure:", page.url());
    await page.screenshot({ path: `${SHOTS}/failure.png`, fullPage: true }).catch(() => {});
  }
} finally {
  server.kill("SIGTERM");
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll smoke checks passed");
process.exit(failures ? 1 : 0);
