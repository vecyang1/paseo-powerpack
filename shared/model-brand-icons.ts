/**
 * Centralized SSOT for AI model-company / provider brand resolution, official
 * monochrome/brand-tinted SVG marks, and sub-session display policy.
 *
 * Pure module (zero DOM, zero Node APIs) so browser UI modules, Node CLI
 * scripts (`scripts/sidebar-child-sessions-plan.mts`), Settings reconcilers,
 * and unit tests always agree on one truth.
 *
 * Design notes:
 * - Model-company first, provider fallback: if `antigravity` runs
 *   `claude-opus-5-5-high`, the resolved brand is `claude` (Anthropic) while
 *   keeping `viaProvider: "antigravity"` for transparent tooltips.
 * - SVG paths are aligned with Paseo's official built-in provider icons
 *   (monochrome `currentColor` geometry), paired with T3 Code-calibrated
 *   Light/Dark brand accents that meet WCAG >= 3:1 non-text contrast across
 *   all 7 Paseo themes (`shared/paseo-theme.ts`).
 */

export type ModelBrandId =
  | "claude"
  | "openai"
  | "antigravity"
  | "gemini"
  | "cursor"
  | "grok"
  | "copilot"
  | "kimi"
  | "minimax"
  | "zai"
  | "qwen"
  | "mistral"
  | "opencode"
  | "openrouter"
  | "unknown";

export type SubsessionModelIconMode = "always" | "different" | "off";

export const DEFAULT_SUBSESSION_MODEL_ICON_MODE: SubsessionModelIconMode = "always";

export function normalizeSubsessionModelIconMode(
  raw: unknown,
): SubsessionModelIconMode {
  if (raw === "always" || raw === "different" || raw === "off") return raw;
  return DEFAULT_SUBSESSION_MODEL_ICON_MODE;
}

export interface ModelBrandSpec {
  id: ModelBrandId;
  /** Human-readable brand name shown in tooltips and diagnostics. */
  label: string;
  /** Parent company key used for cross-company comparisons. */
  company: string;
  /** Accessible icon color on light Paseo themes (null = theme foreground). */
  colorLight: string | null;
  /** Accessible icon color on dark Paseo themes (null = theme foreground). */
  colorDark: string | null;
  /** ViewBox for inline SVG rendering. */
  viewBox: string;
  /** Safe static inner SVG markup (paths/rects using `currentColor`). */
  svgInner: string;
}

export interface SessionModelIdentityInput {
  provider?: string | null;
  model?: string | null;
}

export interface ResolvedSessionModelBrand {
  brand: ModelBrandId;
  label: string;
  company: string;
  provider: string;
  model: string;
  shortModel: string;
  /** Non-null when model company differs from the hosting harness/provider (e.g. Claude Opus via Antigravity). */
  viaProviderLabel: string | null;
  /** Concise tooltip summary, e.g. `Claude · Opus 5.5` or `Claude · Opus 5.5 (via Antigravity)`. */
  summary: string;
}

export interface BrandComparisonResult {
  child: ResolvedSessionModelBrand;
  parent: ResolvedSessionModelBrand | null;
  /** True when child and parent resolve to different model/company brands (e.g. Claude vs Antigravity). */
  differsBrand: boolean;
  /** True when child and parent belong to different AI companies (e.g. Anthropic vs Google). */
  differsCompany: boolean;
  /** True when child and parent use different base models (even within the same company, e.g. Flash vs Neon). */
  differsModel: boolean;
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  antigravity: "Antigravity",
  agy: "Antigravity",
  claude: "Claude Code",
  "claude-code": "Claude Code",
  "claude-acp": "Claude",
  claudeagent: "Claude Code",
  codex: "Codex",
  "codex-acp": "Codex",
  openai: "OpenAI",
  gemini: "Gemini CLI",
  cursor: "Cursor",
  grok: "Grok",
  copilot: "GitHub Copilot",
  "github-copilot-cli": "GitHub Copilot",
  kimi: "Kimi",
  minimax: "MiniMax",
  "minimax-code": "MiniMax",
  zai: "Z.ai",
  "glm-acp-agent": "Z.ai",
  "qwen-code": "Qwen Code",
  qwen: "Qwen",
  "mistral-vibe": "Mistral",
  mistral: "Mistral",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
};

