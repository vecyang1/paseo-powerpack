/// <reference lib="dom" />
/**
 * Shared DOM renderer for model-company / provider brand icons across Paseo
 * plugin surfaces (sidebar sub-sessions, lineage pills, inline session mentions,
 * and Swarm/subagent rows).
 *
 * Single owner for DOM icon markup + live theme color + status pip geometry so
 * no consumer duplicates SVGs, hardcoded hex colors, or mode checks.
 */
import {
  DEFAULT_SUBSESSION_MODEL_ICON_MODE,
  MODEL_BRAND_CATALOG,
  type BrandComparisonResult,
  type ModelBrandId,
  type SubsessionModelIconMode,
  normalizeSubsessionModelIconMode,
  resolveModelBrandIconColor,
  shouldShowModelBrandIcon,
} from "../shared/model-brand-icons";
import type { PaseoThemeTokens } from "../shared/paseo-theme";

export const MODEL_BRAND_ICON_TESTID = "paseo-finder-model-brand-icon";
export const SIDEBAR_CHILD_SESSIONS_PREFS_KEY = "paseo:finder-plugin:sidebar-child-sessions";
export const SIDEBAR_CHILD_SESSIONS_EVENT_NAME = "paseo-finder:sidebar-child-sessions";

function resolveWebWindow(explicit?: Window | null): Window | null {
  if (explicit === null) return null;
  if (explicit !== undefined) return explicit;
  if (typeof window !== "undefined" && typeof (window as unknown as { document?: unknown }).document !== "undefined") {
    return window;
  }
  return null;
}

/**
 * Read the shared `modelIcons` preference (`always` | `different` | `off`) without
 * importing `sidebar-child-sessions-web.ts` (prevents circular imports).
 */
export function readSubsessionModelIconMode(
  win?: Window | null,
): SubsessionModelIconMode {
  try {
    const w = resolveWebWindow(win);
    const raw = w?.localStorage?.getItem(SIDEBAR_CHILD_SESSIONS_PREFS_KEY);
    if (!raw) return DEFAULT_SUBSESSION_MODEL_ICON_MODE;
    const parsed = JSON.parse(raw) as { modelIcons?: unknown };
    return normalizeSubsessionModelIconMode(parsed?.modelIcons);
  } catch {
    return DEFAULT_SUBSESSION_MODEL_ICON_MODE;
  }
}

export type ModelBrandStatusPip = "none" | "running" | "finished" | "attention" | "error";

export interface CreateModelBrandIconOptions {
  doc: Document;
  comparison: BrandComparisonResult;
  mode: SubsessionModelIconMode;
  theme: Pick<
    PaseoThemeTokens,
    | "colorScheme"
    | "foreground"
    | "foregroundMuted"
    | "surfaceSidebar"
    | "surface1"
    | "statusDotRunning"
    | "statusSuccess"
    | "statusWarning"
    | "statusDanger"
  >;
  /** Icon glyph size in pixels (default 13 for sidebar rows, 12 for pills). */
  sizePx?: number;
  /** Optional status corner pip (running blue / finished green / attention amber / error red). */
  statusPip?: ModelBrandStatusPip;
  /** Surface background color used for the cutout halo around the status pip. */
  pipCutoutBg?: string;
  /** Emphasize brand color even when parent comparison is absent or matching. */
  alwaysEmphasize?: boolean;
}

/**
 * Create a crisp inline SVG brand icon wrapper element, or `null` when the
 * current `mode` / brand resolution says this item should keep its default dot.
 */
export function createModelBrandIconElement(
  opts: CreateModelBrandIconOptions,
): HTMLSpanElement | null {
  if (!shouldShowModelBrandIcon(opts.mode, opts.comparison)) {
    return null;
  }
  const { doc, comparison, theme } = opts;
  const brand: ModelBrandId = comparison.child.brand;
  const spec = MODEL_BRAND_CATALOG[brand];
  if (!spec || brand === "unknown") return null;

  const sizePx = opts.sizePx ?? 13;
  const isDifferent = Boolean(
    comparison.differsBrand || comparison.differsCompany,
  );
  const emphasized =
    Boolean(opts.alwaysEmphasize) ||
    !comparison.parent ||
    comparison.parent.brand === "unknown" ||
    isDifferent;

  const color = resolveModelBrandIconColor(brand, {
    colorScheme: theme.colorScheme,
    foreground: theme.foreground,
    foregroundMuted: theme.foregroundMuted,
    emphasized,
  });

  const wrap = doc.createElement("span");
  wrap.setAttribute("data-testid", MODEL_BRAND_ICON_TESTID);
  wrap.setAttribute("data-brand", brand);
  wrap.setAttribute("data-brand-company", spec.company);
  wrap.setAttribute("data-brand-diff", isDifferent ? "true" : "false");
  wrap.setAttribute("data-brand-emphasized", emphasized ? "true" : "false");
  wrap.setAttribute("aria-hidden", "true");
  wrap.className = "pff-brand-icon";

  Object.assign(wrap.style, {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: `${sizePx + 1}px`,
    height: `${sizePx + 1}px`,
    flexShrink: "0",
    color,
    opacity: emphasized ? "0.96" : "0.72",
    lineHeight: "0",
  });

  // Static trusted SVG path data from `MODEL_BRAND_CATALOG` (never user input).
  wrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="${spec.viewBox}" fill="none" style="display:block;width:${sizePx}px;height:${sizePx}px;overflow:visible;">${spec.svgInner}</svg>`;

  const pip = opts.statusPip ?? "none";
  if (pip !== "none") {
    const pipEl = doc.createElement("span");
    pipEl.setAttribute("data-brand-pip", pip);
    const pipColor =
      pip === "running"
        ? theme.statusDotRunning
        : pip === "finished"
          ? theme.statusSuccess
          : pip === "error"
            ? theme.statusDanger
            : theme.statusWarning;
    const cutout = opts.pipCutoutBg ?? theme.surfaceSidebar;
    Object.assign(pipEl.style, {
      position: "absolute",
      right: "-2px",
      bottom: "-2px",
      width: "5px",
      height: "5px",
      borderRadius: "999px",
      backgroundColor: pipColor,
      boxShadow: `0 0 0 1.5px ${cutout}`,
      pointerEvents: "none",
    });
    wrap.appendChild(pipEl);
  }

  return wrap;
}
