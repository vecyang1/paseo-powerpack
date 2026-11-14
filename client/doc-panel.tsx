import {
  type PluginFilePanelProps,
  useFileUrl,
  useRpc,
  useSettings,
  useTranslation,
  useWorkspace,
} from "@getpaseo/plugin/client";
import {
  DocumentFrame,
  Icon,
  Loading,
  ScrollView,
  TextInput,
  copyText,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Image, Platform, Pressable, Text, View } from "react-native";
import {
  type OpenerTarget,
  openFileTargetRpc,
  pluginSettings,
} from "../shared/contracts";
import {
  type DocCompareLayout,
  type DocInteractionMode,
  type DocPdfRenderMode,
  type DocPreviewPage,
  computeNextZoomStep,
  listSiblingDocumentsRpc,
  previewDocumentRpc,
} from "../shared/doc-preview-contracts";
import {
  bindInteractiveDocViewport,
  mountScopedHtmlPreview,
  openWorkspaceFileTabsInSidePane,
  readDocPreviewPrefs,
  scrollDocViewportToPage,
  subscribeCompareDrop,
} from "./doc-preview-web";
import { isChineseLocale, pluginTranslations } from "./i18n";

type PanelTheme = PluginFilePanelProps["theme"];

interface DocumentSlotProps {
  slotId: string;
  syncGroupId: string;
  workspaceId: string;
  workspaceDir?: string | null;
  filePath: string;
  nativeBlobUrl?: string | null;
  isPrimary: boolean;
  compact: boolean;
  theme: PanelTheme;
  isZh: boolean;
  interactionMode: DocInteractionMode;
  pdfMode: DocPdfRenderMode;
  zoom: number;
  searchQuery: string;
  syncScrollEnabled: boolean;
  onZoomChange: (next: number) => void;
  onRemoveCompare?: () => void;
  onOpenInTab?: () => void;
  onPrimaryMetaChange?: (meta: {
    totalPages: number;
    currentPage: number;
    engine: string;
    sizeFormatted: string;
    kind: string;
    absolutePath: string;
    relativePath: string;
    supportsNativeFrame: boolean;
    hasText: boolean;
    matchingPages: number[];
    scrollToPage: (page: number) => void;
  }) => void;
}

