import React, { useState, useRef } from 'react';
import {
  X,
  FolderOpen,
  Upload,
  Sparkles,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import type { MemoryGraph } from '../../shared/types.ts';

interface ImportEnrichModalProps {
  open: boolean;
  onClose: () => void;
  hasEnvGeminiKey: boolean;
  isDemo: boolean;
  memoryCount: number;
  onGraphUpdated: (graph: MemoryGraph, banner: string) => void;
}

export const ImportEnrichModal: React.FC<ImportEnrichModalProps> = ({
  open,
  onClose,
  hasEnvGeminiKey,
  isDemo,
  memoryCount,
  onGraphUpdated,
}) => {
  const [tab, setTab] = useState<'import' | 'gemini'>('import');
  const [folderPath, setFolderPath] = useState('');
  const [maxPhotos, setMaxPhotos] = useState(250);
  const [appendMode, setAppendMode] = useState(false);
  const [albumLabel, setAlbumLabel] = useState('');

  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gemini-4-hydrogen');
  const [enrichLimit, setEnrichLimit] = useState(15);

  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const handleFolderImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!folderPath.trim()) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await fetch('/api/import/folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderPath: folderPath.trim(),
          maxPhotos,
          append: appendMode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Folder import failed');
      const added = data.added ?? data.imported ?? 0;
      const skipped = data.skipped ?? 0;
      const skipNote = skipped > 0 ? `, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : '';
      setStatusMsg({
        type: 'ok',
        text: `Added ${added} memor${added === 1 ? 'y' : 'ies'}${skipNote} (${data.matchedSidecars} Google Takeout JSON sidecars matched).`,
      });
      onGraphUpdated(
        data.graph,
        `Added ${added} personal memor${added === 1 ? 'y' : 'ies'}${skipNote}`
      );
    } catch (err) {
      setStatusMsg({ type: 'err', text: err instanceof Error ? err.message : 'Import failed' });
    } finally {
      setBusy(false);
    }
  };

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      const form = new FormData();
      Array.from(files).forEach((f) => form.append('files', f));
      form.append('append', String(appendMode));
      if (albumLabel.trim()) form.append('albumLabel', albumLabel.trim());

      const res = await fetch('/api/import/upload', {
        method: 'POST',
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      const added = data.added ?? data.imported ?? 0;
      const skipped = data.skipped ?? 0;
      const skipNote = skipped > 0 ? `, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : '';
      setStatusMsg({
        type: 'ok',
        text: `Added ${added} photo${added === 1 ? '' : 's'}${skipNote} (${data.matchedSidecars} Takeout metadata files matched).`,
      });
      onGraphUpdated(data.graph, `Added ${added} uploaded memor${added === 1 ? 'y' : 'ies'}${skipNote}`);
    } catch (err) {
      setStatusMsg({ type: 'err', text: err instanceof Error ? err.message : 'Upload failed' });
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleGeminiEnrich = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await fetch('/api/enrich/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: apiKey.trim() || undefined,
          model,
          limit: enrichLimit,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Enrichment failed');
      const errNote = data.errors?.length ? ` (${data.errors.length} skipped)` : '';
      setStatusMsg({
        type: 'ok',
        text: `Gemini enriched ${data.enrichedCount} memories and wove new semantic synapses${errNote}.`,
      });
      onGraphUpdated(data.graph, `Gemini enriched ${data.enrichedCount} memories with new neural links`);
    } catch (err) {
      setStatusMsg({ type: 'err', text: err instanceof Error ? err.message : 'Enrichment failed' });
    } finally {
      setBusy(false);
    }
  };

  const handleResetDemo = async () => {
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await fetch('/api/reset-demo', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error('Failed to reset demo');
      setStatusMsg({ type: 'ok', text: 'Restored the 35-memory curated demo neural globe.' });
      onGraphUpdated(data.graph, 'Restored curated demo memory globe');
    } catch (err) {
      setStatusMsg({ type: 'err', text: err instanceof Error ? err.message : 'Reset failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Memory Ingestion and Neural Enrichment"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4"
    >
      <div className="glass-panel relative w-full max-w-2xl rounded-2xl overflow-hidden border border-slate-700/60">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800/80">
          <div>
            <h2 className="font-editorial text-2xl tracking-wide text-white">
              Memory Ingestion &amp; Neural Enrichment
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Connect your Google Photos Takeout export locally, then optionally weave deep Gemini AI synapses.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-full text-slate-400 hover:text-white hover:bg-white/10 transition cursor-pointer"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 px-6 pt-4">
          <button
            onClick={() => {
              setTab('import');
              setStatusMsg(null);
            }}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition cursor-pointer ${
              tab === 'import'
                ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/40'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5 border border-transparent'
            }`}
          >
            <FolderOpen className="w-4 h-4" />
            Google Takeout / Photos
          </button>
          <button
            onClick={() => {
              setTab('gemini');
              setStatusMsg(null);
            }}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition cursor-pointer ${
              tab === 'gemini'
                ? 'bg-violet-500/20 text-violet-200 border border-violet-400/40'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5 border border-transparent'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            Gemini AI Enrichment
          </button>
        </div>

        {/* Body */}
        <div className="p-6 max-h-[70vh] overflow-y-auto space-y-5">
          {tab === 'import' ? (
            <>
              {/* Takeout instructions */}
              <div className="rounded-xl bg-cyan-950/30 border border-cyan-500/20 p-3.5 text-xs text-slate-300 leading-relaxed">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-cyan-300 uppercase tracking-wider text-[11px]">
                    How to bring in your Google Photos
                  </span>
                  <a
                    href="https://takeout.google.com/"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200 underline underline-offset-2"
                  >
                    Open Google Takeout <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                Export <strong>Google Photos</strong> from Takeout, unzip it on your PC, and paste the folder path below.
                The local scanner automatically reads Google Takeout <code className="text-cyan-200">.json</code> sidecars
                (people tags, timestamps, GPS coordinates, descriptions) plus photo EXIF metadata.
              </div>

              {/* Local folder scanner */}
              <form onSubmit={handleFolderImport} className="space-y-3">
                <label className="block text-xs font-medium text-slate-300">
                  Scan Local Google Takeout or Photo Folder (Zero-copy, handles large libraries)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={folderPath}
                    onChange={(e) => setFolderPath(e.target.value)}
                    placeholder="e.g. C:\Users\henry\Downloads\Takeout\Google Photos"
                    className="flex-1 rounded-xl bg-slate-950/80 border border-slate-700/70 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400/70 font-mono-tech"
                  />
                  <button
                    type="submit"
                    disabled={busy || !folderPath.trim()}
                    className="px-4 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-slate-950 font-semibold text-sm transition flex items-center gap-2 cursor-pointer"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderOpen className="w-4 h-4" />}
                    Scan
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400 pt-1">
                  <label className="flex items-center gap-2">
                    <span>Max photos:</span>
                    <input
                      type="number"
                      min={10}
                      max={1500}
                      value={maxPhotos}
                      onChange={(e) => setMaxPhotos(Number(e.target.value))}
                      className="w-20 rounded-lg bg-slate-950/80 border border-slate-700/70 px-2 py-1 text-slate-200"
                    />
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={appendMode}
                      onChange={(e) => setAppendMode(e.target.checked)}
                      className="accent-cyan-400"
                    />
                    <span>Append to existing imported library</span>
                  </label>
                </div>
              </form>

              <div className="relative flex items-center py-1">
                <div className="flex-grow border-t border-slate-800" />
                <span className="px-3 text-[11px] uppercase tracking-widest text-slate-500">or quick batch upload</span>
                <div className="flex-grow border-t border-slate-800" />
              </div>

              {/* Direct File Picker / Drag Drop */}
              <div className="space-y-2.5">
                <input
                  type="text"
                  value={albumLabel}
                  onChange={(e) => setAlbumLabel(e.target.value)}
                  placeholder="Optional album/event label for uploaded photos (e.g. Summer in Lisbon)"
                  className="w-full rounded-xl bg-slate-950/70 border border-slate-800 px-3.5 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400/60"
                />
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleFileUpload(e.dataTransfer.files);
                  }}
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-xl border border-dashed border-slate-700 hover:border-cyan-400/60 bg-slate-900/40 hover:bg-cyan-950/20 p-6 text-center transition cursor-pointer"
                >
                  <Upload className="w-6 h-6 text-cyan-400 mx-auto mb-2" />
                  <p className="text-sm text-slate-200 font-medium">
                    Drop photos + Takeout <code className="text-cyan-300">.json</code> files here, or click to browse
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    Supports JPG, PNG, WebP + optional Google Takeout supplemental-metadata JSONs
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*,.json"
                    className="hidden"
                    onChange={(e) => handleFileUpload(e.target.files)}
                  />
                </div>
              </div>

              {!isDemo && (
                <div className="flex justify-end pt-1">
                  <button
                    type="button"
                    onClick={handleResetDemo}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Restore 35-memory Demo Globe
                  </button>
                </div>
              )}
            </>
          ) : (
            <form onSubmit={handleGeminiEnrich} className="space-y-4">
              <div className="rounded-xl bg-violet-950/30 border border-violet-500/25 p-3.5 text-xs text-slate-300 leading-relaxed">
                Uses the official <code className="text-violet-300">@google/genai</code> Interactions API to inspect your
                photos and metadata—extracting poetic memory titles, scene moods, inferred places, and hidden recurring
                themes that weave brand-new glowing synapses across years and trips.
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">
                  Gemini API Key{' '}
                  {hasEnvGeminiKey && (
                    <span className="text-emerald-400 font-normal ml-1">(Detected in environment — optional override)</span>
                  )}
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={hasEnvGeminiKey ? 'Using GEMINI_API_KEY from server environment' : 'Paste GEMINI_API_KEY...'}
                  className="w-full rounded-xl bg-slate-950/80 border border-slate-700/70 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-violet-400/70 font-mono-tech"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-300">Gemini Model</label>
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="w-full rounded-xl bg-slate-950/80 border border-slate-700/70 px-3 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-violet-400/70"
                  >
                    <option value="gemini-4-hydrogen">gemini-4-hydrogen (Balanced Multimodal)</option>
                    <option value="gemini-3.5-flash-lite">gemini-3.5-flash-lite (Ultra-Fast Batch)</option>
                    <option value="gemini-4-neon">gemini-4-neon (Frontier Intelligence)</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-300">
                    Memories to Enrich (of {memoryCount})
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={enrichLimit}
                    onChange={(e) => setEnrichLimit(Number(e.target.value))}
                    className="w-full rounded-xl bg-slate-950/80 border border-slate-700/70 px-3 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-violet-400/70"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={busy || (!hasEnvGeminiKey && !apiKey.trim())}
                className="w-full py-2.5 rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 hover:from-violet-400 hover:to-cyan-400 disabled:opacity-40 text-slate-950 font-semibold text-sm transition flex items-center justify-center gap-2 cursor-pointer"
              >
                {busy ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Analyzing memories &amp; weaving synapses...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    Weave AI Synapses with Gemini
                  </>
                )}
              </button>
            </form>
          )}

          {statusMsg && (
            <div
              className={`rounded-xl px-4 py-3 text-xs flex items-start gap-2.5 ${
                statusMsg.type === 'ok'
                  ? 'bg-emerald-950/50 border border-emerald-500/35 text-emerald-200'
                  : 'bg-rose-950/50 border border-rose-500/35 text-rose-200'
              }`}
            >
              {statusMsg.type === 'ok' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              )}
              <span>{statusMsg.text}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
