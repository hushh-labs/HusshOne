"use client";

/* ============================================================
   ParticleMorph — Hussh One centerpiece (WebGL)
   A dense, volume-filled cloud of frosted-white particles that
   reads as a solid, glassy object and continuously morphs on a
   loop: sphere → DNA double-helix → cube → sphere, slowly
   rotating, with a soft neutral ink glow from the core and a
   contact shadow. Centered on screen; transparent canvas so the
   page paper shows through.

   Mirrors CanvasField's lifecycle: "use client", all WebGL work
   inside a single useEffect, live props via a ref, DPR clamp to
   2, resize handler, immediate first paint, full disposal on
   cleanup. No window/THREE access at module scope (SSR-safe).
   ============================================================ */

import { useEffect, useRef } from "react";
import * as THREE from "three";

interface ParticleMorphProps {
  /** 0..1 — scales rotation + morph speed (matches the app's --motion). */
  motion?: number;
  /** particle count (default 42000). */
  count?: number;
  /** hard-freeze the animation. */
  paused?: boolean;
}

/* ── tunables ─────────────────────────────────────────────── */
const SPHERE_R = 2.5;
const HELIX_H = 4.6;
const HELIX_R = 1.25;
const HELIX_TURNS = 3;
const HELIX_TUBE = 0.24; // tube thickness of the helix strands
const CUBE_HALF = 1.85;
const CUBE_FROST = 0.06; // surface roughness of the cube

const HOLD = 2.2; // seconds a shape rests, fully formed
const MORPH = 1.5; // seconds to morph into the next shape
const JITTER = 0.009; // per-particle shimmer amplitude (subtle → crisp surface)

// frosted-glass tints — neutral greys (hellow monochrome); density carries
// the form, a neutral mid-gray keeps the surface grain visible on off-white.
const TINT_DARK: [number, number, number] = [168, 168, 172];
const TINT_LIGHT: [number, number, number] = [244, 244, 246];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => x * x * (3 - 2 * x);
// deterministic 0..1 hash so shapes are stable across reloads / HMR
const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};
// deterministic offset inside a ball of the given radius (gives volume/thickness)
function ballOffset(i: number, seed: number, radius: number): [number, number, number] {
  const theta = hash(i * 1.7 + seed) * Math.PI * 2;
  const phi = Math.acos(2 * hash(i * 2.3 + seed * 3.1) - 1);
  const r = Math.cbrt(hash(i * 3.1 + seed * 5.7)) * radius;
  const s = Math.sin(phi);
  return [r * s * Math.cos(theta), r * Math.cos(phi), r * s * Math.sin(theta)];
}

/* soft round frosted sprite for each particle (fairly solid center so dense
   packing forms a defined surface rather than a fuzzy haze) */
function makeParticleTexture(): THREE.CanvasTexture {
  const s = 64;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const g = cv.getContext("2d")!;
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.42, "rgba(255,255,255,0.85)");
  grd.addColorStop(0.78, "rgba(255,255,255,0.22)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

/* neutral ink radial glow for the core (hellow monochrome) */
function makeGlowTexture(): THREE.CanvasTexture {
  const s = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const g = cv.getContext("2d")!;
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, "rgba(17,17,19,0.42)"); // ink core
  grd.addColorStop(0.22, "rgba(17,17,19,0.24)");
  grd.addColorStop(0.55, "rgba(59,59,59,0.10)"); // mid grey
  grd.addColorStop(1, "rgba(59,59,59,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

/* soft studio backdrop so the frosted-white object reads as solid glass
   (a near-white center lifting the object, fading to a soft cool gray) */
function makeBackdropTexture(): THREE.CanvasTexture {
  const s = 512;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const g = cv.getContext("2d")!;
  const grd = g.createRadialGradient(s / 2, s * 0.44, 0, s / 2, s * 0.5, s * 0.62);
  grd.addColorStop(0, "#FAF9F8");
  grd.addColorStop(0.5, "#EBEAE8");
  grd.addColorStop(1, "#DEDEE2");
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  // soft contact shadow on the "floor" beneath the object
  g.save();
  g.translate(s / 2, s * 0.8);
  g.scale(1, 0.36);
  const sh = g.createRadialGradient(0, 0, 0, 0, 0, s * 0.24);
  sh.addColorStop(0, "rgba(17,17,19,0.18)");
  sh.addColorStop(1, "rgba(17,17,19,0)");
  g.fillStyle = sh;
  g.beginPath();
  g.arc(0, 0, s * 0.24, 0, Math.PI * 2);
  g.fill();
  g.restore();
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

/* ── shape target builders (each fills xyz for index i) ───── */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

// solid ball: even angular spread (fibonacci) × radius skewed to the surface
function buildSphere(count: number): Float32Array {
  const a = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2; // 1 .. -1
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = GOLDEN * i;
    // thin shell: dense rim reads solid, translucent center shows the core glow
    const rad = SPHERE_R * (0.9 + 0.1 * hash(i * 4.1));
    a[i * 3] = Math.cos(th) * r * rad;
    a[i * 3 + 1] = y * rad;
    a[i * 3 + 2] = Math.sin(th) * r * rad;
  }
  return a;
}

// solid double helix: two phase-shifted strands + rungs, each given tube thickness
function buildHelix(count: number): Float32Array {
  const a = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1); // 0..1 along the axis
    const ang = t * Math.PI * 2 * HELIX_TURNS;
    const yy = (t - 0.5) * HELIX_H;
    let cx: number;
    let cy: number;
    let cz: number;
    if (i % 5 === 4) {
      // ~20% — rungs bridging the two strands
      const fr = hash(i * 1.9);
      const ax = Math.cos(ang) * HELIX_R;
      const az = Math.sin(ang) * HELIX_R;
      const bx = Math.cos(ang + Math.PI) * HELIX_R;
      const bz = Math.sin(ang + Math.PI) * HELIX_R;
      cx = ax + (bx - ax) * fr;
      cy = yy;
      cz = az + (bz - az) * fr;
    } else {
      // ~80% — two backbone strands
      const strand = i % 2 === 0 ? 0 : Math.PI;
      cx = Math.cos(ang + strand) * HELIX_R;
      cy = yy;
      cz = Math.sin(ang + strand) * HELIX_R;
    }
    const off = ballOffset(i, 5.1, HELIX_TUBE);
    a[i * 3] = cx + off[0];
    a[i * 3 + 1] = cy + off[1];
    a[i * 3 + 2] = cz + off[2];
  }
  return a;
}

