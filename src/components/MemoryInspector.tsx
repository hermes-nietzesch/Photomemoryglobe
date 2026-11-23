import React from 'react';
import {
  X,
  MapPin,
  Calendar,
  Users,
  Sparkles,
  Zap,
  ArrowLeft,
  Compass,
} from 'lucide-react';
import type { MemoryGraph, MemoryNode, SynapseEdge, SynapseKind } from '../../shared/types.ts';
import { SYNAPSE_COLORS } from '../../shared/types.ts';
import { getMemoryArtworkDataUrl } from '../utils/memoryArt.ts';

interface MemoryInspectorProps {
  memory: MemoryNode | null;
  graph: MemoryGraph | null;
  arrivedVia: SynapseEdge | null;
  onClose: () => void;
  onJumpToMemory: (memoryId: string, viaEdge: SynapseEdge) => void;
  onFireNext: () => void;
  onStepBack: () => void;
  onSelectFilter: (kind: SynapseKind, value: string) => void;
}

export const MemoryInspector: React.FC<MemoryInspectorProps> = ({
  memory,
  graph,
  arrivedVia,
  onClose,
  onJumpToMemory,
  onFireNext,
  onStepBack,
  onSelectFilter,
}) => {
  if (!memory || !graph) return null;

  const connected = graph.edges
    .filter((e) => e.source === memory.id || e.target === memory.id)
    .map((edge) => {
      const otherId = edge.source === memory.id ? edge.target : edge.source;
      const other = graph.memories.find((m) => m.id === otherId);
      return other ? { edge, other } : null;
    })
    .filter((x): x is { edge: SynapseEdge; other: MemoryNode } => x !== null)
    .sort((a, b) => b.edge.weight - a.edge.weight);

  const imgSrc = getMemoryArtworkDataUrl(memory);

  return (
    <aside className="fixed right-4 top-20 bottom-6 z-30 w-[360px] max-w-[calc(100vw-2rem)] glass-panel rounded-2xl flex flex-col overflow-hidden animate-in fade-in slide-in-from-right-4 duration-300">
      {/* Photo Header */}
      <div className="relative h-52 w-full shrink-0 overflow-hidden bg-slate-950">
        <img
          src={imgSrc}
          alt={memory.title}
          className="h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#070b17] via-transparent to-black/35" />

        <div className="absolute top-3 left-3 flex items-center gap-1.5">
          <span className="px-2.5 py-1 rounded-full bg-black/55 backdrop-blur-md border border-white/15 text-[11px] font-medium text-slate-100">
            {memory.mood}
          </span>
          {memory.enriched && (
            <span className="px-2 py-1 rounded-full bg-violet-500/30 backdrop-blur-md border border-violet-300/40 text-[10px] font-medium text-violet-100 inline-flex items-center gap-1">
              <Sparkles className="w-3 h-3" /> Gemini
            </span>
          )}
        </div>

        <button
          onClick={onClose}
          className="absolute top-3 right-3 p-1.5 rounded-full bg-black/55 hover:bg-black/80 text-slate-200 transition cursor-pointer"
          aria-label="Close inspector"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="absolute bottom-3 left-4 right-4">
          {arrivedVia && (
            <div className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-cyan-200 bg-cyan-950/80 border border-cyan-400/35 px-2.5 py-0.5 rounded-full mb-1.5">
              <Zap className="w-2.5 h-2.5 text-cyan-300" />
              Synapse via {arrivedVia.reasons.map((r) => r.label).slice(0, 2).join(' · ') || arrivedVia.label}
            </div>
          )}
          <h3 className="font-editorial text-2xl leading-tight text-white drop-shadow">
            {memory.title}
          </h3>
        </div>
      </div>

      {/* Scrollable Metadata & Synapses */}
      <div className="flex-1 overflow-y-auto px-4 py-3.5 space-y-4">
        {/* Date + Location */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-300">
          <span className="inline-flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5 text-violet-400" />
            {memory.dateLabel}
          </span>
          <button
            onClick={() => onSelectFilter('place', memory.locationName)}
            className="inline-flex items-center gap-1.5 hover:text-cyan-300 transition cursor-pointer"
          >
            <MapPin className="w-3.5 h-3.5 text-cyan-400" />
            {memory.locationName}
          </button>
        </div>

        {/* Caption */}
        <p className="text-xs leading-relaxed text-slate-300/95">{memory.caption}</p>

        {/* People, Event & Themes Chips */}
        <div className="space-y-2.5 pt-1">
          {memory.people.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-rose-400 mr-0.5" />
              {memory.people.map((person) => (
                <button
                  key={person}
                  onClick={() => onSelectFilter('person', person)}
                  className="px-2.5 py-0.5 rounded-full text-[11px] bg-rose-500/15 hover:bg-rose-500/30 border border-rose-400/30 text-rose-200 transition cursor-pointer"
                >
                  {person}
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <Compass className="w-3.5 h-3.5 text-violet-400 mr-0.5" />
            <button
              onClick={() => onSelectFilter('event', memory.event)}
              className="px-2.5 py-0.5 rounded-full text-[11px] bg-violet-500/15 hover:bg-violet-500/30 border border-violet-400/30 text-violet-200 transition cursor-pointer"
            >
              {memory.event}
            </button>
            {memory.themes.map((theme) => (
              <button
                key={theme}
                onClick={() => onSelectFilter('theme', theme)}
                className="px-2.5 py-0.5 rounded-full text-[11px] bg-amber-500/15 hover:bg-amber-500/30 border border-amber-400/30 text-amber-200 transition cursor-pointer"
              >
                {theme}
              </button>
            ))}
          </div>
        </div>

        {/* Interlaced Memories (Synaptic Connections) */}
        <div className="pt-2 border-t border-slate-800/80">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Interlaced Memories ({connected.length})
            </span>
            <span className="text-[10px] text-slate-500">Scroll in or click to jump</span>
          </div>

          <div className="space-y-2">
            {connected.map(({ edge, other }) => {
              const color = SYNAPSE_COLORS[edge.kind];
              return (
                <button
                  key={edge.id}
                  onClick={() => onJumpToMemory(other.id, edge)}
                  className="w-full flex items-center gap-3 p-2 rounded-xl bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.06] hover:border-cyan-400/35 text-left transition group cursor-pointer"
                >
                  <img
                    src={getMemoryArtworkDataUrl(other)}
                    alt={other.title}
                    className="w-12 h-9 rounded-lg object-cover shrink-0 border border-white/10"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-slate-100 truncate group-hover:text-cyan-200 transition">
                      {other.title}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}` }}
                      />
                      <span className="text-[10px] text-slate-400 truncate">
                        {edge.reasons.map((r) => r.label).slice(0, 2).join(' · ')}
                      </span>
                    </div>
                  </div>
                  <Zap className="w-3.5 h-3.5 text-slate-500 group-hover:text-cyan-300 shrink-0 transition" />
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Footer Neural Navigation Controls */}
      <div className="px-4 py-3 border-t border-slate-800/80 flex items-center gap-2 bg-slate-950/60">
        <button
          onClick={onStepBack}
          className="px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs text-slate-300 transition inline-flex items-center gap-1.5 cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back
        </button>
        <button
          onClick={onFireNext}
          className="flex-1 py-2 px-3 rounded-xl bg-gradient-to-r from-cyan-500/90 to-violet-500/90 hover:from-cyan-400 hover:to-violet-400 text-slate-950 font-semibold text-xs transition inline-flex items-center justify-center gap-1.5 cursor-pointer"
        >
          <Zap className="w-3.5 h-3.5" />
          Fire Next Synapse
        </button>
      </div>
    </aside>
  );
};
