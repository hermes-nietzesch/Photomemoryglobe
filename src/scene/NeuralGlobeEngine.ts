import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type {
  ClusterHub,
  MemoryGraph,
  MemoryNode,
  MorphMode,
  SynapseEdge,
  SynapseKind,
} from '../../shared/types.ts';
import { SYNAPSE_COLORS } from '../../shared/types.ts';
import { renderMemoryArtworkCanvas } from '../utils/memoryArt.ts';

export interface ActiveFilter {
  kind: SynapseKind | 'all';
  value: string | null;
}

export interface EngineCallbacks {
  onHoverMemory: (memory: MemoryNode | null) => void;
  onSelectMemory: (memory: MemoryNode | null, viaEdge?: SynapseEdge | null) => void;
  onSynapseJump: (from: MemoryNode, to: MemoryNode, edge: SynapseEdge) => void;
}

interface NodeVisual {
  memory: MemoryNode;
  group: THREE.Group;
  frameMesh: THREE.Mesh;
  frameMaterial: THREE.MeshBasicMaterial;
  borderMaterial: THREE.MeshBasicMaterial;
  coreSprite: THREE.Sprite;
  coreMaterial: THREE.SpriteMaterial;
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
  grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
  grad.addColorStop(0.22, 'rgba(255, 255, 255, 0.85)');
  grad.addColorStop(0.55, 'rgba(255, 255, 255, 0.22)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
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
      // Cover crop
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

function createHubLabelSprite(hub: ClusterHub): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Pill background
  ctx.fillStyle = 'rgba(7, 11, 24, 0.82)';
  ctx.strokeStyle = hub.color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(12, 16, 336, 64, 32);
  ctx.fill();
  ctx.stroke();

  // Dot
  ctx.fillStyle = hub.color;
  ctx.beginPath();
  ctx.arc(46, 48, 8, 0, Math.PI * 2);
  ctx.fill();

  // Text
  ctx.fillStyle = '#f8fafc';
  ctx.font = '600 24px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const label = hub.label.length > 20 ? `${hub.label.slice(0, 19)}…` : hub.label;
  ctx.fillText(label, 68, 48);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(13, 3.5, 1);
  return sprite;
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
  private graph: MemoryGraph | null = null;
  private morphMode: MorphMode = 'neural';
  private filter: ActiveFilter = { kind: 'all', value: null };
  private autoDrift = false;
  private autoDriftTimer = 0;

  private rootGroup = new THREE.Group();
  private neuralDomeShell!: THREE.Group;
  private earthGlobeGroup!: THREE.Group;
  private clusterHubsGroup = new THREE.Group();
  private nodesGroup = new THREE.Group();
  private edgesGroup = new THREE.Group();
  private ambientDust!: THREE.Points;

  private nodeVisuals = new Map<string, NodeVisual>();
  private nodeMeshes: THREE.Object3D[] = [];
  private edgeVisuals: EdgeVisual[] = [];
  private adjacency = new Map<string, Array<{ neighborId: string; edge: SynapseEdge; edgeIdx: number }>>();

  // Action-potential pulses rendered as a single ultra-fast Points buffer
  private pulses: ActionPotentialPulse[] = [];
  private pulsePoints!: THREE.Points;
  private pulsePositions!: Float32Array;
  private pulseColors!: Float32Array;

  // Camera & navigation state
  private cameraPos = new THREE.Vector3(0, 2, 14);
  private lookTarget = new THREE.Vector3(0, 0, -40);
  private yaw = 0;
  private pitch = 0;
  private orbitRadius = 115; // Used in Geographic Globe & Clusters modes
  private isDragging = false;
  private pointerDownPos = { x: 0, y: 0 };
  private lastPointer = { x: 0, y: 0 };
  private pointerNDC = new THREE.Vector2(-99, -99);
  private raycaster = new THREE.Raycaster();

  private hoveredId: string | null = null;
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
    this.scene.fog = new THREE.FogExp2('#03050c', 0.0036);

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
    this.renderer.toneMappingExposure = 1.08;
    container.appendChild(this.renderer.domElement);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.46, 0.48, 0.68);
    this.composer.addPass(this.bloomPass);

