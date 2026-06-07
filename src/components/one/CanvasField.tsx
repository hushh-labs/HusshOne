"use client";

/* ============================================================
   CanvasField — Hussh canvas centerpiece (ported from fx.jsx)
   A persistent full-viewport canvas that renders the glass
   identity sphere, weightless data particles, the source-node
   constellation, and flying data fragments. Driven by props
   read live from a ref so the RAF loop never goes stale.
   ============================================================ */

import { useEffect, useRef } from "react";

interface CanvasFieldProps {
  mode: "idle" | "collect" | "dashboard";
  progress: number;
  motion?: number;
  preMoment?: boolean;
}

/* hellow monochrome palette tuned for the off-white canvas — particles
   drift from a light grey toward ink so they read on #FCFBFA; glow
   accents are neutral grey/ink (no colour). */
const FX = {
  slate: [165, 168, 188], // ambient particle base (soft cool grey-violet)
  blue: [150, 182, 240],  // periwinkle — primary glow/accent
  cyan: [150, 220, 205],  // mint — core accent
  violet: [212, 168, 236],// lavender-pink
  ink: [17, 17, 19],
};
const rgba = (c: number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a: number[], b: number[], t: number): number[] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

const GHOSTS = [
  { label: "Work", a: 0.2 },
  { label: "Code", a: 1.25 },
  { label: "Web", a: 2.3 },
  { label: "Mentions", a: 3.3 },
  { label: "Social", a: 4.35 },
  { label: "Writing", a: 5.25 },
];

