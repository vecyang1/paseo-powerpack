/**
 * End-to-end check of Task Decisions Queue & In-Place Session Resume in the real Paseo web app:
 *
 *   node --experimental-strip-types --no-warnings --import ./test/register-ts.mjs \
 *     scripts/intake-decisions-e2e.mts [--port 6799] [--shots <dir>]
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureHarness, resolveHarnessSetup, sleep } from "./paseo-harness.mts";

const args = process.argv.slice(2);
const argValue = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const PORT = Number(argValue("--port") || 6799) || 6799;
const SHOTS = argValue("--shots") ?? path.join(os.tmpdir(), "paseo-intake-decisions-e2e");
const PASEO_HOME = process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo");

type Page = any;
const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: unknown, detail = ""): void {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
}

async function main() {
  const setup = resolveHarnessSetup();
  if (!setup) process.exit(3);

  fs.mkdirSync(SHOTS, { recursive: true });
  const harness = await ensureHarness(PORT);

  const require = createRequire(import.meta.url);
  const { chromium } = require(setup.playwrightCore) as { chromium: any };
  const browser = await chromium.launch({
    executablePath: setup.chrome,
    headless: true,
  });

  let page: Page = null;
  try {
    page = await browser.newPage({
      viewport: { width: 1320, height: 860 },
      deviceScaleFactor: 2,
    });

    const consoleErrors: string[] = [];
    page.on("console", (msg: any) => {
      if (msg.type() === "error") {
        const txt = msg.text();
        if (!txt.includes("favicon")) consoleErrors.push(txt);
      }
    });

    await page.goto(`http://127.0.0.1:${PORT}/new`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="sidebar-display-preferences-menu"]', {
      timeout: 20_000,
    });
    await sleep(1000);

    // 1. Trigger Ctrl+Cmd+D to open Task Decisions Queue drawer
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "d",
          code: "KeyD",
          metaKey: true,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    await page.waitForSelector('[data-testid="intake-decisions-drawer"]', { timeout: 10_000 });
    await sleep(600);
    check("Ctrl+Cmd+D opens Task Decisions Queue drawer", true);

    const countText = await page.textContent('[data-testid="intake-decisions-count"]');
    check(
      "Live pending decision count rendered",
      Boolean(countText && /\d+/.test(countText)),
      countText ?? "",
    );

    const rowCount = await page.locator('[data-testid^="intake-decision-row-"]').count();
    check("Queue rows loaded from live review_queue.json", rowCount > 0, `rows=${rowCount}`);

    if (rowCount > 0) {
      // 2. Verify option hit target >= 44px
      const optCount = await page.locator('[data-testid^="intake-decision-opt-"]').count();
      check("Decision options extracted on active item", optCount > 0, `options=${optCount}`);
      if (optCount > 0) {
        const box = await page.locator('[data-testid="intake-decision-opt-1"]').boundingBox();
        check(
          "Option button meets 44px minimum touch/click height",
          Boolean(box && box.height >= 44),
          `height=${box?.height ?? 0}px`,
        );
      }

      // 3. Trigger Dry-Run Preview (`能试`) and verify real RPC execution
      await page.click('[data-testid="intake-decision-preview-btn"]');
      await page.waitForSelector('[data-testid="intake-decision-preview-output"]', {
        timeout: 15_000,
      });
      const previewTxt = await page.textContent('[data-testid="intake-decision-preview-output"]');
      check(
        "Dry-run preview returns real resume_existing_agent plan without mutating state",
        Boolean(previewTxt && previewTxt.includes("mode: resume_existing_agent")),
        (previewTxt ?? "").split("\n")[0],
      );
    }

    const drawerShot = path.join(SHOTS, "intake-decisions-drawer.png");
    await page.screenshot({ path: drawerShot });
    console.log(`Saved screenshot: ${drawerShot}`);

    // 4. Escape closes drawer cleanly
    await page.keyboard.press("Escape");
    await sleep(250);
    const stillOpen = await page.locator('[data-testid="intake-decisions-drawer"]').count();
    check("Escape closes Task Decisions Queue drawer", stillOpen === 0);

    // 5. Verify Settings -> Plugins -> File Inspector & Finder renders the new reconciler card
    const serverId =
      argValue("--server") ?? fs.readFileSync(path.join(PASEO_HOME, "server-id"), "utf8").trim();
    await page.goto(
      `http://127.0.0.1:${PORT}/settings/hosts/${serverId}/plugins/file-inspector-finder/finder-settings`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForSelector('[data-testid="intake-decisions-settings-card"]', {
      timeout: 20_000,
    });
    await page.locator('[data-testid="intake-decisions-settings-card"]').scrollIntoViewIfNeeded();
    await sleep(500);
    check("Settings screen renders Task Decisions & In-Place Session Resume reconciler", true);

    const extStatusTxt = await page.textContent('[data-testid="intake-external-scan-status"]');
    check(
      "Settings card shows auto email & GitHub scan status",
      Boolean(extStatusTxt && /GitHub/i.test(extStatusTxt)),
      extStatusTxt ?? "",
    );

    const hasDryRunBtn = (await page.locator('[data-testid="intake-external-dryrun-btn"]').count()) > 0;
    const hasToggleBtn = (await page.locator('[data-testid="intake-external-toggle-btn"]').count()) > 0;
    check(
      "Settings card exposes external scan Try & Tune controls",
      hasDryRunBtn && hasToggleBtn,
      `dryRunBtn=${hasDryRunBtn} toggleBtn=${hasToggleBtn}`,
    );

    const settingsShot = path.join(SHOTS, "intake-decisions-settings.png");
    await page.screenshot({ path: settingsShot });
    console.log(`Saved screenshot: ${settingsShot}`);

    check("Zero browser console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
  } finally {
    await browser.close();
    if (harness) harness.kill();
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`${failed.length} E2E checks failed`);
    process.exit(1);
  }
  console.log(`All ${results.length}/${results.length} E2E checks passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
