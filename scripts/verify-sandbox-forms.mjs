import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileHeaders } from "../apps/web/worker/security.ts";

// Optional browser verification using an existing Playwright installation, not a project dependency.
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const app = await readFile(
  new URL("../apps/web/src/app.tsx", import.meta.url),
  "utf8",
);
const sandbox = app.match(/sandbox="([^"]+)"/)?.[1];
assert.equal(sandbox, "allow-scripts allow-forms");
const guest = `<!doctype html><html lang="en"><title>Sandbox form regression</title>
<form id="handled"><label>Required value <input id="value" name="value" required></label>
<button id="submit" type="submit">Submit locally</button></form>
<form id="native"><input name="value" value="native-test">
<button id="native-submit" type="submit">Submit natively</button></form>
<script>
window.result = { submits: 0, invalid: 0, native: 0, violations: [], parentBlocked: false };
try { void parent.document.body; } catch (error) { result.parentBlocked = error.name === 'SecurityError'; }
document.querySelector('#value').addEventListener('invalid', () => result.invalid++);
document.querySelector('#handled').addEventListener('submit', event => {
  event.preventDefault();
  result.submits++;
});
// No preventDefault: only the current document's CSP can block this native submission.
document.querySelector('#native').addEventListener('submit', () => result.native++);
document.addEventListener('securitypolicyviolation', event => {
  result.violations.push({ directive: event.effectiveDirective, disposition: event.disposition });
});
</script></html>`;