// frosted cube: points on the 6 faces, edge-biased, with a crystalline frost offset
function buildCube(count: number): Float32Array {
  const a = new Float32Array(count * 3);
  const H = CUBE_HALF;
  for (let i = 0; i < count; i++) {
    const f = i % 6; // which of the 6 faces
    const u = (hash(i * 2.17) * 2 - 1) * H;
    let v = (hash(i * 3.91) * 2 - 1) * H;
    if (i % 6 === 0) v = v > 0 ? H : -H; // ~1/6 onto an edge for a crisp silhouette
    let x = 0;
    let y = 0;
    let z = 0;
    switch (f) {
      case 0: x = H; y = u; z = v; break;
      case 1: x = -H; y = u; z = v; break;
      case 2: y = H; x = u; z = v; break;
      case 3: y = -H; x = u; z = v; break;
      case 4: z = H; x = u; y = v; break;
      default: z = -H; x = u; y = v; break;
    }
    const off = ballOffset(i, 9.3, CUBE_FROST);
    a[i * 3] = x + off[0];
    a[i * 3 + 1] = y + off[1];
    a[i * 3 + 2] = z + off[2];
  }
  return a;
}

export function ParticleMorph(props: ParticleMorphProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const live = useRef<ParticleMorphProps>(props);

  // keep the RAF loop reading the latest props without re-subscribing
  useEffect(() => {
    live.current = props;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const count = Math.max(1000, live.current.count ?? 55000);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0); // transparent → page paper shows through
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.z = 9;

    const group = new THREE.Group();
    scene.add(group);

    // ── soft studio backdrop (fills the canvas behind the object) ─
    const backdropTexture = makeBackdropTexture();
    const backdropGeo = new THREE.PlaneGeometry(1, 1);
    const backdropMat = new THREE.MeshBasicMaterial({
      map: backdropTexture,
      depthTest: false,
      depthWrite: false,
    });
    const backdrop = new THREE.Mesh(backdropGeo, backdropMat);
    backdrop.position.z = -6;
    backdrop.renderOrder = -10; // draw first, behind everything
    scene.add(backdrop);

    // ── morph targets + live position/color buffers ──────────
    const SHAPES = [buildSphere(count), buildHelix(count), buildCube(count)];
    const positions = new Float32Array(SHAPES[0]); // start as a sphere
    const colors = new Float32Array(count * 3);
    const phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const t = Math.pow(hash(i * 5.23), 0.8); // skewed toward light
      colors[i * 3] = (TINT_DARK[0] + (TINT_LIGHT[0] - TINT_DARK[0]) * t) / 255;
      colors[i * 3 + 1] = (TINT_DARK[1] + (TINT_LIGHT[1] - TINT_DARK[1]) * t) / 255;
      colors[i * 3 + 2] = (TINT_DARK[2] + (TINT_LIGHT[2] - TINT_DARK[2]) * t) / 255;
      phase[i] = hash(i * 9.71) * Math.PI * 2;
    }

    const geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(positions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", posAttr);
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const particleTexture = makeParticleTexture();
    const pointsMaterial = new THREE.PointsMaterial({
      map: particleTexture,
      vertexColors: true,
      size: 0.05,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.85, // dense rim reads opaque/solid; thin-shell center stays translucent for the core
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    const points = new THREE.Points(geometry, pointsMaterial);
    group.add(points);

    // ── neutral ink core glow (normal-blended) ─
    const glowTexture = makeGlowTexture();
    const glowMaterial = new THREE.SpriteMaterial({
      map: glowTexture,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
    });
    const glow = new THREE.Sprite(glowMaterial);
    glow.scale.setScalar(4);
    glow.renderOrder = -1; // draw behind the particles
    group.add(glow);

    // ── reduced motion ──────────────────────────────────────
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduce = mq.matches;
    const onMq = (e: MediaQueryListEvent) => {
      reduce = e.matches;
    };
    mq.addEventListener("change", onMq);

    // ── layout: centered on screen; backdrop sized to fill view ─
    function layout() {
      const small = canvas!.clientWidth < 600;
      group.scale.setScalar(small ? 0.72 : 1);
      group.position.y = small ? 0.5 : 0.25;
      // size the backdrop plane to (over)fill the viewport at its depth
      const dist = camera.position.z - backdrop.position.z;
      const vH = 2 * Math.tan((camera.fov * Math.PI) / 180 / 2) * dist;
      backdrop.scale.set(vH * camera.aspect * 1.12, vH * 1.12, 1);
    }

    function resize() {
      const w = canvas!.clientWidth;
      const h = canvas!.clientHeight;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false); // CSS (.field) owns the element size
      camera.aspect = w / h || 1;
      camera.updateProjectionMatrix();
      layout();
    }
    resize();
    window.addEventListener("resize", resize);

    const t0 = performance.now();
    const cycle = HOLD + MORPH;
    const total = SHAPES.length * cycle;
    let raf = 0;
    let running = true;

    function update(now: number) {
      const motion = live.current.motion ?? 0.7;
      const speed = motion / 0.7;
      const t = (now - t0) / 1000;

      // morph driver
      let from = SHAPES[0];
      let to = SHAPES[0];
      let k = 0;
      if (!reduce) {
        const elapsed = (t * speed) % total;
        const seg = elapsed / cycle;
        const fromIdx = Math.floor(seg) % SHAPES.length;
        const toIdx = (fromIdx + 1) % SHAPES.length;
        from = SHAPES[fromIdx];
        to = SHAPES[toIdx];
        const local = (seg - Math.floor(seg)) * cycle; // seconds into segment
        k = smooth(clamp01((local - HOLD) / MORPH));
      }

      const amp = reduce ? 0 : JITTER;
      for (let i = 0; i < count; i++) {
        const ix = i * 3;
        const x = from[ix] + (to[ix] - from[ix]) * k;
        const y = from[ix + 1] + (to[ix + 1] - from[ix + 1]) * k;
        const z = from[ix + 2] + (to[ix + 2] - from[ix + 2]) * k;
        const j = Math.sin(t * 1.1 + phase[i]) * amp;
        positions[ix] = x + j;
        positions[ix + 1] = y + Math.cos(t * 0.9 + phase[i]) * amp;
        positions[ix + 2] = z + j;
      }
      posAttr.needsUpdate = true;

      // slow rotation + faint tilt for a 3D read
      group.rotation.y = reduce ? 0 : t * 0.12 * speed;
      group.rotation.x = reduce ? 0.18 : 0.18 + Math.sin(t * 0.2) * 0.06;

      // gentle glow breathing
      glowMaterial.opacity = 0.9 + (reduce ? 0 : Math.sin(t * 1.5) * 0.06);
    }

    function render() {
      update(performance.now());
      renderer.render(scene, camera);
    }

    function frame() {
      if (!running) return;
      if (!live.current.paused) render();
      raf = requestAnimationFrame(frame);
    }

    render(); // immediate first paint
    raf = requestAnimationFrame(frame);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      mq.removeEventListener("change", onMq);
      geometry.dispose();
      pointsMaterial.dispose();
      glowMaterial.dispose();
      backdropGeo.dispose();
      backdropMat.dispose();
      particleTexture.dispose();
      glowTexture.dispose();
      backdropTexture.dispose();
      renderer.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} className="field" aria-hidden="true" />;
}

export default ParticleMorph;
