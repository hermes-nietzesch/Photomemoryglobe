import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import type { RawMemoryInput } from '../shared/types.ts';

export interface GeminiEnrichmentResult {
  title: string;
  caption: string;
  locationName?: string;
  event?: string;
  mood: string;
  themes: string[];
  peopleHints: string[];
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const ENRICHMENT_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Short evocative 2-5 word title for this personal memory.',
    },
    caption: {
      type: 'string',
      description: 'One vivid, warm sentence describing what makes this moment memorable.',
    },
    locationName: {
      type: 'string',
      description: 'Best inferred city/region or setting name if visible or implied by coordinates.',
    },
    event: {
      type: 'string',
      description: 'Concise event or trip name (e.g., "Autumn in Japan", "Weekend Coastal Hike").',
    },
    mood: {
      type: 'string',
      description: 'Single evocative mood word (e.g., Serene, Electric, Joyful, Nostalgic).',
    },
    themes: {
      type: 'array',
      items: { type: 'string' },
      description:
        '2 to 4 recurring visual/emotional themes to connect related memories (e.g., "Golden Hour", "Ocean Coastlines", "Shared Meals", "Night Lights", "Mountain Horizons", "Family Moments", "Architecture", "Forests & Trails").',
    },
    peopleHints: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Any known people from metadata plus short descriptors if unnamed people appear (leave empty if no people).',
    },
  },
  required: ['title', 'caption', 'mood', 'themes', 'peopleHints'],
};

export async function enrichMemoriesWithGemini(
  memories: RawMemoryInput[],
  options: {
    apiKey?: string;
    model?: string;
    limit?: number;
  }
): Promise<{ enrichedCount: number; updated: RawMemoryInput[]; errors: string[] }> {
  const apiKey = options.apiKey?.trim() || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY. Provide an API key in the enrichment panel or environment.');
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = options.model || 'gemini-4-hydrogen';
  const limit = Math.min(options.limit ?? 15, memories.length);

  const targets = memories.slice(0, limit);
  const updatedMap = new Map<string, RawMemoryInput>();
  const errors: string[] = [];
  let enrichedCount = 0;

  for (const mem of targets) {
    try {
      const metadataContext = [
        `Current title: ${mem.title}`,
        `Date: ${new Date(mem.timestamp).toISOString().slice(0, 10)}`,
        `Location metadata: ${mem.locationName}${mem.lat ? ` (${mem.lat.toFixed(3)}, ${mem.lng?.toFixed(3)})` : ''}`,
        `Event/Album: ${mem.event}`,
        `People tags: ${mem.people.length ? mem.people.join(', ') : 'None'}`,
        `Existing caption: ${mem.caption}`,
      ].join('\n');

      const prompt = `You are indexing personal photo memories for an interactive 3D neural memory globe where related memories interlace like neurons.
Analyze this memory and return structured JSON with a poetic title, concise caption, refined place/event if applicable, mood, and 2-4 consistent recurring theme tags so related moments connect across years.

Metadata:
${metadataContext}`;

      let input: string | Array<Record<string, unknown>> = prompt;

      if (mem.filePath) {
        const ext = path.extname(mem.filePath).toLowerCase();
        const mimeType = MIME_BY_EXT[ext] || 'image/jpeg';
        const buf = await fs.readFile(mem.filePath);
        // Only send inline base64 if file is under 6MB
        if (buf.byteLength <= 6 * 1024 * 1024) {
          input = [
            { type: 'text', text: prompt },
            {
              type: 'image',
              data: buf.toString('base64'),
              mime_type: mimeType,
            },
          ];
        }
      }

      const interaction = await ai.interactions.create({
        model,
        input: input as never,
        response_format: ENRICHMENT_SCHEMA,
        store: false,
      });

      const rawText = interaction.output_text;
      if (!rawText) continue;

      const parsed = JSON.parse(rawText) as GeminiEnrichmentResult;
      const mergedThemes = Array.from(
        new Set([...(parsed.themes || []), ...mem.themes].map((t) => t.trim()).filter(Boolean))
      ).slice(0, 5);

      const mergedPeople = Array.from(
        new Set([...mem.people, ...(parsed.peopleHints || [])].map((p) => p.trim()).filter(Boolean))
      );

      updatedMap.set(mem.id, {
        ...mem,
        title: parsed.title?.trim() || mem.title,
        caption: parsed.caption?.trim() || mem.caption,
        locationName:
          mem.locationName === 'Unmapped Place' && parsed.locationName?.trim()
            ? parsed.locationName.trim()
            : mem.locationName,
        event: parsed.event?.trim() || mem.event,
        mood: parsed.mood?.trim() || mem.mood,
        themes: mergedThemes,
        people: mergedPeople,
        enriched: true,
      });
      enrichedCount++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${mem.title}: ${msg}`);
    }
  }

  const updated = memories.map((m) => updatedMap.get(m.id) ?? m);
  return { enrichedCount, updated, errors };
}
