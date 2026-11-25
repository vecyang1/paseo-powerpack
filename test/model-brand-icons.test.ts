import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_BRAND_CATALOG,
  compareSessionBrands,
  formatConciseModelName,
  normalizeModelBase,
  normalizeSubsessionModelIconMode,
  resolveModelBrandIconColor,
  resolveSessionModelBrand,
  shouldShowModelBrandIcon,
} from "../shared/model-brand-icons";
import { PASEO_THEMES } from "../shared/paseo-theme";
import {
  MODEL_BRAND_ICON_TESTID,
  createModelBrandIconElement,
} from "../client/model-brand-icon-web";

test("resolveSessionModelBrand resolves provider and cross-company model-first identity", () => {
  const claudeDirect = resolveSessionModelBrand({
    provider: "claude",
    model: "claude-opus-5-5",
  });
  assert.equal(claudeDirect.brand, "claude");
  assert.equal(claudeDirect.company, "anthropic");
  assert.equal(claudeDirect.shortModel, "Opus 5.5");
  assert.equal(claudeDirect.viaProviderLabel, null);
  assert.equal(claudeDirect.summary, "Claude · Opus 5.5");

  // Opus running via Antigravity harness must resolve to Claude (Anthropic) with transparent via label
  const claudeViaAg = resolveSessionModelBrand({
    provider: "antigravity",
    model: "claude-opus-5-5-high",
  });
  assert.equal(claudeViaAg.brand, "claude");
  assert.equal(claudeViaAg.company, "anthropic");
  assert.equal(claudeViaAg.shortModel, "Opus 5.5");
  assert.equal(claudeViaAg.viaProviderLabel, "Antigravity");
  assert.equal(claudeViaAg.summary, "Claude · Opus 5.5 (via Antigravity)");

  // Native Antigravity Gemini stays Antigravity (Google) matching Paseo tabs
  const agGemini = resolveSessionModelBrand({
    provider: "antigravity",
    model: "gemini-4-neon-xhigh",
  });
  assert.equal(agGemini.brand, "antigravity");
  assert.equal(agGemini.company, "google");
  assert.equal(agGemini.shortModel, "Gemini 4 Neon");
  assert.equal(agGemini.viaProviderLabel, null);

  // Non-Antigravity Gemini resolves to Gemini sparkle
  const geminiCli = resolveSessionModelBrand({
    provider: "gemini",
    model: "gemini-2.5-pro",
  });
  assert.equal(geminiCli.brand, "gemini");
  assert.equal(geminiCli.company, "google");

  // OpenAI / Codex / Grok / Cursor / OpenRouter / Kimi / Z.ai / Qwen / Mistral
  assert.equal(
    resolveSessionModelBrand({ provider: "codex", model: "gpt-5.4" }).brand,
    "openai",
  );
  assert.equal(
    resolveSessionModelBrand({ provider: "openrouter", model: "openai/o3-mini" }).brand,
    "openai",
  );
  assert.equal(
    resolveSessionModelBrand({ provider: "openrouter", model: "openai/o3-mini" }).viaProviderLabel,
    "OpenRouter",
  );
  assert.equal(
    resolveSessionModelBrand({ provider: "grok", model: "grok-4" }).brand,
    "grok",
  );
  assert.equal(
    resolveSessionModelBrand({ provider: "cursor", model: "default" }).brand,
    "cursor",
  );
  assert.equal(
    resolveSessionModelBrand({ provider: "kimi", model: "kimi-k2" }).brand,
    "kimi",
  );
  assert.equal(
    resolveSessionModelBrand({ provider: "zai", model: "glm-4.5" }).brand,
    "zai",
  );
  assert.equal(
    resolveSessionModelBrand({ provider: "qwen-code", model: "qwen3-coder" }).brand,
    "qwen",
  );
  assert.equal(
    resolveSessionModelBrand({ provider: "mistral-vibe", model: "devstral-small" }).brand,
    "mistral",
  );
  // Combined `provider/model` format
  const combined = resolveSessionModelBrand({ provider: "claude/claude-fable-5-2" });
  assert.equal(combined.brand, "claude");
  assert.equal(combined.shortModel, "Fable 5.2");

  // Unknown
  assert.equal(resolveSessionModelBrand({}).brand, "unknown");
});