export function CanvasField(props: CanvasFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const live = useRef<CanvasFieldProps>(props);

  // keep the RAF loop reading the latest props without re-subscribing
  useEffect(() => {
    live.current = props;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    let raf = 0;
    let running = true;
    let W = 0;
    let H = 0;
    let DPR = 1;

    const fontFamily =
      (typeof window !== "undefined" && getComputedStyle(document.body).fontFamily) ||
      "system-ui, sans-serif";

    // ambient particle cloud (spherical shell)
    const N = 110;
    const parts: {
      theta: number;
      phi: number;
      rad: number;
      size: number;
      tw: number;
      tws: number;
      hue: number;
      drift: number;
    }[] = [];
    for (let i = 0; i < N; i++) {
      const u = Math.random();
      const v = Math.random();
      parts.push({
        theta: u * Math.PI * 2,
        phi: Math.acos(2 * v - 1),
        rad: 0.62 + Math.random() * 0.66, // shell thickness
        size: 0.6 + Math.random() * 1.9,
        tw: Math.random() * Math.PI * 2, // twinkle phase
        tws: 0.4 + Math.random() * 1.2,
        hue: Math.random(), // 0 slate..1 accent
        drift: 0.2 + Math.random() * 0.8,
      });
    }

    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas!.clientWidth;
      H = canvas!.clientHeight;
      canvas!.width = Math.floor(W * DPR);
      canvas!.height = Math.floor(H * DPR);
      ctx!.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    // smoothed center + radius so mode changes glide
    let curR = 1;
    let curGlobal = 1;
    let curCy = 1;
    let inited = false;
    const t0 = performance.now();

    function draw(now: number) {
      const c = ctx!;
      const T = (now - t0) / 1000;
      const p = live.current;
      const mode = p.mode || "idle";
      const motion = p.motion == null ? 0.7 : p.motion;
      const progress = clamp01(p.progress || 0);
      const preMoment = !!p.preMoment && mode === "idle";

      c.clearRect(0, 0, W, H);

      // ── target layout per mode ──────────────────────────
      // Each mode hands the orb a dedicated zone in the UPPER part of the
      // viewport; the CSS copy zones (see globals.css) live below it, so text
      // and sphere never fight for the same pixels.
      const base = Math.min(W, H);
      const small = W < 600;
      let targR: number;
      let targCy: number;
      let targGlobal: number;
      if (mode === "idle") {
        if (preMoment) {
          // precollect — compact "agent ready" beacon, lifted high so the
          // headline + identity column own the lower two-thirds cleanly.
          targR = base * (small ? 0.118 : 0.094);
          targCy = H * (small ? 0.165 : 0.185);
        } else {
          // landing — generous hero orb sitting in the upper third.
          targR = base * (small ? 0.18 : 0.15);
          targCy = H * (small ? 0.27 : 0.3);
        }
        targGlobal = 1;
      } else if (mode === "collect") {
        // scanning — orb is the "thinking core" lifted into the top zone; the
        // glass console sits clearly below it with breathing room.
        targR = base * (small ? 0.13 : 0.108);
        targCy = H * (small ? 0.215 : 0.235);
        targGlobal = 1;
      } else {
        // dashboard — faint ambient backdrop, sphere gone
        targR = base * 0.13;
        targCy = H * 0.3;
        targGlobal = 0.0;
      }
      curR += (targR - curR) * 0.06;
      curCy += (targCy - curCy) * 0.06;
      curGlobal += (targGlobal - curGlobal) * 0.05;
      if (!inited) {
        curR = targR;
        curCy = targCy;
        curGlobal = targGlobal;
        inited = true;
      }

      const cx = W / 2;
      // weightless vertical float — gives the orb life without moving its zone
      const bob = Math.sin(T * 0.5) * curR * 0.02 * (0.5 + motion);
      const cy = curCy + bob;
      const R = curR;
      const focal = base * 1.4;
      const rotSpeed = 0.05 + motion * 0.12;
      const rot = T * rotSpeed;
      const flat = 0.86;

      // collection-driven energy
      const collecting = mode === "collect";
      const energy = collecting ? progress : 0;

      // ── 0. soft ground glow under the sphere ────────────
      if (curGlobal > 0.01) {
        const gg = c.createRadialGradient(cx, cy, 0, cx, cy, R * 3.4);
        gg.addColorStop(0, rgba(FX.blue, 0.05 * curGlobal));
        gg.addColorStop(0.5, rgba(FX.blue, 0.018 * curGlobal));
        gg.addColorStop(1, "rgba(0,0,0,0)");
        c.fillStyle = gg;
        c.fillRect(0, 0, W, H);
      }

      // helper: project a 3D point on the cloud
      function project(theta: number, phi: number, rad: number) {
        const r = R * rad;
        const st = Math.sin(phi);
        const ct = Math.cos(phi);
        const x = r * st * Math.cos(theta + rot);
        const y = r * ct * flat;
        const z = r * st * Math.sin(theta + rot);
        const scale = focal / (focal - z);
        return { sx: cx + x * scale, sy: cy + y * scale, z, scale };
      }

      // split ambient particles by depth (behind / front of glass)
      const back: [(typeof parts)[number], ReturnType<typeof project>][] = [];
      const front: [(typeof parts)[number], ReturnType<typeof project>][] = [];
      for (const pt of parts) {
        const pr = project(pt.theta, pt.phi, pt.rad);
        (pr.z < 0 ? back : front).push([pt, pr]);
      }

      function drawParticles(list: [(typeof parts)[number], ReturnType<typeof project>][]) {
        for (const [pt, pr] of list) {
          const tw = 0.55 + 0.45 * Math.sin(T * pt.tws + pt.tw);
          const depth = (pr.z + R) / (2 * R); // 0 back .. 1 front
          const baseA = (0.16 + depth * 0.6) * tw * curGlobal;
          // during collection, accent ramps up
          const accentMix = clamp01(pt.hue * 0.5 + energy * 0.7);
          const col = mix(FX.slate, FX.blue, accentMix);
          const sz = pt.size * pr.scale * (1 + energy * 0.25) * 1.15;
          c.beginPath();
          c.arc(pr.sx, pr.sy, Math.max(0.3, sz), 0, Math.PI * 2);
          c.fillStyle = rgba(col, baseA);
          c.fill();
          // gentle glow on the brighter/front ones
          if (depth > 0.55 || accentMix > 0.4) {
            c.beginPath();
            c.arc(pr.sx, pr.sy, sz * 2.6, 0, Math.PI * 2);
            c.fillStyle = rgba(mix(col, FX.blue, 0.4), baseA * 0.12);
            c.fill();
          }
        }
      }

      drawParticles(back);

      // ── glass sphere body (between back & front particles) ─
      if (curGlobal > 0.02) {
        drawGlassSphere(c, cx, cy, R, curGlobal, energy);
      }

      drawParticles(front);

      // ── pre-moment: faint source ghosts + inner data fragments ──
      if (preMoment && curGlobal > 0.05) {
        drawPreMoment(c, cx, cy, R, focal, flat, rot, T, curGlobal, fontFamily);
      }

      // ── collection: a soft sonar ripple kept within the orb so the scan
      //    reads as "alive" without ever crossing the console below ──
      if (collecting && curGlobal > 0.02) {
        const ping = (T * (0.5 + motion * 0.35)) % 1;
        const rr = R * (0.3 + ping * 0.82);
        c.beginPath();
        c.arc(cx, cy, rr, 0, Math.PI * 2);
        c.strokeStyle = rgba(FX.blue, (1 - ping) * 0.26 * curGlobal);
        c.lineWidth = 1.4;
        c.stroke();
      }
    }

    function frame(now: number) {
      if (!running) return;
      draw(now);
      raf = requestAnimationFrame(frame);
    }

    draw(performance.now()); // immediate first paint (RAF may be throttled while hidden)
    raf = requestAnimationFrame(frame);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="field" aria-hidden="true" />;
}

/* ── glass sphere: reads as a crystal orb on white paper ── */
function drawGlassSphere(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  R: number,
  g: number,
  energy: number,
) {
  // On first paint after a refresh the canvas may not be laid out yet (clientWidth 0),
  // so R eases through ~0. Bail before any arc/gradient gets a negative/degenerate
  // radius (e.g. `R - 0.7` → IndexSizeError). The orb just stays invisible for a frame.
  if (!(R > 1)) return;
  ctx.save();
  // 0. soft contact shadow beneath — grounds the floating orb
  const sh = ctx.createRadialGradient(cx + R * 0.12, cy + R * 0.55, 0, cx + R * 0.12, cy + R * 0.55, R * 1.25);
  sh.addColorStop(0, `rgba(60,60,64,${0.16 * g})`);
  sh.addColorStop(0.55, `rgba(60,60,64,${0.07 * g})`);
  sh.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = sh;
  ctx.beginPath();
  ctx.ellipse(cx + R * 0.1, cy + R * 0.5, R * 1.2, R * 0.95, 0, 0, Math.PI * 2);
  ctx.fill();

  // 1. faint outer aura (blue while collecting)
  const aura = ctx.createRadialGradient(cx, cy, R * 0.7, cx, cy, R * 1.55);
  aura.addColorStop(0, rgba(FX.blue, 0.0));
  aura.addColorStop(0.7, rgba(FX.blue, (0.04 + energy * 0.13) * g));
  aura.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = aura;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 1.55, 0, Math.PI * 2);
  ctx.fill();

  // 2. glass body — transparent center (paper + particles show through),
  //    refractive rim that darkens toward the bottom-right
  const body = ctx.createRadialGradient(cx - R * 0.34, cy - R * 0.42, R * 0.05, cx, cy, R * 1.04);
  body.addColorStop(0, `rgba(255,255,255,${0.16 * g})`);
  body.addColorStop(0.42, `rgba(234,234,236,${0.07 * g})`);
  body.addColorStop(0.74, `rgba(208,208,212,${0.16 * g})`);
  body.addColorStop(0.9, `rgba(178,178,184,${0.34 * g})`);
  body.addColorStop(0.99, `rgba(140,140,146,${0.52 * g})`);
  body.addColorStop(1, `rgba(140,140,146,0)`);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fill();

  // 2b. heavier refractive shadow on the lower-right crescent
  const cres = ctx.createRadialGradient(cx + R * 0.42, cy + R * 0.46, R * 0.1, cx + R * 0.42, cy + R * 0.46, R * 0.95);
  cres.addColorStop(0, `rgba(96,96,102,${0.2 * g})`);
  cres.addColorStop(1, "rgba(96,96,102,0)");
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = cres;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 3. rim: thin bright top-left edge + cool refractive ring
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = `rgba(255,255,255,${0.85 * g})`;
  ctx.beginPath();
  ctx.arc(cx, cy, R - 0.7, Math.PI * 0.9, Math.PI * 1.85);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(FX.blue, 0.28 * g);
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.992, 0, Math.PI * 2);
  ctx.stroke();

  // 4. inner core glow (intensifies while collecting)
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.7);
  core.addColorStop(0, rgba(FX.blue, (0.1 + energy * 0.35) * g));
  core.addColorStop(0.6, rgba(FX.cyan, (0.04 + energy * 0.1) * g));
  core.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.7, 0, Math.PI * 2);
  ctx.fill();

  // 5. specular highlight
  const spec = ctx.createRadialGradient(cx - R * 0.4, cy - R * 0.46, 0, cx - R * 0.4, cy - R * 0.46, R * 0.5);
  spec.addColorStop(0, `rgba(255,255,255,${0.9 * g})`);
  spec.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = spec;
  ctx.beginPath();
  ctx.ellipse(cx - R * 0.38, cy - R * 0.42, R * 0.34, R * 0.24, -0.5, 0, Math.PI * 2);
  ctx.fill();

  // 6. small crisp catch-light
  ctx.beginPath();
  ctx.arc(cx - R * 0.46, cy - R * 0.5, R * 0.05, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255,255,255,${0.95 * g})`;
  ctx.fill();
  ctx.restore();
}

/* ── pre-moment: hidden source signals waiting to be gathered ─ */
function drawPreMoment(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  R: number,
  focal: number,
  flat: number,
  rot: number,
  T: number,
  g: number,
  fontFamily: string,
) {
  // faint glass data-fragments living inside the sphere
  const frR = R * 0.6;
  for (let i = 0; i < 6; i++) {
    const th = (i / 6) * Math.PI * 2 + rot * 0.6;
    const ph = Math.PI * (0.3 + (i % 3) * 0.2);
    const x = frR * Math.sin(ph) * Math.cos(th);
    const z = frR * Math.sin(ph) * Math.sin(th);
    const y = frR * Math.cos(ph) * flat;
    const scale = focal / (focal - z);
    const depth = (z + frR) / (2 * frR);
    const sx = cx + x * scale;
    const sy = cy + y * scale;
    const a = (0.05 + depth * 0.1) * g;
    const w = 17 * scale;
    const h = 10 * scale;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.fillStyle = `rgba(255,255,255,${a * 2.4})`;
    ctx.strokeStyle = `rgba(150,150,156,${a * 1.2})`;
    ctx.lineWidth = 0.8;
    roundRect(ctx, -w / 2, -h / 2, w, h, 2.4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = `rgba(100,100,106,${a * 1.6})`;
    ctx.fillRect(-w / 2 + 2.5 * scale, -1.4 * scale, w * 0.5, 1.3 * scale);
    ctx.restore();
  }

  // faint source ghosts orbiting outside — hidden signals waiting to be
  // gathered. Kept on a tight orbit that crowns the compact beacon so the
  // labels never drift down into the headline/identity column below.
  const ghR = R * 1.58;
  GHOSTS.forEach((gh, i) => {
    const theta = gh.a + rot * 0.5;
    const phi = Math.PI * (0.32 + (i % 3) * 0.16);
    const x = ghR * Math.sin(phi) * Math.cos(theta);
    const z = ghR * Math.sin(phi) * Math.sin(theta);
    const y = ghR * 0.5 * Math.cos(phi) * flat;
    const scale = focal / (focal - z);
    const sx = cx + x * scale;
    const sy = cy + y * scale;
    const depth = (z + ghR) / (2 * ghR);
    const breathe = 0.5 + 0.5 * Math.sin(T * 0.55 + i * 1.3);
    const a = (0.045 + depth * 0.11) * g * (0.55 + 0.45 * breathe);
    // hairline reaching toward the sphere
    ctx.strokeStyle = rgba(FX.blue, a * 0.55);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(sx, sy);
    ctx.stroke();
    // node dot
    ctx.beginPath();
    ctx.arc(sx, sy, 2.1 * scale, 0, Math.PI * 2);
    ctx.fillStyle = rgba(FX.blue, a * 2.4);
    ctx.fill();
    // barely-there label
    ctx.font = `500 ${11 * scale}px ${fontFamily}`;
    ctx.fillStyle = `rgba(70,70,76,${a * 1.9})`;
    ctx.textBaseline = "middle";
    ctx.textAlign = sx < cx ? "right" : "left";
    ctx.fillText(gh.label, sx + (sx < cx ? -7 * scale : 7 * scale), sy);
    ctx.textAlign = "left";
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export default CanvasField;
