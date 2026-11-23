export type SynapseKind = 'person' | 'place' | 'event' | 'theme';

export type MorphMode = 'neural' | 'globe' | 'clusters';

export interface RawMemoryInput {
  id: string;
  title: string;
  caption: string;
  timestamp: number;
  locationName: string;
  lat?: number;
  lng?: number;
  people: string[];
  event: string;
  themes: string[];
  mood: string;
  palette?: [string, string, string];
  sceneKey?: string;
  imageUrl?: string;
  filePath?: string;
  contentHash?: string;
  source: 'demo' | 'takeout' | 'upload';
  enriched?: boolean;
}

export interface MemoryNode extends RawMemoryInput {
  dateLabel: string;
  palette: [string, string, string];
  positions: {
    neural: [number, number, number];
    globe: [number, number, number];
    clusters: [number, number, number];
  };
  degree: number;
}

export interface SynapseEdge {
  id: string;
  source: string;
  target: string;
  kind: SynapseKind;
  label: string;
  weight: number;
  reasons: Array<{ kind: SynapseKind; label: string }>;
}

export interface ClusterHub {
  id: string;
  kind: 'person' | 'place' | 'event';
  label: string;
  color: string;
  count: number;
  position: [number, number, number];
}

export interface MemoryGraphStats {
  totalMemories: number;
  totalSynapses: number;
  people: string[];
  places: string[];
  events: string[];
  themes: string[];
  source: 'demo' | 'imported' | 'mixed';
}

export type StorageHealthState = 'demo' | 'loaded' | 'damaged';

export interface StorageRecoveryInfo {
  code: 'DAMAGED_INDEX' | 'READ_ERROR';
  message: string;
  damagedPath: string;
  archivedPath?: string;
  detail: string;
  detectedAt: string;
}

export interface MemoryGraph {
  memories: MemoryNode[];
  edges: SynapseEdge[];
  hubs: ClusterHub[];
  stats: MemoryGraphStats;
  storageState?: StorageHealthState;
  storageRecovery?: StorageRecoveryInfo | null;
}

export const SYNAPSE_COLORS: Record<SynapseKind, string> = {
  person: '#fb7185', // rose-coral
  place: '#22d3ee',  // electric cyan
  event: '#a78bfa',  // neural violet
  theme: '#f59e0b',  // warm synapse gold
};
