import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type {
  ClusterDimension,
  ClusterHub,
  GlobeRegionGroup,
  MemoryGraph,
  MemoryNode,
  MorphMode,
  SynapseEdge,
  SynapseKind,
} from '../../shared/types.ts';
import { SYNAPSE_COLORS } from '../../shared/types.ts';
import { WORLD_COASTLINES } from '../../shared/worldCoastlines.ts';
import {
  CLUSTERS_PAGE_SIZE,
  getClusterPage,
  latLngToCartesian,
} from '../../shared/graphEngine.ts';
import { renderMemoryArtworkCanvas } from '../utils/memoryArt.ts';

export interface ActiveFilter {
  kind: SynapseKind | 'all';
  value: string | null;
}

export interface OpenedGroupInfo {
  mode: 'clusters' | 'globe';
  id: string;
  label: string;
  count: number;
  color: string;
}

export interface EngineCallbacks {
  onHoverMemory: (memory: MemoryNode | null) => void;
  onHoverGroup?: (label: string | null) => void;
  onSelectMemory: (memory: MemoryNode | null, viaEdge?: SynapseEdge | null) => void;
  onSynapseJump: (from: MemoryNode, to: MemoryNode, edge: SynapseEdge) => void;
  onOpenGroupChange?: (group: OpenedGroupInfo | null) => void;
  onClusterPageChange?: (page: number) => void;
}

interface NodeVisual {
  memory: MemoryNode;
  group: THREE.Group;
  frameMesh: THREE.Mesh;
  frameMaterial: THREE.MeshBasicMaterial;
  backingMaterial: THREE.MeshBasicMaterial;
  borderMaterial: THREE.MeshBasicMaterial;
  coreSprite: THREE.Sprite;
  coreMaterial: THREE.SpriteMaterial;
  titleSprite: THREE.Sprite;
  titleMaterial: THREE.SpriteMaterial;
  currentPos: THREE.Vector3;
  targetPos: THREE.Vector3;
  baseScale: number;
  pulseEnergy: number;
  phase: number;
}

interface EdgeVisual {
  edge: SynapseEdge;
  line: THREE.Line;
  material: THREE.LineBasicMaterial;
  curve: THREE.QuadraticBezierCurve3;
  baseColor: THREE.Color;
  pulseCount: number;
}

interface GroupCardVisual {
  id: string;
  label: string;
  count: number;
  color: string;
  memoryIds: string[];
  group: THREE.Group;
  hitMeshes: THREE.Object3D[];
  cardMaterial: THREE.MeshBasicMaterial;
  borderMaterial: THREE.MeshBasicMaterial;
  stackMaterials: THREE.MeshBasicMaterial[];
  labelSprite: THREE.Sprite;
  labelMaterial: THREE.SpriteMaterial;
  position: THREE.Vector3;
  surfacePos?: THREE.Vector3;
  stemLine?: THREE.Line;
  stemMaterial?: THREE.LineBasicMaterial;
  kind?: ClusterDimension;
}

interface GroupLinkVisual {
  fromId: string;
  toId: string;
  line: THREE.Line;
  material: THREE.LineBasicMaterial;
  kind: SynapseKind;
}

interface ActionPotentialPulse {
  edgeIdx: number;
  t: number;
  speed: number;
  direction: 1 | -1;
  color: THREE.Color;
  boost: number;
}

interface CameraFlight {
  startPos: THREE.Vector3;
  controlPos: THREE.Vector3;
  endPos: THREE.Vector3;
  startLook: THREE.Vector3;
  endLook: THREE.Vector3;
  elapsed: number;
  duration: number;
  targetMemoryId: string | null;
}

function createSoftGlowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.92)');
  grad.addColorStop(0.24, 'rgba(255, 255, 255, 0.58)');
  grad.addColorStop(0.58, 'rgba(255, 255, 255, 0.14)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function createEarthTexture(): THREE.CanvasTexture {
  const width = 1024;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Deep nocturnal ocean gradient
  const ocean = ctx.createLinearGradient(0, 0, 0, height);
  ocean.addColorStop(0, '#07172d');
  ocean.addColorStop(0.5, '#040d1f');
  ocean.addColorStop(1, '#07172d');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, width, height);

  // Fill recognizable continental silhouettes with subtle luminous slate-teal
  ctx.fillStyle = '#113254';
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.42)';
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';

  for (const ring of WORLD_COASTLINES) {
    if (ring.length < 3) continue;
    ctx.beginPath();
    let prevLng: number | null = null;
    for (let i = 0; i < ring.length; i++) {
      const [lat, lng] = ring[i];
      const x = ((lng + 180) / 360) * width;
      const y = ((90 - lat) / 180) * height;
      // Avoid drawing wrap-around stripes across the dateline
      if (i === 0 || (prevLng !== null && Math.abs(lng - prevLng) > 160)) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      prevLng = lng;
    }
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) {
      ctx.closePath();
      ctx.fill();
    }
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function createMemoryCardTexture(memory: MemoryNode): THREE.CanvasTexture {
  const art = renderMemoryArtworkCanvas(memory, 384, 268);
  const tex = new THREE.CanvasTexture(art);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;

  if (memory.imageUrl) {
    const img = new Image();
    if (!memory.imageUrl.startsWith('/')) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 384;
      c.height = 268;
      const ctx = c.getContext('2d')!;
      const ir = img.width / img.height;
      const cr = c.width / c.height;
      let sx = 0;
      let sy = 0;
      let sw = img.width;
      let sh = img.height;
      if (ir > cr) {
        sw = img.height * cr;
        sx = (img.width - sw) / 2;
      } else {
        sh = img.width / cr;
        sy = (img.height - sh) / 2;
      }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
      tex.image = c;
      tex.needsUpdate = true;
    };
    img.src = memory.imageUrl;
  }

  return tex;
}

