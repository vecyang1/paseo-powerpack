/**
 * Read-only check of the native Paseo contract the quota-queue guard depends on (T-153 / D-094),
 * against the real web bundle served by the live :6767 daemon. Sends nothing, edits no queue.
 *
 *   node --experimental-strip-types --no-warnings --import ./test/register-ts.mjs \
 *     scripts/quota-queue-native-contract-probe.mts [--port 6817]
 *
 * Why: the guard reads a send's outcome from `queuedAgentDrainInFlight` + "head back at the
 * queue front", because Paseo 0.16.1's drain returns nothing. The unit fake once returned the
 * send promise and hid exactly that. Run after every Paseo update; exit 0 = contract holds.
 */
import { createRequire } from "node:module";
import { ensureHarness, resolveHarnessSetup, sleep } from "./paseo-harness.mts";

const args = process.argv.slice(2);
const PORT = Number(args.includes("--port") ? args[args.indexOf("--port") + 1] : 6817) || 6817;

async function main(): Promise<number> {
  const setup = resolveHarnessSetup();
  if (!setup) return 3;
  await ensureHarness(PORT);
  const require = createRequire(import.meta.url);
  const { chromium } = require(setup.playwrightCore) as { chromium: any };
  const browser = await chromium.launch({ executablePath: setup.chrome, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid^="sidebar-workspace-row-"]', { timeout: 30_000 });
    await sleep(2500);
    const facts = await page.evaluate(() => {
      const w = window as any;
      let map: Map<number, any> | null = w.__c instanceof Map ? w.__c : null;
      if (!map && typeof w.__r === "function") {
        // Same lookup as quota-queue-guard-e2e.mts: catch Metro's module map on a lookup of id 0.
        const origGet = Map.prototype.get;
        try {
          Map.prototype.get = function (this: Map<unknown, unknown>, k: unknown) {
            if (k === 0 && !map && this.size > 50) map = this as Map<number, any>;
            return origGet.call(this, k);
          };
          try {
            w.__r(0);
          } catch {}
        } finally {
          Map.prototype.get = origGet;
        }
      }
      if (!map) return { error: "no metro module map" };
      let mod: any = null;
      for (const rec of map.values()) {
        const exp = rec?.isInitialized ? rec.publicModule?.exports : null;
        if (exp?.HostRuntimeStore && typeof exp.getHostRuntimeStore === "function") mod = exp;
      }
      if (!mod) return { error: "HostRuntimeStore module not found" };
      const proto = mod.HostRuntimeStore.prototype;
      const patch = proto.__paseoFinderQuotaQueuePatch;
      const orig: unknown = patch?.origDrain ?? proto.drainQueuedAgentMessage;
      const src = typeof orig === "function" ? Function.prototype.toString.call(orig) : "";
      const runtime = mod.getHostRuntimeStore();
      return {
        guardInstalled: Boolean(patch) && proto.drainQueuedAgentMessage !== patch?.origDrain,
        inFlightIsSet: runtime?.queuedAgentDrainInFlight instanceof Set,
        nativeUsesInFlightKey: src.includes("queuedAgentDrainInFlight"),
        nativeReturnsSendPromise: /return\s*\(?\s*\(0,\s*\w+\.sendQueuedComposerMessageNow\)/.test(src),
        srcLength: src.length,
      };
    });
    console.log(JSON.stringify(facts));
    if ("error" in facts) return 2;
    const ok =
      facts.guardInstalled && facts.inFlightIsSet && facts.nativeUsesInFlightKey && facts.srcLength > 0;
    console.log(
      ok
        ? `PASS  native drain contract holds (returns send promise: ${facts.nativeReturnsSendPromise})`
        : "FAIL  native drain contract changed; re-read HostRuntimeStore.drainQueuedAgentMessage in app-dist",
    );
    return ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(2);
});
