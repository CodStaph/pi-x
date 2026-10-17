import assert from "node:assert/strict";

/**
 * Embedded browser page view: a normal right-panel tab (TabBar kind "browser")
 * opened from the topbar globe toggle, alongside file and terminal tabs. On
 * mobile the toggle must not exist at all.
 *
 * Runs in both e2e viewports. The iframe is pointed at the harness's own
 * origin (`/offline.html`) so the check never depends on an external site's
 * X-Frame-Options header.
 */
export async function checkBrowserCard(page, base, viewportWidth) {
  const toggle = page.locator(".browser-toggle");

  if (viewportWidth <= 600) {
    assert.equal(await toggle.count(), 0, "the browser toggle must be desktop-only");
    return;
  }

  await toggle.waitFor({ state: "visible" });
  const panel = page.locator("#file-panel");
  const browserTab = page.getByRole("tab", { name: "Browser", exact: true });
  assert.equal(await browserTab.count(), 0, "the browser tab must start closed");

  await toggle.click();
  await browserTab.waitFor({ state: "visible" });

  const address = panel.locator(".context-browser-address");
  await address.waitFor({ state: "visible" });

  const url = `${base}/offline.html`;
  await address.fill(url);
  await address.press("Enter");
  const iframe = panel.locator("iframe.context-browser-frame");
  await iframe.waitFor({ state: "attached" });
  assert.equal(await iframe.getAttribute("src"), url, "the address bar must drive the iframe");

  // Closing the tab removes the page view; reopening restores the URL.
  await browserTab.locator(".file-tab-close").click();
  await browserTab.waitFor({ state: "detached" });
  await toggle.click();
  await browserTab.waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#file-panel .context-browser-address").inputValue(),
    url,
    "the last URL must survive a close/reopen",
  );

  await browserTab.locator(".file-tab-close").click();
  await browserTab.waitFor({ state: "detached" });
}
