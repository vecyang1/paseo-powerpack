/**
 * Live end-to-end verification for Antigravity Native Swarm Board & Run-Workflow integration in Paseo:
 *   - Creates a disposable temporary workspace (archived cleanly in `finally`, never touching user threads)
 *   - Connects to the live local Paseo daemon via Paseo's web harness (`paseo-harness.mts`)
 *   - Opens the `Swarm` workspace panel via client bridge (same path as `/swarm-board`, `⌘K`, and `sidecar://`)
 *   - Verifies Google's official `swarm_board` loads live inside the Paseo `Swarm` tab with real local swarm data
 *     (Board, Members, Graph with Mentions/Hive + Replay + Hide inactive + Expand @all + Export GIF)
 *   - Verifies Paseo 7-theme CSS variables sync into the official iframe (`theme-change`)
 *   - Switches to `Workflows` mode and verifies real local `/run-workflow` phases, logs, and child agent cards
 *   - Saves desktop screenshots for visual verification
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings --import ./test/register-ts.mjs \
 *     scripts/swarm-workflow-e2e.mts [--port 6886] [--shots <dir>]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { ensureHarness, resolveHarnessSetup, sleep } from "./paseo-harness.mts";

const args = process.argv.slice(2);
const argValue = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

const PORT = Number(argValue("--port") || 6886) || 6886;
const SHOTS = argValue("--shots") ?? path.join(os.tmpdir(), "paseo-swarm-workflow-e2e");
const REAL_WS_ID = argValue("--real-workspace") ?? "";
const EXPECTED_SWARM_SUBSTR = argValue("--expect-swarm-title") ?? "";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: unknown, detail = ""): void {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
}

function runPaseoJson(cmdArgs: string[]): any {
  const out = execFileSync("paseo", [...cmdArgs, "--json"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  return JSON.parse(out.trim());
}

async function main() {
  const setup = resolveHarnessSetup();
  if (!setup) {
    console.error("Playwright harness setup unavailable");
    process.exit(3);
  }
  fs.mkdirSync(SHOTS, { recursive: true });

  const rawTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-swarm-e2e-ws-"));
  const wsDir = fs.realpathSync(rawTmpDir);
  let tempWorkspaceId: string | null = null;
  let browser: any = null;
  const harnessChild = await ensureHarness(PORT);

  try {
    const created = runPaseoJson([
      "workspace",
      "create",
      "--isolation",
      "local",
      "--path",
      wsDir,
      "--title",
      "Swarm & Workflow E2E Fixture",
    ]);
    tempWorkspaceId = created.id || created.workspaceId || created.workspace?.id || null;
    check("Created disposable E2E workspace", Boolean(tempWorkspaceId), String(tempWorkspaceId));
    if (!tempWorkspaceId) throw new Error("Failed to create temp workspace");

    const req = createRequire(path.join(setup.playwrightCore, "package.json"));
    const { chromium } = req("playwright-core") as any;
    browser = await chromium.launch({
      executablePath: setup.chrome,
      headless: true,
    });
    const context = await browser.newContext({
      viewport: { width: 1480, height: 920 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    const pageErrors: string[] = [];
    page.on("pageerror", (e: Error) => pageErrors.push(e.message));

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector('[data-testid="sidebar-footer"]', { timeout: 45_000 });

    const serverId =
      (await page.evaluate(() => {
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
        } catch {}
        return null;
      })) || fs.readFileSync(path.join(os.homedir(), ".paseo", "server-id"), "utf8").trim();

    check("Resolved local Paseo serverId", Boolean(serverId), String(serverId));

    await page.goto(`http://localhost:${PORT}/h/${serverId}/workspace/${tempWorkspaceId}`, {
      waitUntil: "domcontentloaded",
    });
    await sleep(2500);

    const bridgeReady = await page.evaluate(() => {
      const w = window as any;
      return Boolean(w.__paseoFinderSwarmWorkflow && typeof w.__paseoFinderSwarmWorkflow.openPanel === "function");
    });
    check("Paseo Powerpack Swarm/Workflow client bridge mounted on window", bridgeReady);

    const deckScope = page.locator(`[data-testid="workspace-deck-entry-${serverId}:${tempWorkspaceId}"]`);

    // Open the Swarm Workspace Panel via the client bridge (same path as /swarm-board, ⌘K, and sidecar:// clicks)
    await page.evaluate((wsId: string) => {
      (window as any).__paseoFinderSwarmWorkflow.openPanel({ tab: "swarm", swarmTab: "graph", workspaceId: wsId });
    }, tempWorkspaceId);

    await deckScope.locator('[data-testid="paseo-swarm-workspace-panel"]').waitFor({ state: "visible", timeout: 20_000 });
    check("Swarm Workspace Panel rendered inside Paseo workspace tab", true);

    const activeIframeLoc = deckScope.locator('iframe[data-testid="paseo-swarm-board-iframe"]');
    await activeIframeLoc.waitFor({ state: "visible", timeout: 20_000 });
    await sleep(600);
    const geom = await page.evaluate((deckTid: string) => {
      const root = document.querySelector(`[data-testid="${deckTid}"]`) || document;
      const panel = root.querySelector('[data-testid="paseo-swarm-workspace-panel"]')?.getBoundingClientRect();
      const iframe = root.querySelector('iframe[data-testid="paseo-swarm-board-iframe"]')?.getBoundingClientRect();
      const stage = root.querySelector('[data-testid^="paseo-swarm-stage-"]')?.getBoundingClientRect();
      return {
        panel: panel ? { w: Math.round(panel.width), h: Math.round(panel.height) } : null,
        stage: stage ? { w: Math.round(stage.width), h: Math.round(stage.height) } : null,
        iframe: iframe ? { w: Math.round(iframe.width), h: Math.round(iframe.height) } : null,
      };
    }, `workspace-deck-entry-${serverId}:${tempWorkspaceId}`);
    check(
      "Official swarm_board iframe fills full Paseo workspace panel (no width/height clipping)",
      Boolean(geom.iframe && geom.iframe.w >= 900 && geom.iframe.h >= 550),
      JSON.stringify(geom),
    );

    const iframeHandle = await activeIframeLoc.elementHandle();
    const frame = await iframeHandle?.contentFrame();
    check("Official swarm_board iframe attached and accessible", Boolean(frame));

    if (frame) {
      await frame.waitForSelector('[data-testid="swarm-board"]:not(.hidden), [data-testid="swarm-empty-state"]:not(.hidden)', {
        timeout: 20_000,
      });
      const innerGeom = await frame.evaluate(() => ({
        iw: window.innerWidth,
        ih: window.innerHeight,
        dpr: window.devicePixelRatio,
        boardW: Math.round(document.getElementById("board")?.getBoundingClientRect()?.width ?? 0),
      }));
      check(
        "Official swarm_board inner viewport matches outer iframe at Retina 2x (zero OOPIF clipping)",
        innerGeom.iw >= 900 && innerGeom.ih >= 550 && innerGeom.boardW >= 900,
        JSON.stringify(innerGeom),
      );
      const boardVisible = await frame.locator('[data-testid="swarm-board"]').isVisible();
      check("Official swarm_board loaded real local swarm data", boardVisible);

      const syncedBg = await frame.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      );
      check("Paseo 7-theme CSS variables synced into swarm_board iframe", Boolean(syncedBg), `background=${syncedBg}`);

      const feedTab = frame.locator('[data-testid="swarm-tab-feed"]');
      const membersTab = frame.locator('[data-testid="swarm-tab-members"]');
      const graphTab = frame.locator('[data-testid="swarm-tab-graph"]');
      check(
        "Official swarm_board exposes Board, Members, and Graph tabs",
        (await feedTab.isVisible()) && (await membersTab.isVisible()) && (await graphTab.isVisible()),
      );

      // Click Graph tab -> Mentions view (matching user screenshot)
      await graphTab.click();
      await sleep(700);
      const mentionsBtn = frame.locator("#gview-mentions");
      if (await mentionsBtn.isVisible()) {
        await mentionsBtn.click();
        await sleep(500);
      }
      const graphSvgVisible = await frame.locator('[data-testid="swarm-graph"]').isVisible();
      const replayPlayVisible = await frame.locator('[data-testid="swarm-replay-play"]').isVisible();
      const exportGifVisible = await frame.locator('[data-testid="swarm-graph-export-gif"]').isVisible();
      check(
        "Swarm Graph (Mentions) + Replay + Export GIF rendered live",
        graphSvgVisible && replayPlayVisible && exportGifVisible,
      );
      await page.screenshot({ path: path.join(SHOTS, "01-swarm-graph-mentions.png") });

      // Check Graph -> Hive view if available
      const hiveBtn = frame.locator("#gview-hive");
      if (await hiveBtn.isVisible()) {
        await hiveBtn.click();
        await sleep(500);
        await page.screenshot({ path: path.join(SHOTS, "05-swarm-graph-hive.png") });
      }

      // Check Board feed tab
      await feedTab.click();
      await sleep(500);
      const msgCount = await frame.locator('[data-testid="swarm-message"]').count();
      check("Swarm Board feed displays real persisted board posts", msgCount > 0, `posts=${msgCount}`);
      await page.screenshot({ path: path.join(SHOTS, "02-swarm-board-feed.png") });

      // Check Members tab (official hive.js renders article.o2-mrow[data-open-member])
      await membersTab.click();
      await sleep(600);
      const memberRows = frame.locator('article.o2-mrow[data-open-member]');
      const memberCount = await memberRows.count();
      check("Swarm Members roster displays real swarm members", memberCount > 0, `members=${memberCount}`);
      await page.screenshot({ path: path.join(SHOTS, "04-swarm-members.png") });

      if (memberCount > 0) {
        await memberRows.first().click();
        await sleep(500);
        const openedCount = await page.evaluate(() => (window as any).__paseoFinderSwarmWorkflow?.status?.()?.openedMemberConversations ?? 0);
        const drawerVisible = await page.locator('[data-testid="paseo-finder-subagents-drawer"]').isVisible().catch(() => false);
        check(
          "Clicking a Swarm member opens Paseo conversation navigation / timeline drawer",
          openedCount > 0,
          `opened=${openedCount}, drawerVisible=${drawerVisible}`,
        );
        if (drawerVisible) {
          await page.screenshot({ path: path.join(SHOTS, "06-swarm-member-drawer.png") });
          const closeBtn = page.locator('[data-testid="paseo-finder-subagents-close"]');
          if (await closeBtn.isVisible().catch(() => false)) {
            await closeBtn.click();
          } else {
            await page.keyboard.press("Escape");
          }
          await sleep(400);
        } else if (!page.url().includes(tempWorkspaceId)) {
          // Clicking a real Paseo-backed swarm member navigated directly to its workspace;
          // return to the disposable E2E workspace before continuing the remaining checks.
          await page.goto(`http://localhost:${PORT}/h/${serverId}/workspace/${tempWorkspaceId}`, {
            waitUntil: "domcontentloaded",
          });
          await sleep(1500);
          await page.evaluate((wsId: string) => {
            (window as any).__paseoFinderSwarmWorkflow?.openPanel?.({ tab: "swarm", workspaceId: wsId });
          }, tempWorkspaceId);
          await deckScope.locator('[data-testid="paseo-swarm-workspace-panel"]').waitFor({ state: "visible", timeout: 15_000 });
        }
      }
    }

    // Verify sidecar://swarm/swarm_board click interception
    const sidecarClicks = await page.evaluate(() => {
      const a = document.createElement("a");
      a.href = "sidecar://swarm/swarm_board/?tab=board";
      a.textContent = "Open Swarm";
      document.body.appendChild(a);
      a.click();
      a.remove();
      return (window as any).__paseoFinderSwarmWorkflow?.status?.()?.interceptedSidecarClicks ?? 0;
    });
    check("sidecar://swarm/swarm_board link click intercepted into Paseo Swarm panel", sidecarClicks > 0, `clicks=${sidecarClicks}`);

    // Switch to Workflows mode inside the same Paseo panel
    await deckScope.locator('[data-testid="paseo-swarm-mode-workflows"]').click();
    await sleep(1200);
    const wfListVisible = await deckScope.locator('[data-testid="paseo-workflows-list"]').isVisible();
    const wfCards = deckScope.locator('[data-testid^="paseo-workflow-card-"]');
    const wfCardCount = await wfCards.count();
    if (wfCardCount > 0) {
      // Expand the richest workflow card (the one with child agents if present, else first)
      let targetIdx = 0;
      for (let i = 0; i < wfCardCount; i++) {
        const txt = (await wfCards.nth(i).textContent()) ?? "";
        if (/[1-9]\d*\s+agent\(s\)/.test(txt)) {
          targetIdx = i;
          break;
        }
      }
      await wfCards.nth(targetIdx).click();
      await sleep(500);
    }
    const wfAgentCount = await deckScope.locator('[data-testid^="paseo-workflow-agent-"]').count();
    check(
      "Workflows tab lists real local /run-workflow runs with phases & child agents",
      wfListVisible && wfCardCount > 0 && wfAgentCount > 0,
      `workflows=${wfCardCount}, agents=${wfAgentCount}`,
    );
    await page.screenshot({ path: path.join(SHOTS, "03-workflows-inspector.png") });

    // Verify bare `/swarm board` + Enter interception (0 LLM tokens)
    const boardCmdIntercepted = await page.evaluate(() => {
      const ta = document.createElement("textarea");
      ta.setAttribute("data-composer-input", "true");
      ta.value = "/swarm board";
      document.body.appendChild(ta);
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      const cleared = ta.value === "";
      ta.remove();
      return cleared ? ((window as any).__paseoFinderSwarmWorkflow?.status?.()?.interceptedBoardCommands ?? 0) : 0;
    });
    check(
      "Bare `/swarm board` + Enter intercepted locally (0 LLM tokens, clears input & opens Swarm panel)",
      boardCmdIntercepted > 0,
      `intercepted=${boardCmdIntercepted}`,
    );

    // Verify Dark theme sync into official swarm_board iframe
    await deckScope.locator('[data-testid="paseo-swarm-mode-swarm"]').click();
    await sleep(600);
    await page.evaluate(() => {
      try {
        const raw = localStorage.getItem("@paseo:app-settings");
        const parsed = raw ? JSON.parse(raw) : {};
        (window as any).__origThemeBeforeE2e = parsed.theme;
        parsed.theme = "dark";
        localStorage.setItem("@paseo:app-settings", JSON.stringify(parsed));
      } catch {}
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await sleep(2200);
    await page.evaluate((wsId: string) => {
      (window as any).__paseoFinderSwarmWorkflow?.openPanel?.({ tab: "swarm", swarmTab: "graph", workspaceId: wsId });
    }, tempWorkspaceId);
    const darkIframeLoc = deckScope.locator('iframe[data-testid="paseo-swarm-board-iframe"]');
    await darkIframeLoc.waitFor({ state: "visible", timeout: 20_000 });
    await sleep(1200);
    const darkFrame = await (await darkIframeLoc.elementHandle())?.contentFrame();
    let darkScheme = "";
    let darkBg = "";
    if (darkFrame) {
      await darkFrame.waitForSelector('[data-testid="swarm-board"]:not(.hidden)', { timeout: 15_000 }).catch(() => {});
      await sleep(700);
      const st = await darkFrame.evaluate(() => ({
        scheme: document.documentElement.getAttribute("data-theme") || "",
        bg: getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      }));
      darkScheme = st.scheme;
      darkBg = st.bg;
    }
    check(
      "Dark theme syncs into official swarm_board iframe (data-theme=dark)",
      darkScheme === "dark" && Boolean(darkBg) && darkBg !== "#ffffff",
      `scheme=${darkScheme}, bg=${darkBg}`,
    );
    await page.screenshot({ path: path.join(SHOTS, "07-swarm-dark-theme.png") });
    await page.evaluate(() => {
      try {
        const raw = localStorage.getItem("@paseo:app-settings");
        const parsed = raw ? JSON.parse(raw) : {};
        parsed.theme = (window as any).__origThemeBeforeE2e || "light";
        localStorage.setItem("@paseo:app-settings", JSON.stringify(parsed));
      } catch {}
    });

    // Verify Settings -> Paseo Powerpack -> Swarm & Run-Workflow Bridge -> Run Live Probe (7/7 PASS)
    await page.goto(`http://localhost:${PORT}/settings/hosts/${serverId}/plugins/file-inspector-finder/finder-settings`, {
      waitUntil: "domcontentloaded",
    });
    const probeBtn = page.locator('[data-testid="paseo-swarm-settings-probe-btn"]').first();
    const probeReady = await probeBtn.waitFor({ state: "attached", timeout: 15_000 }).then(() => true).catch(() => false);
    if (probeReady) {
      await probeBtn.scrollIntoViewIfNeeded();
      await sleep(300);
      await probeBtn.click();
      await page
        .locator('[data-testid="paseo-swarm-settings-probe-result"]')
        .waitFor({ state: "visible", timeout: 15_000 })
        .catch(() => {});
      await sleep(300);
    }
    const secText =
      (await page.locator('[data-testid="paseo-swarm-settings-probe-result"]').textContent().catch(() => "")) ?? "";
    const passHits = (secText.match(/\[PASS\]/g) || []).length;
    const failHits = (secText.match(/\[FAIL\]/g) || []).length;
    check(
      "Settings -> Swarm & Run-Workflow Bridge -> Run Live Probe passes all 7 checks",
      probeReady && passHits === 7 && failHits === 0,
      `probeReady=${probeReady}, pass=${passHits}/7, fail=${failHits}`,
    );
    await page.screenshot({ path: path.join(SHOTS, "08-settings-live-probe.png") });

    // Optional read-only verification on a real existing workspace with a native Swarm
    if (REAL_WS_ID) {
      await page.goto(`http://localhost:${PORT}/h/${serverId}/workspace/${REAL_WS_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await sleep(3500);

      const realDeck = page.locator(`[data-testid="workspace-deck-entry-${serverId}:${REAL_WS_ID}"]`);
      const headerSwarmBtn = realDeck.locator('button, [role="button"]').filter({ hasText: /^Swarm/ }).first();
      const headerBtnVisible = await headerSwarmBtn.isVisible().catch(() => false);
      check(
        "Real Swarm workspace displays dynamic `Swarm` header button",
        headerBtnVisible,
        `workspace=${REAL_WS_ID}`,
      );

      const composerSwarmBoardLoc = realDeck.locator('[data-testid="paseo-finder-open-swarm-board"]');
      const composerSwarmBoardBtn = await composerSwarmBoardLoc
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
      const inlineCardCount = await realDeck.locator('[data-testid^="antigravity-swarm-card-"]').count();
      const inlineRowCount = await realDeck.locator('[data-testid^="antigravity-swarm-row-"]').count();
      const namedWorkerPills = await realDeck.locator('[data-testid^="paseo-finder-subagent-pill-"]').allTextContents().catch(() => []);
      await page.screenshot({ path: path.join(SHOTS, "09-real-workspace-timeline.png") });
      check(
        "Real Swarm workspace displays named @worker pills & Swarm Board shortcut above composer",
        headerBtnVisible && (composerSwarmBoardBtn || inlineCardCount > 0 || inlineRowCount > 0),
        `cards=${inlineCardCount}, rows=${inlineRowCount}, composerBoardBtn=${composerSwarmBoardBtn}, pills=${JSON.stringify(namedWorkerPills.slice(0, 4))}`,
      );

      // Click the header Swarm button (or open panel via bridge) and verify THIS workspace's own swarm auto-selected!
      if (headerBtnVisible) {
        await headerSwarmBtn.click();
      } else {
        await page.evaluate((wsId: string) => {
          (window as any).__paseoFinderSwarmWorkflow?.openPanel?.({ tab: "swarm", workspaceId: wsId });
        }, REAL_WS_ID);
      }
      const realIframeLoc = realDeck.locator('iframe[data-testid="paseo-swarm-board-iframe"]');
      await realIframeLoc.waitFor({ state: "visible", timeout: 20_000 });
      await sleep(1800);
      const realFrame = await (await realIframeLoc.elementHandle())?.contentFrame();
      let realSwarmTitle = "";
      if (realFrame) {
        await realFrame.waitForSelector('[data-testid="swarm-title"]', { timeout: 15_000 }).catch(() => {});
        await sleep(500);
        realSwarmTitle = ((await realFrame.locator('[data-testid="swarm-title"]').textContent().catch(() => "")) ?? "").trim();
      }
      const titleMatched = EXPECTED_SWARM_SUBSTR
        ? realSwarmTitle.toLowerCase().includes(EXPECTED_SWARM_SUBSTR.toLowerCase())
        : realSwarmTitle.length > 0;
      check(
        "Opening Swarm tab from real workspace auto-selects THIS workspace's own swarm",
        titleMatched,
        `title=${JSON.stringify(realSwarmTitle)}`,
      );
      await page.screenshot({ path: path.join(SHOTS, "10-real-workspace-swarm-tab.png") });

      // Verify Overview 'N of M tasks done' card is expanded by default AND respects manual collapse
      if (realFrame) {
        const overviewTabBtn = realFrame.locator('[data-tab="overview"], button:has-text("Overview")').first();
        if (await overviewTabBtn.isVisible().catch(() => false)) {
          await overviewTabBtn.click();
          await sleep(600);
        }
        const doneToggle = realFrame.locator('button.o2-progh[data-o2="doneOpen"]').first();
        const toggleVisible = await doneToggle
          .waitFor({ state: "visible", timeout: 8_000 })
          .then(() => true)
          .catch(() => false);
        const expandedByDefault = toggleVisible
          ? (await doneToggle.getAttribute("aria-expanded")) === "true" &&
            (await realFrame.locator(".o2-prog .o2-progb").isVisible().catch(() => false))
          : false;
        await page.screenshot({ path: path.join(SHOTS, "11-overview-tasks-expanded-default.png") });
        check(
          "Overview 'N of M tasks done' card is expanded by default without clicking",
          expandedByDefault,
          `toggleVisible=${toggleVisible}`,
        );

        let staysCollapsedAfterClick = false;
        if (toggleVisible && expandedByDefault) {
          await doneToggle.click();
          await sleep(500);
          staysCollapsedAfterClick =
            (await doneToggle.getAttribute("aria-expanded")) === "false";
        }
        check(
          "Manually collapsing 'N of M tasks done' stays collapsed (no auto-reopen fight)",
          staysCollapsedAfterClick,
          `collapsed=${staysCollapsedAfterClick}`,
        );
      }
    }

    check("Zero uncaught page errors during E2E", pageErrors.length === 0, pageErrors.join("; "));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (tempWorkspaceId) {
      try {
        execFileSync("paseo", ["workspace", "archive", tempWorkspaceId], {
          stdio: "ignore",
          timeout: 15_000,
        });
      } catch {
        // ignore cleanup errors
      }
    }
    try {
      fs.rmSync(wsDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (harnessChild) {
      try {
        harnessChild.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed (shots: ${SHOTS})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