test("compareSessionBrands and shouldShowModelBrandIcon follow mode rules", () => {
  const cross = compareSessionBrands(
    { provider: "claude", model: "claude-opus-5-5" },
    { provider: "antigravity", model: "gemini-4-neon" },
  );
  assert.equal(cross.differsBrand, true);
  assert.equal(cross.differsCompany, true);
  assert.equal(cross.differsModel, true);
  assert.equal(shouldShowModelBrandIcon("always", cross), true);
  assert.equal(shouldShowModelBrandIcon("different", cross), true);
  assert.equal(shouldShowModelBrandIcon("off", cross), false);

  const agOpusVsAgGemini = compareSessionBrands(
    { provider: "antigravity", model: "claude-opus-5-5-high" },
    { provider: "antigravity", model: "gemini-4-neon" },
  );
  assert.equal(agOpusVsAgGemini.differsBrand, true);
  assert.equal(agOpusVsAgGemini.differsCompany, true);
  assert.equal(shouldShowModelBrandIcon("different", agOpusVsAgGemini), true);

  const sameBrandDiffModel = compareSessionBrands(
    { provider: "antigravity", model: "gemini-3.8-flash-high" },
    { provider: "antigravity", model: "gemini-4-neon" },
  );
  assert.equal(sameBrandDiffModel.differsBrand, false);
  assert.equal(sameBrandDiffModel.differsCompany, false);
  assert.equal(sameBrandDiffModel.differsModel, true);
  assert.equal(shouldShowModelBrandIcon("always", sameBrandDiffModel), true);
  assert.equal(shouldShowModelBrandIcon("different", sameBrandDiffModel), false);

  assert.equal(normalizeModelBase("gemini-4-neon-xhigh"), "gemini-4-neon");
  assert.equal(formatConciseModelName("claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(normalizeSubsessionModelIconMode("bogus"), "always");
});

test("brand catalog SVGs and Light/Dark theme colors are valid and accessible", () => {
  for (const [id, spec] of Object.entries(MODEL_BRAND_CATALOG)) {
    assert.ok(spec.viewBox.split(/\s+/).length === 4, `${id} viewBox`);
    assert.ok(spec.svgInner.includes("currentColor"), `${id} uses currentColor`);
    assert.ok(!/<script/i.test(spec.svgInner), `${id} has no script`);
  }

  const light = PASEO_THEMES.light;
  const dark = PASEO_THEMES.dark;
  const claudeLight = resolveModelBrandIconColor("claude", {
    colorScheme: light.colorScheme,
    foreground: light.foreground,
    foregroundMuted: light.foregroundMuted,
    emphasized: true,
  });
  const claudeDark = resolveModelBrandIconColor("claude", {
    colorScheme: dark.colorScheme,
    foreground: dark.foreground,
    foregroundMuted: dark.foregroundMuted,
    emphasized: true,
  });
  assert.notEqual(claudeLight, claudeDark);
  assert.equal(
    resolveModelBrandIconColor("antigravity", {
      colorScheme: light.colorScheme,
      foreground: light.foreground,
      foregroundMuted: light.foregroundMuted,
      emphasized: false,
    }),
    light.foregroundMuted,
  );
});

test("createModelBrandIconElement creates SVG icon with status pip and respects modes", () => {
  interface FakeNode {
    tagName: string;
    className: string;
    innerHTML: string;
    attrs: Map<string, string>;
    style: Record<string, string>;
    children: FakeNode[];
    setAttribute(k: string, v: string): void;
    getAttribute(k: string): string | null;
    appendChild(child: FakeNode): FakeNode;
  }
  const createEl = (tag: string): FakeNode => {
    const node: FakeNode = {
      tagName: tag.toUpperCase(),
      className: "",
      innerHTML: "",
      attrs: new Map(),
      style: {},
      children: [],
      setAttribute(k, v) {
        this.attrs.set(k, v);
      },
      getAttribute(k) {
        return this.attrs.get(k) ?? null;
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
    };
    return node;
  };
  const fakeDoc = { createElement: createEl } as unknown as Document;

  const cross = compareSessionBrands(
    { provider: "claude", model: "claude-opus-5-5" },
    { provider: "antigravity", model: "gemini-4-neon" },
  );
  const el = createModelBrandIconElement({
    doc: fakeDoc,
    comparison: cross,
    mode: "always",
    theme: PASEO_THEMES.light,
    sizePx: 13,
    statusPip: "running",
  }) as unknown as FakeNode;
  assert.ok(el);
  assert.equal(el.getAttribute("data-testid"), MODEL_BRAND_ICON_TESTID);
  assert.equal(el.getAttribute("data-brand"), "claude");
  assert.equal(el.getAttribute("data-brand-diff"), "true");
  assert.equal(el.getAttribute("data-brand-emphasized"), "true");
  assert.ok(el.innerHTML.includes("<svg"));
  assert.equal(el.children.length, 1);
  assert.equal(el.children[0]!.getAttribute("data-brand-pip"), "running");

  const same = compareSessionBrands(
    { provider: "antigravity", model: "gemini-4-neon" },
    { provider: "antigravity", model: "gemini-4-neon" },
  );
  assert.equal(
    createModelBrandIconElement({
      doc: fakeDoc,
      comparison: same,
      mode: "different",
      theme: PASEO_THEMES.light,
    }),
    null,
  );
  assert.equal(
    createModelBrandIconElement({
      doc: fakeDoc,
      comparison: cross,
      mode: "off",
      theme: PASEO_THEMES.light,
    }),
    null,
  );
});