export const MODEL_BRAND_CATALOG: Record<ModelBrandId, ModelBrandSpec> = {
  claude: {
    id: "claude",
    label: "Claude",
    company: "anthropic",
    colorLight: "#c6613f",
    colorDark: "#e08262",
    viewBox: "0 0 24 24",
    svgInner:
      '<path fill="currentColor" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/>',
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    company: "openai",
    colorLight: null,
    colorDark: null,
    viewBox: "0 0 24 24",
    svgInner:
      '<path fill="currentColor" fill-rule="evenodd" d="M21.55 10.004a5.416 5.416 0 00-.478-4.501c-1.217-2.09-3.662-3.166-6.05-2.66A5.59 5.59 0 0010.831 1C8.39.995 6.224 2.546 5.473 4.838A5.553 5.553 0 001.76 7.496a5.487 5.487 0 00.691 6.5 5.416 5.416 0 00.477 4.502c1.217 2.09 3.662 3.165 6.05 2.66A5.586 5.586 0 0013.168 23c2.443.006 4.61-1.546 5.361-3.84a5.553 5.553 0 003.715-2.66 5.488 5.488 0 00-.693-6.497v.001zm-8.381 11.558a4.199 4.199 0 01-2.675-.954c.034-.018.093-.05.132-.074l4.44-2.53a.71.71 0 00.364-.623v-6.176l1.877 1.069c.02.01.033.029.036.05v5.115c-.003 2.274-1.87 4.118-4.174 4.123zM4.192 17.78a4.059 4.059 0 01-.498-2.763c.032.02.09.055.131.078l4.44 2.53c.225.13.504.13.73 0l5.42-3.088v2.138a.068.068 0 01-.027.057L9.9 19.288c-1.999 1.136-4.552.46-5.707-1.51h-.001zM3.023 8.216A4.15 4.15 0 015.198 6.41l-.002.151v5.06a.711.711 0 00.364.624l5.42 3.087-1.876 1.07a.067.067 0 01-.063.005l-4.489-2.559c-1.995-1.14-2.679-3.658-1.53-5.63h.001zm15.417 3.54l-5.42-3.088L14.896 7.6a.067.067 0 01.063-.006l4.489 2.557c1.998 1.14 2.683 3.662 1.529 5.633a4.163 4.163 0 01-2.174 1.807V12.38a.71.71 0 00-.363-.623zm1.867-2.773a6.04 6.04 0 00-.132-.078l-4.44-2.53a.731.731 0 00-.729 0l-5.42 3.088V7.325a.068.068 0 01.027-.057L14.1 4.713c2-1.137 4.555-.46 5.707 1.513.487.833.664 1.809.499 2.757h.001zm-11.741 3.81l-1.877-1.068a.065.065 0 01-.036-.051V6.559c.001-2.277 1.873-4.122 4.181-4.12.976 0 1.92.338 2.671.954-.034.018-.092.05-.131.073l-4.44 2.53a.71.71 0 00-.365.623l-.003 6.173v.002zm1.02-2.168L12 9.25l2.414 1.375v2.75L12 14.75l-2.415-1.375v-2.75z"/>',
  },
  antigravity: {
    id: "antigravity",
    label: "Antigravity",
    company: "google",
    colorLight: "#4870a6",
    colorDark: "#7ca6dc",
    viewBox: "0 0 24 24",
    svgInner:
      '<path fill="currentColor" transform="translate(12 12) scale(0.24) translate(-55.738 -56.945)" d="M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z"/>',
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    company: "google",
    colorLight: "#3b6fd8",
    colorDark: "#7ba8ff",
    viewBox: "0 0 24 24",
    svgInner:
      '<path fill="currentColor" d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/>',
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    company: "cursor",
    colorLight: null,
    colorDark: null,
    viewBox: "0 0 466.73 532.09",
    svgInner:
      '<path fill="currentColor" d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"/>',
  },
  grok: {
    id: "grok",
    label: "Grok",
    company: "xai",
    colorLight: null,
    colorDark: null,
    viewBox: "0 0 1024 1024",
    svgInner:
      '<path fill="currentColor" d="M395.479 633.828L735.91 381.105C752.599 368.715 776.454 373.548 784.406 392.792C826.26 494.285 807.561 616.253 724.288 699.996C641.016 783.739 525.151 802.104 419.247 760.277L303.556 814.143C469.49 928.202 670.987 899.995 796.901 773.282C896.776 672.843 927.708 535.937 898.785 412.476L899.047 412.739C857.105 231.37 909.358 158.874 1016.4 10.6326C1018.93 7.11771 1021.47 3.60279 1024 0L883.144 141.651V141.212L395.392 633.916"/><path fill="currentColor" d="M325.226 695.251C206.128 580.84 226.662 403.776 328.285 301.668C403.431 226.097 526.549 195.254 634.026 240.596L749.454 186.994C728.657 171.88 702.007 155.623 671.424 144.2C533.19 86.9942 367.693 115.465 255.323 228.382C147.234 337.081 113.244 504.215 171.613 646.833C215.216 753.423 143.739 828.818 71.7385 904.916C46.2237 931.893 20.6216 958.87 0 987.429L325.139 695.339"/>',
  },
  copilot: {
    id: "copilot",
    label: "Copilot",
    company: "github",
    colorLight: "#654ec4",
    colorDark: "#a697f5",
    viewBox: "0 0 16 16",
    svgInner:
      '<path fill-rule="evenodd" clip-rule="evenodd" d="M7.99816 14.2779C12.0678 14.2779 14.9997 11.6274 14.9997 10.9574V9.3189C14.939 8.77306 14.4165 7.82349 13.6074 7.48636C13.5959 7.42498 13.5859 7.36153 13.5756 7.29542C13.5506 7.13548 13.5231 6.95977 13.4649 6.75954C13.6409 6.31508 13.6873 5.81187 13.6873 5.31135C13.6873 4.54947 13.5757 3.76321 13.0811 3.13712C12.5745 2.4959 11.7737 2.15372 10.6972 2.03411C9.64215 1.91688 8.71828 2.06409 8.12157 2.70342C8.07827 2.74981 8.0345 2.79812 7.99655 2.84746C7.95861 2.79812 7.91805 2.74981 7.87475 2.70342C7.27804 2.06409 6.35416 1.91688 5.29908 2.03411C4.22263 2.15372 3.42181 2.4959 2.91521 3.13712C2.42057 3.76321 2.30905 4.54947 2.30905 5.31135C2.30905 5.81187 2.35539 6.31508 2.53142 6.75954C2.47323 6.95977 2.44574 7.13542 2.42072 7.29536C2.41037 7.3615 2.40044 7.42496 2.38893 7.48636C1.57983 7.82349 1.05728 8.77306 0.996582 9.3189V10.9574C0.996582 11.6274 3.92849 14.2779 7.99816 14.2779ZM10.5523 3.33859C9.63863 3.23707 9.25001 3.41798 9.0811 3.59896C8.90273 3.79007 8.76738 4.19254 8.86971 5.0112C8.94909 5.64627 9.13423 6.08757 9.41018 6.36929C9.67188 6.63645 10.0966 6.8426 10.8435 6.8426C11.6506 6.8426 11.9631 6.66867 12.1051 6.51046C12.2619 6.33577 12.3748 6.00462 12.3748 5.31135C12.3748 4.64141 12.2675 4.22455 12.0513 3.95077C11.8469 3.69214 11.4446 3.43773 10.5523 3.33859ZM6.91639 3.59896C6.74748 3.41798 6.35886 3.23707 5.44518 3.33859C4.55289 3.43773 4.15058 3.69214 3.94624 3.95077C3.72994 4.22455 3.62271 4.64141 3.62271 5.31135C3.62271 6.00462 3.73563 6.33577 3.89239 6.51046C4.03436 6.66867 4.34693 6.8426 5.15396 6.8426C5.90092 6.8426 6.32561 6.63645 6.58731 6.36929C6.86326 6.08757 7.0484 5.64627 7.12778 5.0112C7.23011 4.19254 7.09476 3.79007 6.91639 3.59896ZM7.99818 12.9788C9.99307 12.9788 12.0088 12.0076 12.3748 11.7248V8.00133L12.3546 7.90026C11.9257 8.08369 11.4142 8.1551 10.8435 8.1551C9.84049 8.1551 9.04148 7.86851 8.47257 7.28773C8.28092 7.09208 8.12536 6.87308 7.99978 6.6378C7.8742 6.87308 7.71544 7.09208 7.52378 7.28773C6.95488 7.86851 6.15587 8.1551 5.15283 8.1551C4.58212 8.1551 4.07068 8.08369 3.6418 7.90026L3.62158 8.00133V11.7248C3.98755 12.0076 6.00329 12.9788 7.99818 12.9788Z" fill="currentColor"/><path d="M6.46854 9.0301C6.83097 9.0301 7.12479 9.32391 7.12479 9.68635V10.9988C7.12479 11.3613 6.83097 11.6551 6.46854 11.6551C6.1061 11.6551 5.81229 11.3613 5.81229 10.9988V9.68635C5.81229 9.32391 6.1061 9.0301 6.46854 9.0301Z" fill="currentColor"/><path d="M10.1873 9.68635C10.1873 9.32391 9.89347 9.0301 9.53104 9.0301C9.1686 9.0301 8.87479 9.32391 8.87479 9.68635V10.9988C8.87479 11.3613 9.1686 11.6551 9.53104 11.6551C9.89347 11.6551 10.1873 11.3613 10.1873 10.9988V9.68635Z" fill="currentColor"/>',
  },
  kimi: {
    id: "kimi",
    label: "Kimi",
    company: "moonshot",
    colorLight: "#2a6cc8",
    colorDark: "#6fa8f5",
    viewBox: "0 0 24 24",
    svgInner:
      '<path fill="currentColor" d="M19.514 7.342C19.711 7.862 19.814 8.413 19.816 8.969C19.816 12.494 15.998 14.697 12.946 12.934C11.529 12.116 10.657 10.605 10.657 8.969C10.657 5.646 14.085 3.431 17.115 4.793C15.26 3.373 12.99 2.607 10.655 2.612C4.772 2.614 0.005 7.381 0 13.265C0.002 19.148 4.772 23.918 10.655 23.92C16.538 23.916 21.306 19.147 21.31 13.265C21.312 11.155 20.687 9.095 19.514 7.342ZM14.841 4.666C14.841 8.191 18.657 10.395 21.709 8.632C23.127 7.814 24 6.302 24 4.666C24 1.14 20.184-1.061 17.13 0.699C15.714 1.519 14.841 3.03 14.841 4.666"/>',
  },
  minimax: {
    id: "minimax",
    label: "MiniMax",
    company: "minimax",
    colorLight: "#c44d56",
    colorDark: "#e88289",
    viewBox: "0 0 24 24",
    svgInner:
      '<path fill="currentColor" d="M16.278 2c1.156 0 2.093.927 2.093 2.07v12.501a.74.74 0 00.744.709.74.74 0 00.743-.709V9.099a2.06 2.06 0 012.071-2.049A2.06 2.06 0 0124 9.1v6.561a.649.649 0 01-.652.645.649.649 0 01-.653-.645V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v7.472a2.037 2.037 0 01-2.048 2.026 2.037 2.037 0 01-2.048-2.026v-12.5a.785.785 0 00-.788-.753.785.785 0 00-.789.752l-.001 15.904A2.037 2.037 0 0113.441 22a2.037 2.037 0 01-2.048-2.026V18.04c0-.356.292-.645.652-.645.36 0 .652.289.652.645v1.934c0 .263.142.506.372.638.23.131.514.131.744 0a.734.734 0 00.372-.638V4.07c0-1.143.937-2.07 2.093-2.07zm-5.674 0c1.156 0 2.093.927 2.093 2.07v11.523a.648.648 0 01-.652.645.648.648 0 01-.652-.645V4.07a.785.785 0 00-.789-.78.785.785 0 00-.789.78v14.013a2.06 2.06 0 01-2.07 2.048 2.06 2.06 0 01-2.071-2.048V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v3.8a2.06 2.06 0 01-2.071 2.049A2.06 2.06 0 010 12.9v-1.378c0-.357.292-.646.652-.646.36 0 .653.29.653.646V12.9c0 .418.343.757.766.757s.766-.339.766-.757V9.099a2.06 2.06 0 012.07-2.048 2.06 2.06 0 012.071 2.048v8.984c0 .419.343.758.767.758.423 0 .766-.339.766-.758V4.07c0-1.143.937-2.07 2.093-2.07z"/>',
  },
  zai: {
    id: "zai",
    label: "Z.ai",
    company: "zhipu",
    colorLight: "#3368c6",
    colorDark: "#78a4f0",
    viewBox: "0 0 16 16",
    svgInner:
      '<path fill="currentColor" fill-rule="evenodd" d="M8.07 1.333L6.618 3.302H.435L1.887 1.333h6.184zM15.503 12.699L14.052 14.667h-6.161l1.449-1.968h6.163zM16 1.333L6.176 14.667H0L9.824 1.333H16z"/>',
  },
  qwen: {
    id: "qwen",
    label: "Qwen",
    company: "alibaba",
    colorLight: "#5c4ec9",
    colorDark: "#9c90f2",
    viewBox: "0 0 24 24",
    svgInner:
      '<path fill="currentColor" d="M12 2L20.66 7v10L12 22l-8.66-5V7L12 2zm0 3.2L6.2 8.55v6.9L12 18.8l5.8-3.35v-6.9L12 5.2zm0 3.05a3.75 3.75 0 110 7.5 3.75 3.75 0 010-7.5z"/>',
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    company: "mistral",
    colorLight: "#c7632a",
    colorDark: "#eb8c54",
    viewBox: "0 0 24 24",
    svgInner:
      '<path fill="currentColor" d="M3 4h4v4H3V4zm14 0h4v4h-4V4zM3 8h8v4H3V8zm10 0h8v4h-8V8zM3 12h18v4H3v-4zm0 4h4v4H3v-4zm7 0h4v4h-4v-4zm7 0h4v4h-4v-4z"/>',
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    company: "opencode",
    colorLight: null,
    colorDark: null,
    viewBox: "96 64 288 384",
    svgInner:
      '<path fill="currentColor" d="M320 224V352H192V224H320Z" opacity="0.4"/><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"/>',
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    company: "openrouter",
    colorLight: null,
    colorDark: null,
    viewBox: "0 0 24 24",
    svgInner:
      '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 12h4c4 0 5-6 9-6h3M7 12c4 0 5 6 9 6h3M17 3l3 3-3 3M17 15l3 3-3 3"/>',
  },
  unknown: {
    id: "unknown",
    label: "Model",
    company: "unknown",
    colorLight: null,
    colorDark: null,
    viewBox: "0 0 24 24",
    svgInner:
      '<circle cx="12" cy="12" r="5" fill="currentColor"/>',
  },
};

