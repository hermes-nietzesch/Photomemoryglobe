import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Brain,
  Globe2,
  Network,
  Sparkles,
  Upload,
  RotateCcw,
  Play,
  Pause,
  Users,
  MapPin,
  Calendar,
  Tag,
  Zap,
  X,
  AlertTriangle,
  RefreshCw,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import type {
  ClusterDimension,
  MemoryGraph,
  MemoryNode,
  MorphMode,
  StorageRecoveryInfo,
  SynapseEdge,
  SynapseKind,
} from '../shared/types.ts';
import { SYNAPSE_COLORS } from '../shared/types.ts';
import { DEMO_MEMORIES } from '../shared/demoMemories.ts';
import { buildMemoryGraph, CLUSTERS_PAGE_SIZE, getClusterPage } from '../shared/graphEngine.ts';
import {
  NeuralGlobeEngine,
  type ActiveFilter,
  type OpenedGroupInfo,
} from './scene/NeuralGlobeEngine.ts';
import { MemoryInspector } from './components/MemoryInspector.tsx';
import { ImportEnrichModal } from './components/ImportEnrichModal.tsx';

interface SynapseToast {
  fromTitle: string;
  toTitle: string;
  reason: string;
  kind: SynapseKind;
}

export const App: React.FC = () => {
  const mountRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<NeuralGlobeEngine | null>(null);

  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [morphMode, setMorphMode] = useState<MorphMode>('neural');
  const [clusterDimension, setClusterDimension] = useState<ClusterDimension>('event');
  const [clusterPage, setClusterPage] = useState(0);
  const [openedGroup, setOpenedGroup] = useState<OpenedGroupInfo | null>(null);
  const [hoveredMemory, setHoveredMemory] = useState<MemoryNode | null>(null);
  const [hoveredGroupLabel, setHoveredGroupLabel] = useState<string | null>(null);
  const [selectedMemory, setSelectedMemory] = useState<MemoryNode | null>(null);
  const [arrivedVia, setArrivedVia] = useState<SynapseEdge | null>(null);

  const [filterCategory, setFilterCategory] = useState<SynapseKind | 'all'>('all');
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>({ kind: 'all', value: null });
  const [autoDrift, setAutoDrift] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [hasEnvGeminiKey, setHasEnvGeminiKey] = useState(false);
  const [storageRecovery, setStorageRecovery] = useState<StorageRecoveryInfo | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [synapseToast, setSynapseToast] = useState<SynapseToast | null>(null);
  const [bannerMsg, setBannerMsg] = useState<string | null>(null);

  const toastTimerRef = useRef<number | null>(null);

  const showSynapseToast = useCallback((from: MemoryNode, to: MemoryNode, edge: SynapseEdge) => {
    setSynapseToast({
      fromTitle: from.title,
      toTitle: to.title,
      reason: edge.reasons.map((r) => r.label).slice(0, 2).join(' · '),
      kind: edge.kind,
    });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setSynapseToast(null), 5500);
  }, []);

  // Initialize Three.js NeuralGlobeEngine
  useEffect(() => {
    if (!mountRef.current) return;
    const engine = new NeuralGlobeEngine(mountRef.current, {
      onHoverMemory: (mem) => setHoveredMemory(mem),
      onHoverGroup: (label) => setHoveredGroupLabel(label),
      onSelectMemory: (mem, viaEdge) => {
        setSelectedMemory(mem);
        setArrivedVia(viaEdge ?? null);
      },
      onSynapseJump: (from, to, edge) => showSynapseToast(from, to, edge),
      onOpenGroupChange: (grp) => setOpenedGroup(grp),
      onClusterPageChange: (page) => setClusterPage(page),
    });
    engineRef.current = engine;

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [showSynapseToast]);

  // Fetch initial graph + API status (fallback gracefully to client-side demo graph if backend not reachable)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [graphRes, statusRes] = await Promise.all([fetch('/api/graph'), fetch('/api/status')]);
        if (graphRes.ok) {
          const data = (await graphRes.json()) as MemoryGraph;
          if (!cancelled) {
            setGraph(data);
            setStorageRecovery(data.storageRecovery ?? null);
            engineRef.current?.setGraph(data);
          }
        }
        if (statusRes.ok) {
          const status = await statusRes.json();
          if (!cancelled) {
            setHasEnvGeminiKey(Boolean(status.hasEnvGeminiKey));
            if (status.storageRecovery) setStorageRecovery(status.storageRecovery);
          }
        }
      } catch {
        const fallback = buildMemoryGraph(DEMO_MEMORIES);
        if (!cancelled) {
          setGraph(fallback);
          engineRef.current?.setGraph(fallback);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keyboard shortcuts for effortless neural navigation
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (modalOpen) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.code === 'Space' || e.key === 'ArrowRight') {
        e.preventDefault();
        engineRef.current?.fireNextSynapse();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        engineRef.current?.stepBackSynapse();
      } else if (e.key === 'Escape') {
        engineRef.current?.resetView();
      } else if (e.key === '1') {
        handleMorphChange('neural');
      } else if (e.key === '2') {
        handleMorphChange('globe');
      } else if (e.key === '3') {
        handleMorphChange('clusters');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modalOpen]);

  const handleMorphChange = (mode: MorphMode) => {
    setMorphMode(mode);
    setOpenedGroup(null);
    engineRef.current?.setMorphMode(mode);
  };

  const handleClusterDimensionChange = (dim: ClusterDimension) => {
    setClusterDimension(dim);
    setClusterPage(0);
    setOpenedGroup(null);
    engineRef.current?.setClusterDimension(dim);
  };

  const handleClusterPageChange = (nextPage: number) => {
    setClusterPage(nextPage);
    setOpenedGroup(null);
    engineRef.current?.setClusterPage(nextPage);
  };

  const handleApplyFilter = (kind: SynapseKind | 'all', value: string | null) => {
    const next: ActiveFilter =
      activeFilter.kind === kind && activeFilter.value === value
        ? { kind: 'all', value: null }
        : { kind, value };
    setActiveFilter(next);
    if (next.kind !== 'all') setFilterCategory(next.kind);
    engineRef.current?.setFilter(next);
  };

  const toggleAutoDrift = () => {
    const next = !autoDrift;
    setAutoDrift(next);
    engineRef.current?.setAutoDrift(next);
  };

  const handleGraphUpdated = (newGraph: MemoryGraph, banner: string) => {
    setGraph(newGraph);
    setStorageRecovery(newGraph.storageRecovery ?? null);
    setSelectedMemory(null);
    setArrivedVia(null);
    setActiveFilter({ kind: 'all', value: null });
    setFilterCategory('all');
    engineRef.current?.setFilter({ kind: 'all', value: null });
    engineRef.current?.setGraph(newGraph);
    setBannerMsg(banner);
    window.setTimeout(() => setBannerMsg(null), 5000);
  };

  const handleReloadStorage = async () => {
    setRecoveryBusy(true);
    try {
      const res = await fetch('/api/storage/reload', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.graph) {
        const recovered = data.storageState !== 'damaged';
        handleGraphUpdated(
          data.graph,
          recovered
            ? 'Photo index recovered and loaded successfully'
            : 'Saved photo index is still damaged and remains preserved on disk'
        );
      }
    } finally {
      setRecoveryBusy(false);
    }
  };

  const handleArchiveAndReset = async () => {
    setRecoveryBusy(true);
    try {
      const res = await fetch('/api/reset-demo', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.graph) {
        const archiveNote = data.archivedDamagedPath
          ? `Damaged index preserved at ${data.archivedDamagedPath}`
          : 'Restored demo globe';
        handleGraphUpdated(data.graph, archiveNote);
      }
    } finally {
      setRecoveryBusy(false);
    }
  };

  const filterOptions: string[] = (() => {
    if (!graph) return [];
    if (filterCategory === 'person') return graph.stats.people;
    if (filterCategory === 'place') return graph.stats.places;
    if (filterCategory === 'event') return graph.stats.events;
    if (filterCategory === 'theme') return graph.stats.themes;
    return [];
  })();

  const clusterPageInfo = graph
    ? getClusterPage(graph.hubs, clusterDimension, clusterPage, CLUSTERS_PAGE_SIZE)
    : null;

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#03050b] select-none">
      {/* 3D WebGL Neural Memory Globe Canvas */}
      <div ref={mountRef} className="absolute inset-0 w-full h-full" />

      {/* Subtle top/bottom vignette for crisp HUD readability */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-[#03050b]/80 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-[#03050b]/85 to-transparent" />

      {/* Top HUD Bar */}
      <header className="fixed top-3.5 inset-x-3.5 z-30 flex items-center justify-between gap-2 pointer-events-none">
        {/* Brand + Live Graph Stats */}
        <div className="glass-pill rounded-2xl px-3.5 py-2 flex items-center gap-2.5 pointer-events-auto shrink-0">
          <div className="relative flex items-center justify-center w-8 h-8 rounded-xl bg-gradient-to-br from-cyan-500/30 to-violet-500/30 border border-cyan-400/40 shrink-0">
            <Brain className="w-4 h-4 text-cyan-300" />
            <span className="absolute inset-0 rounded-xl border border-cyan-400/50 animate-pulse-ring" />
          </div>
          <div className="whitespace-nowrap">
            <div className="flex items-center gap-1.5">
              <h1 className="font-editorial text-xl leading-none tracking-wide text-white">Synapse</h1>
              <span
                className={`text-[9px] font-mono-tech uppercase px-1.5 py-0.5 rounded-md border whitespace-nowrap ${
                  graph?.stats.source === 'demo'
                    ? 'bg-cyan-500/15 text-cyan-300 border-cyan-400/30'
                    : 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30'
                }`}
              >
                {graph?.stats.source === 'demo' ? 'Demo' : 'Personal'}
              </span>
            </div>
            {graph && (
              <p className="text-[10px] font-mono-tech text-slate-400 mt-0.5 whitespace-nowrap">
                {graph.stats.totalMemories} memories · {graph.stats.totalSynapses} synapses
              </p>
            )}
          </div>
        </div>

        {/* Center Morph Mode Switcher */}
        <div className="glass-pill rounded-2xl p-1 flex items-center gap-0.5 pointer-events-auto shrink-0">
          {(
            [
              { id: 'neural', label: 'Neural Dome', icon: Brain },
              { id: 'globe', label: 'Earth Globe', icon: Globe2 },
              { id: 'clusters', label: 'Clusters', icon: Network },
            ] as const
          ).map(({ id, label, icon: Icon }) => {
            const active = morphMode === id;
            return (
              <button
                key={id}
                onClick={() => handleMorphChange(id)}
                className={`px-3 py-1.5 rounded-xl text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap transition cursor-pointer ${
                  active
                    ? 'bg-white/15 text-white shadow-inner border border-white/20'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-white/5 border border-transparent'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 shrink-0 ${active ? 'text-cyan-300' : ''}`} />
                <span className="hidden lg:inline">{label}</span>
              </button>
            );
          })}
        </div>

        {/* Right Action Buttons */}
        <div className="flex items-center gap-1.5 pointer-events-auto shrink-0">
          <button
            onClick={toggleAutoDrift}
            className={`glass-pill px-3 py-2 rounded-xl text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap transition cursor-pointer ${
              autoDrift
                ? 'border-cyan-400/60 text-cyan-200 bg-cyan-500/20'
                : 'text-slate-200 hover:bg-white/10'
            }`}
            title="Automatically fire from memory to related memory"
          >
            {autoDrift ? <Pause className="w-3.5 h-3.5 shrink-0" /> : <Play className="w-3.5 h-3.5 shrink-0" />}
            <span className="hidden xl:inline">{autoDrift ? 'Drifting' : 'Synaptic Drift'}</span>
          </button>

          <button
            onClick={() => setModalOpen(true)}
            className="px-3 py-2 rounded-xl text-xs font-semibold bg-gradient-to-r from-cyan-500/90 to-violet-500/90 hover:from-cyan-400 hover:to-violet-400 text-slate-950 transition inline-flex items-center gap-1.5 whitespace-nowrap shadow-lg shadow-cyan-500/15 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5 shrink-0" />
            <span>Import</span>
            <Sparkles className="w-3 h-3 opacity-80 shrink-0" />
          </button>

          <button
            onClick={() => engineRef.current?.resetView()}
            className="glass-pill p-2 rounded-xl text-slate-300 hover:text-white hover:bg-white/10 transition cursor-pointer shrink-0"
            title="Reset camera view (Esc)"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Damaged Photo Index Recovery Banner */}
      {storageRecovery && (
        <div
          role="alert"
          className="fixed top-20 left-1/2 -translate-x-1/2 z-40 w-[min(640px,calc(100vw-2rem))] glass-panel border-amber-400/50 bg-amber-950/80 text-amber-100 px-4 py-3 rounded-2xl shadow-2xl flex flex-col gap-2"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-amber-200">
                Saved Photo Index Needs Recovery (Preserved Untouched on Disk)
              </div>
              <p className="text-[11px] text-amber-100/90 mt-0.5 leading-relaxed">
                {storageRecovery.message}
              </p>
              <p className="text-[10px] font-mono-tech text-amber-200/80 mt-1 truncate" title={storageRecovery.damagedPath}>
                File: {storageRecovery.damagedPath}
              </p>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 pt-0.5">
            <button
              onClick={handleReloadStorage}
              disabled={recoveryBusy}
              className="px-3 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/35 border border-amber-400/40 text-[11px] font-medium text-amber-100 inline-flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${recoveryBusy ? 'animate-spin' : ''}`} />
              Retry Load
            </button>
            <button
              onClick={handleArchiveAndReset}
              disabled={recoveryBusy}
              className="px-3 py-1.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 text-[11px] font-semibold transition cursor-pointer disabled:opacity-50"
            >
              Archive Damaged Copy &amp; Start Fresh
            </button>
          </div>
        </div>
      )}

      {/* Success Banner Toast */}
      {bannerMsg && !storageRecovery && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-40 glass-pill border-emerald-400/40 bg-emerald-950/70 text-emerald-100 px-4 py-2 rounded-full text-xs flex items-center gap-2 shadow-xl">
          <Sparkles className="w-3.5 h-3.5 text-emerald-300" />
          {bannerMsg}
        </div>
      )}

      {/* Contextual Sub-Bar for Clusters Grouping & Opened Group Breadcrumb */}
      {!storageRecovery && (morphMode === 'clusters' || openedGroup) && (
        <div className="fixed top-[68px] left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 pointer-events-auto">
          {openedGroup ? (
            <div className="glass-pill rounded-full px-3.5 py-1.5 flex items-center gap-2.5 text-xs shadow-lg">
              <button
                onClick={() => engineRef.current?.closeOpenGroup()}
                className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200 font-medium transition cursor-pointer"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                {openedGroup.mode === 'clusters' ? 'All Groups' : 'Globe Overview'}
              </button>
              <span className="text-slate-600">·</span>
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: openedGroup.color, boxShadow: `0 0 8px ${openedGroup.color}` }}
              />
              <span className="text-white font-medium">{openedGroup.label}</span>
              <span className="text-slate-400 font-mono-tech text-[11px]">
                {openedGroup.count} {openedGroup.count === 1 ? 'memory' : 'memories'}
              </span>
            </div>
          ) : (
            morphMode === 'clusters' && (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <div className="glass-pill rounded-full p-1 flex items-center gap-1 text-[11px]">
                  <span className="px-2.5 text-slate-400">Group by</span>
                  {(
                    [
                      { id: 'event', label: 'Events' },
                      { id: 'person', label: 'People' },
                      { id: 'place', label: 'Places' },
                    ] as const
                  ).map(({ id, label }) => {
                    const active = clusterDimension === id;
                    const col = SYNAPSE_COLORS[id];
                    return (
                      <button
                        key={id}
                        onClick={() => handleClusterDimensionChange(id)}
                        className={`px-3 py-1 rounded-full font-medium inline-flex items-center gap-1.5 transition cursor-pointer ${
                          active ? 'bg-white/15 text-white' : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: col }}
                        />
                        {label}
                      </button>
                    );
                  })}
                </div>

                {clusterPageInfo && clusterPageInfo.totalPages > 1 && (
                  <div className="glass-pill rounded-full p-1 flex items-center gap-1 text-[11px]">
                    <button
                      onClick={() => handleClusterPageChange(clusterPageInfo.page - 1)}
                      disabled={clusterPageInfo.page === 0}
                      className="px-2.5 py-1 rounded-full text-slate-200 hover:bg-white/10 disabled:opacity-35 disabled:cursor-not-allowed inline-flex items-center gap-1 transition cursor-pointer"
                      aria-label="Previous groups page"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                      <span>Prev</span>
                    </button>
                    <span className="px-2 font-mono-tech text-[10px] text-slate-300 whitespace-nowrap">
                      {clusterPageInfo.page * clusterPageInfo.pageSize + 1}–
                      {clusterPageInfo.page * clusterPageInfo.pageSize + clusterPageInfo.items.length} of{' '}
                      {clusterPageInfo.totalGroups}
                    </span>
                    <button
                      onClick={() => handleClusterPageChange(clusterPageInfo.page + 1)}
                      disabled={clusterPageInfo.page >= clusterPageInfo.totalPages - 1}
                      className="px-2.5 py-1 rounded-full text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-35 disabled:cursor-not-allowed inline-flex items-center gap-1 font-medium transition cursor-pointer"
                      aria-label="More groups"
                    >
                      <span>More groups</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            )
          )}
        </div>
      )}

      {/* Synaptic Jump Breadcrumb Toast */}
      {synapseToast && (
        <div
          role="status"
          className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 glass-panel rounded-full px-4 py-2 flex items-center gap-2.5 text-xs pointer-events-none border-cyan-400/45 shadow-2xl"
        >
          <span className="text-slate-300 max-w-[170px] truncate">{synapseToast.fromTitle}</span>
          <span
            className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full font-medium text-[11px] whitespace-nowrap"
            style={{
              backgroundColor: `${SYNAPSE_COLORS[synapseToast.kind]}28`,
              color: SYNAPSE_COLORS[synapseToast.kind],
              border: `1px solid ${SYNAPSE_COLORS[synapseToast.kind]}66`,
            }}
          >
            <Zap className="w-3 h-3" />
            {synapseToast.reason}
          </span>
          <span className="text-white font-medium max-w-[180px] truncate">{synapseToast.toTitle}</span>
        </div>
      )}

      {/* Subtle Hover Memory or Group Label */}
      {!synapseToast && hoveredGroupLabel && !hoveredMemory && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-20 glass-pill rounded-full px-4 py-1.5 text-xs flex items-center gap-2 pointer-events-none">
          <span className="text-white font-medium">{hoveredGroupLabel}</span>
          <span className="text-cyan-300">· Click to open group</span>
        </div>
      )}
      {hoveredMemory && hoveredMemory.id !== selectedMemory?.id && !synapseToast && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-20 glass-pill rounded-full px-4 py-1.5 text-xs flex items-center gap-2 pointer-events-none">
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: hoveredMemory.palette[0], boxShadow: `0 0 8px ${hoveredMemory.palette[0]}` }}
          />
          <span className="text-white font-medium">{hoveredMemory.title}</span>
          <span className="text-slate-400">· {hoveredMemory.locationName}</span>
          <span className="text-slate-500 font-mono-tech text-[10px]">{hoveredMemory.dateLabel}</span>
        </div>
      )}

      {/* Bottom HUD: Synaptic Cascade Filters & Controls Guide */}
      <footer className="fixed bottom-4 inset-x-4 z-30 flex flex-col gap-2 pointer-events-none">
        {/* Expanded Entity Filter Pills */}
        {filterCategory !== 'all' && filterOptions.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 max-w-2xl pointer-events-auto">
            {filterOptions.map((val) => {
              const isSelected = activeFilter.kind === filterCategory && activeFilter.value === val;
              const col = SYNAPSE_COLORS[filterCategory];
              return (
                <button
                  key={val}
                  onClick={() => handleApplyFilter(filterCategory, val)}
                  className="shrink-0 px-3 py-1 rounded-full text-[11px] font-medium transition cursor-pointer backdrop-blur-md"
                  style={
                    isSelected
                      ? { backgroundColor: col, color: '#03050b', boxShadow: `0 0 18px ${col}88` }
                      : {
                          backgroundColor: 'rgba(9, 14, 28, 0.78)',
                          color: '#cbd5e1',
                          border: `1px solid ${col}44`,
                        }
                  }
                >
                  {val}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Dimension Filter Tabs + Color Legend */}
          <div className="glass-pill rounded-2xl p-1 flex items-center gap-1 pointer-events-auto">
            <button
              onClick={() => {
                setFilterCategory('all');
                handleApplyFilter('all', null);
              }}
              className={`px-3 py-1.5 rounded-xl text-[11px] font-medium transition cursor-pointer ${
                filterCategory === 'all' && !activeFilter.value
                  ? 'bg-white/15 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              All Synapses
            </button>
            {(
              [
                { kind: 'person', label: 'People', icon: Users },
                { kind: 'place', label: 'Places', icon: MapPin },
                { kind: 'event', label: 'Events', icon: Calendar },
                { kind: 'theme', label: 'Themes', icon: Tag },
              ] as const
            ).map(({ kind, label, icon: Icon }) => {
              const color = SYNAPSE_COLORS[kind];
              const isOpen = filterCategory === kind;
              return (
                <button
                  key={kind}
                  onClick={() => setFilterCategory(isOpen ? 'all' : kind)}
                  className={`px-3 py-1.5 rounded-xl text-[11px] font-medium inline-flex items-center gap-1.5 transition cursor-pointer ${
                    isOpen ? 'bg-white/15 text-white' : 'text-slate-300 hover:bg-white/5'
                  }`}
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}` }}
                  />
                  <Icon className="w-3 h-3 opacity-80" />
                  <span>{label}</span>
                </button>
              );
            })}

            {activeFilter.value && (
              <button
                onClick={() => {
                  setActiveFilter({ kind: 'all', value: null });
                  engineRef.current?.setFilter({ kind: 'all', value: null });
                }}
                className="ml-1 px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-[10px] text-slate-200 inline-flex items-center gap-1 cursor-pointer"
              >
                {activeFilter.value}
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Subtle Interactive Hint Pill */}
          <div className="glass-pill rounded-full px-3.5 py-1.5 text-[11px] text-slate-400 hidden lg:flex items-center gap-2.5">
            <span>Drag to look 360°</span>
            <span className="text-slate-600">·</span>
            <span className="text-cyan-300/90">Scroll in to dive &amp; jump synapses</span>
            <span className="text-slate-600">·</span>
            <span>
              <kbd className="font-mono-tech text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-slate-200">Space</kbd> next neuron
            </span>
          </div>
        </div>
      </footer>

      {/* Right Memory Inspector Drawer */}
      <MemoryInspector
        memory={selectedMemory}
        graph={graph}
        arrivedVia={arrivedVia}
        onClose={() => engineRef.current?.resetView()}
        onJumpToMemory={(targetId, edge) => {
          if (selectedMemory && graph) {
            const target = graph.memories.find((m) => m.id === targetId);
            if (target) showSynapseToast(selectedMemory, target, edge);
          }
          engineRef.current?.focusMemory(targetId, edge);
        }}
        onFireNext={() => engineRef.current?.fireNextSynapse()}
        onStepBack={() => engineRef.current?.stepBackSynapse()}
        onSelectFilter={(kind, value) => handleApplyFilter(kind, value)}
      />

      {/* Google Takeout Importer & Gemini AI Enrichment Modal */}
      <ImportEnrichModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        hasEnvGeminiKey={hasEnvGeminiKey}
        isDemo={graph?.stats.source === 'demo'}
        memoryCount={graph?.stats.totalMemories ?? 0}
        onGraphUpdated={handleGraphUpdated}
      />
    </div>
  );
};

export default App;
