import type { MemoryNode } from '../../shared/types.ts';

const artCache = new Map<string, string>();

function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seedStr: string) {
  let s = hashSeed(seedStr) || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function renderMemoryArtworkCanvas(memory: MemoryNode, width = 480, height = 340): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const rand = makeRng(memory.id + (memory.sceneKey || ''));
  const [c1, c2, c3] = memory.palette;

  // Base atmospheric gradient sky
  const bg = ctx.createLinearGradient(0, 0, width * 0.3, height);
  bg.addColorStop(0, c3);
  bg.addColorStop(0.52, c1);
  bg.addColorStop(1, c2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // Luminous atmospheric glow orb
  const sunX = width * (0.28 + rand() * 0.44);
  const sunY = height * (0.22 + rand() * 0.34);
  const glow = ctx.createRadialGradient(sunX, sunY, 6, sunX, sunY, width * 0.58);
  glow.addColorStop(0, 'rgba(255,255,255,0.85)');
  glow.addColorStop(0.18, `${c2}aa`);
  glow.addColorStop(0.55, `${c1}44`);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  const key = memory.sceneKey || 'default';

  // Scene-specific atmospheric painterly silhouettes
  if (key === 'aurora' || key === 'milky_way') {
    // Deep cosmic sky + stars
    ctx.fillStyle = 'rgba(4, 8, 22, 0.72)';
    ctx.fillRect(0, 0, width, height);

    for (let i = 0; i < 120; i++) {
      const sx = rand() * width;
      const sy = rand() * height * 0.72;
      const sr = 0.5 + rand() * 1.8;
      ctx.fillStyle = `rgba(255,255,255,${0.25 + rand() * 0.75})`;
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fill();
    }

    if (key === 'aurora') {
      for (let ribbon = 0; ribbon < 3; ribbon++) {
        ctx.save();
        const grad = ctx.createLinearGradient(0, height * 0.1, 0, height * 0.65);
        grad.addColorStop(0, 'rgba(52, 211, 153, 0)');
        grad.addColorStop(0.45, ribbon % 2 === 0 ? 'rgba(52, 211, 153, 0.55)' : 'rgba(129, 140, 248, 0.48)');
        grad.addColorStop(1, 'rgba(34, 211, 238, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(0, height * (0.35 + ribbon * 0.08));
        for (let x = 0; x <= width; x += 24) {
          const wave = Math.sin(x * 0.015 + ribbon * 2) * 32 + Math.cos(x * 0.03) * 14;
          ctx.lineTo(x, height * (0.28 + ribbon * 0.07) + wave);
        }
        ctx.lineTo(width, height * 0.72);
        ctx.lineTo(0, height * 0.72);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    } else {
      // Milky Way diagonal band
      ctx.save();
      ctx.translate(width * 0.5, height * 0.45);
      ctx.rotate(-0.48);
      const band = ctx.createRadialGradient(0, 0, 12, 0, 0, width * 0.65);
      band.addColorStop(0, 'rgba(224, 231, 255, 0.65)');
      band.addColorStop(0.3, 'rgba(129, 140, 248, 0.35)');
      band.addColorStop(0.7, 'rgba(34, 211, 238, 0.12)');
      band.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.scale(1.6, 0.35);
      ctx.fillStyle = band;
      ctx.beginPath();
      ctx.arc(0, 0, width * 0.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Horizon silhouette + mirror reflection
    ctx.fillStyle = '#060a14';
    ctx.beginPath();
    ctx.moveTo(0, height * 0.72);
    ctx.lineTo(width * 0.28, height * 0.54);
    ctx.lineTo(width * 0.48, height * 0.68);
    ctx.lineTo(width * 0.72, height * 0.56);
    ctx.lineTo(width, height * 0.7);
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fill();

    // Water shimmer
    const water = ctx.createLinearGradient(0, height * 0.72, 0, height);
    water.addColorStop(0, `${c1}55`);
    water.addColorStop(1, '#040712');
    ctx.fillStyle = water;
    ctx.fillRect(0, height * 0.72, width, height * 0.28);
  } else if (key === 'torii') {
    // Perspective vermilion torii gates fading into golden mist
    for (let g = 5; g >= 0; g--) {
      const scale = 0.34 + g * 0.14;
      const cx = width * 0.5;
      const cy = height * 0.62;
      const gw = 190 * scale;
      const gh = 165 * scale;
      const alpha = 0.28 + (5 - g) * 0.14;
      ctx.fillStyle = `rgba(220, 48, 36, ${Math.min(0.95, alpha)})`;
      // Pillars
      const pw = Math.max(4, 14 * scale);
      ctx.fillRect(cx - gw * 0.42, cy - gh * 0.52, pw, gh);
      ctx.fillRect(cx + gw * 0.42 - pw, cy - gh * 0.52, pw, gh);
      // Crossbeams
      ctx.fillRect(cx - gw * 0.56, cy - gh * 0.56, gw * 1.12, pw * 1.15);
      ctx.fillRect(cx - gw * 0.48, cy - gh * 0.36, gw * 0.96, pw * 0.75);
    }
  } else if (key === 'neon_alley' || key === 'jazz_club' || key === 'lanterns') {
    ctx.fillStyle = 'rgba(7, 8, 20, 0.62)';
    ctx.fillRect(0, 0, width, height);
    // Perspective alley walls
    ctx.fillStyle = '#090b18';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(width * 0.36, height * 0.24);
    ctx.lineTo(width * 0.36, height * 0.78);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(width, 0);
    ctx.lineTo(width * 0.64, height * 0.24);
    ctx.lineTo(width * 0.64, height * 0.78);
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fill();

    // Glowing lanterns / neon bokeh
    for (let i = 0; i < 24; i++) {
      const lx = width * (0.12 + rand() * 0.76);
      const ly = height * (0.14 + rand() * 0.52);
      const r = 6 + rand() * 18;
      const col = i % 2 === 0 ? c1 : c2;
      const lg = ctx.createRadialGradient(lx, ly, 1, lx, ly, r * 2.2);
      lg.addColorStop(0, '#ffffff');
      lg.addColorStop(0.3, col);
      lg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.arc(lx, ly, r * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    // Wet street reflections
    for (let i = 0; i < 18; i++) {
      const rx = width * (0.25 + rand() * 0.5);
      const ry = height * (0.76 + rand() * 0.22);
      ctx.fillStyle = i % 2 === 0 ? `${c1}66` : `${c2}66`;
      ctx.fillRect(rx - 18, ry, 36 + rand() * 32, 3);
    }
  } else if (key === 'bamboo' || key === 'redwoods' || key === 'misty_forest') {
    // Diagonal sunbeams
    ctx.save();
    for (let b = 0; b < 5; b++) {
      const grad = ctx.createLinearGradient(width * (0.15 + b * 0.16), 0, width * (0.35 + b * 0.16), height);
      grad.addColorStop(0, 'rgba(255,255,230,0.34)');
      grad.addColorStop(1, 'rgba(255,255,230,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(width * (0.12 + b * 0.17), 0);
      ctx.lineTo(width * (0.22 + b * 0.17), 0);
      ctx.lineTo(width * (0.44 + b * 0.17), height);
      ctx.lineTo(width * (0.28 + b * 0.17), height);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    // Vertical trunks / bamboo stalks
    for (let t = 0; t < 22; t++) {
      const tx = (t / 22) * width + rand() * 18;
      const tw = key === 'redwoods' ? 12 + rand() * 24 : 5 + rand() * 9;
      ctx.fillStyle = `rgba(6, 22, 16, ${0.35 + rand() * 0.55})`;
      ctx.fillRect(tx, 0, tw, height);
    }
  } else if (key === 'fuji' || key === 'alpine_peak' || key === 'mountain_lake' || key === 'glacier') {
    // Layered peaks
    const layers = [
      { y: 0.62, amp: 95, col: 'rgba(15, 23, 42, 0.52)' },
      { y: 0.72, amp: 70, col: 'rgba(10, 18, 34, 0.85)' },
    ];
    for (const layer of layers) {
      ctx.fillStyle = layer.col;
      ctx.beginPath();
      ctx.moveTo(0, height);
      ctx.lineTo(0, height * layer.y);
      ctx.lineTo(width * 0.25, height * (layer.y - 0.12));
      ctx.lineTo(width * 0.5, height * (layer.y - 0.34));
      ctx.lineTo(width * 0.76, height * (layer.y - 0.14));
      ctx.lineTo(width, height * layer.y);
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();
    }
    // Snow cap highlight
    ctx.fillStyle = 'rgba(255, 248, 245, 0.78)';
    ctx.beginPath();
    ctx.moveTo(width * 0.5, height * 0.28);
    ctx.lineTo(width * 0.43, height * 0.42);
    ctx.lineTo(width * 0.49, height * 0.39);
    ctx.lineTo(width * 0.56, height * 0.42);
    ctx.closePath();
    ctx.fill();

    // Lake mirror below
    const lake = ctx.createLinearGradient(0, height * 0.72, 0, height);
    lake.addColorStop(0, `${c1}66`);
    lake.addColorStop(1, c3);
    ctx.fillStyle = lake;
    ctx.fillRect(0, height * 0.72, width, height * 0.28);
  } else if (key === 'golden_gate' || key === 'city_bridge') {
    // Suspension bridge towers & cables
    const waterY = height * 0.72;
    ctx.fillStyle = `${c3}dd`;
    ctx.fillRect(0, waterY, width, height - waterY);
    // Mist bands
    const mist = ctx.createLinearGradient(0, height * 0.56, 0, height * 0.82);
    mist.addColorStop(0, 'rgba(255,255,255,0)');
    mist.addColorStop(0.5, 'rgba(226, 232, 240, 0.36)');
    mist.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = mist;
    ctx.fillRect(0, height * 0.56, width, height * 0.26);

    const bridgeColor = key === 'golden_gate' ? '#ea580c' : '#1e293b';
    ctx.strokeStyle = bridgeColor;
    ctx.fillStyle = bridgeColor;
    ctx.lineWidth = 4;
    // Towers
    for (const tx of [width * 0.32, width * 0.72]) {
      ctx.fillRect(tx - 7, height * 0.24, 14, height * 0.52);
      ctx.fillRect(tx - 16, height * 0.36, 32, 6);
      ctx.fillRect(tx - 16, height * 0.5, 32, 6);
    }
    // Deck
    ctx.fillRect(0, height * 0.64, width, 6);
    // Main suspension curve
    ctx.beginPath();
    ctx.moveTo(0, height * 0.56);
    ctx.quadraticCurveTo(width * 0.16, height * 0.62, width * 0.32, height * 0.26);
    ctx.quadraticCurveTo(width * 0.52, height * 0.66, width * 0.72, height * 0.26);
    ctx.quadraticCurveTo(width * 0.86, height * 0.58, width, height * 0.54);
    ctx.stroke();
  } else if (key === 'sahara_dunes') {
    // Sweeping desert dunes
    for (let d = 0; d < 3; d++) {
      ctx.fillStyle = d === 0 ? `${c1}bb` : d === 1 ? `${c2}aa` : '#3b150c';
      ctx.beginPath();
      ctx.moveTo(0, height);
      ctx.lineTo(0, height * (0.58 + d * 0.11));
      ctx.bezierCurveTo(
        width * 0.32,
        height * (0.44 + d * 0.1),
        width * 0.64,
        height * (0.76 + d * 0.05),
        width,
        height * (0.56 + d * 0.12)
      );
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();
    }
  } else if (key === 'rooftop_lights' || key === 'candle_dinner' || key === 'cabin_fire') {
    ctx.fillStyle = 'rgba(14, 10, 22, 0.55)';
    ctx.fillRect(0, 0, width, height);
    // Warm string lights / bokeh festoons
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.5;
    for (let row = 0; row < 2; row++) {
      ctx.beginPath();
      ctx.moveTo(0, height * (0.18 + row * 0.16));
      ctx.quadraticCurveTo(width * 0.5, height * (0.34 + row * 0.14), width, height * (0.16 + row * 0.18));
      ctx.stroke();
      for (let i = 1; i <= 9; i++) {
        const t = i / 10;
        const bx = width * t;
        const by =
          (1 - t) * (1 - t) * height * (0.18 + row * 0.16) +
          2 * (1 - t) * t * height * (0.34 + row * 0.14) +
          t * t * height * (0.16 + row * 0.18);
        const bgGlow = ctx.createRadialGradient(bx, by, 1, bx, by, 22);
        bgGlow.addColorStop(0, '#fffbeb');
        bgGlow.addColorStop(0.35, '#fbbf24aa');
        bgGlow.addColorStop(1, 'rgba(251,191,36,0)');
        ctx.fillStyle = bgGlow;
        ctx.beginPath();
        ctx.arc(bx, by, 22, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Warm foreground bokeh
    for (let i = 0; i < 16; i++) {
      const bx = rand() * width;
      const by = height * (0.5 + rand() * 0.45);
      const br = 8 + rand() * 24;
      const g = ctx.createRadialGradient(bx, by, 1, bx, by, br);
      g.addColorStop(0, 'rgba(255,245,220,0.75)');
      g.addColorStop(0.4, `${c1}66`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // Coastal cliffs / city skyline / harbor silhouette
    const horizon = height * 0.64;
    ctx.fillStyle = `${c3}cc`;
    ctx.beginPath();
    ctx.moveTo(0, height);
    ctx.lineTo(0, horizon);
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const px = (i / steps) * width;
      const py = horizon - (rand() * 48 + (i === 4 || i === 7 ? 32 : 0));
      ctx.lineTo(px, py);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fill();

    // Shimmering water / horizon highlights
    for (let i = 0; i < 24; i++) {
      const wx = rand() * width;
      const wy = horizon + 10 + rand() * (height - horizon - 14);
      ctx.fillStyle = `rgba(255,255,255,${0.12 + rand() * 0.35})`;
      ctx.fillRect(wx, wy, 18 + rand() * 42, 2);
    }
  }

  // Subtle film vignette + glowing editorial border
  const vig = ctx.createRadialGradient(
    width * 0.5,
    height * 0.48,
    width * 0.18,
    width * 0.5,
    height * 0.5,
    width * 0.72
  );
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(2, 4, 12, 0.55)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, width, height);

  return canvas;
}

export function getMemoryArtworkDataUrl(memory: MemoryNode): string {
  if (memory.imageUrl) return memory.imageUrl;
  const cached = artCache.get(memory.id);
  if (cached) return cached;
  const canvas = renderMemoryArtworkCanvas(memory, 480, 320);
  const url = canvas.toDataURL('image/jpeg', 0.9);
  artCache.set(memory.id, url);
  return url;
}
