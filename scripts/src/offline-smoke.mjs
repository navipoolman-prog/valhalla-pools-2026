// Run after building pool-reader-pro. Tests only a random isolated tenant.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import assert from "node:assert/strict";

const tenant = `offline-smoke-${crypto.randomUUID()}`;
const headers = { "X-Tenant-Id": tenant, "Content-Type": "application/json" };
const api = async (path, method = "GET", body) => {
  const response = await fetch(`http://localhost:80/api${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  assert(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
  return response.status === 204 ? null : response.json();
};
const root = resolve("artifacts/pool-reader-pro/dist/public");
const types = { ".js": "application/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      const body = [];
      for await (const chunk of req) body.push(chunk);
      const response = await fetch(`http://localhost:80${req.url}`, {
        method: req.method, headers: req.headers,
        body: body.length ? Buffer.concat(body) : undefined,
      });
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(Buffer.from(await response.arrayBuffer()));
    } else {
      const path = req.url.split("?")[0];
      const file = extname(path) ? resolve(root, `.${path}`) : resolve(root, "index.html");
      if (!file.startsWith(`${root}/`)) throw new Error("Bad path");
      res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(file));
    }
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: "/repl/tools/bin/chromium", args: ["--no-sandbox"], headless: true });
const context = await browser.newContext();
const page = await context.newPage();
page.on("pageerror", (error) => console.error("BROWSER", error.message));
let customer;
try {
  customer = await api("/customers", "POST", { name: "Offline smoke client", dayOfWeek: "monday", poolType: "chlorine", address: "Original" });
  await api("/service-logs", "POST", { customerId: customer.id, serviceDate: "2024-01-01T12:00:00Z", notes: "Old offline history" });
  await api("/payments", "POST", { customerId: customer.id, periodYear: 2024, periodMonth: 1, amountCents: 15000 });
  await api("/company-settings", "PUT", { companyName: "Offline smoke pools", address: "Original company address" });
  await context.addInitScript(({ tenant }) => localStorage.setItem("prp_session_v2", JSON.stringify({ username: tenant, role: "admin" })), { tenant });
  await page.goto(`${origin}/settings`);
  await page.getByText("Ready to work offline", { exact: true }).waitFor();
  await page.locator("#address").waitFor();
  assert.equal(await page.locator("#companyName").inputValue(), "Offline smoke pools");
  await context.setOffline(true);
  await page.reload();
  await page.getByText("Ready to work offline", { exact: true }).waitFor();
  await page.locator("#address").fill("Saved without internet");
  await page.getByRole("button", { name: "Save Company Settings", exact: true }).click();
  await page.getByText("Company settings saved", { exact: true }).waitFor();
  await page.goto(`${origin}/customers/${customer.id}/edit`);
  await page.getByPlaceholder("123 Pool St, City, ST").fill("Offline customer address");
  await page.getByRole("button", { name: "Save Changes", exact: true }).click();
  await page.waitForURL(`**/customers/${customer.id}`);
  await page.goto(`${origin}/logs`);
  await page.getByText("Old offline history", { exact: false }).waitFor();
  await page.goto(`${origin}/invoice/${customer.id}?year=2024&month=1`);
  await page.getByText("Saved without internet", { exact: true }).waitFor();
  await page.getByText("$150.00", { exact: true }).first().waitFor();
  await page.goto(`${origin}/billing`);
  await page.getByRole("button", { name: "Expenses", exact: true }).click();
  await page.getByPlaceholder("Description (e.g. chlorine tablets)").fill("Offline chemicals");
  await page.getByPlaceholder("0", { exact: true }).fill("25");
  await page.getByPlaceholder("0", { exact: true }).press("Enter");
  await page.getByText("Offline chemicals", { exact: true }).waitFor();
  await context.setOffline(false);
  await page.goto(`${origin}/settings`);
  await page.getByRole("button", { name: "Download / sync now" }).click();
  await page.getByRole("button", { name: "Download / sync now" }).waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes("waiting to upload"), { timeout: 30000 });
  const result = await api("/offline-snapshot");
  assert.equal(result.companySettings.address, "Saved without internet");
  assert.equal(result.customers[0].address, "Offline customer address");
  assert.equal(result.expenses[0].description, "Offline chemicals");
  console.log("PASS: production service-worker cold reload, nested offline routes, full history, invoice branding, offline settings/customer/expense saves, and reconnect upload.");
} finally {
  if (customer) await api(`/customers/${customer.id}`, "DELETE");
  for (const expense of await api("/expenses")) await api(`/expenses/${expense.id}`, "DELETE");
  await api("/company-settings", "PUT", {});
  await browser.close();
  await new Promise((done) => server.close(done));
  console.log(`Cleaned test records for ${tenant} (blank settings row remains).`);
}