function createGroupPillTexture(label: string, count: number, color: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 560;
  canvas.height = 112;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Measure text to size pill cleanly centered
  ctx.font = '600 32px Inter, system-ui, sans-serif';
  const displayLabel = label.length > 21 ? `${label.slice(0, 20)}…` : label;
  const textWidth = ctx.measureText(displayLabel).width;
  const countStr = String(count);
  ctx.font = '700 26px Inter, system-ui, sans-serif';
  const badgeW = Math.max(46, ctx.measureText(countStr).width + 26);

  const pillW = Math.min(544, Math.max(220, textWidth + badgeW + 96));
  const pillH = 76;
  const x0 = (canvas.width - pillW) / 2;
  const y0 = (canvas.height - pillH) / 2;

  // Dark glass pill with high-contrast border
  ctx.fillStyle = 'rgba(5, 9, 22, 0.92)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.roundRect(x0, y0, pillW, pillH, 38);
  ctx.fill();
  ctx.stroke();

  // Category dot
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x0 + 32, canvas.height / 2, 8.5, 0, Math.PI * 2);
  ctx.fill();

  // Label text
  ctx.fillStyle = '#f8fafc';
  ctx.font = '600 30px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(displayLabel, x0 + 54, canvas.height / 2 + 1);

  // Count badge on right
  const bx = x0 + pillW - badgeW - 14;
  const by = y0 + 16;
  ctx.fillStyle = `${color}33`;
  ctx.strokeStyle = `${color}aa`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(bx, by, badgeW, 44, 22);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = '700 24px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(countStr, bx + badgeW / 2, canvas.height / 2 + 1);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createMiniTitleTexture(title: string, accent: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 440;
  canvas.height = 76;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.font = '600 24px Inter, system-ui, sans-serif';
  const text = title.length > 24 ? `${title.slice(0, 23)}…` : title;
  const w = Math.min(424, Math.max(150, ctx.measureText(text).width + 44));
  const x = (canvas.width - w) / 2;

  ctx.fillStyle = 'rgba(5, 9, 22, 0.88)';
  ctx.strokeStyle = `${accent}88`;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.roundRect(x, 12, w, 52, 26);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#f1f5f9';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, 39);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export class NeuralGlobeEngine {
  private container: HTMLElement;
  private callbacks: EngineCallbacks;

  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloomPass: UnrealBloomPass;

  private glowTex: THREE.CanvasTexture;
  private earthTex: THREE.CanvasTexture;
  private graph: MemoryGraph | null = null;
  private morphMode: MorphMode = 'neural';
  private clusterDimension: ClusterDimension = 'event';
  private clusterPage = 0;
  private openClusterId: string | null = null;
  private openGlobeGroupId: string | null = null;
  private filter: ActiveFilter = { kind: 'all', value: null };
  private autoDrift = false;
  private autoDriftTimer = 0;

  private rootGroup = new THREE.Group();
  private neuralDomeShell!: THREE.Group;
  private earthGlobeGroup!: THREE.Group;
  private clusterCardsGroup = new THREE.Group();
  private clusterLinksGroup = new THREE.Group();
  private globeCardsGroup = new THREE.Group();
  private globeLinksGroup = new THREE.Group();
  private expandedStemsGroup = new THREE.Group();
  private nodesGroup = new THREE.Group();
  private edgesGroup = new THREE.Group();
  private ambientDust!: THREE.Points;
  private ambientDustMaterial!: THREE.PointsMaterial;

  private nodeVisuals = new Map<string, NodeVisual>();
  private cardTextures = new Map<string, THREE.CanvasTexture>();
  private nodeMeshes: THREE.Object3D[] = [];
  private edgeVisuals: EdgeVisual[] = [];
  private adjacency = new Map<string, Array<{ neighborId: string; edge: SynapseEdge; edgeIdx: number }>>();

  private clusterCardVisuals = new Map<string, GroupCardVisual>();
  private clusterHitMeshes: THREE.Object3D[] = [];
  private clusterLinkVisuals: GroupLinkVisual[] = [];

  private globeCardVisuals = new Map<string, GroupCardVisual>();
  private globeHitMeshes: THREE.Object3D[] = [];
  private globeLinkVisuals: GroupLinkVisual[] = [];

  private pulses: ActionPotentialPulse[] = [];
  private pulsePoints!: THREE.Points;
  private pulsePositions!: Float32Array;
  private pulseColors!: Float32Array;

  // Camera & navigation state
  private cameraPos = new THREE.Vector3(0, 1.5, 14);
  private lookTarget = new THREE.Vector3(0, 2, -60);
  private yaw = 0;
  private pitch = 0;
  private orbitRadius = 118;
  private isDragging = false;
  private pointerDownPos = { x: 0, y: 0 };
  private lastPointer = { x: 0, y: 0 };
  private pointerNDC = new THREE.Vector2(-99, -99);
  private raycaster = new THREE.Raycaster();

  private hoveredId: string | null = null;
  private hoveredGroupId: string | null = null;
  private selectedId: string | null = null;
  private visitedStack: string[] = [];
  private scrollAccumulator = 0;
  private scrollJumpCooldown = 0;

  private activeFlight: CameraFlight | null = null;
  private morphProgress = 1;
  private animFrameId = 0;
  private clock = new THREE.Clock();
  private disposed = false;

  constructor(container: HTMLElement, callbacks: EngineCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#03050c');
    this.scene.fog = new THREE.FogExp2('#03050c', 0.0028);

    this.camera = new THREE.PerspectiveCamera(68, width / height, 0.4, 600);
    this.camera.position.copy(this.cameraPos);
    this.camera.lookAt(this.lookTarget);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.04;
    container.appendChild(this.renderer.domElement);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Restrained bloom: thumbnails stay crisp & vibrant without white washout
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.28, 0.36, 0.82);
    this.composer.addPass(this.bloomPass);

    this.glowTex = createSoftGlowTexture();
    this.earthTex = createEarthTexture();

    this.scene.add(this.rootGroup);
    this.buildEnvironmentShells();
    this.rootGroup.add(this.edgesGroup);
    this.rootGroup.add(this.clusterLinksGroup);
    this.rootGroup.add(this.globeLinksGroup);
    this.rootGroup.add(this.expandedStemsGroup);
    this.rootGroup.add(this.nodesGroup);
    this.rootGroup.add(this.clusterCardsGroup);
    this.rootGroup.add(this.globeCardsGroup);

    this.bindEvents();
    this.animate();
  }

  private buildEnvironmentShells(): void {
    // 1. Inside-Out Neural Dome cortical shell
    this.neuralDomeShell = new THREE.Group();
    const domeGeo = new THREE.IcosahedronGeometry(108, 3);
    const domeWire = new THREE.WireframeGeometry(domeGeo);
    const domeMat = new THREE.LineBasicMaterial({
      color: '#1e3a5f',
      transparent: true,
      opacity: 0.14,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.neuralDomeShell.add(new THREE.LineSegments(domeWire, domeMat));

    for (let r = 0; r < 3; r++) {
      const ringGeo = new THREE.RingGeometry(102, 102.3, 96);
      const ringMat = new THREE.MeshBasicMaterial({
        color: r === 0 ? '#22d3ee' : r === 1 ? '#818cf8' : '#fb7185',
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      if (r === 0) ring.rotation.x = Math.PI / 2;
      if (r === 1) ring.rotation.y = Math.PI / 3;
      if (r === 2) {
        ring.rotation.x = Math.PI / 4;
        ring.rotation.y = -Math.PI / 5;
      }
      this.neuralDomeShell.add(ring);
    }
    this.rootGroup.add(this.neuralDomeShell);

    // 2. Holographic Geographic Earth Globe with subtle coastlines & landmass fills
    this.earthGlobeGroup = new THREE.Group();
    const earthRadius = 54;
    const earthSphere = new THREE.Mesh(
      new THREE.SphereGeometry(earthRadius, 64, 48),
      new THREE.MeshBasicMaterial({
        map: this.earthTex,
      })
    );
    this.earthGlobeGroup.add(earthSphere);

    // Crisp 3D vector coastline outlines slightly above the sphere surface
    const coastMat = new THREE.LineBasicMaterial({
      color: '#5eead4',
      transparent: true,
      opacity: 0.44,
      depthWrite: false,
    });
    for (const polyline of WORLD_COASTLINES) {
      if (polyline.length < 2) continue;
      let segment: THREE.Vector3[] = [];
      let prevLng: number | null = null;
      for (const [lat, lng] of polyline) {
        if (prevLng !== null && Math.abs(lng - prevLng) > 160) {
          if (segment.length >= 2) {
            const geo = new THREE.BufferGeometry().setFromPoints(segment);
            this.earthGlobeGroup.add(new THREE.Line(geo, coastMat));
          }
          segment = [];
        }
        segment.push(new THREE.Vector3(...latLngToCartesian(lat, lng, earthRadius + 0.25)));
        prevLng = lng;
      }
      if (segment.length >= 2) {
        const geo = new THREE.BufferGeometry().setFromPoints(segment);
        this.earthGlobeGroup.add(new THREE.Line(geo, coastMat));
      }
    }

    // Understated lat/lng graticule so coastlines remain the clear geographic focal point
    const graticulePoints: THREE.Vector3[] = [];
    for (let lat = -60; lat <= 60; lat += 30) {
      const phi = ((90 - lat) * Math.PI) / 180;
      const r = earthRadius + 0.14;
      for (let lng = -180; lng < 180; lng += 6) {
        const t1 = ((lng + 180) * Math.PI) / 180;
        const t2 = ((lng + 6 + 180) * Math.PI) / 180;
        graticulePoints.push(
          new THREE.Vector3(-r * Math.sin(phi) * Math.cos(t1), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(t1)),
          new THREE.Vector3(-r * Math.sin(phi) * Math.cos(t2), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(t2))
        );
      }
    }
    for (let lng = -180; lng < 180; lng += 30) {
      const theta = ((lng + 180) * Math.PI) / 180;
      const r = earthRadius + 0.14;
      for (let lat = -84; lat < 84; lat += 6) {
        const p1 = ((90 - lat) * Math.PI) / 180;
        const p2 = ((90 - (lat + 6)) * Math.PI) / 180;
        graticulePoints.push(
          new THREE.Vector3(-r * Math.sin(p1) * Math.cos(theta), r * Math.cos(p1), r * Math.sin(p1) * Math.sin(theta)),
          new THREE.Vector3(-r * Math.sin(p2) * Math.cos(theta), r * Math.cos(p2), r * Math.sin(p2) * Math.sin(theta))
        );
      }
    }
    const graticuleGeo = new THREE.BufferGeometry().setFromPoints(graticulePoints);
    const graticule = new THREE.LineSegments(
      graticuleGeo,
      new THREE.LineBasicMaterial({
        color: '#22d3ee',
        transparent: true,
        opacity: 0.11,
        depthWrite: false,
      })
    );
    this.earthGlobeGroup.add(graticule);

    // Subtle atmospheric Fresnel rim glow
    const atmoMat = new THREE.ShaderMaterial({
      uniforms: {
        glowColor: { value: new THREE.Color('#38bdf8') },
      },
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 glowColor;
        varying vec3 vNormal;
        void main() {
          float intensity = pow(0.66 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.2);
          gl_FragColor = vec4(glowColor, clamp(intensity * 0.65, 0.0, 0.48));
        }
      `,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(earthRadius * 1.11, 48, 48), atmoMat);
    this.earthGlobeGroup.add(atmosphere);
    this.earthGlobeGroup.visible = false;
    this.rootGroup.add(this.earthGlobeGroup);

    // 3. Restrained ambient cosmic stardust (never outshines memory thumbnails)
    const dustCount = 720;
    const dustPos = new Float32Array(dustCount * 3);
    const dustCol = new Float32Array(dustCount * 3);
    const palette = [
      new THREE.Color('#22d3ee'),
      new THREE.Color('#818cf8'),
      new THREE.Color('#fb7185'),
      new THREE.Color('#fbbf24'),
    ];
    for (let i = 0; i < dustCount; i++) {
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const r = 30 + Math.random() * 110;
      dustPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      dustPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      dustPos[i * 3 + 2] = r * Math.cos(phi);

      const c = palette[i % palette.length];
      dustCol[i * 3] = c.r;
      dustCol[i * 3 + 1] = c.g;
      dustCol[i * 3 + 2] = c.b;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    dustGeo.setAttribute('color', new THREE.BufferAttribute(dustCol, 3));
    this.ambientDustMaterial = new THREE.PointsMaterial({
      size: 0.9,
      map: this.glowTex,
      vertexColors: true,
      transparent: true,
      opacity: 0.24,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.ambientDust = new THREE.Points(dustGeo, this.ambientDustMaterial);
    this.ambientDust.renderOrder = 0;
    this.rootGroup.add(this.ambientDust);
  }

  public setGraph(graph: MemoryGraph): void {
    this.graph = graph;
    this.clearGraphObjects();

    const frameGeo = new THREE.PlaneGeometry(8.2, 5.7);
    const backingGeo = new THREE.PlaneGeometry(8.32, 5.82);
    const borderGeo = new THREE.PlaneGeometry(8.62, 6.12);

    // 1. Build Memory Neuron Nodes (with opaque depth-writing backing so lines NEVER slice across images)
    graph.memories.forEach((memory, idx) => {
      const group = new THREE.Group();
      const startPos = new THREE.Vector3(...memory.positions[this.morphMode]);
      group.position.copy(startPos);

      const cardTex = createMemoryCardTexture(memory);
      this.cardTextures.set(memory.id, cardTex);

      const frameMaterial = new THREE.MeshBasicMaterial({
        map: cardTex,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.96,
        depthWrite: true,
      });
      const frameMesh = new THREE.Mesh(frameGeo, frameMaterial);
      frameMesh.position.z = 0.04;
      frameMesh.renderOrder = 6;
      frameMesh.userData = { memoryId: memory.id };

      // Solid dark backing behind the photo so axons behind the card are cleanly occluded
      const backingMaterial = new THREE.MeshBasicMaterial({
        color: '#050812',
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.98,
        depthWrite: true,
      });
      const backingMesh = new THREE.Mesh(backingGeo, backingMaterial);
      backingMesh.position.z = -0.02;
      backingMesh.renderOrder = 5;

      const accent = new THREE.Color(memory.palette[0]);
      const borderMaterial = new THREE.MeshBasicMaterial({
        color: accent,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
      });
      const borderMesh = new THREE.Mesh(borderGeo, borderMaterial);
      borderMesh.position.z = -0.08;
      borderMesh.renderOrder = 4;

      // Subtle neural soma glow behind the card (restrained so it never outshines the artwork)
      const coreMaterial = new THREE.SpriteMaterial({
        map: this.glowTex,
        color: accent,
        transparent: true,
        opacity: 0.22,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const coreSprite = new THREE.Sprite(coreMaterial);
      const hubBoost = Math.min(1.18, 0.9 + memory.degree * 0.03);
      coreSprite.scale.set(9.2 * hubBoost, 9.2 * hubBoost, 1);
      coreSprite.position.z = -0.25;
      coreSprite.renderOrder = 2;

      // Mini title pill (shown when expanded inside a Cluster or Globe Region group)
      const titleTex = createMiniTitleTexture(memory.title, memory.palette[0]);
      const titleMaterial = new THREE.SpriteMaterial({
        map: titleTex,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      });
      const titleSprite = new THREE.Sprite(titleMaterial);
      titleSprite.scale.set(9.4, 1.62, 1);
      titleSprite.position.set(0, -4.05, 0.08);
      titleSprite.visible = false;
      titleSprite.renderOrder = 8;

      group.add(coreSprite);
      group.add(borderMesh);
      group.add(backingMesh);
      group.add(frameMesh);
      group.add(titleSprite);

      this.nodesGroup.add(group);
      this.nodeMeshes.push(frameMesh);

      this.nodeVisuals.set(memory.id, {
        memory,
        group,
        frameMesh,
        frameMaterial,
        backingMaterial,
        borderMaterial,
        coreSprite,
        coreMaterial,
        titleSprite,
        titleMaterial,
        currentPos: startPos.clone(),
        targetPos: startPos.clone(),
        baseScale: hubBoost,
        pulseEnergy: 0.18,
        phase: idx * 0.71,
      });
    });

    // 2. Build Adjacency + Curved 3D Synaptic Axons
    this.adjacency.clear();
    graph.edges.forEach((edge, edgeIdx) => {
      const a = this.nodeVisuals.get(edge.source);
      const b = this.nodeVisuals.get(edge.target);
      if (!a || !b) return;

      const curve = this.computeSynapseCurve(a.currentPos, b.currentPos, edgeIdx);
      const pts = curve.getPoints(26);
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const baseColor = new THREE.Color(SYNAPSE_COLORS[edge.kind]);
      const material = new THREE.LineBasicMaterial({
        color: baseColor,
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(geo, material);
      line.renderOrder = 1;
      this.edgesGroup.add(line);

      this.edgeVisuals.push({
        edge,
        line,
        material,
        curve,
        baseColor,
        pulseCount: edge.weight > 0.76 ? 2 : 1,
      });

      if (!this.adjacency.has(edge.source)) this.adjacency.set(edge.source, []);
      if (!this.adjacency.has(edge.target)) this.adjacency.set(edge.target, []);
      this.adjacency.get(edge.source)!.push({ neighborId: edge.target, edge, edgeIdx });
      this.adjacency.get(edge.target)!.push({ neighborId: edge.source, edge, edgeIdx });
    });

    // 3. Build Restrained Action-Potential Sparks
    this.pulses = [];
    this.edgeVisuals.forEach((ev, edgeIdx) => {
      for (let p = 0; p < ev.pulseCount; p++) {
        this.pulses.push({
          edgeIdx,
          t: Math.random(),
          speed: 0.13 + Math.random() * 0.2,
          direction: Math.random() > 0.5 ? 1 : -1,
          color: ev.baseColor.clone(),
          boost: 0,
        });
      }
    });

    const pulseGeo = new THREE.BufferGeometry();
    this.pulsePositions = new Float32Array(this.pulses.length * 3);
    this.pulseColors = new Float32Array(this.pulses.length * 3);
    pulseGeo.setAttribute('position', new THREE.BufferAttribute(this.pulsePositions, 3));
    pulseGeo.setAttribute('color', new THREE.BufferAttribute(this.pulseColors, 3));

    const pulseMat = new THREE.PointsMaterial({
      size: 1.75,
      map: this.glowTex,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.pulsePoints = new THREE.Points(pulseGeo, pulseMat);
    this.pulsePoints.renderOrder = 3;
    this.edgesGroup.add(this.pulsePoints);

    // 4. Build Interactive Expandable Cluster Group Cards & Globe Region Cards
    this.clusterPage = 0;
    this.callbacks.onClusterPageChange?.(0);
    this.buildClusterGroupVisuals(graph);
    this.buildGlobeRegionVisuals(graph);

    // Reset state & sync visibility for active mode
    this.selectedId = null;
    this.openClusterId = null;
    this.openGlobeGroupId = null;
    this.visitedStack = [];
    this.syncModeVisibility();
    this.resetCameraForMode(this.morphMode);
  }

  private buildClusterGroupVisuals(graph: MemoryGraph): void {
    this.clearGroupCollection(this.clusterCardVisuals, this.clusterCardsGroup, this.clusterLinkVisuals, this.clusterLinksGroup);
    this.clusterHitMeshes = [];

    const pageInfo = getClusterPage(graph.hubs, this.clusterDimension, this.clusterPage, CLUSTERS_PAGE_SIZE);
    this.clusterPage = pageInfo.page;
    const hubs = pageInfo.items;
    const cardGeo = new THREE.PlaneGeometry(14.0, 9.6);
    const borderGeo = new THREE.PlaneGeometry(14.55, 10.15);
    const stackGeo = new THREE.PlaneGeometry(14.0, 9.6);

    for (const hub of hubs) {
      const repTex = this.cardTextures.get(hub.representativeId);
      const group = new THREE.Group();
      const pos = new THREE.Vector3(...hub.position);
      group.position.copy(pos);

      const stackMaterials: THREE.MeshBasicMaterial[] = [];
      if (hub.count > 1) {
        const stackLayers = Math.min(2, hub.count - 1);
        for (let s = 1; s <= stackLayers; s++) {
          const mat = new THREE.MeshBasicMaterial({
            color: '#0c1528',
            transparent: true,
            opacity: 0.72 - s * 0.16,
            side: THREE.DoubleSide,
            depthWrite: false,
          });
          const stackMesh = new THREE.Mesh(stackGeo, mat);
          stackMesh.position.set(s * 0.95, s * 0.72, -0.18 * s);
          stackMesh.renderOrder = 3;
          group.add(stackMesh);
          stackMaterials.push(mat);

          const rimMat = new THREE.MeshBasicMaterial({
            color: hub.color,
            transparent: true,
            opacity: 0.25,
            side: THREE.DoubleSide,
            depthWrite: false,
          });
          const rim = new THREE.Mesh(borderGeo, rimMat);
          rim.position.set(s * 0.95, s * 0.72, -0.18 * s - 0.03);
          rim.renderOrder = 2;
          group.add(rim);
          stackMaterials.push(rimMat);
        }
      }

      const borderMaterial = new THREE.MeshBasicMaterial({
        color: hub.color,
        transparent: true,
        opacity: 0.78,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const borderMesh = new THREE.Mesh(borderGeo, borderMaterial);
      borderMesh.position.z = -0.05;
      borderMesh.renderOrder = 4;
      group.add(borderMesh);

      const cardMaterial = new THREE.MeshBasicMaterial({
        map: repTex ?? null,
        color: repTex ? '#ffffff' : hub.color,
        transparent: true,
        opacity: 0.98,
        side: THREE.DoubleSide,
        depthWrite: true,
      });
      const cardMesh = new THREE.Mesh(cardGeo, cardMaterial);
      cardMesh.position.z = 0.02;
      cardMesh.renderOrder = 5;
      cardMesh.userData = { clusterGroupId: hub.id };
      group.add(cardMesh);

      const labelTex = createGroupPillTexture(hub.label, hub.count, hub.color);
      const labelMaterial = new THREE.SpriteMaterial({
        map: labelTex,
        transparent: true,
        opacity: 0.98,
        depthWrite: false,
      });
      const labelSprite = new THREE.Sprite(labelMaterial);
      labelSprite.scale.set(22.5, 4.5, 1);
      labelSprite.position.set(0, -7.5, 0.12);
      labelSprite.renderOrder = 8;
      labelSprite.userData = { clusterGroupId: hub.id };
      group.add(labelSprite);

      this.clusterCardsGroup.add(group);
      this.clusterHitMeshes.push(cardMesh, labelSprite);

      this.clusterCardVisuals.set(hub.id, {
        id: hub.id,
        label: hub.label,
        count: hub.count,
        color: hub.color,
        memoryIds: hub.memoryIds,
        group,
        hitMeshes: [cardMesh, labelSprite],
        cardMaterial,
        borderMaterial,
        stackMaterials,
        labelSprite,
        labelMaterial,
        position: pos,
        kind: hub.kind,
      });
    }

    // Inter-group synaptic links (show subtle connections between groups that share linked memories)
    const hubByMemory = new Map<string, string[]>();
    for (const hub of hubs) {
      for (const mId of hub.memoryIds) {
        const list = hubByMemory.get(mId) ?? [];
        list.push(hub.id);
        hubByMemory.set(mId, list);
      }
    }

    const linkSeen = new Set<string>();
    for (const edge of graph.edges) {
      const aHubs = hubByMemory.get(edge.source) ?? [];
      const bHubs = hubByMemory.get(edge.target) ?? [];
      for (const ha of aHubs) {
        for (const hb of bHubs) {
          if (ha === hb) continue;
          const [u, v] = ha < hb ? [ha, hb] : [hb, ha];
          const key = `${u}__${v}`;
          if (linkSeen.has(key)) continue;
          linkSeen.add(key);

          const va = this.clusterCardVisuals.get(u);
          const vb = this.clusterCardVisuals.get(v);
          if (!va || !vb) continue;

          const mid = new THREE.Vector3().addVectors(va.position, vb.position).multiplyScalar(0.5);
          mid.z -= 8;
          const curve = new THREE.QuadraticBezierCurve3(va.position.clone(), mid, vb.position.clone());
          const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(22));
          const material = new THREE.LineBasicMaterial({
            color: SYNAPSE_COLORS[edge.kind],
            transparent: true,
            opacity: 0.16,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          });
          const line = new THREE.Line(geo, material);
          line.renderOrder = 1;
          this.clusterLinksGroup.add(line);
          this.clusterLinkVisuals.push({ fromId: u, toId: v, line, material, kind: edge.kind });
        }
      }
    }
  }

  private buildGlobeRegionVisuals(graph: MemoryGraph): void {
    this.clearGroupCollection(this.globeCardVisuals, this.globeCardsGroup, this.globeLinkVisuals, this.globeLinksGroup);
    this.globeHitMeshes = [];

    const cardGeo = new THREE.PlaneGeometry(7.8, 5.4);
    const borderGeo = new THREE.PlaneGeometry(8.2, 5.8);
    const stackGeo = new THREE.PlaneGeometry(7.8, 5.4);

    for (const region of graph.globeGroups) {
      const repTex = this.cardTextures.get(region.representativeId);
      const group = new THREE.Group();
      const pos = new THREE.Vector3(...region.pinPos);
      const surfacePos = new THREE.Vector3(...region.surfacePos);
      group.position.copy(pos);

      const stackMaterials: THREE.MeshBasicMaterial[] = [];
      if (region.count > 1) {
        const mat = new THREE.MeshBasicMaterial({
          color: '#0c1528',
          transparent: true,
          opacity: 0.78,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const stackMesh = new THREE.Mesh(stackGeo, mat);
        stackMesh.position.set(0.65, 0.48, -0.14);
        stackMesh.renderOrder = 4;
        group.add(stackMesh);
        stackMaterials.push(mat);

        const rimMat = new THREE.MeshBasicMaterial({
          color: region.color,
          transparent: true,
          opacity: 0.36,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const rim = new THREE.Mesh(borderGeo, rimMat);
        rim.position.set(0.65, 0.48, -0.17);
        rim.renderOrder = 3;
        group.add(rim);
        stackMaterials.push(rimMat);
      }

      const borderMaterial = new THREE.MeshBasicMaterial({
        color: region.color,
        transparent: true,
        opacity: 0.82,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const borderMesh = new THREE.Mesh(borderGeo, borderMaterial);
      borderMesh.position.z = -0.04;
      borderMesh.renderOrder = 5;
      group.add(borderMesh);

      const cardMaterial = new THREE.MeshBasicMaterial({
        map: repTex ?? null,
        color: repTex ? '#ffffff' : region.color,
        transparent: true,
        opacity: 0.98,
        side: THREE.DoubleSide,
        depthWrite: true,
      });
      const cardMesh = new THREE.Mesh(cardGeo, cardMaterial);
      cardMesh.position.z = 0.02;
      cardMesh.renderOrder = 6;
      cardMesh.userData = { globeGroupId: region.id };
      group.add(cardMesh);

      const labelTex = createGroupPillTexture(region.label, region.count, region.color);
      const labelMaterial = new THREE.SpriteMaterial({
        map: labelTex,
        transparent: true,
        opacity: 0.96,
        depthWrite: false,
      });
      const labelSprite = new THREE.Sprite(labelMaterial);
      labelSprite.scale.set(16.5, 3.3, 1);
      labelSprite.position.set(0, -4.5, 0.1);
      labelSprite.renderOrder = 8;
      labelSprite.userData = { globeGroupId: region.id };
      group.add(labelSprite);

      // Pin stem connecting coastline surface anchor -> elevated region card
      const stemGeo = new THREE.BufferGeometry().setFromPoints([surfacePos, pos]);
      const stemMaterial = new THREE.LineBasicMaterial({
        color: region.color,
        transparent: true,
        opacity: 0.65,
        depthWrite: false,
      });
      const stemLine = new THREE.Line(stemGeo, stemMaterial);
      stemLine.renderOrder = 3;
      this.globeLinksGroup.add(stemLine);

      // Glowing coastline anchor dot
      const dot = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTex,
          color: region.color,
          transparent: true,
          opacity: 0.95,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      dot.position.copy(surfacePos);
      dot.scale.set(2.4, 2.4, 1);
      dot.renderOrder = 4;
      this.globeLinksGroup.add(dot);

      this.globeCardsGroup.add(group);
      this.globeHitMeshes.push(cardMesh, labelSprite);

      this.globeCardVisuals.set(region.id, {
        id: region.id,
        label: region.label,
        count: region.count,
        color: region.color,
        memoryIds: region.memoryIds,
        group,
        hitMeshes: [cardMesh, labelSprite],
        cardMaterial,
        borderMaterial,
        stackMaterials,
        labelSprite,
        labelMaterial,
        position: pos,
        surfacePos,
        stemLine,
        stemMaterial,
      });
    }

    // Great-circle neural arcs connecting related geographic regions above the Earth
    const regionByMemory = new Map<string, string>();
    for (const region of graph.globeGroups) {
      for (const mId of region.memoryIds) regionByMemory.set(mId, region.id);
    }

    const arcSeen = new Set<string>();
    for (const edge of graph.edges) {
      const ra = regionByMemory.get(edge.source);
      const rb = regionByMemory.get(edge.target);
      if (!ra || !rb || ra === rb) continue;
      const [u, v] = ra < rb ? [ra, rb] : [rb, ra];
      const key = `${u}__${v}`;
      if (arcSeen.has(key)) continue;
      arcSeen.add(key);

      const va = this.globeCardVisuals.get(u);
      const vb = this.globeCardVisuals.get(v);
      if (!va?.surfacePos || !vb?.surfacePos) continue;

      const dist = va.surfacePos.distanceTo(vb.surfacePos);
      const mid = new THREE.Vector3().addVectors(va.surfacePos, vb.surfacePos).multiplyScalar(0.5);
      const midLen = mid.length() || 1;
      mid.normalize().multiplyScalar(Math.max(60, midLen + dist * 0.25));

      const curve = new THREE.QuadraticBezierCurve3(va.surfacePos.clone(), mid, vb.surfacePos.clone());
      const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(28));
      const material = new THREE.LineBasicMaterial({
        color: SYNAPSE_COLORS[edge.kind],
        transparent: true,
        opacity: 0.26,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(geo, material);
      line.renderOrder = 2;
      this.globeLinksGroup.add(line);
      this.globeLinkVisuals.push({ fromId: u, toId: v, line, material, kind: edge.kind });
    }
  }

  private clearGroupCollection(
    cardMap: Map<string, GroupCardVisual>,
    cardGroup: THREE.Group,
    linkList: GroupLinkVisual[],
    linkGroup: THREE.Group
  ): void {
    for (const cv of cardMap.values()) {
      cv.cardMaterial.dispose();
      cv.borderMaterial.dispose();
      cv.stackMaterials.forEach((m) => m.dispose());
      cv.labelMaterial.map?.dispose();
      cv.labelMaterial.dispose();
      cv.stemLine?.geometry.dispose();
      cv.stemMaterial?.dispose();
    }
    cardMap.clear();
    cardGroup.clear();

    for (const lv of linkList) {
      lv.line.geometry.dispose();
      lv.material.dispose();
    }
    linkList.length = 0;
    linkGroup.clear();
  }

  private clearGraphObjects(): void {
    for (const nv of this.nodeVisuals.values()) {
      nv.frameMaterial.dispose();
      nv.backingMaterial.dispose();
      nv.borderMaterial.dispose();
      nv.coreMaterial.dispose();
      nv.titleMaterial.map?.dispose();
      nv.titleMaterial.dispose();
    }
    for (const tex of this.cardTextures.values()) {
      tex.dispose();
    }
    this.cardTextures.clear();
    this.nodeVisuals.clear();
    this.nodeMeshes = [];
    this.nodesGroup.clear();

    for (const ev of this.edgeVisuals) {
      ev.line.geometry.dispose();
      ev.material.dispose();
    }
    this.edgeVisuals = [];
    this.edgesGroup.clear();
    this.expandedStemsGroup.clear();

    this.clearGroupCollection(this.clusterCardVisuals, this.clusterCardsGroup, this.clusterLinkVisuals, this.clusterLinksGroup);
    this.clearGroupCollection(this.globeCardVisuals, this.globeCardsGroup, this.globeLinkVisuals, this.globeLinksGroup);
  }

  private computeSynapseCurve(
    a: THREE.Vector3,
    b: THREE.Vector3,
    seed: number,
    pullEndpointsBack = false
  ): THREE.QuadraticBezierCurve3 {
    let start = a.clone();
    let end = b.clone();

    if (pullEndpointsBack && this.morphMode === 'neural') {
      // Offset endpoints cleanly behind each card plane away from the camera so lines NEVER slice across images
      const camToA = start.clone().sub(this.camera.position).normalize();
      const camToB = end.clone().sub(this.camera.position).normalize();
      start.addScaledVector(camToA, 1.35);
      end.addScaledVector(camToB, 1.35);
    }

    const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    const dist = start.distanceTo(end);

    if (this.morphMode === 'globe') {
      const midLen = mid.length() || 1;
      const archHeight = Math.max(60, midLen + dist * 0.25);
      mid.normalize().multiplyScalar(archHeight);
    } else if (this.morphMode === 'neural') {
      const midLen = mid.length();
      if (midLen > 12) {
        const pull = 0.76 + (seed % 7) * 0.025;
        mid.multiplyScalar(pull);
      } else {
        const perp = new THREE.Vector3(start.y - end.y, end.x - start.x, (seed % 2 === 0 ? 1 : -1) * 18).normalize();
        mid.addScaledVector(perp, 24);
      }
    } else {
      mid.z -= 4 + (seed % 4) * 1.5;
    }

    return new THREE.QuadraticBezierCurve3(start, mid, end);
  }

  private syncModeVisibility(): void {
    const isNeural = this.morphMode === 'neural';
    const isGlobe = this.morphMode === 'globe';
    const isClusters = this.morphMode === 'clusters';

    this.neuralDomeShell.visible = isNeural;
    this.earthGlobeGroup.visible = isGlobe;

    this.clusterCardsGroup.visible = isClusters;
    this.clusterLinksGroup.visible = isClusters && !this.openClusterId;

    this.globeCardsGroup.visible = isGlobe;
    this.globeLinksGroup.visible = isGlobe;

    const showIndividualNodes =
      isNeural ||
      (isClusters && this.openClusterId !== null) ||
      (isGlobe && this.openGlobeGroupId !== null);

    this.nodesGroup.visible = showIndividualNodes;
    this.edgesGroup.visible = showIndividualNodes;
    this.expandedStemsGroup.visible = isGlobe && this.openGlobeGroupId !== null;

    if (this.pulsePoints) {
      this.pulsePoints.visible = isNeural;
    }
  }

  public setClusterDimension(dim: ClusterDimension): void {
    if (this.clusterDimension === dim) return;
    this.clusterDimension = dim;
    this.clusterPage = 0;
    this.openClusterId = null;
    this.selectedId = null;
    this.callbacks.onSelectMemory(null, null);
    this.callbacks.onOpenGroupChange?.(null);
    this.callbacks.onClusterPageChange?.(0);
    if (this.graph) {
      this.buildClusterGroupVisuals(this.graph);
    }
    this.syncModeVisibility();
    if (this.morphMode === 'clusters') {
      this.resetCameraForMode('clusters');
    }
  }

  public setClusterPage(page: number): void {
    if (!this.graph) return;
    const pageInfo = getClusterPage(this.graph.hubs, this.clusterDimension, page, CLUSTERS_PAGE_SIZE);
    if (pageInfo.page === this.clusterPage && this.openClusterId === null) return;
    this.clusterPage = pageInfo.page;
    this.openClusterId = null;
    this.selectedId = null;
    this.callbacks.onSelectMemory(null, null);
    this.callbacks.onOpenGroupChange?.(null);
    this.callbacks.onClusterPageChange?.(this.clusterPage);
    for (const nv of this.nodeVisuals.values()) {
      nv.titleSprite.visible = false;
      nv.group.visible = this.morphMode === 'neural';
    }
    this.buildClusterGroupVisuals(this.graph);
    this.syncModeVisibility();
    if (this.morphMode === 'clusters') {
      this.resetCameraForMode('clusters');
    }
  }

  public openClusterGroup(groupId: string): void {
    if (!this.graph) return;
    // If the target group belongs to another pagination page, switch to that page first
    if (!this.clusterCardVisuals.has(groupId)) {
      const dimHubs = this.graph.hubs.filter((h) => h.kind === this.clusterDimension);
      const idx = dimHubs.findIndex((h) => h.id === groupId);
      if (idx === -1) return;
      const targetPage = Math.floor(idx / CLUSTERS_PAGE_SIZE);
      if (targetPage !== this.clusterPage) {
        this.clusterPage = targetPage;
        this.callbacks.onClusterPageChange?.(targetPage);
        this.buildClusterGroupVisuals(this.graph);
      }
    }
    const cv = this.clusterCardVisuals.get(groupId);
    if (!cv) return;

    this.openClusterId = groupId;
    this.selectedId = null;
    this.callbacks.onSelectMemory(null, null);
    this.callbacks.onOpenGroupChange?.({
      mode: 'clusters',
      id: cv.id,
      label: cv.label,
      count: cv.count,
      color: cv.color,
    });

    // Arrange the opened group's individual photos cleanly in a wide non-overlapping arc/grid facing the camera
    const memberIds = cv.memoryIds;
    const center = cv.position.clone();
    const yaw = -0.35;
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const up = new THREE.Vector3(0, 1, 0);
    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));

    const cols = memberIds.length <= 3 ? memberIds.length : memberIds.length <= 6 ? 3 : 4;
    const rows = Math.ceil(memberIds.length / cols);
    const spacingX = 12.2;
    const spacingY = 10.0;

    const memberSet = new Set(memberIds);
    for (const [id, nv] of this.nodeVisuals) {
      if (memberSet.has(id)) {
        const idx = memberIds.indexOf(id);
        const row = Math.floor(idx / cols);
        const rowCount = row === rows - 1 ? memberIds.length - row * cols : cols;
        const col = idx % cols;
        const u = (col - (rowCount - 1) / 2) * spacingX;
        const v = ((rows - 1) / 2 - row) * spacingY;
        const pos = center
          .clone()
          .addScaledVector(right, u)
          .addScaledVector(up, v)
          .addScaledVector(forward, 6);
        nv.targetPos.copy(pos);
        nv.currentPos.copy(center);
        nv.group.visible = true;
        nv.titleSprite.visible = true;
      } else {
        nv.group.visible = false;
        nv.titleSprite.visible = false;
      }
    }

    this.morphProgress = 0;
    this.syncModeVisibility();

    // Glide camera to cleanly frame the expanded group
    const frameDist = Math.max(36, cols * 11 + rows * 6.5);
    const endPos = center.clone().addScaledVector(forward, frameDist).add(new THREE.Vector3(0, 3, 0));
    this.startCameraFlight(this.camera.position.clone(), endPos, this.lookTarget.clone(), center.clone(), 0.95, null);
  }

  public openGlobeGroup(groupId: string): void {
    if (!this.graph) return;
    const gv = this.globeCardVisuals.get(groupId);
    if (!gv) return;

    this.openGlobeGroupId = groupId;
    this.selectedId = null;
    this.callbacks.onSelectMemory(null, null);
    this.callbacks.onOpenGroupChange?.({
      mode: 'globe',
      id: gv.id,
      label: gv.label,
      count: gv.count,
      color: gv.color,
    });

    // Compute local tangent basis at the region's coastline normal so expanded photos fan cleanly above the globe
    const normal = gv.position.clone().normalize();
    const worldUp = Math.abs(normal.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const tangentRight = new THREE.Vector3().crossVectors(worldUp, normal).normalize();
    const tangentUp = new THREE.Vector3().crossVectors(normal, tangentRight).normalize();

    const anchorCenter = normal.clone().multiplyScalar(67.5);
    const memberIds = gv.memoryIds;
    const memberSet = new Set(memberIds);

    const cols = memberIds.length <= 3 ? memberIds.length : 3;
    const rows = Math.ceil(memberIds.length / cols);
    const spacingX = 11.4;
    const spacingY = 9.4;

    // Clear old expanded stems
    this.expandedStemsGroup.clear();

    for (const [id, nv] of this.nodeVisuals) {
      if (memberSet.has(id)) {
        const idx = memberIds.indexOf(id);
        const row = Math.floor(idx / cols);
        const rowCount = row === rows - 1 ? memberIds.length - row * cols : cols;
        const col = idx % cols;
        const u = (col - (rowCount - 1) / 2) * spacingX;
        const v = ((rows - 1) / 2 - row) * spacingY;

        const pos = anchorCenter
          .clone()
          .addScaledVector(tangentRight, u)
          .addScaledVector(tangentUp, v);
        nv.targetPos.copy(pos);
        nv.currentPos.copy(gv.position);
        nv.group.visible = true;
        nv.titleSprite.visible = true;

        // Draw delicate stem connecting this memory's GPS pin on the coastline to its expanded card
        const m = nv.memory;
        const pinOrigin =
          typeof m.lat === 'number' && typeof m.lng === 'number' && (m.lat !== 0 || m.lng !== 0)
            ? new THREE.Vector3(...latLngToCartesian(m.lat, m.lng, 54.35))
            : gv.surfacePos?.clone() ?? normal.clone().multiplyScalar(54.35);

        const stemGeo = new THREE.BufferGeometry().setFromPoints([pinOrigin, pos]);
        const stemLine = new THREE.Line(
          stemGeo,
          new THREE.LineBasicMaterial({
            color: m.palette[0],
            transparent: true,
            opacity: 0.45,
            depthWrite: false,
          })
        );
        stemLine.renderOrder = 3;
        this.expandedStemsGroup.add(stemLine);
      } else {
        nv.group.visible = false;
        nv.titleSprite.visible = false;
      }
    }

    this.morphProgress = 0;
    this.syncModeVisibility();

    // Orbit camera right in front of this coastline region so geography & all expanded photos are unmistakable
    const camDist = 104 + rows * 5;
    const endPos = normal.clone().multiplyScalar(camDist);
    const lookAt = normal.clone().multiplyScalar(56);
    this.startCameraFlight(this.camera.position.clone(), endPos, this.lookTarget.clone(), lookAt, 1.05, null);
  }

  public closeOpenGroup(): void {
    const hadOpen = this.openClusterId !== null || this.openGlobeGroupId !== null;
    this.openClusterId = null;
    this.openGlobeGroupId = null;
    this.selectedId = null;
    this.callbacks.onSelectMemory(null, null);
    this.callbacks.onOpenGroupChange?.(null);

    for (const nv of this.nodeVisuals.values()) {
      nv.titleSprite.visible = false;
      nv.group.visible = this.morphMode === 'neural';
    }
    this.expandedStemsGroup.clear();
    this.syncModeVisibility();

    if (hadOpen) {
      this.resetCameraForMode(this.morphMode);
    }
  }

  public setMorphMode(mode: MorphMode): void {
    if (this.morphMode === mode) return;
    this.morphMode = mode;
    this.morphProgress = 0;
    this.selectedId = null;
    this.openClusterId = null;
    this.openGlobeGroupId = null;
    this.callbacks.onSelectMemory(null, null);
    this.callbacks.onOpenGroupChange?.(null);

    for (const nv of this.nodeVisuals.values()) {
      nv.targetPos.set(...nv.memory.positions[mode]);
      nv.titleSprite.visible = false;
      nv.group.visible = mode === 'neural';
    }
    this.expandedStemsGroup.clear();
    this.syncModeVisibility();
    this.resetCameraForMode(mode);
  }

  public setFilter(filter: ActiveFilter): void {
    this.filter = filter;
    for (const nv of this.nodeVisuals.values()) {
      if (this.matchesFilter(nv.memory)) {
        nv.pulseEnergy = 0.8;
      }
    }
    this.boostMatchingPulses();
  }

  public setAutoDrift(enabled: boolean): void {
    this.autoDrift = enabled;
    this.autoDriftTimer = 0;
    if (enabled && !this.selectedId && this.graph && this.graph.memories.length > 0) {
      this.focusMemory(this.graph.memories[0].id);
    }
  }

  public resetView(): void {
    this.selectedId = null;
    this.openClusterId = null;
    this.openGlobeGroupId = null;
    this.visitedStack = [];
    this.callbacks.onSelectMemory(null, null);
    this.callbacks.onOpenGroupChange?.(null);
    for (const nv of this.nodeVisuals.values()) {
      nv.titleSprite.visible = false;
      nv.group.visible = this.morphMode === 'neural';
    }
    this.expandedStemsGroup.clear();
    this.syncModeVisibility();
    this.resetCameraForMode(this.morphMode);
  }

  private resetCameraForMode(mode: MorphMode): void {
    if (mode === 'neural') {
      this.yaw = 0;
      this.pitch = 0.04;
      const startPos = this.camera.position.clone();
      const endPos = new THREE.Vector3(0, 1.5, 14);
      const endLook = new THREE.Vector3(0, 2, -60);
      this.startCameraFlight(startPos, endPos, this.lookTarget.clone(), endLook, 1.0, null);
    } else if (mode === 'globe') {
      // Same exact camera coordinates as BEFORE so before/after screenshots match identically
      this.orbitRadius = 128;
      this.yaw = 0.45;
      this.pitch = 0.28;
      const endPos = this.sphericalOrbitPos(this.orbitRadius, this.yaw, this.pitch);
      this.startCameraFlight(this.camera.position.clone(), endPos, this.lookTarget.clone(), new THREE.Vector3(0, 0, 0), 1.1, null);
    } else {
      // Same exact camera coordinates as BEFORE so before/after screenshots match identically
      this.orbitRadius = 118;
      this.yaw = -0.35;
      this.pitch = 0.22;
      const endPos = this.sphericalOrbitPos(this.orbitRadius, this.yaw, this.pitch);
      this.startCameraFlight(this.camera.position.clone(), endPos, this.lookTarget.clone(), new THREE.Vector3(0, 0, 0), 1.1, null);
    }
  }

  private sphericalOrbitPos(radius: number, yaw: number, pitch: number): THREE.Vector3 {
    const clampedPitch = Math.max(-1.35, Math.min(1.35, pitch));
    return new THREE.Vector3(
      radius * Math.cos(clampedPitch) * Math.sin(yaw),
      radius * Math.sin(clampedPitch),
      radius * Math.cos(clampedPitch) * Math.cos(yaw)
    );
  }

  public focusMemory(memoryId: string, viaEdge?: SynapseEdge | null): void {
    const nv = this.nodeVisuals.get(memoryId);
    if (!nv) return;

    // If in Clusters or Earth Globe mode and jumping to a memory outside the currently opened group,
    // automatically open its containing group first so the photo is visible and framed cleanly!
    if (this.morphMode === 'clusters' && this.graph) {
      // Search across ALL pages of the active cluster dimension so jumping to a group beyond #16 works seamlessly
      const targetHub = this.graph.hubs.find(
        (h) => h.kind === this.clusterDimension && h.memoryIds.includes(memoryId)
      );
      if (targetHub && this.openClusterId !== targetHub.id) {
        this.openClusterGroup(targetHub.id);
      }
    } else if (this.morphMode === 'globe') {
      const targetRegion = Array.from(this.globeCardVisuals.values()).find((gv) =>
        gv.memoryIds.includes(memoryId)
      );
      if (targetRegion && this.openGlobeGroupId !== targetRegion.id) {
        this.openGlobeGroup(targetRegion.id);
      }
    }

    const prevId = this.selectedId;
    this.selectedId = memoryId;
    if (prevId && prevId !== memoryId) {
      this.visitedStack.push(prevId);
      if (this.visitedStack.length > 24) this.visitedStack.shift();
    }

    nv.pulseEnergy = 0.85;

    const neighbors = this.adjacency.get(memoryId) ?? [];
    for (const n of neighbors) {
      const targetNv = this.nodeVisuals.get(n.neighborId);
      if (targetNv) targetNv.pulseEnergy = Math.max(targetNv.pulseEnergy, 0.55);
      for (const pulse of this.pulses) {
        if (pulse.edgeIdx === n.edgeIdx) {
          pulse.boost = 0.7;
          pulse.t = n.edge.source === memoryId ? 0.08 : 0.92;
          pulse.direction = n.edge.source === memoryId ? 1 : -1;
        }
      }
    }

    const nodePos = nv.targetPos.clone();
    let endPos: THREE.Vector3;

    if (this.morphMode === 'neural') {
      const inward = nodePos.clone().normalize().negate();
      endPos = nodePos.clone().addScaledVector(inward, 19.5);
    } else if (this.morphMode === 'globe') {
      const outward = nodePos.clone().normalize();
      endPos = nodePos.clone().addScaledVector(outward, 22);
    } else {
      const yaw = -0.35;
      const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      endPos = nodePos.clone().addScaledVector(forward, 20);
    }

    const controlPos = new THREE.Vector3().addVectors(this.camera.position, endPos).multiplyScalar(0.5);
    if (viaEdge && this.morphMode === 'neural') {
      const ev = this.edgeVisuals.find((e) => e.edge.id === viaEdge.id);
      if (ev) {
        const curveMid = ev.curve.getPoint(0.5);
        controlPos.lerp(curveMid, 0.45);
      }
    }

    this.activeFlight = {
      startPos: this.camera.position.clone(),
      controlPos,
      endPos,
      startLook: this.lookTarget.clone(),
      endLook: nodePos.clone(),
      elapsed: 0,
      duration: viaEdge ? 1.15 : 0.95,
      targetMemoryId: memoryId,
    };

    this.callbacks.onSelectMemory(nv.memory, viaEdge ?? null);
  }

  public fireNextSynapse(preferredKind?: SynapseKind): boolean {
    if (!this.graph || this.graph.memories.length === 0) return false;

    if (!this.selectedId) {
      const candidate =
        this.graph.memories.find((m) => this.matchesFilter(m)) ?? this.graph.memories[0];
      this.focusMemory(candidate.id, null);
      return true;
    }

    const fromNv = this.nodeVisuals.get(this.selectedId);
    if (!fromNv) return false;

    const neighbors = this.adjacency.get(this.selectedId) ?? [];
    if (neighbors.length === 0) return false;

    const recentSet = new Set(this.visitedStack.slice(-5));
    const ranked = [...neighbors].sort((a, b) => {
      const aVisited = recentSet.has(a.neighborId) ? -1.5 : 0;
      const bVisited = recentSet.has(b.neighborId) ? -1.5 : 0;
      const aKind = preferredKind && a.edge.kind === preferredKind ? 1.2 : 0;
      const bKind = preferredKind && b.edge.kind === preferredKind ? 1.2 : 0;
      const aFilter = this.matchesFilter(this.nodeVisuals.get(a.neighborId)!.memory) ? 0.6 : 0;
      const bFilter = this.matchesFilter(this.nodeVisuals.get(b.neighborId)!.memory) ? 0.6 : 0;
      return b.edge.weight + bVisited + bKind + bFilter - (a.edge.weight + aVisited + aKind + aFilter);
    });

    const chosen = ranked[0];
    const toNv = this.nodeVisuals.get(chosen.neighborId);
    if (!toNv) return false;

    this.focusMemory(chosen.neighborId, chosen.edge);
    this.callbacks.onSynapseJump(fromNv.memory, toNv.memory, chosen.edge);
    return true;
  }

  public stepBackSynapse(): boolean {
    if (this.visitedStack.length === 0) {
      if (this.selectedId && (this.openClusterId || this.openGlobeGroupId)) {
        // Step back from focused card to its opened group view
        this.selectedId = null;
        this.callbacks.onSelectMemory(null, null);
        if (this.openClusterId) this.openClusterGroup(this.openClusterId);
        else if (this.openGlobeGroupId) this.openGlobeGroup(this.openGlobeGroupId);
        return true;
      }
      this.resetView();
      return false;
    }
    const prevId = this.visitedStack.pop()!;
    this.selectedId = null;
    this.focusMemory(prevId, null);
    return true;
  }

  private startCameraFlight(
    startPos: THREE.Vector3,
    endPos: THREE.Vector3,
    startLook: THREE.Vector3,
    endLook: THREE.Vector3,
    duration: number,
    targetMemoryId: string | null
  ): void {
    const controlPos = new THREE.Vector3().addVectors(startPos, endPos).multiplyScalar(0.5);
    this.activeFlight = {
      startPos,
      controlPos,
      endPos,
      startLook,
      endLook,
      elapsed: 0,
      duration,
      targetMemoryId,
    };
  }

  private matchesFilter(memory: MemoryNode): boolean {
    if (this.filter.kind === 'all' || !this.filter.value) return true;
    const v = this.filter.value;
    if (this.filter.kind === 'person') return memory.people.includes(v);
    if (this.filter.kind === 'place') return memory.locationName === v;
    if (this.filter.kind === 'event') return memory.event === v;
    if (this.filter.kind === 'theme') return memory.themes.includes(v);
    return true;
  }

  private boostMatchingPulses(): void {
    for (const pulse of this.pulses) {
      const ev = this.edgeVisuals[pulse.edgeIdx];
      if (!ev) continue;
      const a = this.nodeVisuals.get(ev.edge.source)?.memory;
      const b = this.nodeVisuals.get(ev.edge.target)?.memory;
      if (a && b && (this.matchesFilter(a) || this.matchesFilter(b))) {
        pulse.boost = 0.8;
      }
    }
  }

  private bindEvents(): void {
    const dom = this.renderer.domElement;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      this.isDragging = true;
      this.pointerDownPos = { x: e.clientX, y: e.clientY };
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.activeFlight = null;
      dom.style.cursor = 'grabbing';
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = dom.getBoundingClientRect();
      this.pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      if (this.isDragging) {
        const dx = e.clientX - this.lastPointer.x;
        const dy = e.clientY - this.lastPointer.y;
        this.lastPointer = { x: e.clientX, y: e.clientY };

        if (this.morphMode === 'neural' && !this.selectedId) {
          this.yaw -= dx * 0.0042;
          this.pitch = Math.max(-1.28, Math.min(1.28, this.pitch - dy * 0.0042));
          const lookDir = new THREE.Vector3(
            Math.cos(this.pitch) * Math.sin(this.yaw),
            Math.sin(this.pitch),
            -Math.cos(this.pitch) * Math.cos(this.yaw)
          );
          this.lookTarget.copy(this.camera.position).addScaledVector(lookDir, 60);
          this.camera.lookAt(this.lookTarget);
        } else {
          const center = this.selectedId
            ? this.nodeVisuals.get(this.selectedId)?.currentPos.clone() ?? new THREE.Vector3()
            : new THREE.Vector3(0, 0, 0);
          const offset = this.camera.position.clone().sub(center);
          const sph = new THREE.Spherical().setFromVector3(offset);
          sph.theta -= dx * 0.0052;
          sph.phi = Math.max(0.2, Math.min(Math.PI - 0.2, sph.phi - dy * 0.0052));
          offset.setFromSpherical(sph);
          this.camera.position.copy(center).add(offset);
          this.lookTarget.copy(center);
          this.camera.lookAt(center);
        }
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const moved = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y);
      this.isDragging = false;
      dom.style.cursor = this.hoveredId || this.hoveredGroupId ? 'pointer' : 'grab';

      if (moved < 6) {
        const picked = this.pickUnderPointer();
        if (picked?.type === 'memory') {
          let connectingEdge: SynapseEdge | null = null;
          if (this.selectedId && this.selectedId !== picked.id) {
            const adj = this.adjacency.get(this.selectedId)?.find((n) => n.neighborId === picked.id);
            if (adj) {
              connectingEdge = adj.edge;
              const fromMem = this.nodeVisuals.get(this.selectedId)?.memory;
              const toMem = this.nodeVisuals.get(picked.id)?.memory;
              if (fromMem && toMem) {
                this.callbacks.onSynapseJump(fromMem, toMem, adj.edge);
              }
            }
          }
          this.focusMemory(picked.id, connectingEdge);
        } else if (picked?.type === 'cluster') {
          this.openClusterGroup(picked.id);
        } else if (picked?.type === 'globe') {
          this.openGlobeGroup(picked.id);
        }
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (this.scrollJumpCooldown > 0) return;

      const delta = e.deltaY;

      if (delta < 0) {
        if (this.morphMode === 'clusters' && !this.openClusterId) {
          if (this.hoveredGroupId) {
            this.scrollJumpCooldown = 0.55;
            this.openClusterGroup(this.hoveredGroupId);
            return;
          }
          this.orbitRadius = Math.max(70, this.orbitRadius + delta * 0.08);
          const dir = this.camera.position.clone().normalize();
          this.camera.position.copy(dir.multiplyScalar(this.orbitRadius));
          return;
        }
        if (this.morphMode === 'globe' && !this.openGlobeGroupId) {
          if (this.hoveredGroupId) {
            this.scrollJumpCooldown = 0.55;
            this.openGlobeGroup(this.hoveredGroupId);
            return;
          }
          this.orbitRadius = Math.max(76, this.orbitRadius + delta * 0.08);
          const dir = this.camera.position.clone().normalize();
          this.camera.position.copy(dir.multiplyScalar(this.orbitRadius));
          return;
        }

        if (!this.selectedId) {
          const targetId = this.hoveredId || this.findClosestMemoryToGaze();
          if (targetId) {
            this.scrollAccumulator += Math.abs(delta);
            if (this.scrollAccumulator > 90) {
              this.scrollAccumulator = 0;
              this.scrollJumpCooldown = 0.55;
              this.focusMemory(targetId, null);
              return;
            }
          }
        } else {
          const nv = this.nodeVisuals.get(this.selectedId);
          if (nv) {
            const dist = this.camera.position.distanceTo(nv.currentPos);
            if (dist > 14.5) {
              const dir = nv.currentPos.clone().sub(this.camera.position).normalize();
              this.camera.position.addScaledVector(dir, Math.min(3.2, dist - 13.5));
            } else {
              this.scrollAccumulator += Math.abs(delta);
              if (this.scrollAccumulator > 130) {
                this.scrollAccumulator = 0;
                this.scrollJumpCooldown = 0.85;
                this.fireNextSynapse();
              }
            }
          }
        }
      } else {
        if (this.selectedId) {
          const nv = this.nodeVisuals.get(this.selectedId);
          if (nv) {
            const dist = this.camera.position.distanceTo(nv.currentPos);
            if (dist < 30) {
              const away = this.camera.position.clone().sub(nv.currentPos).normalize();
              this.camera.position.addScaledVector(away, 2.8);
            } else {
              this.scrollJumpCooldown = 0.65;
              this.stepBackSynapse();
            }
          }
        } else if (this.openClusterId || this.openGlobeGroupId) {
          this.scrollAccumulator += Math.abs(delta);
          if (this.scrollAccumulator > 160) {
            this.scrollAccumulator = 0;
            this.scrollJumpCooldown = 0.65;
            this.closeOpenGroup();
          }
        } else if (this.morphMode !== 'neural') {
          this.orbitRadius = Math.min(195, Math.max(76, this.orbitRadius + delta * 0.08));
          const dir = this.camera.position.clone().normalize();
          this.camera.position.copy(dir.multiplyScalar(this.orbitRadius));
        }
      }
    };

    const onResize = () => {
      if (this.disposed) return;
      const w = this.container.clientWidth || window.innerWidth;
      const h = this.container.clientHeight || window.innerHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this.composer.setSize(w, h);
      this.bloomPass.setSize(w, h);
    };

    dom.style.cursor = 'grab';
    dom.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    dom.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', onResize);

    this.cleanupListeners = () => {
      dom.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      dom.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
    };
  }

  private cleanupListeners: () => void = () => {};

  private pickUnderPointer(): { type: 'memory' | 'cluster' | 'globe'; id: string } | null {
    this.raycaster.setFromCamera(this.pointerNDC, this.camera);

    // 1. Check visible individual memory cards first
    if (this.nodesGroup.visible) {
      const visibleCards = this.nodeMeshes.filter((m) => m.parent?.visible);
      if (visibleCards.length > 0) {
        const hits = this.raycaster.intersectObjects(visibleCards, false);
        if (hits.length > 0) {
          const id = hits[0].object.userData.memoryId as string | undefined;
          if (id) return { type: 'memory', id };
        }
      }
    }

    // 2. Check Cluster group cards & labels
    if (this.morphMode === 'clusters' && this.clusterHitMeshes.length > 0) {
      const hits = this.raycaster.intersectObjects(this.clusterHitMeshes, false);
      if (hits.length > 0) {
        const id = hits[0].object.userData.clusterGroupId as string | undefined;
        if (id && id !== this.openClusterId) return { type: 'cluster', id };
      }
    }

    // 3. Check Earth Globe region group cards & labels (prefer front-facing pins)
    if (this.morphMode === 'globe' && this.globeHitMeshes.length > 0) {
      const hits = this.raycaster.intersectObjects(this.globeHitMeshes, false);
      for (const hit of hits) {
        const id = hit.object.userData.globeGroupId as string | undefined;
        if (!id || id === this.openGlobeGroupId) continue;
        const gv = this.globeCardVisuals.get(id);
        if (gv) {
          const camDir = this.camera.position.clone().normalize();
          const pinDir = gv.position.clone().normalize();
          if (camDir.dot(pinDir) > -0.15) {
            return { type: 'globe', id };
          }
        }
      }
    }

    return null;
  }

  private findClosestMemoryToGaze(): string | null {
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    let bestId: string | null = null;
    let bestDot = -Infinity;
    for (const [id, nv] of this.nodeVisuals) {
      if (!nv.group.visible || !this.matchesFilter(nv.memory)) continue;
      const toNode = nv.currentPos.clone().sub(this.camera.position).normalize();
      const d = camDir.dot(toNode);
      if (d > bestDot) {
        bestDot = d;
        bestId = id;
      }
    }
    return bestId;
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.animFrameId = requestAnimationFrame(this.animate);

    const dt = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.elapsedTime;

    if (this.scrollJumpCooldown > 0) {
      this.scrollJumpCooldown = Math.max(0, this.scrollJumpCooldown - dt);
    }

    // 1. Auto Synaptic Drift
    if (this.autoDrift && !this.isDragging) {
      this.autoDriftTimer += dt;
      if (this.autoDriftTimer > 4.2) {
        this.autoDriftTimer = 0;
        this.fireNextSynapse();
      }
    }

    // 2. Camera flight
    if (this.activeFlight) {
      this.activeFlight.elapsed += dt;
      const rawT = Math.min(1, this.activeFlight.elapsed / this.activeFlight.duration);
      const t = rawT < 0.5 ? 4 * rawT * rawT * rawT : 1 - Math.pow(-2 * rawT + 2, 3) / 2;

      const oneMinus = 1 - t;
      const pos = new THREE.Vector3()
        .addScaledVector(this.activeFlight.startPos, oneMinus * oneMinus)
        .addScaledVector(this.activeFlight.controlPos, 2 * oneMinus * t)
        .addScaledVector(this.activeFlight.endPos, t * t);
      this.camera.position.copy(pos);

      this.lookTarget.lerpVectors(this.activeFlight.startLook, this.activeFlight.endLook, t);
      this.camera.lookAt(this.lookTarget);

      if (rawT >= 1) {
        this.activeFlight = null;
      }
    } else if (!this.isDragging && !this.selectedId && !this.openClusterId && !this.openGlobeGroupId) {
      // Very gentle living motion in Neural Dome only; keep Clusters & Earth Globe steady for effortless reading & selection
      if (this.morphMode === 'neural') {
        this.yaw += dt * 0.015;
        const lookDir = new THREE.Vector3(
          Math.cos(this.pitch) * Math.sin(this.yaw),
          Math.sin(this.pitch),
          -Math.cos(this.pitch) * Math.cos(this.yaw)
        );
        this.lookTarget.copy(this.camera.position).addScaledVector(lookDir, 60);
        this.camera.lookAt(this.lookTarget);
      }
    }

    // 3. Morph / expansion interpolation
    let positionsDirty = false;
    if (this.morphProgress < 1) {
      this.morphProgress = Math.min(1, this.morphProgress + dt * 1.15);
      positionsDirty = true;
    }

    const activeFocusId = this.selectedId || this.hoveredId;
    const focusedNv = this.selectedId ? this.nodeVisuals.get(this.selectedId) ?? null : null;
    const activeNeighbors = new Set<string>();
    if (activeFocusId) {
      activeNeighbors.add(activeFocusId);
      for (const n of this.adjacency.get(activeFocusId) ?? []) {
        activeNeighbors.add(n.neighborId);
      }
    }

    // Gently dim background dust when a card is focused so artwork stays crystal-clear
    const targetDustOpacity = this.selectedId ? 0.09 : this.morphMode === 'clusters' ? 0.14 : 0.22;
    this.ambientDustMaterial.opacity = THREE.MathUtils.lerp(
      this.ambientDustMaterial.opacity,
      targetDustOpacity,
      dt * 5
    );

    // 4. Update visible Individual Memory Cards
    for (const [id, nv] of this.nodeVisuals) {
      if (!nv.group.visible) continue;

      if (positionsDirty) {
        nv.currentPos.lerp(nv.targetPos, Math.min(1, dt * 6.2));
      }

      const floatAmp = this.selectedId === id ? 0.08 : 0.24;
      const floatY = Math.sin(elapsed * 0.85 + nv.phase) * floatAmp;
      nv.group.position.set(nv.currentPos.x, nv.currentPos.y + floatY, nv.currentPos.z);
      nv.group.quaternion.copy(this.camera.quaternion);

      nv.pulseEnergy = Math.max(0.12, nv.pulseEnergy - dt * 0.45);

      const isSelected = id === this.selectedId;
      const isHovered = id === this.hoveredId;
      const isNeighbor = activeNeighbors.has(id);
      const matches = this.matchesFilter(nv.memory);

      let targetScale = nv.baseScale;
      let targetOpacity = 0.96;
      let borderOpacity = 0.38;
      let coreOpacity = 0.18 + nv.pulseEnergy * 0.14;

      if (!matches) {
        targetScale *= 0.65;
        targetOpacity = 0.16;
        borderOpacity = 0.05;
        coreOpacity = 0.03;
      } else if (isSelected) {
        targetScale *= 1.32;
        targetOpacity = 1.0;
        borderOpacity = 0.88;
        // Restrained halo behind focused card so it frames cleanly without blowing out the painting
        coreOpacity = 0.2;
      } else if (isHovered) {
        targetScale *= 1.18;
        targetOpacity = 1.0;
        borderOpacity = 0.78;
        coreOpacity = 0.26;
      } else if (activeFocusId && isNeighbor) {
        targetScale *= 1.08;
        targetOpacity = 0.95;
        borderOpacity = 0.62;
        coreOpacity = 0.24;
      } else if (activeFocusId) {
        targetScale *= 0.84;
        targetOpacity = 0.36;
        borderOpacity = 0.12;
        coreOpacity = 0.06;
      }

      const s = THREE.MathUtils.lerp(nv.group.scale.x, targetScale, dt * 7);
      nv.group.scale.setScalar(s);
      nv.frameMaterial.opacity = THREE.MathUtils.lerp(nv.frameMaterial.opacity, targetOpacity, dt * 7);
      nv.backingMaterial.opacity = nv.frameMaterial.opacity;
      nv.borderMaterial.opacity = THREE.MathUtils.lerp(nv.borderMaterial.opacity, borderOpacity, dt * 7);
      nv.coreMaterial.opacity = THREE.MathUtils.lerp(nv.coreMaterial.opacity, coreOpacity, dt * 6);
      nv.frameMesh.renderOrder = isSelected ? 10 : 6;
    }

    // 5. Update Cluster Group Cards (Billboard toward camera, dim non-open groups when one is opened)
    if (this.morphMode === 'clusters') {
      for (const [id, cv] of this.clusterCardVisuals) {
        cv.group.quaternion.copy(this.camera.quaternion);
        const isOpen = this.openClusterId === id;
        const isHovered = this.hoveredGroupId === id;
        const hasFilterMatch =
          !this.filter.value ||
          cv.memoryIds.some((mId) => {
            const m = this.nodeVisuals.get(mId)?.memory;
            return m ? this.matchesFilter(m) : false;
          });

        // Hide the collapsed stack card of the currently opened group (replaced by its fanned-out individual photos)
        cv.group.visible = !isOpen;
        if (!cv.group.visible) continue;

        const dimmed = this.openClusterId !== null || !hasFilterMatch;
        const targetOpacity = dimmed ? 0.2 : 0.98;
        const targetScale = isHovered && !dimmed ? 1.12 : dimmed ? 0.88 : 1.0;

        cv.group.scale.setScalar(THREE.MathUtils.lerp(cv.group.scale.x, targetScale, dt * 8));
        cv.cardMaterial.opacity = THREE.MathUtils.lerp(cv.cardMaterial.opacity, targetOpacity, dt * 7);
        cv.borderMaterial.opacity = THREE.MathUtils.lerp(
          cv.borderMaterial.opacity,
          isHovered && !dimmed ? 1.0 : dimmed ? 0.16 : 0.78,
          dt * 7
        );
        cv.labelMaterial.opacity = THREE.MathUtils.lerp(cv.labelMaterial.opacity, dimmed ? 0.22 : 0.98, dt * 7);
        for (const sm of cv.stackMaterials) {
          sm.opacity = THREE.MathUtils.lerp(sm.opacity, dimmed ? 0.08 : 0.52, dt * 7);
        }
      }
    }

    // 6. Update Earth Globe Region Cards (Billboard + hemisphere visibility fade so back-of-Earth pins never clutter)
    if (this.morphMode === 'globe') {
      const camDir = this.camera.position.clone().normalize();
      for (const [id, gv] of this.globeCardVisuals) {
        gv.group.quaternion.copy(this.camera.quaternion);
        const isOpen = this.openGlobeGroupId === id;
        gv.group.visible = !isOpen;
        if (gv.stemLine) gv.stemLine.visible = !isOpen;
        if (!gv.group.visible) continue;

        const pinDir = gv.position.clone().normalize();
        const facing = camDir.dot(pinDir);
        const isFront = facing > -0.05;
        const isHovered = this.hoveredGroupId === id;
        const otherOpen = this.openGlobeGroupId !== null;

        const targetOpacity = otherOpen ? (isFront ? 0.2 : 0.04) : isFront ? 0.98 : 0.12;
        const targetLabelOpacity = otherOpen ? 0.15 : facing > 0.05 ? 0.96 : 0.0;
        const targetScale = isHovered && isFront && !otherOpen ? 1.15 : isFront ? 1.0 : 0.78;

        gv.group.scale.setScalar(THREE.MathUtils.lerp(gv.group.scale.x, targetScale, dt * 8));
        gv.cardMaterial.opacity = THREE.MathUtils.lerp(gv.cardMaterial.opacity, targetOpacity, dt * 7);
        gv.borderMaterial.opacity = THREE.MathUtils.lerp(
          gv.borderMaterial.opacity,
          isHovered && isFront ? 1.0 : targetOpacity * 0.82,
          dt * 7
        );
        gv.labelMaterial.opacity = THREE.MathUtils.lerp(gv.labelMaterial.opacity, targetLabelOpacity, dt * 7);
        if (gv.stemMaterial) {
          gv.stemMaterial.opacity = THREE.MathUtils.lerp(gv.stemMaterial.opacity, targetOpacity * 0.65, dt * 7);
        }
      }
    }

    // 7. Update Curved Synaptic Axons (pushed behind card planes in Neural Dome so lines NEVER cross images)
    if (this.edgesGroup.visible) {
      const needPullUpdate = positionsDirty || this.morphMode === 'neural';
      for (let i = 0; i < this.edgeVisuals.length; i++) {
        const ev = this.edgeVisuals[i];
        const a = this.nodeVisuals.get(ev.edge.source);
        const b = this.nodeVisuals.get(ev.edge.target);
        if (!a || !b) continue;

        const bothVisible = a.group.visible && b.group.visible;
        ev.line.visible = bothVisible;
        if (!bothVisible) continue;

        if (needPullUpdate) {
          ev.curve = this.computeSynapseCurve(a.currentPos, b.currentPos, i, true);
          ev.line.geometry.setFromPoints(ev.curve.getPoints(24));
        }

        const involvesFocus =
          activeFocusId && (ev.edge.source === activeFocusId || ev.edge.target === activeFocusId);
        const matches = this.matchesFilter(a.memory) && this.matchesFilter(b.memory);

        let targetEdgeOpacity = 0.15;
        if (!matches && this.filter.value) {
          targetEdgeOpacity = 0.025;
        } else if (involvesFocus) {
          targetEdgeOpacity = 0.62;
        } else if (activeFocusId) {
          targetEdgeOpacity = 0.035;
        } else if (this.filter.value && matches) {
          targetEdgeOpacity = 0.52;
        }

        ev.material.opacity = THREE.MathUtils.lerp(ev.material.opacity, targetEdgeOpacity, dt * 6.5);
      }

      // 8. Advance firing action-potential sparks with focused-card clear exclusion zone
      if (this.pulsePoints && this.pulsePoints.visible && this.pulses.length > 0) {
        const posAttr = this.pulsePoints.geometry.getAttribute('position') as THREE.BufferAttribute;
        const colAttr = this.pulsePoints.geometry.getAttribute('color') as THREE.BufferAttribute;
        const tmp = new THREE.Vector3();
        const focusCenter = focusedNv ? focusedNv.group.position : null;
        const camToFocusDir = focusCenter
          ? focusCenter.clone().sub(this.camera.position).normalize()
          : null;
        const camToFocusDist = focusCenter ? this.camera.position.distanceTo(focusCenter) : 0;

        for (let i = 0; i < this.pulses.length; i++) {
          const p = this.pulses[i];
          const ev = this.edgeVisuals[p.edgeIdx];
          if (!ev || !ev.line.visible) {
            this.pulseColors[i * 3] = 0;
            this.pulseColors[i * 3 + 1] = 0;
            this.pulseColors[i * 3 + 2] = 0;
            continue;
          }

          const involvesFocus =
            activeFocusId && (ev.edge.source === activeFocusId || ev.edge.target === activeFocusId);
          const speedMult = involvesFocus ? 1.85 : 1.0 + p.boost * 1.4;
          p.t += dt * p.speed * speedMult * p.direction;
          p.boost = Math.max(0, p.boost - dt * 0.55);

          if (p.t >= 1) {
            p.t = 0;
            const targetNv = this.nodeVisuals.get(ev.edge.target);
            if (targetNv) targetNv.pulseEnergy = Math.min(0.85, targetNv.pulseEnergy + 0.22);
          } else if (p.t <= 0) {
            p.t = 1;
            const sourceNv = this.nodeVisuals.get(ev.edge.source);
            if (sourceNv) sourceNv.pulseEnergy = Math.min(0.85, sourceNv.pulseEnergy + 0.22);
          }

          ev.curve.getPoint(p.t, tmp);
          this.pulsePositions[i * 3] = tmp.x;
          this.pulsePositions[i * 3 + 1] = tmp.y;
          this.pulsePositions[i * 3 + 2] = tmp.z;

          let brightness = involvesFocus ? 1.05 : activeFocusId ? 0.16 : 0.78 + p.boost * 0.45;

          // Attenuate sparks near the focused card or crossing the camera->focused card corridor so NOTHING outshines the image
          if (focusCenter && camToFocusDir) {
            const distToFocus = tmp.distanceTo(focusCenter);
            if (distToFocus < 11.5) {
              const fade = Math.max(0, (distToFocus - 6.5) / 5.0);
              brightness *= fade * fade;
            }
            const camToSpark = tmp.clone().sub(this.camera.position);
            const along = camToSpark.dot(camToFocusDir);
            if (along > 0 && along < camToFocusDist + 4) {
              const perpDist = camToSpark.addScaledVector(camToFocusDir, -along).length();
              if (perpDist < 8.5) {
                brightness *= Math.max(0, (perpDist - 5.2) / 3.3);
              }
            }
          }

          this.pulseColors[i * 3] = Math.min(1.25, p.color.r * brightness);
          this.pulseColors[i * 3 + 1] = Math.min(1.25, p.color.g * brightness);
          this.pulseColors[i * 3 + 2] = Math.min(1.25, p.color.b * brightness);
        }

        posAttr.needsUpdate = true;
        colAttr.needsUpdate = true;
      }
    }

    // 9. Subtle ambient motion
    this.ambientDust.rotation.y = elapsed * 0.008;
    this.neuralDomeShell.rotation.y = -elapsed * 0.006;

    // 10. Hover Raycasting
    if (!this.isDragging) {
      const picked = this.pickUnderPointer();
      const nextMemId = picked?.type === 'memory' ? picked.id : null;
      const nextGroupId = picked && picked.type !== 'memory' ? picked.id : null;

      if (nextMemId !== this.hoveredId) {
        this.hoveredId = nextMemId;
        const mem = nextMemId ? this.nodeVisuals.get(nextMemId)?.memory ?? null : null;
        this.callbacks.onHoverMemory(mem);
      }

      if (nextGroupId !== this.hoveredGroupId) {
        this.hoveredGroupId = nextGroupId;
        const gLabel =
          nextGroupId && picked?.type === 'cluster'
            ? this.clusterCardVisuals.get(nextGroupId)?.label ?? null
            : nextGroupId && picked?.type === 'globe'
              ? this.globeCardVisuals.get(nextGroupId)?.label ?? null
              : null;
        this.callbacks.onHoverGroup?.(gLabel);
      }

      this.renderer.domElement.style.cursor = nextMemId || nextGroupId ? 'pointer' : 'grab';
    }

    this.composer.render();
  };

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.animFrameId);
    this.cleanupListeners();
    this.clearGraphObjects();
    this.glowTex.dispose();
    this.earthTex.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