let receiverRequests = 0;
const receiver = createServer((_request, response) => {
  receiverRequests++;
  response.end("Native submission escaped");
});
let ownerRequests = 0;
const server = createServer((request, response) => {
  const url = new URL(request.url, origin);
  if (url.pathname === "/api/library") {
    ownerRequests++;
    response.end("Native submission escaped");
    return;
  }
  if (url.pathname === "/guest/index.html") {
    const headers = fileHeaders("index.html", `${origin}/guest/`);
    // Negative control: demonstrate why changing only the iframe is insufficient.
    if (url.searchParams.has("old-csp")) {
      headers.set(
        "Content-Security-Policy",
        headers.get("Content-Security-Policy").replace(" allow-forms", ""),
      );
    }
    headers.set("Cache-Control", "no-store");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    response.writeHead(200, Object.fromEntries(headers));
    response.end(guest);
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<iframe name="guest" title="Form regression" width="600" height="300"
    sandbox="${url.searchParams.has("old-iframe") ? "allow-scripts" : sandbox}"
    src="/guest/index.html${url.search}"></iframe>`);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
receiver.listen(0, "127.0.0.1");
await once(receiver, "listening");
const crossOrigin = `http://127.0.0.1:${receiver.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  console.log(`Chromium verification: ${browser.version()}`);
  for (const mode of ["iframe", "direct", "old-iframe", "old-csp"]) {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const topUrl =
      mode === "direct" ? `${origin}/guest/index.html` : `${origin}/?${mode}`;
    await page.goto(topUrl);
    const frame = mode === "direct" ? page.mainFrame() : page.frame("guest");
    await frame.waitForFunction(() => window.result);
    const guestUrl = frame.url();
    if (mode !== "direct") {
      assert.equal(
        await frame.evaluate(() => result.parentBlocked),
        true,
        "Guest must not read same-host parent DOM",
      );
    }
    const fixed = mode === "iframe" || mode === "direct";
    await frame.locator("#submit").click();
    assert.equal(await frame.evaluate(() => result.invalid), fixed ? 1 : 0);
    assert.equal(await frame.evaluate(() => result.submits), 0);
    await frame.locator("#value").fill("client-side value");
    await frame.locator("#submit").click();
    assert.equal(await frame.evaluate(() => result.submits), fixed ? 1 : 0);
    await frame.locator("#value").press("Enter");
    assert.equal(await frame.evaluate(() => result.submits), fixed ? 2 : 0);
    await frame.locator("#value").fill("");
    await frame.evaluate(() =>
      document.querySelector("#handled").requestSubmit(),
    );
    assert.equal(await frame.evaluate(() => result.invalid), fixed ? 2 : 0);
    assert.equal(await frame.evaluate(() => result.submits), fixed ? 2 : 0);
    await frame.locator("#value").fill("requestSubmit value");
    await frame.evaluate(() =>
      document.querySelector("#handled").requestSubmit(),
    );
    assert.equal(await frame.evaluate(() => result.submits), fixed ? 3 : 0);
    if (fixed) {
      let attempts = 0;
      let submitEvents = 0;
      const button = await frame.locator("#native-submit").boundingBox();
      for (const action of [
        `${origin}/api/library`,
        `${crossOrigin}/receive`,
      ]) {
        for (const method of ["get", "post"]) {
          await frame.evaluate(
            (options) => {
              const form = document.querySelector("#native");
              form.action = options.action;
              form.method = options.method;
            },
            { action, method },
          );
          for (const invocation of ["click", "prototype.submit"]) {
            if (invocation === "click") {
              // Avoid automatic navigation waits: observe CSP's cancellation instead.
              await page.mouse.click(
                button.x + button.width / 2,
                button.y + button.height / 2,
              );
              submitEvents++;
            } else {
              await frame.evaluate(() =>
                HTMLFormElement.prototype.submit.call(
                  document.querySelector("#native"),
                ),
              );
            }
            attempts++;
            await frame.waitForFunction(
              (count) => result.violations.length === count,
              attempts,
            );
            assert.equal(
              await frame.evaluate(() => result.native),
              submitEvents,
              "prototype.submit must bypass submit events, not CSP",
            );
            assert.deepEqual(
              await frame.evaluate(() => result.violations.at(-1)),
              {
                directive: "form-action",
                disposition: "enforce",
              },
            );
            assert.equal(frame.url(), guestUrl);
            assert.equal(page.url(), topUrl);
            assert.equal(ownerRequests, 0);
            assert.equal(receiverRequests, 0);
          }
        }
      }
    }
    assert.equal(ownerRequests, 0);
    assert.equal(receiverRequests, 0);
    console.log(
      `PASS ${mode}: ${fixed ? "validation, click/Enter/requestSubmit handlers, eight blocked native GET/POST attempts from Panes-served documents (including prototype.submit without submit events)" : "missing allow-forms prevents validation and click/Enter/requestSubmit handlers"}${mode === "direct" ? "" : ", parent DOM isolated"}`,
    );
    await page.close();
  }
  // External documents keep inherited sandbox flags, but do not inherit form-action.
  // Fulfill all synthetic HTTPS traffic locally; never forward it to a real host.
  const external = "https://external.panes.test";
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const externalRequests = [];
  await page.route(`${external}/**`, async (route) => {
    externalRequests.push({
      url: route.request().url(),
      method: route.request().method(),
    });
    await route.fulfill({
      contentType: "text/html",
      headers: {
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline'; form-action 'self'",
      },
      body: guest,
    });
  });
  await page.goto(`${origin}/?iframe`);
  const preview = page.frame("guest");
  await preview.evaluate(
    (url) =>
      new Promise((resolve) => {
        const child = document.createElement("iframe");
        child.name = "external";
        child.src = url;
        child.onload = () => resolve();
        document.body.appendChild(child);
      }),
    `${external}/child`,
  );
  const child = page.frame("external");
  assert.equal(
    await preview.locator('iframe[name="external"]').getAttribute("sandbox"),
    null,
  );
  assert.equal(
    await child.evaluate(() => globalThis.origin),
    "null",
    "Child must inherit an opaque sandbox origin even without its own sandbox attribute/header",
  );
  assert.equal(await child.evaluate(() => result.parentBlocked), true);
  const submitted = page.waitForRequest(`${external}/receive`);
  await child.evaluate((action) => {
    const form = document.querySelector("#native");
    form.action = action;
    form.method = "post";
    form.requestSubmit();
  }, `${external}/receive`);
  const request = await submitted;
  assert.equal(request.isNavigationRequest(), true);
  assert.equal(request.method(), "POST");
  assert.equal(request.postData(), "value=native-test");
  await child.waitForURL(`${external}/receive`);
  assert.equal(await child.evaluate(() => globalThis.origin), "null");
  assert.equal(await child.evaluate(() => result.parentBlocked), true);
  assert.deepEqual(externalRequests, [
    { url: `${external}/child`, method: "GET" },
    { url: `${external}/receive`, method: "POST" },
  ]);
  assert.equal(preview.url(), `${origin}/guest/index.html?iframe`);
  assert.equal(page.url(), `${origin}/?iframe`);
  await page.close();
  console.log(
    "PASS external child: inherited opaque sandbox origin; own CSP permits native POST/navigation (intercepted, no external network traffic).",
  );
  console.log(
    "5 browser scenarios passed; 16 Panes-served native attempts blocked; 0 owner-route/loopback receiver requests; 1 external-child POST fulfilled locally.",
  );
} finally {
  await browser?.close();
  await Promise.all(
    [server, receiver].map(
      (server) =>
        new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
}
