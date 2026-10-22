import { Fragment, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { WorklistItem } from "@/data/mockData";
import { dicomWebService, type SeriesItem } from "@/lib/dicomService";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChevronLeft, ChevronRight, ImageIcon, Layers3, Loader2, RotateCcw, Sun } from "lucide-react";

type StudySeriesPreviewPanelProps = {
  item: WorklistItem | null;
  className?: string;
  compact?: boolean;
  micro?: boolean;
  enableViewerBrightnessContrast?: boolean;
  selectedSeriesId?: string | null;
  onSeriesSelect?: (payload: {
    series: SeriesItem;
    instances: Record<string, unknown>[];
    loading: boolean;
    imageIndex?: number;
  }) => void;
};

const getSopInstanceUid = (instance?: Record<string, unknown>): string => {
  const rawElement = instance?.["00080018"] as { Value?: unknown[] } | undefined;
  const value = Array.isArray(rawElement?.Value) ? rawElement.Value[0] : undefined;
  return (value as string | number | undefined)?.toString() ?? "";
};

const StudySeriesPreviewPanel = ({
  item,
  className = "",
  compact = false,
  micro = false,
  enableViewerBrightnessContrast = false,
  selectedSeriesId,
  onSeriesSelect,
}: StudySeriesPreviewPanelProps) => {
  const activeStudyKey = item?.studyInstanceUid || item?.id || "";
  const [series, setSeries] = useState<SeriesItem[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const [expandedSeriesId, setExpandedSeriesId] = useState<string | null>(null);
  const [instancesBySeries, setInstancesBySeries] = useState<Record<string, Record<string, unknown>[]>>({});
  const [instancesLoadingSeriesId, setInstancesLoadingSeriesId] = useState<string | null>(null);
  const [activeImageIndexBySeries, setActiveImageIndexBySeries] = useState<Record<string, number>>({});
  const [viewerSeriesId, setViewerSeriesId] = useState<string | null>(null);
  const [viewerImageIndex, setViewerImageIndex] = useState(0);
  const [viewerBrightness, setViewerBrightness] = useState(1);
  const [viewerContrast, setViewerContrast] = useState(1);
  const [viewerAdjusting, setViewerAdjusting] = useState(false);
  const viewerAdjustmentDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startBrightness: number;
    startContrast: number;
    viewportWidth: number;
    viewportHeight: number;
  } | null>(null);
  const [touchFirst, setTouchFirst] = useState(false);
  const instancesCacheRef = useRef<Record<string, Record<string, unknown>[]>>({});

  useEffect(() => {
    if (typeof window === "undefined") return;

    const updateTouchFirst = () => {
      setTouchFirst(window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0);
    };

    updateTouchFirst();
    window.addEventListener("resize", updateTouchFirst);
    window.addEventListener("orientationchange", updateTouchFirst);
    return () => {
      window.removeEventListener("resize", updateTouchFirst);
      window.removeEventListener("orientationchange", updateTouchFirst);
    };
  }, []);

  const loadInstances = useCallback(
    async (studyInstanceUid: string, seriesInstanceUid: string) => {
      if (!studyInstanceUid || !seriesInstanceUid) return [];
      if (instancesCacheRef.current[seriesInstanceUid]) {
        return instancesCacheRef.current[seriesInstanceUid];
      }
      setInstancesLoadingSeriesId(seriesInstanceUid);
      try {
        const nextInstances = (await dicomWebService.fetchInstances(
          studyInstanceUid,
          seriesInstanceUid
        )) as Record<string, unknown>[];
        instancesCacheRef.current[seriesInstanceUid] = Array.isArray(nextInstances)
          ? nextInstances
          : [];
        setInstancesBySeries(prev => ({
          ...prev,
          [seriesInstanceUid]: instancesCacheRef.current[seriesInstanceUid],
        }));
        return instancesCacheRef.current[seriesInstanceUid];
      } catch (error) {
        setSeriesError(
          error instanceof Error ? error.message : "Failed to load images for selected series"
        );
        return [];
      } finally {
        setInstancesLoadingSeriesId(current =>
          current === seriesInstanceUid ? null : current
        );
      }
    },
    []
  );

  useEffect(() => {
    if (!item?.studyInstanceUid || !activeStudyKey) {
      setSeries([]);
      setSeriesError(null);
      setSeriesLoading(false);
      setExpandedSeriesId(null);
      setInstancesBySeries({});
      setInstancesLoadingSeriesId(null);
      setActiveImageIndexBySeries({});
      setViewerSeriesId(null);
      setViewerImageIndex(0);
      return;
    }

    let isMounted = true;
    setSeries([]);
    setSeriesError(null);
    setSeriesLoading(true);
    setExpandedSeriesId(null);
    setInstancesBySeries({});
    setInstancesLoadingSeriesId(null);
    setActiveImageIndexBySeries({});
    setViewerSeriesId(null);
    setViewerImageIndex(0);
    instancesCacheRef.current = {};

    void dicomWebService
      .fetchSeries(item.studyInstanceUid)
      .then(nextSeries => {
        if (!isMounted) return;
        setSeries(nextSeries);
      })
      .catch(error => {
        if (!isMounted) return;
        setSeriesError(error instanceof Error ? error.message : "Failed to load series");
      })
      .finally(() => {
        if (isMounted) {
          setSeriesLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [activeStudyKey, item?.studyInstanceUid, loadInstances]);

  useEffect(() => {
    if (!item?.studyInstanceUid || !viewerSeriesId) return;
    if (instancesBySeries[viewerSeriesId]?.length) return;
    void loadInstances(item.studyInstanceUid, viewerSeriesId);
  }, [instancesBySeries, item, loadInstances, viewerSeriesId]);

  useEffect(() => {
    viewerAdjustmentDragRef.current = null;
    setViewerAdjusting(false);
    setViewerBrightness(1);
    setViewerContrast(1);
  }, [activeStudyKey, viewerSeriesId]);

  if (!item) return null;

  const openViewerForSeries = (seriesId: string, imageIndex = 0) => {
    setViewerSeriesId(seriesId);
    setViewerImageIndex(imageIndex);
    if (item.studyInstanceUid) {
      void loadInstances(item.studyInstanceUid, seriesId);
    }
  };

  const selectSeriesForPanel = async (entry: SeriesItem, imageIndex = 0) => {
    const seriesId = entry.SeriesInstanceUID;
    const cachedInstances = instancesBySeries[seriesId] ?? instancesCacheRef.current[seriesId] ?? [];
    onSeriesSelect?.({
      series: entry,
      instances: cachedInstances,
      loading: cachedInstances.length === 0,
      imageIndex,
    });

    if (!item.studyInstanceUid) return;
    const loadedInstances = await loadInstances(item.studyInstanceUid, seriesId);
    onSeriesSelect?.({
      series: entry,
      instances: loadedInstances,
      loading: false,
      imageIndex,
    });
  };

  const viewerSeries = viewerSeriesId
    ? series.find(entry => entry.SeriesInstanceUID === viewerSeriesId) ?? null
    : null;
  const viewerInstances = viewerSeriesId ? instancesBySeries[viewerSeriesId] ?? [] : [];
  const normalizedViewerIndex = Math.min(
    Math.max(viewerImageIndex, 0),
    Math.max(viewerInstances.length - 1, 0)
  );
  const activeViewerInstance = viewerInstances[normalizedViewerIndex];
  const activeViewerSopInstanceUid = getSopInstanceUid(activeViewerInstance);
  const activeViewerImageUrl =
    viewerSeriesId && activeViewerSopInstanceUid
      ? dicomWebService.getInstanceThumbnailUrl(
          item.studyInstanceUid,
          viewerSeriesId,
          activeViewerSopInstanceUid
        )
      : "";
  const viewerAdjustmentDefault =
    Math.abs(viewerBrightness - 1) < 0.001 && Math.abs(viewerContrast - 1) < 0.001;
  const resetViewerAdjustment = () => {
    viewerAdjustmentDragRef.current = null;
    setViewerAdjusting(false);
    setViewerBrightness(1);
    setViewerContrast(1);
  };
  const beginViewerAdjustment = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enableViewerBrightnessContrast || event.pointerType !== "mouse" || event.button !== 0 || !event.isPrimary) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    viewerAdjustmentDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startBrightness: viewerBrightness,
      startContrast: viewerContrast,
      viewportWidth: Math.max(bounds.width, 1),
      viewportHeight: Math.max(bounds.height, 1),
    };
    setViewerAdjusting(true);
  };
  const moveViewerAdjustment = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = viewerAdjustmentDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    setViewerContrast(Math.min(3, Math.max(0.25, drag.startContrast + (deltaX / drag.viewportWidth) * 2)));
    setViewerBrightness(Math.min(3, Math.max(0.25, drag.startBrightness - (deltaY / drag.viewportHeight) * 2)));
  };
  const endViewerAdjustment = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = viewerAdjustmentDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    viewerAdjustmentDragRef.current = null;
    setViewerAdjusting(false);
  };

  return (
    <>
      <section
        className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm ${className}`}
      >
        <div className={`flex min-h-0 flex-col ${micro ? "space-y-0.5 px-2 py-1.5" : compact ? "space-y-1 px-2 py-2" : "space-y-1.5 px-3 py-2 sm:px-4 sm:py-2"}`}>
        {seriesLoading ? (
          <div className={`flex items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-muted/20 text-sm text-muted-foreground ${micro ? "min-h-[78px]" : compact ? "min-h-[112px]" : "min-h-[120px]"}`}>
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading series list...
          </div>
        ) : seriesError ? (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {seriesError}
          </div>
        ) : series.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-4 py-10 text-center text-sm text-muted-foreground">
            No series available for this study.
          </div>
        ) : (
          <>
            <div className="min-h-0 space-y-1">
              {!compact && (
                <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <Layers3 className="h-3.5 w-3.5 text-muted-foreground" />
                  Series Information
                </div>
              )}
              <div className="report-scrollbar overflow-x-auto pb-0">
                <div className="flex min-w-max items-start gap-1.5">
                  {series.map(entry => {
                    const seriesId = entry.SeriesInstanceUID;
                    const isExpanded = expandedSeriesId === seriesId;
                    const isSelected = selectedSeriesId === seriesId;
                    const activeInstances = instancesBySeries[seriesId] ?? [];
                    const thumbnailUrl = dicomWebService.getSeriesThumbnailUrl(
                      item.studyInstanceUid,
                      seriesId
                    );

                    return (
                      <Fragment key={seriesId}>
                        <div
                          className={`group relative shrink-0 overflow-visible rounded-xl border text-left transition-colors ${micro ? "w-[82px]" : compact ? "w-[104px]" : "w-[92px]"} ${
                            isSelected
                              ? "border-emerald-400 bg-emerald-500/10 shadow-sm"
                              : isExpanded
                              ? "border-primary bg-primary/5 shadow-sm"
                              : "border-border bg-background"
                          }`}
                          onClick={() => {
                            if (touchFirst && expandedSeriesId !== seriesId) {
                              setExpandedSeriesId(seriesId);
                            }
                            void selectSeriesForPanel(entry);
                          }}
                          onDoubleClick={() => {
                            openViewerForSeries(seriesId, activeImageIndexBySeries[seriesId] ?? 0);
                          }}
                        >
                          <div className={`relative overflow-hidden rounded-t-xl bg-black/90 ${micro ? "h-[58px]" : compact ? "h-[92px]" : "h-[78px]"}`}>
                            <img
                              src={thumbnailUrl}
                              alt={entry.SeriesDescription || `Series ${entry.SeriesNumber || ""}`}
                              className="h-full w-full object-contain"
                              loading="lazy"
                              decoding="async"
                            />
                            <div className={`absolute right-1 top-1 inline-flex items-center justify-center rounded-md bg-white/90 px-1 py-0.5 font-semibold text-slate-800 shadow-sm ${micro ? "min-w-4 text-[8px]" : "min-w-5 text-[9px]"}`}>
                              {entry.NumberOfSeriesRelatedInstances || 0}
                            </div>
                          </div>
                          <button
                            type="button"
                            aria-label={isExpanded ? "Collapse series" : "Expand series"}
                            title={isExpanded ? "Collapse" : "Expand"}
                            onClick={() => {
                              if (isExpanded) {
                                setExpandedSeriesId(null);
                                return;
                              }
                              setExpandedSeriesId(seriesId);
                              void loadInstances(item.studyInstanceUid, seriesId);
                            }}
                            className={`absolute -right-2 top-1/2 z-10 inline-flex -translate-y-1/2 items-center justify-center rounded-full border shadow-sm transition-colors ${micro ? "h-4 w-4" : "h-5 w-5"} ${
                              isExpanded
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
                            }`}
                          >
                            <ChevronRight className={`${micro ? "h-2.5 w-2.5" : "h-3 w-3"} transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                          </button>
                          <div className={micro ? "space-y-0.5 px-1 py-1" : "space-y-0.5 p-1.5"}>
                            <div
                              className={`truncate min-w-0 pr-2 font-semibold text-foreground ${micro ? "text-[8px]" : "text-[9px]"}`}
                              title={entry.SeriesDescription || `Series ${entry.SeriesNumber || "-"}`}
                            >
                              {entry.SeriesDescription || `Series ${entry.SeriesNumber || "-"}`}
                            </div>
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="flex shrink-0 items-start gap-1">
                            <div className="flex h-[92px] items-center justify-center px-0.5 text-muted-foreground">
                              <ChevronRight className="h-3 w-3" />
                            </div>

                            {instancesLoadingSeriesId === seriesId && activeInstances.length === 0 ? (
                              <div className="flex h-[92px] w-[72px] items-center justify-center gap-1 rounded-xl border border-dashed border-border bg-muted/20 px-2 text-center text-[9px] text-muted-foreground">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Loading image...
                              </div>
                            ) : activeInstances.length === 0 ? (
                              <div className="flex h-[92px] w-[72px] items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 px-2 text-center text-[9px] text-muted-foreground">
                                Image thumbnail is not available.
                              </div>
                            ) : (
                              <div className="flex gap-1.5">
                                {activeInstances.map((instance, index) => {
                                  const sopInstanceUid = getSopInstanceUid(instance);
                                  const imageThumbnailUrl = dicomWebService.getInstanceThumbnailUrl(
                                    item.studyInstanceUid,
                                    seriesId,
                                    sopInstanceUid
                                  );
                                  const isActive =
                                    (activeImageIndexBySeries[seriesId] ?? 0) === index;

                                  return (
                                    <button
                                      key={sopInstanceUid || `${seriesId}-${index}`}
                                      type="button"
                                      onClick={() => {
                                        setActiveImageIndexBySeries(prev => ({
                                          ...prev,
                                          [seriesId]: index,
                                        }));
                                        if (touchFirst) {
                                          void selectSeriesForPanel(entry, index);
                                          openViewerForSeries(seriesId, index);
                                        }
                                      }}
                                      className={`w-[68px] shrink-0 overflow-hidden rounded-xl border text-left transition-colors ${
                                        isActive
                                          ? "border-primary bg-primary/5 shadow-sm"
                                          : "border-border bg-card hover:border-primary/40 hover:bg-muted/20"
                                      }`}
                                    >
                                      <div className="h-[68px] overflow-hidden bg-muted/30">
                                        <img
                                          src={imageThumbnailUrl}
                                          alt={`Image ${index + 1}`}
                                          className="h-full w-full object-cover"
                                          loading="lazy"
                                          decoding="async"
                                        />
                                      </div>
                                      <div className="flex items-center justify-between px-1.5 py-1 text-[8px]">
                                        <span className="font-medium text-foreground">
                                          {index + 1}
                                        </span>
                                        <ImageIcon className="h-3 w-3 text-muted-foreground" />
                                      </div>
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </Fragment>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        )}
        </div>
      </section>

      <Dialog
        open={Boolean(viewerSeriesId)}
        onOpenChange={open => {
          if (!open) {
            setViewerSeriesId(null);
            setViewerImageIndex(0);
          }
        }}
      >
        <DialogContent className="flex h-[86vh] max-h-[860px] w-[calc(100vw-2rem)] max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-black p-0 text-white shadow-2xl sm:w-[94vw] [&>button]:right-4 [&>button]:top-4 [&>button]:text-white [&>button]:opacity-80 [&>button]:hover:opacity-100">
          <DialogHeader className="shrink-0 border-b border-white/10 px-4 py-3 pr-12">
            <DialogTitle className="text-base font-semibold text-white">
              {viewerSeries?.SeriesDescription || "Series Viewer"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Viewer for browsing and switching study series images.
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-4">
            <div
              className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 ${
                enableViewerBrightnessContrast ? "cursor-crosshair select-none" : ""
              }`}
              data-testid="series-dialog-image-viewport"
              onPointerDown={beginViewerAdjustment}
              onPointerMove={moveViewerAdjustment}
              onPointerUp={endViewerAdjustment}
              onPointerCancel={endViewerAdjustment}
              onWheel={event => {
                if (!viewerSeriesId || viewerInstances.length === 0) return;
                const direction = event.deltaY > 0 ? 1 : -1;
                const nextIndex = Math.min(
                  Math.max(normalizedViewerIndex + direction, 0),
                  viewerInstances.length - 1
                );
                setViewerImageIndex(nextIndex);
              }}
            >
              {enableViewerBrightnessContrast && activeViewerImageUrl && (
                <div className="absolute left-2 top-2 z-20 flex h-8 items-center gap-1 overflow-hidden rounded-lg border border-white/10 bg-black/70 px-1 text-white/90 shadow-lg backdrop-blur">
                  <div
                    className="flex h-full w-7 items-center justify-center"
                    aria-label="Dialog brightness and contrast: drag the image to adjust"
                    title="Drag over the image: horizontal for contrast, vertical for brightness"
                  >
                    <Sun className={`h-3.5 w-3.5 ${viewerAdjusting ? "animate-pulse text-amber-200" : "text-amber-300"}`} />
                  </div>
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded-md border-l border-white/10 text-white/55 transition hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-35"
                    onPointerDown={event => event.stopPropagation()}
                    onClick={event => {
                      event.stopPropagation();
                      resetViewerAdjustment();
                    }}
                    disabled={viewerAdjustmentDefault}
                    aria-label="Reset dialog brightness and contrast"
                    title="Reset brightness and contrast"
                  >
                    <RotateCcw className="h-3 w-3" />
                  </button>
                </div>
              )}
              {instancesLoadingSeriesId === viewerSeriesId && viewerInstances.length === 0 ? (
                <div className="flex items-center gap-3 text-sm text-slate-300">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  Loading image...
                </div>
              ) : activeViewerImageUrl ? (
                <img
                  src={activeViewerImageUrl}
                  alt={`Image ${normalizedViewerIndex + 1}`}
                  className="h-full max-h-full w-full max-w-full object-contain"
                  decoding="async"
                  draggable={false}
                  style={
                    enableViewerBrightnessContrast
                      ? {
                          filter: `brightness(${viewerBrightness}) contrast(${viewerContrast})`,
                          willChange: "filter",
                        }
                      : undefined
                  }
                />
              ) : (
                <div className="text-sm text-slate-300">Image is not available.</div>
              )}
            </div>

            <div className="mx-auto flex w-full max-w-3xl shrink-0 items-center justify-between gap-3 text-xs text-slate-300">
              <span>
                Image {viewerInstances.length === 0 ? 0 : normalizedViewerIndex + 1} / {viewerInstances.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 transition-colors hover:bg-white/10 disabled:opacity-40"
                  disabled={normalizedViewerIndex <= 0}
                  onClick={() => setViewerImageIndex(current => Math.max(current - 1, 0))}
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 transition-colors hover:bg-white/10 disabled:opacity-40"
                  disabled={normalizedViewerIndex >= Math.max(viewerInstances.length - 1, 0)}
                  onClick={() =>
                    setViewerImageIndex(current =>
                      Math.min(current + 1, Math.max(viewerInstances.length - 1, 0))
                    )
                  }
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>

            {viewerInstances.length > 0 && (
              <>
                <input
                  type="range"
                  min={0}
                  max={Math.max(viewerInstances.length - 1, 0)}
                  value={normalizedViewerIndex}
                  onChange={event => setViewerImageIndex(Number(event.target.value))}
                  className="mx-auto h-6 w-full max-w-3xl shrink-0 accent-emerald-400"
                />

                <div className="report-scrollbar w-full max-w-full shrink-0 overflow-x-auto overflow-y-hidden pb-1">
                  <div className="flex w-max max-w-none gap-2 pr-2 sm:gap-3">
                    {series.map(entry => {
                      const isActive = viewerSeriesId === entry.SeriesInstanceUID;
                      const thumbnailUrl = dicomWebService.getSeriesThumbnailUrl(
                        item.studyInstanceUid,
                        entry.SeriesInstanceUID
                      );

                      return (
                        <button
                          key={entry.SeriesInstanceUID}
                          type="button"
                          onClick={() => openViewerForSeries(entry.SeriesInstanceUID, 0)}
                          className={`w-[5.5rem] shrink-0 overflow-hidden rounded-xl border text-center transition sm:w-[5.75rem] ${
                            isActive
                              ? "border-emerald-400/60 bg-emerald-400/10"
                              : "border-white/10 hover:border-emerald-400/40"
                          }`}
                        >
                          <div className="h-20 w-full overflow-hidden bg-black sm:h-24">
                            <img
                              src={thumbnailUrl}
                              alt={entry.SeriesDescription || `Series ${entry.SeriesNumber || ""}`}
                              className="h-full w-full object-contain"
                              loading="lazy"
                              decoding="async"
                            />
                          </div>
                          <div className="h-11 px-2 py-1.5 text-[10px] text-slate-300">
                            <div
                              className="line-clamp-2 leading-4"
                              title={entry.SeriesDescription || `Series ${entry.SeriesNumber || "-"}`}
                            >
                              {entry.SeriesDescription || `Series ${entry.SeriesNumber || "-"}`}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default StudySeriesPreviewPanel;