    this.glowTex = createSoftGlowTexture();

    this.scene.add(this.rootGroup);
    this.buildEnvironmentShells();
    this.rootGroup.add(this.edgesGroup);
    this.rootGroup.add(this.nodesGroup);
    this.rootGroup.add(this.clusterHubsGroup);

    this.bindEvents();
    this.animate();
  }

  private buildEnvironmentShells(): void {
    // 1. Inside-Out Neural Dome cortical shell (subtle glowing icosahedral lattice + outer nebula halo)
    this.neuralDomeShell = new THREE.Group();
    const domeGeo = new THREE.IcosahedronGeometry(108, 3);
    const domeWire = new THREE.WireframeGeometry(domeGeo);
    const domeMat = new THREE.LineBasicMaterial({
      color: '#1e3a5f',
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.neuralDomeShell.add(new THREE.LineSegments(domeWire, domeMat));

    // Inner equatorial meridian rings for spatial orientation inside the giant globe
    for (let r = 0; r < 3; r++) {
      const ringGeo = new THREE.RingGeometry(102, 102.35, 96);
      const ringMat = new THREE.MeshBasicMaterial({
        color: r === 0 ? '#22d3ee' : r === 1 ? '#818cf8' : '#fb7185',
        transparent: true,
        opacity: 0.11,
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

    // 2. Holographic Geographic Earth Globe (visible when morphMode === 'globe')
    this.earthGlobeGroup = new THREE.Group();
    const earthRadius = 54;
    const earthSphere = new THREE.Mesh(
      new THREE.SphereGeometry(earthRadius, 48, 48),
      new THREE.MeshBasicMaterial({
        color: '#061326',
        transparent: true,
        opacity: 0.88,
      })
    );
    this.earthGlobeGroup.add(earthSphere);

    // Lat/Lng Graticule lines
    const graticulePoints: THREE.Vector3[] = [];
    for (let lat = -75; lat <= 75; lat += 15) {
      const phi = ((90 - lat) * Math.PI) / 180;
      const r = earthRadius + 0.15;
      for (let lng = -180; lng < 180; lng += 6) {
        const t1 = ((lng + 180) * Math.PI) / 180;
        const t2 = ((lng + 6 + 180) * Math.PI) / 180;
        graticulePoints.push(
          new THREE.Vector3(-r * Math.sin(phi) * Math.cos(t1), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(t1)),
          new THREE.Vector3(-r * Math.sin(phi) * Math.cos(t2), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(t2))
        );
      }
    }
    for (let lng = -180; lng < 180; lng += 20) {
      const theta = ((lng + 180) * Math.PI) / 180;
      const r = earthRadius + 0.15;
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
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
      })
    );
    this.earthGlobeGroup.add(graticule);

    // Atmospheric Fresnel Halo around Earth
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
          float intensity = pow(0.68 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.0);
          gl_FragColor = vec4(glowColor, clamp(intensity, 0.0, 0.85));
        }
      `,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(earthRadius * 1.14, 48, 48), atmoMat);
    this.earthGlobeGroup.add(atmosphere);
    this.earthGlobeGroup.visible = false;
    this.rootGroup.add(this.earthGlobeGroup);

    // 3. Ambient cosmic/synaptic stardust particles floating inside the sphere
    const dustCount = 1100;
    const dustPos = new Float32Array(dustCount * 3);
    const dustCol = new Float32Array(dustCount * 3);
    const palette = [new THREE.Color('#22d3ee'), new THREE.Color('#818cf8'), new THREE.Color('#fb7185'), new THREE.Color('#fbbf24')];
    for (let i = 0; i < dustCount; i++) {
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const r = 18 + Math.random() * 115;
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
    const dustMat = new THREE.PointsMaterial({
      size: 1.4,
      map: this.glowTex,
      vertexColors: true,
      transparent: true,
      opacity: 0.48,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.ambientDust = new THREE.Points(dustGeo, dustMat);
    this.rootGroup.add(this.ambientDust);
  }

  public setGraph(graph: MemoryGraph): void {
    this.graph = graph;
    this.clearGraphObjects();

    const frameGeo = new THREE.PlaneGeometry(8.2, 5.7);
    const borderGeo = new THREE.PlaneGeometry(8.55, 6.05);

    // Build Memory Neuron Nodes
    graph.memories.forEach((memory, idx) => {
      const group = new THREE.Group();
      const startPos = new THREE.Vector3(...memory.positions[this.morphMode]);
      group.position.copy(startPos);

      const cardTex = createMemoryCardTexture(memory);
      const frameMaterial = new THREE.MeshBasicMaterial({
        map: cardTex,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.94,
      });
      const frameMesh = new THREE.Mesh(frameGeo, frameMaterial);
      frameMesh.userData = { memoryId: memory.id };

      const accent = new THREE.Color(memory.palette[0]);
      const borderMaterial = new THREE.MeshBasicMaterial({
        color: accent,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const borderMesh = new THREE.Mesh(borderGeo, borderMaterial);
      borderMesh.position.z = -0.05;

      // Glowing neural soma halo behind the photo card
      const coreMaterial = new THREE.SpriteMaterial({
        map: this.glowTex,
        color: accent,
        transparent: true,
        opacity: 0.36,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const coreSprite = new THREE.Sprite(coreMaterial);
      const hubBoost = Math.min(1.32, 0.88 + memory.degree * 0.045);
      coreSprite.scale.set(10.5 * hubBoost, 10.5 * hubBoost, 1);
      coreSprite.position.z = -0.15;

      group.add(coreSprite);
      group.add(borderMesh);
      group.add(frameMesh);

      this.nodesGroup.add(group);
      this.nodeMeshes.push(frameMesh);

      this.nodeVisuals.set(memory.id, {
        memory,
        group,
        frameMesh,
        frameMaterial,
        borderMaterial,
        coreSprite,
        coreMaterial,
        currentPos: startPos.clone(),
        targetPos: startPos.clone(),
        baseScale: hubBoost,
        pulseEnergy: 0.25,
        phase: idx * 0.71,
      });
    });

    // Build Adjacency + Curved 3D Synaptic Axons
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
        opacity: 0.24,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(geo, material);
      this.edgesGroup.add(line);

      const visual: EdgeVisual = {
        edge,
        line,
        material,
        curve,
        baseColor,
        pulseCount: edge.weight > 0.7 ? 2 : 1,
      };
      this.edgeVisuals.push(visual);

      if (!this.adjacency.has(edge.source)) this.adjacency.set(edge.source, []);
      if (!this.adjacency.has(edge.target)) this.adjacency.set(edge.target, []);
      this.adjacency.get(edge.source)!.push({ neighborId: edge.target, edge, edgeIdx });
      this.adjacency.get(edge.target)!.push({ neighborId: edge.source, edge, edgeIdx });
    });

    // Build Action-Potential Firing Sparks along every synapse
    this.pulses = [];
    this.edgeVisuals.forEach((ev, edgeIdx) => {
      for (let p = 0; p < ev.pulseCount; p++) {
        this.pulses.push({
          edgeIdx,
          t: Math.random(),
          speed: 0.14 + Math.random() * 0.24,
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
      size: 3.1,
      map: this.glowTex,
      vertexColors: true,
      transparent: true,
      opacity: 0.96,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.pulsePoints = new THREE.Points(pulseGeo, pulseMat);
    this.edgesGroup.add(this.pulsePoints);

    // Build Cluster Hub Nodes for `clusters` mode
    graph.hubs.forEach((hub) => {
      const hubGroup = new THREE.Group();
      hubGroup.position.set(...hub.position);

      const orb = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTex,
          color: hub.color,
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      orb.scale.set(9.5, 9.5, 1);
      hubGroup.add(orb);

      const label = createHubLabelSprite(hub);
      label.position.y = 4.2;
      hubGroup.add(label);

      this.clusterHubsGroup.add(hubGroup);
    });
    this.clusterHubsGroup.visible = this.morphMode === 'clusters';

    // Reset selection & start inside the globe looking at the richest hub memory
    this.selectedId = null;
    this.visitedStack = [];
    this.resetCameraForMode(this.morphMode);
  }

  private clearGraphObjects(): void {
    for (const nv of this.nodeVisuals.values()) {
      nv.frameMaterial.map?.dispose();
      nv.frameMaterial.dispose();
      nv.borderMaterial.dispose();
      nv.coreMaterial.dispose();
    }
    this.nodeVisuals.clear();
    this.nodeMeshes = [];
    this.nodesGroup.clear();

    for (const ev of this.edgeVisuals) {
      ev.line.geometry.dispose();
      ev.material.dispose();
    }
    this.edgeVisuals = [];
    this.edgesGroup.clear();
    this.clusterHubsGroup.clear();
  }

  private computeSynapseCurve(a: THREE.Vector3, b: THREE.Vector3, seed: number): THREE.QuadraticBezierCurve3 {
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const dist = a.distanceTo(b);

    if (this.morphMode === 'globe') {
      // Arch gracefully ABOVE the Earth surface like glowing neural flight arcs
      const midLen = mid.length() || 1;
      const archHeight = Math.max(58, midLen + dist * 0.28);
      mid.normalize().multiplyScalar(archHeight);
    } else if (this.morphMode === 'neural') {
      // Gently bow inward across the neural dome (never colliding with exact origin 0,0,0)
      const midLen = mid.length();
      if (midLen > 12) {
        const pull = 0.72 + ((seed % 7) * 0.03);
        mid.multiplyScalar(pull);
      } else {
        // Long cross-dome axon: bow around an organic perpendicular offset
        const perp = new THREE.Vector3(a.y - b.y, b.x - a.x, (seed % 2 === 0 ? 1 : -1) * 18).normalize();
        mid.addScaledVector(perp, 24);
      }
    } else {
      // Clusters mode: gentle organic curve
      const offset = ((seed % 5) - 2) * 3.5;
      mid.y += offset;
    }

    return new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone());
  }

  public setMorphMode(mode: MorphMode): void {
    if (this.morphMode === mode) return;
    this.morphMode = mode;
    this.morphProgress = 0;
    this.selectedId = null;
    this.callbacks.onSelectMemory(null, null);

    for (const nv of this.nodeVisuals.values()) {
      nv.targetPos.set(...nv.memory.positions[mode]);
    }

    this.neuralDomeShell.visible = mode === 'neural';
    this.earthGlobeGroup.visible = mode === 'globe';
    this.clusterHubsGroup.visible = mode === 'clusters';
    this.resetCameraForMode(mode);
  }

  public setFilter(filter: ActiveFilter): void {
    this.filter = filter;
    // Trigger a celebratory synaptic ripple across matching nodes
    for (const nv of this.nodeVisuals.values()) {
      if (this.matchesFilter(nv.memory)) {
        nv.pulseEnergy = 1.0;
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
    this.visitedStack = [];
    this.callbacks.onSelectMemory(null, null);
    this.resetCameraForMode(this.morphMode);
  }

  private resetCameraForMode(mode: MorphMode): void {
    if (mode === 'neural') {
      // Inside the giant neural globe!
      this.yaw = 0;
      this.pitch = 0.04;
      const startPos = this.camera.position.clone();
      const endPos = new THREE.Vector3(0, 1.5, 14);
      const endLook = new THREE.Vector3(0, 2, -60);
      this.startCameraFlight(startPos, endPos, this.lookTarget.clone(), endLook, 1.15, null);
    } else if (mode === 'globe') {
      // Outside looking at the glowing holographic Earth
      this.orbitRadius = 128;
      this.yaw = 0.45;
      this.pitch = 0.28;
      const endPos = this.sphericalOrbitPos(this.orbitRadius, this.yaw, this.pitch);
      this.startCameraFlight(this.camera.position.clone(), endPos, this.lookTarget.clone(), new THREE.Vector3(0, 0, 0), 1.25, null);
    } else {
      // Constellation Clusters view
      this.orbitRadius = 118;
      this.yaw = -0.35;
      this.pitch = 0.22;
      const endPos = this.sphericalOrbitPos(this.orbitRadius, this.yaw, this.pitch);
      this.startCameraFlight(this.camera.position.clone(), endPos, this.lookTarget.clone(), new THREE.Vector3(0, 0, 0), 1.25, null);
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

    const prevId = this.selectedId;
    this.selectedId = memoryId;
    if (prevId && prevId !== memoryId) {
      this.visitedStack.push(prevId);
      if (this.visitedStack.length > 24) this.visitedStack.shift();
    }

    nv.pulseEnergy = 1.25;

    // Ignite connected neighbors & fire rapid action potentials out of this neuron!
    const neighbors = this.adjacency.get(memoryId) ?? [];
    for (const n of neighbors) {
      const targetNv = this.nodeVisuals.get(n.neighborId);
      if (targetNv) targetNv.pulseEnergy = Math.max(targetNv.pulseEnergy, 0.8);
      for (const pulse of this.pulses) {
        if (pulse.edgeIdx === n.edgeIdx) {
          pulse.boost = 1.0;
          pulse.t = n.edge.source === memoryId ? 0.02 : 0.98;
          pulse.direction = n.edge.source === memoryId ? 1 : -1;
        }
      }
    }

    const nodePos = nv.targetPos.clone();
    let endPos: THREE.Vector3;

    if (this.morphMode === 'neural') {
      // Position camera smoothly *inward* from the memory node facing it nicely inside the dome
      const inward = nodePos.clone().normalize().negate();
      endPos = nodePos.clone().addScaledVector(inward, 19.5);
    } else if (this.morphMode === 'globe') {
      // Hover above the Earth surface looking down at the memory
      const outward = nodePos.clone().normalize();
      endPos = nodePos.clone().addScaledVector(outward, 24);
    } else {
      const dir = nodePos.clone().sub(this.camera.position).normalize();
      endPos = nodePos.clone().addScaledVector(dir, -21);
    }

    // If traveling from another memory via a synapse, curve the camera flight along that synaptic path!
    let controlPos = new THREE.Vector3().addVectors(this.camera.position, endPos).multiplyScalar(0.5);
    if (viaEdge) {
      const ev = this.edgeVisuals.find((e) => e.edge.id === viaEdge.id);
      if (ev) {
        const curveMid = ev.curve.getPoint(0.5);
        controlPos.lerp(curveMid, 0.55);
      }
    }

    this.activeFlight = {
      startPos: this.camera.position.clone(),
      controlPos,
      endPos,
      startLook: this.lookTarget.clone(),
      endLook: nodePos.clone(),
      elapsed: 0,
      duration: viaEdge ? 1.25 : 1.0,
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
    // Prefer unvisited neighbors, matching preferredKind or active filter, with strong cross-event weight
    const ranked = [...neighbors].sort((a, b) => {
      const aVisited = recentSet.has(a.neighborId) ? -1.5 : 0;
      const bVisited = recentSet.has(b.neighborId) ? -1.5 : 0;
      const aKind = preferredKind && a.edge.kind === preferredKind ? 1.2 : 0;
      const bKind = preferredKind && b.edge.kind === preferredKind ? 1.2 : 0;
      const aFilter = this.matchesFilter(this.nodeVisuals.get(a.neighborId)!.memory) ? 0.6 : 0;
      const bFilter = this.matchesFilter(this.nodeVisuals.get(b.neighborId)!.memory) ? 0.6 : 0;
      return (b.edge.weight + bVisited + bKind + bFilter) - (a.edge.weight + aVisited + aKind + aFilter);
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
      this.resetView();
      return false;
    }
    const prevId = this.visitedStack.pop()!;
    this.selectedId = null; // Avoid pushing current back onto stack immediately
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
        pulse.boost = 1.0;
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
          // Inside-out 360° look around!
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
          // Smooth spherical orbit around either the selected memory or the globe center
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
      dom.style.cursor = this.hoveredId ? 'pointer' : 'grab';

      if (moved < 6) {
        // Click detection
        const hit = this.pickMemoryUnderPointer();
        if (hit) {
          let connectingEdge: SynapseEdge | null = null;
          if (this.selectedId && this.selectedId !== hit) {
            const adj = this.adjacency.get(this.selectedId)?.find((n) => n.neighborId === hit);
            if (adj) {
              connectingEdge = adj.edge;
              const fromMem = this.nodeVisuals.get(this.selectedId)?.memory;
              const toMem = this.nodeVisuals.get(hit)?.memory;
              if (fromMem && toMem) {
                this.callbacks.onSynapseJump(fromMem, toMem, adj.edge);
              }
            }
          }
          this.focusMemory(hit, connectingEdge);
        }
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (this.scrollJumpCooldown > 0) return;

      const delta = e.deltaY;

      // Scroll-in Neural Traversal!
      if (delta < 0) {
        // Scrolling IN / forward
        if (!this.selectedId) {
          // If hovering a memory, dive into it; otherwise dive into the memory closest to center gaze!
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
          // Already focused on a memory: scrolling in smoothly zooms closer, then FIRES a synapse into a related memory!
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
        // Scrolling OUT / backward
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
        } else if (this.morphMode !== 'neural') {
          this.orbitRadius = Math.min(195, Math.max(75, this.orbitRadius + delta * 0.08));
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

  private pickMemoryUnderPointer(): string | null {
    if (this.nodeMeshes.length === 0) return null;
    this.raycaster.setFromCamera(this.pointerNDC, this.camera);
    const hits = this.raycaster.intersectObjects(this.nodeMeshes, false);
    if (hits.length > 0) {
      return (hits[0].object.userData.memoryId as string) || null;
    }
    return null;
  }

  private findClosestMemoryToGaze(): string | null {
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    let bestId: string | null = null;
    let bestDot = -Infinity;
    for (const [id, nv] of this.nodeVisuals) {
      if (!this.matchesFilter(nv.memory)) continue;
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

    // 1. Auto Synaptic Drift mode
    if (this.autoDrift && !this.isDragging) {
      this.autoDriftTimer += dt;
      if (this.autoDriftTimer > 4.2) {
        this.autoDriftTimer = 0;
        this.fireNextSynapse();
      }
    }

    // 2. Smooth Camera Flight along synaptic pathways
    if (this.activeFlight) {
      this.activeFlight.elapsed += dt;
      const rawT = Math.min(1, this.activeFlight.elapsed / this.activeFlight.duration);
      // Cubic ease-in-out
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
    } else if (!this.isDragging && !this.selectedId) {
      // Gentle living breath / slow ambient drift so the neural globe feels alive
      if (this.morphMode === 'neural') {
        this.yaw += dt * 0.025;
        const lookDir = new THREE.Vector3(
          Math.cos(this.pitch) * Math.sin(this.yaw),
          Math.sin(this.pitch),
          -Math.cos(this.pitch) * Math.cos(this.yaw)
        );
        this.lookTarget.copy(this.camera.position).addScaledVector(lookDir, 60);
        this.camera.lookAt(this.lookTarget);
      } else {
        this.yaw += dt * 0.055;
        const pos = this.sphericalOrbitPos(this.orbitRadius, this.yaw, this.pitch);
        this.camera.position.lerp(pos, 0.08);
        this.lookTarget.lerp(new THREE.Vector3(0, 0, 0), 0.1);
        this.camera.lookAt(this.lookTarget);
      }
    }

    // 3. Smoothly morph nodes between Neural Dome / Earth Globe / Clusters
    let positionsDirty = false;
    if (this.morphProgress < 1) {
      this.morphProgress = Math.min(1, this.morphProgress + dt * 0.95);
      positionsDirty = true;
    }

    const activeFocusId = this.selectedId || this.hoveredId;
    const activeNeighbors = new Set<string>();
    if (activeFocusId) {
      activeNeighbors.add(activeFocusId);
      for (const n of this.adjacency.get(activeFocusId) ?? []) {
        activeNeighbors.add(n.neighborId);
      }
    }

    for (const [id, nv] of this.nodeVisuals) {
      if (positionsDirty) {
        nv.currentPos.lerp(nv.targetPos, Math.min(1, dt * 5.2));
      }

      // Gentle organic floating motion
      const floatY = Math.sin(elapsed * 0.9 + nv.phase) * 0.35;
      nv.group.position.set(nv.currentPos.x, nv.currentPos.y + floatY, nv.currentPos.z);

      // Billboard softly toward camera so every memory photo is always clear & readable
      nv.group.quaternion.copy(this.camera.quaternion);

      // Decay synaptic pulse energy
      nv.pulseEnergy = Math.max(0.18, nv.pulseEnergy - dt * 0.45);

      const isSelected = id === this.selectedId;
      const isHovered = id === this.hoveredId;
      const isNeighbor = activeNeighbors.has(id);
      const matches = this.matchesFilter(nv.memory);

      let targetScale = nv.baseScale;
      let targetOpacity = 0.92;
      let borderOpacity = 0.32;
      let coreOpacity = 0.48 + nv.pulseEnergy * 0.45;

      if (!matches) {
        targetScale *= 0.62;
        targetOpacity = 0.18;
        borderOpacity = 0.06;
        coreOpacity = 0.08;
      } else if (isSelected) {
        targetScale *= 1.38;
        targetOpacity = 1.0;
        borderOpacity = 0.95;
        coreOpacity = 1.0;
      } else if (isHovered) {
        targetScale *= 1.24;
        targetOpacity = 1.0;
        borderOpacity = 0.85;
        coreOpacity = 0.9;
      } else if (activeFocusId && isNeighbor) {
        targetScale *= 1.12;
        targetOpacity = 0.96;
        borderOpacity = 0.68;
        coreOpacity = 0.78;
      } else if (activeFocusId) {
        targetScale *= 0.86;
        targetOpacity = 0.42;
        borderOpacity = 0.14;
        coreOpacity = 0.22;
      }

      const s = THREE.MathUtils.lerp(nv.group.scale.x, targetScale, dt * 7);
      nv.group.scale.setScalar(s);
      nv.frameMaterial.opacity = THREE.MathUtils.lerp(nv.frameMaterial.opacity, targetOpacity, dt * 7);
      nv.borderMaterial.opacity = THREE.MathUtils.lerp(nv.borderMaterial.opacity, borderOpacity, dt * 7);
      nv.coreMaterial.opacity = THREE.MathUtils.lerp(nv.coreMaterial.opacity, coreOpacity, dt * 6);
    }

    // 4. Update Curved Synaptic Axons & Fire Action-Potential Pulses
    for (let i = 0; i < this.edgeVisuals.length; i++) {
      const ev = this.edgeVisuals[i];
      const a = this.nodeVisuals.get(ev.edge.source);
      const b = this.nodeVisuals.get(ev.edge.target);
      if (!a || !b) continue;

      if (positionsDirty) {
        ev.curve = this.computeSynapseCurve(a.currentPos, b.currentPos, i);
        const pts = ev.curve.getPoints(26);
        ev.line.geometry.setFromPoints(pts);
      }

      const involvesFocus =
        activeFocusId && (ev.edge.source === activeFocusId || ev.edge.target === activeFocusId);
      const matches = this.matchesFilter(a.memory) && this.matchesFilter(b.memory);

      let targetEdgeOpacity = 0.2;
      if (!matches && this.filter.value) {
        targetEdgeOpacity = 0.03;
      } else if (involvesFocus) {
        targetEdgeOpacity = 0.86;
      } else if (activeFocusId) {
        targetEdgeOpacity = 0.07;
      } else if (this.filter.value && matches) {
        targetEdgeOpacity = 0.62;
      }

      ev.material.opacity = THREE.MathUtils.lerp(ev.material.opacity, targetEdgeOpacity, dt * 6.5);
    }

    // Advance firing neuron pulses along the curves
    if (this.pulsePoints && this.pulses.length > 0) {
      const posAttr = this.pulsePoints.geometry.getAttribute('position') as THREE.BufferAttribute;
      const colAttr = this.pulsePoints.geometry.getAttribute('color') as THREE.BufferAttribute;
      const tmp = new THREE.Vector3();

      for (let i = 0; i < this.pulses.length; i++) {
        const p = this.pulses[i];
        const ev = this.edgeVisuals[p.edgeIdx];
        if (!ev) continue;

        const involvesFocus =
          activeFocusId && (ev.edge.source === activeFocusId || ev.edge.target === activeFocusId);
        const speedMult = involvesFocus ? 2.4 : 1.0 + p.boost * 1.8;
        p.t += dt * p.speed * speedMult * p.direction;
        p.boost = Math.max(0, p.boost - dt * 0.55);

        if (p.t >= 1) {
          p.t = 0;
          // Arrival at target neuron triggers a brief soma glow flare!
          const targetNv = this.nodeVisuals.get(ev.edge.target);
          if (targetNv) targetNv.pulseEnergy = Math.min(1.2, targetNv.pulseEnergy + 0.35);
        } else if (p.t <= 0) {
          p.t = 1;
          const sourceNv = this.nodeVisuals.get(ev.edge.source);
          if (sourceNv) sourceNv.pulseEnergy = Math.min(1.2, sourceNv.pulseEnergy + 0.35);
        }

        ev.curve.getPoint(p.t, tmp);
        this.pulsePositions[i * 3] = tmp.x;
        this.pulsePositions[i * 3 + 1] = tmp.y;
        this.pulsePositions[i * 3 + 2] = tmp.z;

        const brightness = involvesFocus ? 1.85 : activeFocusId ? 0.35 : 1.15 + p.boost * 0.7;
        this.pulseColors[i * 3] = Math.min(2.0, p.color.r * brightness);
        this.pulseColors[i * 3 + 1] = Math.min(2.0, p.color.g * brightness);
        this.pulseColors[i * 3 + 2] = Math.min(2.0, p.color.b * brightness);
      }

      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
    }

    // 5. Subtle rotation of ambient dust & neural dome lattice
    this.ambientDust.rotation.y = elapsed * 0.012;
    this.neuralDomeShell.rotation.y = -elapsed * 0.008;

    // 6. Hover Raycasting
    if (!this.isDragging) {
      const hit = this.pickMemoryUnderPointer();
      if (hit !== this.hoveredId) {
        this.hoveredId = hit;
        this.renderer.domElement.style.cursor = hit ? 'pointer' : 'grab';
        const mem = hit ? this.nodeVisuals.get(hit)?.memory ?? null : null;
        this.callbacks.onHoverMemory(mem);
      }
    }

    this.composer.render();
  };

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.animFrameId);
    this.cleanupListeners();
    this.clearGraphObjects();
    this.glowTex.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
