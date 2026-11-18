/**
 * Live headless E2E verification of Paseo Antigravity Subagent UX (anti-repetition, single composer
 * bar, smart per-workspace sidebar collapse, hidden L0 return row on root, and L2 tab prefix dedupe)
 * against the real Paseo 0.15.4 bundle + live daemon on :6767.
 *
 *   node --experimental-strip-types --no-warnings --import ./test/register-ts.mjs \
 *     scripts/subagents-ux-e2e.mts [--port 6798] [--workspace wks_c31ef60595de6846] [--shots /dir]
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureHarness, resolveHarnessSetup, sleep } from "./paseo-harness.mts";

const args = process.argv.slice(2);
const argValue = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const PORT = Number(argValue("--port") || 6798) || 6798;
const WORKSPACE_ID = argValue("--workspace") || "wks_c31ef60595de6846";
const SHOTS = argValue("--shots") ?? path.join(os.tmpdir(), "paseo-subagents-ux-e2e");
const SERVER_ID_FILE = path.join(os.homedir(), ".paseo", "server-id");
const SERVER_ID = fs.existsSync(SERVER_ID_FILE) ? fs.readFileSync(SERVER_ID_FILE, "utf8").trim() : "local";

type Page = any;
const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: unknown, detail = ""): void {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
}

async function shoot(page: Page, label: string): Promise<string> {
  fs.mkdirSync(SHOTS, { recursive: true });
  const shot = path.join(SHOTS, `${label}.png`);
  await page.screenshot({ path: shot });
  return shot;
}

async function run(page: Page, shots: string[]): Promise<void> {
  const pageErrors: string[] = [];
  page.on("pageerror", (err: Error) => pageErrors.push(err.message));

  // Step 0: Boot `/` first so daemon-registry initializes in localStorage before deep-linking
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="sidebar-footer"]', { timeout: 45_000 });

  let serverId: string | null = await page.evaluate(() => {
    try {
      const raw = localStorage.getItem("@paseo:daemon-registry");
      if (raw) {
        const parsed = JSON.parse(raw);
        const entries = parsed?.daemons || parsed?.hosts || parsed?.entries || [];
        for (const item of Array.isArray(entries) ? entries : Object.values(entries)) {
          const sid = (item as any)?.serverId || (item as any)?.id;
          if (typeof sid === "string" && sid.startsWith("srv_")) return sid;
        }
      }
    } catch {
      // ignore
    }
    return null;
  });
  if (!serverId) serverId = SERVER_ID;

  const targetUrl = `http://localhost:${PORT}/h/${encodeURIComponent(serverId)}/workspace/${encodeURIComponent(WORKSPACE_ID)}`;
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('textarea[data-composer-input], [data-testid="message-input-root"]', {
    timeout: 45_000,
  });

  // Ensure the active workspace's project is expanded in the left sidebar so its sidebar row is visible
  await page.evaluate(async (wsId: string) => {
    const existing = document.querySelector(`[data-testid$=":${wsId}"][data-testid^="sidebar-workspace-row-"]`);
    if (existing) {
      existing.scrollIntoView({ block: "center" });
      return;
    }
    const projRows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="sidebar-project-row-"]'),
    );
    const projectPattern = new RegExp(process.env.PASEO_E2E_PROJECT_PATTERN || "A-coding|Example", "i");
    const targetProj = projRows.find((r) => projectPattern.test(r.textContent || ""));
    if (targetProj) {
      targetProj.click();
    }
  }, WORKSPACE_ID);
  await sleep(600);
  await page.evaluate((wsId: string) => {
    const showMoreBtns = Array.from(document.querySelectorAll<HTMLElement>("button, [role='button']"));
    for (const btn of showMoreBtns) {
      if (/show more|显示更多/i.test(btn.textContent || "")) btn.click();
    }
    const row = document.querySelector(`[data-testid$=":${wsId}"][data-testid^="sidebar-workspace-row-"]`);
    row?.scrollIntoView({ block: "center" });
  }, WORKSPACE_ID);

  // Wait for subagent bar + left sidebar subagent tree to mount
  let barReady = false;
  for (let i = 0; i < 40; i += 1) {
    barReady = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="paseo-finder-subagents-bar"]') as HTMLElement | null;
      return Boolean(bar && bar.getBoundingClientRect().height > 0);
    });
    if (barReady) break;
    await sleep(300);
  }
  check("unified subagents bar mounted above composer", barReady);

  // 1. Check zero duplicate native `[1 subagent]` pill visible above our unified bar on L0
  const composerState = await page.evaluate(() => {
    const visibleHeaders = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="subagents-track-header"]'),
    ).filter((el) => {
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const unifiedBars = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="paseo-finder-subagents-bar"]'),
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return {
      visibleNativeHeaders: visibleHeaders.map((h) => (h.textContent || "").trim()),
      unifiedBarsCount: unifiedBars.length,
      unifiedBarText: (unifiedBars[0]?.textContent || "").trim(),
    };
  });
  check(
    "single composer bar on L0 (zero stacked duplicate `[1 subagent]` pill)",
    composerState.visibleNativeHeaders.length === 0 && composerState.unifiedBarsCount === 1,
    JSON.stringify(composerState),
  );

  // 2. Check left sidebar smart collapse on completed workspace + no redundant `↩ L0 Main Agent` when expanded on L0
  const sidebarInitial = await page.evaluate((wsId: string) => {
    const box = document.querySelector(
      `[data-testid="paseo-finder-left-sidebar-subagents"][data-workspace-id="${wsId}"]`,
    ) as HTMLElement | null;
    if (!box) return { found: false, text: "", itemCount: 0 };
    const items = box.querySelectorAll('[data-testid^="paseo-finder-left-sidebar-subagent-"]');
    return { found: true, text: (box.textContent || "").trim(), itemCount: items.length };
  }, WORKSPACE_ID);
  check(
    "completed subagent tree auto-collapses to 1 summary line in left sidebar",
    sidebarInitial.found && sidebarInitial.itemCount === 0 && sidebarInitial.text.includes("▸"),
    JSON.stringify(sidebarInitial),
  );

  // Expand left sidebar tree for this workspace to verify `↩ L0 Main Agent` is hidden while on L0
  await page.evaluate((wsId: string) => {
    const toggle = document.querySelector(
      `[data-testid="paseo-finder-left-sidebar-subagents-toggle"][data-workspace-id="${wsId}"]`,
    ) as HTMLElement | null;
    toggle?.click();
  }, WORKSPACE_ID);
  await sleep(250);
  const sidebarExpandedOnL0 = await page.evaluate((wsId: string) => {
    const box = document.querySelector(
      `[data-testid="paseo-finder-left-sidebar-subagents"][data-workspace-id="${wsId}"]`,
    ) as HTMLElement | null;
    const rootBtn = box?.querySelector(
      '[data-testid="paseo-finder-left-sidebar-subagent-root"]',
    ) as HTMLElement | null;
    const rootVisible = Boolean(
      rootBtn && window.getComputedStyle(rootBtn).display !== "none" && rootBtn.getBoundingClientRect().height > 0,
    );
    const items = Array.from(
      box?.querySelectorAll<HTMLElement>('[data-testid^="paseo-finder-left-sidebar-subagent-"]:not([data-testid="paseo-finder-left-sidebar-subagent-root"])') ?? [],
    ).map((el) => (el.textContent || "").trim());
    return { rootVisible, items };
  }, WORKSPACE_ID);
  check(
    "left sidebar hides redundant `↩ L0 Main Agent` row while already viewing L0 Main Agent",
    sidebarExpandedOnL0.rootVisible === false && sidebarExpandedOnL0.items.length === 3,
    JSON.stringify(sidebarExpandedOnL0),
  );

  shots.push(await shoot(page, "01-l0-bottom-composer-and-sidebar"));

  // 3. Click L1 DeepInvestigator pill (16 steps total) and expand `Used 2 other tools` so inline `tool-call-badge` rows render
  await page.evaluate(() => {
    const pills = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="paseo-finder-subagent-pill-"]'),
    );
    const l1Pill = pills.find((p) => /L1\s+DeepInvestigator/i.test(p.textContent || ""));
    l1Pill?.click();
  });
  await sleep(900);
  const usedToolsPt = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll<HTMLElement>("div, span"));
    for (const el of all) {
      if (el.children.length === 0 && /^Used \d+ other tools$/i.test((el.textContent || "").trim())) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    return null;
  });
  if (usedToolsPt) {
    await page.mouse.click(usedToolsPt.x, usedToolsPt.y);
    await sleep(600);
  }

  const inlineBadgeAudit = await page.evaluate(() => {
    const badges = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="tool-call-badge"]'));
    const target = badges.find((b) => /WorkerL0|ImprovementWorker|DeepInvestigator/i.test(b.textContent || ""));
    if (!target) return null;
    const chip = target.querySelector('[data-testid="paseo-finder-inline-subagent-chip"]');
    const leaves = Array.from(target.querySelectorAll<HTMLElement>("div, span"))
      .filter((el) => el.children.length === 0 && (!chip || !chip.contains(el)) && (el.textContent || "").trim().length > 0)
      .map((el) => (el.textContent || "").trim());
    return {
      leaves,
      chipText: (chip?.textContent || "").trim(),
      fullText: (target.textContent || "").trim(),
    };
  });
  check(
    "inline tool-call-badge deduplicates subAgentType, role, and bracketed status text",
    Boolean(
      inlineBadgeAudit &&
        !inlineBadgeAudit.leaves.some((t: string) => /^L\d+\s+DeepInvestigator/i.test(t)) &&
        !inlineBadgeAudit.leaves.some((t: string) => /\[(?:Done|Running)/i.test(t)) &&
        !inlineBadgeAudit.leaves.some((t: string) => /—\s*(?:Ec|Layer\s*0)/i.test(t)) &&
        inlineBadgeAudit.chipText.includes("steps"),
    ),
    JSON.stringify(inlineBadgeAudit),
  );
  shots.push(await shoot(page, "02-inline-badge-deduped-l1-tab"));

  // 4. Click L2 WorkerL0 pill to open L2 subagent tab and verify tab label is `L2 WorkerL0` (not `L2 DeepInvestiga...`)
  await page.evaluate(() => {
    const pills = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="paseo-finder-subagent-pill-"]'),
    );
    const l2Pill = pills.find((p) => /WorkerL0/i.test(p.textContent || ""));
    l2Pill?.click();
  });
  await sleep(700);

  const l2TabAudit = await page.evaluate((wsId: string) => {
    const tabs = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="workspace-tab-provider_subagent_"]'),
    ).map((t) => ({
      text: (t.textContent || "").trim(),
      selected: t.getAttribute("aria-selected"),
      labelAttr: t.getAttribute("data-vec-tab-label"),
    }));
    const box = document.querySelector(
      `[data-testid="paseo-finder-left-sidebar-subagents"][data-workspace-id="${wsId}"]`,
    ) as HTMLElement | null;
    const rootBtn = box?.querySelector(
      '[data-testid="paseo-finder-left-sidebar-subagent-root"]',
    ) as HTMLElement | null;
    const rootVisibleOnL2 = Boolean(
      rootBtn && window.getComputedStyle(rootBtn).display !== "none" && rootBtn.getBoundingClientRect().height > 0,
    );
    return { tabs, rootVisibleOnL2 };
  }, WORKSPACE_ID);
  check(
    "L2 subagent tab displays concise `L2 WorkerL0` (zero `L2 DeepInvestiga...` collision) and reveals `↩ L0 Main Agent` while on L2",
    l2TabAudit.tabs.some((t: any) => t.text.includes("L2 WorkerL0") && !t.text.includes("DeepInvestiga")) &&
      l2TabAudit.rootVisibleOnL2 === true,
    JSON.stringify(l2TabAudit),
  );
  shots.push(await shoot(page, "03-l2-tab-concise-and-return-link"));

  check("zero browser pageerror exceptions", pageErrors.length === 0, pageErrors.join("; "));
}

async function main(): Promise<void> {
  const setup = resolveHarnessSetup();
  if (!setup) process.exit(2);
  const harness = await ensureHarness(PORT);
  const require = createRequire(path.join(setup.playwrightCore, "package.json"));
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ headless: true, executablePath: setup.chrome });
  const shots: string[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await run(page, shots);
  } finally {
    await browser.close();
    harness?.kill();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed. Shots: ${shots.join(", ")}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
