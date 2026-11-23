# Synapse — 3D Neural Memory Globe

An interactive 3D neural memory globe for your Google Photos library. Step *inside* a living cosmic sphere of memories interlaced by glowing synaptic pathways—people, places, events, and recurring themes—where scrolling in dives into a memory and fires you along neural filaments to related moments across years.

## Features

- **Inside-Out Neural Dome**: Start inside a luminous 360° cortical sphere surrounded by floating memories and continuously firing action-potential sparks.
- **Scroll-to-Dive Synaptic Navigation**: Drag to look 360°, scroll in to dive into a memory and jump along its brightest interlaced synapse, or press `Space` / `→` to fire the next synapse.
- **3 Seamless Morph Modes**:
  1. **Neural Dome** (`1`): Inside-out brain sphere of associative neighborhoods.
  2. **Earth Globe** (`2`): Holographic 3D Earth with great-circle neural arcs connecting geotagged locations.
  3. **Clusters** (`3`): 3D constellation hubs for People, Places, and Events.
- **Synaptic Cascades**: Click any Person, Place, Event, or Theme chip to send a ripple of neural light through all connected memories.
- **Google Takeout & Local Photo Importer**: Paste a local Google Takeout folder path (zero-copy scan matching `.json` / `.supplemental-metadata.json` sidecars + EXIF GPS/timestamps) or drag-and-drop photos directly.
- **Optional Gemini AI Enrichment**: Uses `@google/genai` (`gemini-4-hydrogen` / `gemini-3.5-flash-lite`) via the Interactions API to extract poetic titles, moods, places, and deeper cross-memory themes.

## Running Locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.