function cleanToken(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeProviderKey(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (!lower) return "";
  if (lower.includes("/")) {
    return lower.split("/")[0]?.trim() ?? lower;
  }
  return lower;
}

function resolveBrandFromModelString(
  modelRaw: string,
  providerKey: string,
): ModelBrandId | null {
  const m = modelRaw.trim().toLowerCase();
  if (!m || m === "default" || m === "auto" || m === "inherit") return null;

  // Strip provider prefix when models come in forms like `anthropic/claude-opus-5-5`
  const tail = m.includes("/") ? (m.split("/").pop() ?? m) : m;

  if (
    /(^|[-_/])(claude|opus|sonnet|haiku|fable)($|[-_./0-9])/.test(m) ||
    m.startsWith("anthropic/")
  ) {
    return "claude";
  }
  if (
    /(^|[-_/])(gpt|chatgpt|codex)($|[-_./0-9])/.test(m) ||
    /^o[134]($|[-_.])/.test(tail) ||
    m.startsWith("openai/")
  ) {
    return "openai";
  }
  if (/(^|[-_/])grok($|[-_./0-9])/.test(m) || m.startsWith("xai/") || m.startsWith("x-ai/")) {
    return "grok";
  }
  if (/(^|[-_/])(kimi|moonshot)($|[-_./0-9])/.test(m)) {
    return "kimi";
  }
  if (/(^|[-_/])minimax($|[-_./0-9])/.test(m)) {
    return "minimax";
  }
  if (/(^|[-_/])(glm|zhipu|zai)($|[-_./0-9])/.test(m)) {
    return "zai";
  }
  if (/(^|[-_/])qwen($|[-_./0-9])/.test(m)) {
    return "qwen";
  }
  if (/(^|[-_/])(mistral|devstral|codestral|magistral)($|[-_./0-9])/.test(m)) {
    return "mistral";
  }
  if (/(^|[-_/])gemini($|[-_./0-9])/.test(m) || m.startsWith("google/")) {
    return providerKey === "antigravity" || providerKey === "agy"
      ? "antigravity"
      : "gemini";
  }
  return null;
}

function resolveBrandFromProviderKey(providerKey: string): ModelBrandId {
  if (!providerKey) return "unknown";
  if (
    providerKey === "claude" ||
    providerKey === "claude-code" ||
    providerKey === "claude-acp" ||
    providerKey === "claudeagent" ||
    providerKey === "anthropic"
  ) {
    return "claude";
  }
  if (
    providerKey === "codex" ||
    providerKey === "codex-acp" ||
    providerKey === "openai"
  ) {
    return "openai";
  }
  if (providerKey === "antigravity" || providerKey === "agy") {
    return "antigravity";
  }
  if (providerKey === "gemini" || providerKey === "google") {
    return "gemini";
  }
  if (providerKey === "cursor") {
    return "cursor";
  }
  if (providerKey === "grok" || providerKey === "xai") {
    return "grok";
  }
  if (providerKey === "copilot" || providerKey === "github-copilot-cli") {
    return "copilot";
  }
  if (providerKey === "kimi" || providerKey === "moonshot") {
    return "kimi";
  }
  if (providerKey === "minimax" || providerKey === "minimax-code") {
    return "minimax";
  }
  if (providerKey === "zai" || providerKey === "glm-acp-agent") {
    return "zai";
  }
  if (providerKey === "qwen" || providerKey === "qwen-code") {
    return "qwen";
  }
  if (providerKey === "mistral" || providerKey === "mistral-vibe") {
    return "mistral";
  }
  if (providerKey === "opencode") {
    return "opencode";
  }
  if (providerKey === "openrouter") {
    return "openrouter";
  }
  return "unknown";
}

/**
 * Strip thinking/effort suffixes (`-high`, `-xhigh`, `-low`, `-medium`, `-thinking`)
 * to compare underlying model bases reliably.
 */
export function normalizeModelBase(modelRaw: string | null | undefined): string {
  const clean = cleanToken(modelRaw).toLowerCase();
  if (!clean || clean === "default" || clean === "auto" || clean === "inherit") return "";
  const tail = clean.includes("/") ? (clean.split("/").pop() ?? clean) : clean;
  return tail.replace(/-(xhigh|high|medium|low|thinking|fast)$/i, "");
}

/**
 * Format raw model slugs into concise human-readable labels for tooltips and diagnostics.
 * Examples:
 * - `claude-opus-5-5-high` -> `Opus 5.5`
 * - `gemini-4-neon-xhigh` -> `Gemini 4 Neon`
 * - `gpt-5.4` -> `GPT-5.4`
 */
export function formatConciseModelName(modelRaw: string | null | undefined): string {
  const clean = cleanToken(modelRaw);
  if (!clean || /^(default|auto|inherit)$/i.test(clean)) return "";
  const tail = clean.includes("/") ? (clean.split("/").pop() ?? clean) : clean;
  const base = tail.replace(/-(xhigh|high|medium|low|thinking)$/i, "");

  // claude-opus-5-5 -> Opus 5.5
  const claudeMatch = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?(?:-(.+))?$/i.exec(base);
  if (claudeMatch) {
    const fam = claudeMatch[1]!.charAt(0).toUpperCase() + claudeMatch[1]!.slice(1).toLowerCase();
    const ver = claudeMatch[3] ? `${claudeMatch[2]}.${claudeMatch[3]}` : claudeMatch[2]!;
    return `${fam} ${ver}`;
  }
  // gemini-pro-orchestrator-neon -> Gemini Pro Orchestrator Neon
  if (/^gemini-/i.test(base)) {
    return base
      .split("-")
      .map((part) => {
        if (/^\d/.test(part)) return part;
        if (part.toLowerCase() === "pro") return "Pro";
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      })
      .join(" ");
  }
  if (/^gpt-/i.test(base)) {
    return `GPT-${base.slice(4)}`;
  }
  return base;
}

export function resolveSessionModelBrand(
  input: SessionModelIdentityInput | null | undefined,
): ResolvedSessionModelBrand {
  let providerRaw = cleanToken(input?.provider);
  let modelRaw = cleanToken(input?.model);

  // Handle combined `provider/model` strings (e.g. `claude/claude-opus-5-5` from CLI output)
  if (providerRaw.includes("/") && !modelRaw) {
    const slashIdx = providerRaw.indexOf("/");
    modelRaw = providerRaw.slice(slashIdx + 1).trim();
    providerRaw = providerRaw.slice(0, slashIdx).trim();
  }

  const providerKey = normalizeProviderKey(providerRaw);
  const fromModel = resolveBrandFromModelString(modelRaw, providerKey);
  const fromProvider = resolveBrandFromProviderKey(providerKey);
  const brand: ModelBrandId = fromModel ?? fromProvider;
  const spec = MODEL_BRAND_CATALOG[brand];

  const shortModel = formatConciseModelName(modelRaw);
  const hostBrand = fromProvider;
  const viaProviderLabel =
    hostBrand !== "unknown" &&
    brand !== "unknown" &&
    hostBrand !== brand &&
    spec.company !== MODEL_BRAND_CATALOG[hostBrand].company
      ? PROVIDER_DISPLAY_NAMES[providerKey] ?? MODEL_BRAND_CATALOG[hostBrand].label
      : null;

  const baseSummary = shortModel
    ? shortModel.toLowerCase().startsWith(spec.label.toLowerCase())
      ? shortModel
      : `${spec.label} · ${shortModel}`
    : spec.label;
  const summary = viaProviderLabel ? `${baseSummary} (via ${viaProviderLabel})` : baseSummary;

  return {
    brand,
    label: spec.label,
    company: spec.company,
    provider: providerKey,
    model: modelRaw,
    shortModel,
    viaProviderLabel,
    summary,
  };
}

export function compareSessionBrands(
  childInput: SessionModelIdentityInput | null | undefined,
  parentInput: SessionModelIdentityInput | null | undefined,
): BrandComparisonResult {
  const child = resolveSessionModelBrand(childInput);
  const hasParentSignal = Boolean(
    cleanToken(parentInput?.provider) || cleanToken(parentInput?.model),
  );
  const parent = hasParentSignal ? resolveSessionModelBrand(parentInput) : null;

  const differsBrand = Boolean(
    parent &&
      child.brand !== "unknown" &&
      parent.brand !== "unknown" &&
      child.brand !== parent.brand,
  );
  const differsCompany = Boolean(
    parent &&
      child.company !== "unknown" &&
      parent.company !== "unknown" &&
      child.company !== parent.company,
  );
  const childBase = normalizeModelBase(child.model);
  const parentBase = normalizeModelBase(parent?.model);
  const differsModel = Boolean(
    differsBrand || (childBase && parentBase && childBase !== parentBase),
  );

  return { child, parent, differsBrand, differsCompany, differsModel };
}

export function shouldShowModelBrandIcon(
  mode: SubsessionModelIconMode,
  comparison: BrandComparisonResult,
): boolean {
  if (mode === "off") return false;
  if (comparison.child.brand === "unknown") return false;
  if (mode === "always") return true;
  // "different": show when model brand/company differs from parent (or parent is unknown)
  if (!comparison.parent || comparison.parent.brand === "unknown") return true;
  return comparison.differsBrand || comparison.differsCompany;
}

/**
 * Resolve accessible brand icon color for light/dark Paseo themes.
 * When `emphasized` is false (same brand as parent in `always` mode), returns
 * `mutedFallback` so cross-company models visually stand out without noise.
 */
export function resolveModelBrandIconColor(
  brand: ModelBrandId,
  options: {
    colorScheme: "light" | "dark";
    foreground: string;
    foregroundMuted: string;
    emphasized: boolean;
  },
): string {
  if (!options.emphasized) {
    return options.foregroundMuted;
  }
  const spec = MODEL_BRAND_CATALOG[brand] ?? MODEL_BRAND_CATALOG.unknown;
  const themed =
    options.colorScheme === "dark" ? spec.colorDark : spec.colorLight;
  return themed ?? options.foreground;
}