function DocumentViewportSlot({
  slotId,
  syncGroupId,
  workspaceId,
  workspaceDir,
  filePath,
  nativeBlobUrl,
  isPrimary,
  compact,
  theme,
  isZh,
  interactionMode,
  pdfMode,
  zoom,
  searchQuery,
  syncScrollEnabled,
  onZoomChange,
  onRemoveCompare,
  onOpenInTab,
  onPrimaryMetaChange,
}: DocumentSlotProps) {
  const previewDoc = useRpc(previewDocumentRpc);
  const [extraPages, setExtraPages] = useState<DocPreviewPage[]>([]);
  const [loadedEndPage, setLoadedEndPage] = useState<number>(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);
  const [slotWidth, setSlotWidth] = useState<number>(580);
  const loadingMoreRef = useRef(false);

  const scrollTestId = `paseo-doc-scroll-${slotId}`;
  const htmlHostTestId = `paseo-doc-html-${slotId}`;

  const initialQuery = useQuery({
    queryKey: ["finder.previewDocument", workspaceId, workspaceDir, filePath],
    queryFn: () =>
      previewDoc({
        workspaceId,
        workspaceRoot: workspaceDir ?? undefined,
        path: filePath,
        pageStart: 1,
        pageLimit: 8,
        dpi: 144,
      }),
    staleTime: 15000,
  });

  useEffect(() => {
    setExtraPages([]);
    setCurrentPage(1);
    setActiveSheetIdx(0);
    setLoadedEndPage(initialQuery.data?.loadedPageEnd ?? 0);
  }, [filePath, initialQuery.data?.loadedPageEnd]);

  const data = initialQuery.data;
  const allPages = useMemo(() => {
    if (!data?.pages) return [];
    const byNum = new Map<number, DocPreviewPage>();
    for (const p of data.pages) byNum.set(p.pageNumber, p);
    for (const p of extraPages) byNum.set(p.pageNumber, p);
    return [...byNum.values()].sort((a, b) => a.pageNumber - b.pageNumber);
  }, [data?.pages, extraPages]);

  const effectiveLoadedEnd = Math.max(loadedEndPage, data?.loadedPageEnd ?? 0);
  const totalPages = data?.totalPages ?? 0;
  const hasMorePages = Boolean(data?.renderFormat === "pages" && effectiveLoadedEnd < totalPages);

  const loadNextBatch = useCallback(
    async (targetPage?: number) => {
      if (!data || loadingMoreRef.current) return;
      const nextStart = effectiveLoadedEnd + 1;
      if (nextStart > totalPages) return;
      const neededLimit =
        targetPage && targetPage > nextStart ? Math.min(24, targetPage - nextStart + 2) : 8;
      loadingMoreRef.current = true;
      setLoadingMore(true);
      try {
        const more = await previewDoc({
          workspaceId,
          workspaceRoot: workspaceDir ?? undefined,
          path: filePath,
          pageStart: nextStart,
          pageLimit: neededLimit,
          dpi: 144,
        });
        if (more.ok && more.pages.length > 0) {
          setExtraPages((prev) => [...prev, ...more.pages]);
          setLoadedEndPage(more.loadedPageEnd);
        }
      } catch {
        // Ignore transient batch error
      } finally {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    },
    [data, effectiveLoadedEnd, filePath, previewDoc, totalPages, workspaceDir, workspaceId],
  );

  const jumpToPage = useCallback(
    async (page: number) => {
      const clamped = Math.max(1, Math.min(Math.max(1, totalPages), page));
      setCurrentPage(clamped);
      if (clamped > effectiveLoadedEnd && hasMorePages) {
        await loadNextBatch(clamped);
      }
      setTimeout(() => {
        scrollDocViewportToPage(scrollTestId, clamped);
      }, 40);
    },
    [effectiveLoadedEnd, hasMorePages, loadNextBatch, scrollTestId, totalPages],
  );

  const matchingPages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (q.length < 2 || !data) return [];
    const hits: number[] = [];
    if (allPages.length > 0) {
      for (const p of allPages) {
        if (p.text && p.text.toLowerCase().includes(q)) {
          hits.push(p.pageNumber);
        }
      }
    }
    return hits;
  }, [allPages, data, searchQuery]);

  useEffect(() => {
    return bindInteractiveDocViewport({
      scrollTestId,
      interactionMode,
      zoom,
      syncGroupId,
      slotId,
      syncScrollEnabled,
      onZoomChange,
      onViewportWidthChange: (cw) => {
        setSlotWidth((prev) => (Math.abs(prev - cw) > 2 ? cw : prev));
      },
      onVisiblePageChange: (p) => setCurrentPage(p),
      onReachNearBottom: hasMorePages ? () => void loadNextBatch() : undefined,
    });
  }, [
    hasMorePages,
    interactionMode,
    loadNextBatch,
    onZoomChange,
    scrollTestId,
    slotId,
    syncGroupId,
    syncScrollEnabled,
    zoom,
  ]);

  const activeHtml = useMemo(() => {
    if (!data) return "";
    if (data.renderFormat === "sheets" && data.sheets && data.sheets.length > 0) {
      const safeSheet = data.sheets[Math.min(activeSheetIdx, data.sheets.length - 1)];
      return safeSheet?.html ?? data.htmlContent ?? "";
    }
    return data.htmlContent ?? "";
  }, [activeSheetIdx, data]);

  const shouldRenderHtml =
    Boolean(data) &&
    pdfMode !== "text" &&
    (data?.renderFormat === "html" || data?.renderFormat === "sheets") &&
    Boolean(activeHtml);

  useEffect(() => {
    if (!shouldRenderHtml) return;
    return mountScopedHtmlPreview({
      hostTestId: htmlHostTestId,
      html: activeHtml,
      zoom,
      containerWidth: slotWidth,
      searchQuery,
    });
  }, [activeHtml, htmlHostTestId, searchQuery, shouldRenderHtml, slotWidth, zoom]);

  useEffect(() => {
    if (!isPrimary || !data || !onPrimaryMetaChange) return;
    onPrimaryMetaChange({
      totalPages: data.totalPages,
      currentPage,
      engine: data.engine,
      sizeFormatted: data.sizeFormatted,
      kind: data.extension ? data.extension.toUpperCase() : data.kind.toUpperCase(),
      absolutePath: data.absolutePath,
      relativePath: data.relativePath,
      supportsNativeFrame: data.supportsNativeFrame && Boolean(nativeBlobUrl),
      hasText: Boolean(data.plainText && data.plainText.trim().length > 0),
      matchingPages,
      scrollToPage: (p) => void jumpToPage(p),
    });
  }, [currentPage, data, isPrimary, jumpToPage, matchingPages, nativeBlobUrl, onPrimaryMetaChange]);

  const slotStyles = useMemo(
    () => ({
      slotRoot: {
        flex: 1,
        flexBasis: 0,
        minWidth: 160,
        minHeight: 200,
        overflow: "hidden" as const,
        backgroundColor: theme.colors.surface1,
        borderLeftWidth: isPrimary ? 0 : 1,
        borderLeftColor: theme.colors.border,
      },
      compareHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        paddingHorizontal: 10,
        paddingVertical: 6,
        backgroundColor: theme.colors.surface0,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        gap: 8,
      },
      compareTitle: {
        flex: 1,
        color: theme.colors.foreground,
        fontSize: 12,
        fontWeight: "600" as const,
      },
      compareMeta: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        flexShrink: 1,
      },
      miniBtn: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        paddingHorizontal: 7,
        paddingVertical: 4,
        borderRadius: 5,
        backgroundColor: theme.colors.surface2,
      },
      miniBtnText: {
        color: theme.colors.foreground,
        fontSize: 11,
      },
      sheetTabsBar: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 6,
        backgroundColor: theme.colors.surface0,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      sheetChip: {
        paddingHorizontal: 9,
        paddingVertical: 4,
        borderRadius: 5,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      sheetChipActive: {
        paddingHorizontal: 9,
        paddingVertical: 4,
        borderRadius: 5,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.accent,
      },
      scrollArea: {
        flex: 1,
        backgroundColor: theme.colors.surface1,
      },
      pagesContent: {
        flexGrow: 1,
        alignItems: (zoom > 1.02 ? "flex-start" : "center") as "flex-start" | "center",
        paddingVertical: compact ? 10 : 14,
        paddingHorizontal: compact ? 8 : 14,
        gap: 14,
      },
      pageCard: {
        backgroundColor: "#ffffff",
        borderRadius: 4,
        borderWidth: 1,
        borderColor: theme.colors.border,
        overflow: "hidden" as const,
      },
      pageBadge: {
        alignSelf: "center" as const,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 4,
        backgroundColor: theme.colors.surface2,
      },
      pageBadgeText: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
      },
      textSurface: {
        width: "100%" as const,
        maxWidth: 860,
        backgroundColor: theme.colors.surface0,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        padding: compact ? 14 : 24,
      },
      plainTextContent: {
        color: theme.colors.foreground,
        fontSize: Math.round(13 * zoom),
        lineHeight: Math.round(20 * zoom),
      },
      centerMsg: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        padding: 24,
        gap: 10,
      },
      errorText: {
        color: theme.colors.statusDanger,
        fontSize: 13,
        textAlign: "center" as const,
      },
    }),
    [compact, isPrimary, theme, zoom],
  );

  if (initialQuery.isLoading) {
    return (
      <View style={slotStyles.slotRoot}>
        <Loading />
      </View>
    );
  }

  if (initialQuery.isError || !data || !data.ok) {
    const errMsg =
      initialQuery.error instanceof Error
        ? initialQuery.error.message
        : data?.errorMessage ?? (isZh ? "文档预览加载失败" : "Document preview failed");
    return (
      <View style={slotStyles.slotRoot}>
        {!isPrimary ? (
          <View style={slotStyles.compareHeader}>
            <Text style={slotStyles.compareTitle} numberOfLines={1}>
              {filePath.split("/").pop() ?? filePath}
            </Text>
            {onRemoveCompare ? (
              <Pressable accessibilityRole="button" onPress={onRemoveCompare} style={slotStyles.miniBtn}>
                <Icon name="X" size={12} color={theme.colors.foreground} />
              </Pressable>
            ) : null}
          </View>
        ) : null}
        <View style={slotStyles.centerMsg}>
          <Text style={slotStyles.errorText}>{errMsg}</Text>
        </View>
      </View>
    );
  }

  const useNativePdfFrame =
    data.extension === "pdf" &&
    Boolean(nativeBlobUrl) &&
    (pdfMode === "native" || data.renderFormat === "native-only");

  const usePlainTextView =
    pdfMode === "text" ||
    (data.renderFormat === "text" && Boolean(data.plainText));

  return (
    <View
      style={slotStyles.slotRoot}
      testID={`paseo-doc-slot-${slotId}`}
      onLayout={(ev) => {
        const w = Math.round(ev.nativeEvent.layout.width);
        if (w > 80 && Math.abs(w - slotWidth) > 4) {
          setSlotWidth(w);
        }
      }}
    >
      {!isPrimary ? (
        <View style={slotStyles.compareHeader}>
          <Text style={slotStyles.compareTitle} numberOfLines={1}>
            {data.fileName}
          </Text>
          <Text style={slotStyles.compareMeta} numberOfLines={1} ellipsizeMode="tail">
            {data.extension.toUpperCase()} · {data.totalPages}p · {data.sizeFormatted}
          </Text>
          {onOpenInTab ? (
            <Pressable accessibilityRole="button" onPress={onOpenInTab} style={slotStyles.miniBtn}>
              <Icon name="ExternalLink" size={11} color={theme.colors.foreground} />
              <Text style={slotStyles.miniBtnText}>{isZh ? "标签页" : "Tab"}</Text>
            </Pressable>
          ) : null}
          {onRemoveCompare ? (
            <Pressable accessibilityRole="button" onPress={onRemoveCompare} style={slotStyles.miniBtn}>
              <Icon name="X" size={12} color={theme.colors.foreground} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {data.renderFormat === "sheets" && data.sheets && data.sheets.length > 1 && !usePlainTextView ? (
        <View style={slotStyles.sheetTabsBar}>
          {data.sheets.map((sheet, idx) => (
            <Pressable
              key={`${sheet.name}-${idx}`}
              accessibilityRole="button"
              onPress={() => setActiveSheetIdx(idx)}
              style={idx === activeSheetIdx ? slotStyles.sheetChipActive : slotStyles.sheetChip}
            >
              <Text style={slotStyles.miniBtnText}>
                {sheet.name} ({sheet.rowCount})
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {useNativePdfFrame && nativeBlobUrl ? (
        <DocumentFrame url={nativeBlobUrl} testID={`paseo-doc-native-frame-${slotId}`} />
      ) : (
        <ScrollView
          testID={scrollTestId}
          style={slotStyles.scrollArea}
          contentContainerStyle={slotStyles.pagesContent}
        >
          {usePlainTextView ? (
            <View style={slotStyles.textSurface}>
              <Text selectable style={slotStyles.plainTextContent}>
                {data.plainText || (isZh ? "未提取到可检索文本" : "No extractable text found.")}
              </Text>
            </View>
          ) : shouldRenderHtml ? (
            Platform.OS === "web" ? (
              <View
                testID={htmlHostTestId}
                style={{ width: "100%", minHeight: 420 }}
              />
            ) : (
              <View style={slotStyles.textSurface}>
                <Text selectable style={slotStyles.plainTextContent}>
                  {data.plainText || data.fileName}
                </Text>
              </View>
            )
          ) : (
            <>
              {allPages.map((page) => {
                const padX = compact ? 16 : 28;
                const availWidth = Math.max(180, slotWidth - padX);
                const naturalCap = page.widthPx > 0 ? Math.round(page.widthPx * 0.72) : 840;
                const baseWidth = Math.min(availWidth, naturalCap);
                const aspect =
                  page.widthPx > 0 && page.heightPx > 0 ? page.heightPx / page.widthPx : 1.414;
                const displayW = Math.round(baseWidth * zoom);
                const displayH = Math.round(displayW * aspect);
                const isSearchHit = matchingPages.includes(page.pageNumber);

                return (
                  <View
                    key={page.pageNumber}
                    testID={`paseo-doc-page-${slotId}-${page.pageNumber}`}
                    {...(Platform.OS === "web" ? ({ "data-doc-page": String(page.pageNumber) } as object) : {})}
                    style={{ alignItems: "center", gap: 6 }}
                  >
                    <View
                      style={[
                        slotStyles.pageCard,
                        { width: displayW, height: displayH },
                        isSearchHit ? { borderColor: theme.colors.accent, borderWidth: 2 } : null,
                      ]}
                    >
                      {page.imageDataUrl ? (
                        <Image
                          source={{ uri: page.imageDataUrl }}
                          resizeMode="contain"
                          style={{ width: displayW, height: displayH }}
                          accessibilityLabel={`${data.fileName} page ${page.pageNumber}`}
                        />
                      ) : null}
                    </View>
                    {totalPages > 1 ? (
                      <View style={slotStyles.pageBadge}>
                        <Text style={slotStyles.pageBadgeText}>
                          {page.pageNumber} / {totalPages}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                );
              })}

              {hasMorePages ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void loadNextBatch()}
                  disabled={loadingMore}
                  style={slotStyles.miniBtn}
                >
                  <Text style={slotStyles.miniBtnText}>
                    {loadingMore
                      ? isZh
                        ? "正在加载后续页面..."
                        : "Loading pages..."
                      : isZh
                        ? `加载更多页面 (${effectiveLoadedEnd}/${totalPages})`
                        : `Load more pages (${effectiveLoadedEnd}/${totalPages})`}
                  </Text>
                </Pressable>
              ) : null}
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

export function DocumentInspectorFilePanel({
  file,
  params,
  workspaceId,
  theme,
  layout,
}: PluginFilePanelProps) {
  const { t, locale } = useTranslation(pluginTranslations);
  const isZh = isChineseLocale(locale);
  const urlState = useFileUrl(file);
  const toast = useToast();
  const openTarget = useRpc(openFileTargetRpc);
  const listSiblings = useRpc(listSiblingDocumentsRpc);
  const settingsState = useSettings(pluginSettings);
  const workspaceDir = useWorkspace(workspaceId, (w) => w.directory);
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  const initialPrefs = useMemo(() => readDocPreviewPrefs(), []);
  const [interactionMode, setInteractionMode] = useState<DocInteractionMode>(
    initialPrefs.defaultInteractionMode,
  );
  const [pdfMode, setPdfMode] = useState<DocPdfRenderMode>(initialPrefs.defaultPdfMode);
  const [zoom, setZoom] = useState<number>(1);
  const [comparePaths, setComparePaths] = useState<string[]>([]);
  const [compareLayout, setCompareLayout] = useState<DocCompareLayout>(
    initialPrefs.defaultCompareLayout === "stack" ? "stack" : "split",
  );
  const [syncScrollEnabled, setSyncScrollEnabled] = useState<boolean>(
    initialPrefs.enableSyncScrollInCompare,
  );
  const [showCompareTray, setShowCompareTray] = useState(false);
  const [showSearchBar, setShowSearchBar] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [lastReceipt, setLastReceipt] = useState<string | null>(null);

  const [primaryMeta, setPrimaryMeta] = useState<{
    totalPages: number;
    currentPage: number;
    engine: string;
    sizeFormatted: string;
    kind: string;
    absolutePath: string;
    relativePath: string;
    supportsNativeFrame: boolean;
    hasText: boolean;
    matchingPages: number[];
    scrollToPage: (page: number) => void;
  } | null>(null);

  const preferredEditor =
    settingsState.status === "ready" ? settingsState.values.preferredCodeEditor : "antigravity";

  useEffect(() => {
    return subscribeCompareDrop(workspaceId, (droppedPaths) => {
      setComparePaths((prev) => {
        const next = [...prev];
        for (const p of droppedPaths) {
          if (p !== params.path && p !== primaryMeta?.absolutePath && !next.includes(p) && next.length < 3) {
            next.push(p);
          }
        }
        return next;
      });
    });
  }, [params.path, primaryMeta?.absolutePath, workspaceId]);

  const siblingsQuery = useQuery({
    queryKey: ["finder.siblingDocs", workspaceId, workspaceDir, params.path],
    queryFn: () =>
      listSiblings({
        workspaceId,
        workspaceRoot: workspaceDir ?? undefined,
        currentPath: params.path,
        limit: 20,
      }),
    enabled: showCompareTray,
    staleTime: 8000,
  });

  const openMutation = useMutation({
    mutationFn: (target: OpenerTarget) =>
      openTarget({
        workspaceId,
        workspaceRoot: workspaceDir ?? undefined,
        path: params.path,
        target,
      }),
    onSuccess: (res) => {
      if (res.ok) {
        setLastReceipt(`${res.message} (${res.durationMs}ms)`);
        toast.show(res.message, { variant: "success" });
      } else {
        toast.error(res.message);
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });

  const styles = useMemo(
    () => ({
      root: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
      },
      toolbar: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        paddingHorizontal: layout.compact ? 10 : 12,
        paddingVertical: 7,
        gap: 6,
        backgroundColor: theme.colors.surface0,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      group: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 5,
      },
      segmented: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        backgroundColor: theme.colors.surface1,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        padding: 2,
        gap: 2,
      },
      segItem: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
      },
      segItemActive: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        backgroundColor: theme.colors.surface2,
      },
      btn: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderRadius: 6,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      btnActive: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.accent,
      },
      btnText: {
        color: theme.colors.foreground,
        fontSize: 12,
      },
      mutedText: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
      },
      subBar: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        paddingHorizontal: layout.compact ? 10 : 12,
        paddingVertical: 6,
        gap: 8,
        backgroundColor: theme.colors.surface1,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      trayCard: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 6,
        backgroundColor: theme.colors.surface1,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      siblingRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 6,
      },
      canvasRow: {
        flex: 1,
        flexDirection: (comparePaths.length > 0 && compareLayout === "split"
          ? "row"
          : "column") as "row" | "column",
      },
    }),
    [compareLayout, comparePaths.length, layout.compact, theme],
  );

  const isPdf = file.extension.toLowerCase() === "pdf";
  const nativeBlobUrl = urlState.status === "ready" ? urlState.url : null;

  async function handleCopyPath() {
    const targetPath = primaryMeta?.absolutePath ?? params.path;
    try {
      await copyText(targetPath);
      const msg = t("actions.copiedFilePath");
      setLastReceipt(msg);
      toast.show(msg, { variant: "success" });
    } catch {
      toast.error(t("actions.copyFailed"));
    }
  }

  function toggleComparePath(candidatePath: string) {
    setComparePaths((prev) => {
      if (prev.includes(candidatePath)) {
        return prev.filter((p) => p !== candidatePath);
      }
      if (prev.length >= 3) {
        return [...prev.slice(1), candidatePath];
      }
      return [...prev, candidatePath];
    });
  }

  return (
    <View
      style={styles.root}
      testID="paseo-doc-inspector-root"
      {...(Platform.OS === "web" ? ({ "data-workspace-id": workspaceId } as object) : {})}
    >
      <View style={styles.toolbar}>
        <View style={styles.group}>
          {/* Pan / Drag vs Select Mode */}
          <View style={styles.segmented}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isZh ? "拖拽平移模式" : "Drag to pan"}
              testID="paseo-doc-mode-pan"
              onPress={() => setInteractionMode("pan")}
              style={interactionMode === "pan" ? styles.segItemActive : styles.segItem}
            >
              <Icon name="Hand" size={13} color={theme.colors.foreground} />
              <Text style={styles.btnText}>{isZh ? "拖拽" : "Drag"}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isZh ? "文本选择模式" : "Select text"}
              testID="paseo-doc-mode-select"
              onPress={() => setInteractionMode("select")}
              style={interactionMode === "select" ? styles.segItemActive : styles.segItem}
            >
              <Icon name="MousePointer" size={13} color={theme.colors.foreground} />
              <Text style={styles.btnText}>{isZh ? "选择" : "Select"}</Text>
            </Pressable>
          </View>

          {/* Page Navigation */}
          {primaryMeta && primaryMeta.totalPages > 1 ? (
            <View style={styles.segmented}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={isZh ? "上一页" : "Previous page"}
                onPress={() => primaryMeta.scrollToPage(primaryMeta.currentPage - 1)}
                style={styles.segItem}
              >
                <Icon name="ChevronLeft" size={13} color={theme.colors.foreground} />
              </Pressable>
              <Text style={[styles.btnText, { paddingHorizontal: 6 }]}>
                {primaryMeta.currentPage} / {primaryMeta.totalPages}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={isZh ? "下一页" : "Next page"}
                onPress={() => primaryMeta.scrollToPage(primaryMeta.currentPage + 1)}
                style={styles.segItem}
              >
                <Icon name="ChevronRight" size={13} color={theme.colors.foreground} />
              </Pressable>
            </View>
          ) : null}

          {/* Zoom Controls */}
          <View style={styles.segmented}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isZh ? "缩小" : "Zoom out"}
              testID="paseo-doc-zoom-out"
              onPress={() => setZoom((z) => computeNextZoomStep(z, "out"))}
              style={styles.segItem}
            >
              <Icon name="ZoomOut" size={13} color={theme.colors.foreground} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isZh ? "重置缩放" : "Reset zoom"}
              testID="paseo-doc-zoom-reset"
              onPress={() => setZoom(1)}
              style={styles.segItem}
            >
              <Text style={styles.btnText}>{Math.round(zoom * 100)}%</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isZh ? "放大" : "Zoom in"}
              testID="paseo-doc-zoom-in"
              onPress={() => setZoom((z) => computeNextZoomStep(z, "in"))}
              style={styles.segItem}
            >
              <Icon name="ZoomIn" size={13} color={theme.colors.foreground} />
            </Pressable>
          </View>

          {/* View Mode (Canvas / Native / Text) */}
          <View style={styles.segmented}>
            <Pressable
              accessibilityRole="button"
              testID="paseo-doc-view-canvas"
              onPress={() => setPdfMode("canvas")}
              style={pdfMode === "canvas" ? styles.segItemActive : styles.segItem}
            >
              <Text style={styles.btnText}>{isPdf ? (isZh ? "画布" : "Canvas") : isZh ? "版式" : "Layout"}</Text>
            </Pressable>
            {isPdf && primaryMeta?.supportsNativeFrame ? (
              <Pressable
                accessibilityRole="button"
                testID="paseo-doc-view-native"
                onPress={() => setPdfMode("native")}
                style={pdfMode === "native" ? styles.segItemActive : styles.segItem}
              >
                <Text style={styles.btnText}>{isZh ? "原生" : "Native"}</Text>
              </Pressable>
            ) : null}
            {primaryMeta?.hasText ? (
              <Pressable
                accessibilityRole="button"
                testID="paseo-doc-view-text"
                onPress={() => setPdfMode("text")}
                style={pdfMode === "text" ? styles.segItemActive : styles.segItem}
              >
                <Text style={styles.btnText}>{isZh ? "文本" : "Text"}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <View style={styles.group}>
          {/* Multi-Doc Compare */}
          <Pressable
            accessibilityRole="button"
            testID="paseo-doc-compare-toggle"
            onPress={() => setShowCompareTray((v) => !v)}
            style={comparePaths.length > 0 || showCompareTray ? styles.btnActive : styles.btn}
          >
            <Icon name="Columns2" size={13} color={theme.colors.foreground} />
            <Text style={styles.btnText}>
              {isZh ? "多文档对比" : "Compare"}
              {comparePaths.length > 0 ? ` (${comparePaths.length + 1})` : ""}
            </Text>
          </Pressable>

          {/* Search */}
          <Pressable
            accessibilityRole="button"
            testID="paseo-doc-search-toggle"
            onPress={() => setShowSearchBar((v) => !v)}
            style={showSearchBar || searchQuery.trim().length > 0 ? styles.btnActive : styles.btn}
          >
            <Icon name="Search" size={13} color={theme.colors.foreground} />
            <Text style={styles.btnText}>{isZh ? "搜索" : "Find"}</Text>
          </Pressable>

          {/* Finder & System Openers */}
          <Pressable
            accessibilityRole="button"
            onPress={() => openMutation.mutate("finder-reveal")}
            style={styles.btn}
          >
            <Icon name="FolderOpen" size={13} color={theme.colors.foreground} />
            <Text style={styles.btnText}>Finder</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={() => openMutation.mutate("system-default")}
            style={styles.btn}
          >
            <Icon name="ExternalLink" size={13} color={theme.colors.foreground} />
            <Text style={styles.btnText}>{isZh ? "外部打开" : "Open"}</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={() => void handleCopyPath()}
            style={styles.btn}
          >
            <Icon name="Copy" size={13} color={theme.colors.foreground} />
            <Text style={styles.btnText}>{isZh ? "路径" : "Path"}</Text>
          </Pressable>
        </View>
      </View>

      {/* Search Bar */}
      {showSearchBar ? (
        <View style={styles.subBar}>
          <View style={[styles.group, { flex: 1 }]}>
            <View style={{ minWidth: 220, flex: 1, maxWidth: 360 }}>
              <TextInput
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder={isZh ? "在文档中查找关键词..." : "Find in document..."}
              />
            </View>
            {primaryMeta && primaryMeta.matchingPages.length > 0 ? (
              <View style={styles.group}>
                <Text style={styles.mutedText}>
                  {isZh ? "命中页码：" : "Matches:"}
                </Text>
                {primaryMeta.matchingPages.slice(0, 10).map((pno) => (
                  <Pressable
                    key={pno}
                    accessibilityRole="button"
                    onPress={() => primaryMeta.scrollToPage(pno)}
                    style={styles.btn}
                  >
                    <Text style={styles.btnText}>P{pno}</Text>
                  </Pressable>
                ))}
              </View>
            ) : searchQuery.trim().length >= 2 ? (
              <Text style={styles.mutedText}>
                {isZh ? "已高亮匹配文本" : "Highlighted matching text"}
              </Text>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setSearchQuery("");
              setShowSearchBar(false);
            }}
            style={styles.btn}
          >
            <Icon name="X" size={12} color={theme.colors.foreground} />
          </Pressable>
        </View>
      ) : null}

      {/* Multi-Doc Compare Tray */}
      {showCompareTray ? (
        <View style={styles.trayCard} testID="paseo-doc-compare-tray">
          <View style={[styles.group, { justifyContent: "space-between" }]}>
            <Text style={styles.mutedText}>
              {isZh
                ? "点选同目录或工作区文档进行并排/上下多文档预览，也可直接从聊天链接或 Finder 拖入文件"
                : "Select workspace documents to preview side-by-side, or drag files from Finder or chat links"}
            </Text>
            <View style={styles.group}>
              <View style={styles.segmented}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setCompareLayout("split")}
                  style={compareLayout === "split" ? styles.segItemActive : styles.segItem}
                >
                  <Icon name="Columns2" size={12} color={theme.colors.foreground} />
                  <Text style={styles.btnText}>{isZh ? "并排" : "Split"}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setCompareLayout("stack")}
                  style={compareLayout === "stack" ? styles.segItemActive : styles.segItem}
                >
                  <Icon name="Rows2" size={12} color={theme.colors.foreground} />
                  <Text style={styles.btnText}>{isZh ? "上下" : "Stack"}</Text>
                </Pressable>
              </View>
              <Pressable
                accessibilityRole="button"
                onPress={() => setSyncScrollEnabled((v) => !v)}
                style={syncScrollEnabled ? styles.btnActive : styles.btn}
              >
                <Icon name="Link2" size={12} color={theme.colors.foreground} />
                <Text style={styles.btnText}>{isZh ? "同步滚动" : "Sync scroll"}</Text>
              </Pressable>
              {comparePaths.length > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setComparePaths([])}
                  style={styles.btn}
                >
                  <Text style={styles.btnText}>{isZh ? "清空对比" : "Clear"}</Text>
                </Pressable>
              ) : null}
            </View>
          </View>

          <View style={styles.siblingRow}>
            {siblingsQuery.isLoading ? (
              <Text style={styles.mutedText}>{isZh ? "正在扫描同目录文档..." : "Scanning sibling documents..."}</Text>
            ) : siblingsQuery.data?.items && siblingsQuery.data.items.length > 0 ? (
              siblingsQuery.data.items.slice(0, 12).map((item) => {
                const active = comparePaths.includes(item.absolutePath);
                return (
                  <Pressable
                    key={item.absolutePath}
                    accessibilityRole="button"
                    testID={`paseo-doc-sibling-${item.fileName}`}
                    onPress={() => toggleComparePath(item.absolutePath)}
                    style={active ? styles.btnActive : styles.btn}
                  >
                    <Icon name={active ? "X" : "Plus"} size={11} color={theme.colors.foreground} />
                    <Text style={styles.btnText} numberOfLines={1}>
                      {item.fileName}
                    </Text>
                    <Text style={styles.mutedText}>{item.extension.toUpperCase()}</Text>
                  </Pressable>
                );
              })
            ) : (
              <Text style={styles.mutedText}>
                {isZh ? "当前目录暂无其他可对比文档，可直接拖入文件" : "No sibling documents found; drag any file onto this pane"}
              </Text>
            )}
          </View>
        </View>
      ) : null}

      {/* Metadata Observability Strip */}
      <View style={styles.subBar}>
        <View style={styles.group}>
          <Text style={[styles.btnText, { fontWeight: "600" }]}>
            {primaryMeta?.kind ?? file.extension.toUpperCase()}
          </Text>
          {primaryMeta ? (
            <>
              <Text style={styles.mutedText}>
                {primaryMeta.totalPages} {primaryMeta.totalPages === 1 ? (isZh ? "页" : "page") : isZh ? "页" : "pages"}
              </Text>
              <Text style={styles.mutedText}>{primaryMeta.sizeFormatted}</Text>
              <Text style={styles.mutedText}>{primaryMeta.engine}</Text>
            </>
          ) : null}
          <Text style={styles.mutedText} numberOfLines={1}>
            {primaryMeta?.relativePath ?? params.path}
          </Text>
        </View>
        <Text style={styles.mutedText}>
          {lastReceipt
            ? lastReceipt
            : interactionMode === "pan"
              ? isZh
                ? "按住左键拖拽平移 · 滚轮滚动 · Cmd+滚轮缩放"
                : "Drag to pan · Scroll pages · Cmd+Scroll zoom"
              : isZh
                ? "选择文本可引用回复 · 按住空格键临时拖拽平移 ·编辑器：" + preferredEditor
                : "Select text to quote · Hold Space to pan"}
        </Text>
      </View>

      {/* Single or Multi-Doc Split / Stack Viewport */}
      <View style={styles.canvasRow}>
        <DocumentViewportSlot
          slotId={`${instanceId}-primary`}
          syncGroupId={instanceId}
          workspaceId={workspaceId}
          workspaceDir={workspaceDir}
          filePath={params.path}
          nativeBlobUrl={nativeBlobUrl}
          isPrimary={true}
          compact={layout.compact}
          theme={theme}
          isZh={isZh}
          interactionMode={interactionMode}
          pdfMode={pdfMode}
          zoom={zoom}
          searchQuery={searchQuery}
          syncScrollEnabled={syncScrollEnabled && comparePaths.length > 0}
          onZoomChange={setZoom}
          onPrimaryMetaChange={setPrimaryMeta}
        />

        {comparePaths.map((compPath, idx) => (
          <DocumentViewportSlot
            key={compPath}
            slotId={`${instanceId}-cmp-${idx}`}
            syncGroupId={instanceId}
            workspaceId={workspaceId}
            workspaceDir={workspaceDir}
            filePath={compPath}
            nativeBlobUrl={null}
            isPrimary={false}
            compact={layout.compact}
            theme={theme}
            isZh={isZh}
            interactionMode={interactionMode}
            pdfMode={pdfMode === "native" ? "canvas" : pdfMode}
            zoom={zoom}
            searchQuery={searchQuery}
            syncScrollEnabled={syncScrollEnabled}
            onZoomChange={setZoom}
            onOpenInTab={() => {
              openWorkspaceFileTabsInSidePane(workspaceId, [compPath]);
            }}
            onRemoveCompare={() => {
              setComparePaths((prev) => prev.filter((p) => p !== compPath));
            }}
          />
        ))}
      </View>
    </View>
  );
}
