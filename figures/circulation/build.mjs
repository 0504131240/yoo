// Circulation bench: the human circulatory system as one closed hydraulic loop.
// Four bellows pumps (the heart's chambers) push blood through two sets of
// capillary arches: over an air chest (lungs, blue turns red) and over a tissue
// tray (body, red turns blue). A pacemaker box fires the atria, then, after the
// AV delay, the ventricles. Cells move at the true pace: one lap = 5 L / output.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "../kit/iso-kit.mjs";
import * as G from "../kit/lathe.mjs";
import * as A from "../kit/audit.mjs";
import { tubePieces, tubeSvg } from "../kit/tube.mjs";
import { kitScript } from "../scripts/inline-kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv;
const theme = argv.includes("--light") ? "light" : "dark";
const OUT = argv.find((a) => a.startsWith("--out="))?.slice(6);

const WIDTH = 680;
const HEIGHT = 330;

// ---- world -------------------------------------------------------------
const BENCH = { x: -238, y: -66, w: 476, d: 132, r: 10 };
const BENCH_H = 12;
const FOOT_H = 5;
const PL = 4; // plinth height
const PZ = 14; // pipe centre height
const PR = 4; // main pipe radius
const AR = 2.2; // capillary radius
const ATOP = 50; // capillary arch height
const LY = 28; // the two lines: y = -28 blue (right heart), y = +28 red (left heart)
const BLOCK_H = 20; // valve blocks under the chambers, z 4..24
const BZ = PL + BLOCK_H;

const HEART_PLINTH = { x: -62, y: -48, w: 124, d: 96, r: 6 };
const LUNG_PLINTH = { x: -232, y: -48, w: 134, d: 96, r: 6 };
const BODY_PLINTH = { x: 98, y: -48, w: 100, d: 96, r: 6 };

const LUNG_X = [-178, -162, -146, -130, -114];
const BODY_X = [114, 130, 146, 162, 178];
const END_X = 190;

const CHAMBERS = {
  RA: { c: [25, -LY], half: 11, R: 8.6, kind: "atrium", ox: 0 },
  RV: { c: [-25, -LY], half: 13, R: 11, kind: "ventricle", ox: 0 },
  LA: { c: [-25, LY], half: 11, R: 8.6, kind: "atrium", ox: 100 },
  LV: { c: [25, LY], half: 13, R: 11, kind: "ventricle", ox: 100 },
};

const VALVES = {
  tricuspid: { x: 1, y: -LY, kind: "av" },
  pulmonary: { x: -52, y: -LY, kind: "semi" },
  mitral: { x: 1, y: LY, kind: "av" },
  aortic: { x: 52, y: LY, kind: "semi" },
};
const VALVE_HALF = 4;

const SUPPORTS = [[-80, -LY], [-80, LY], [80, -LY], [80, LY]];
const BAND_T = 2;

// ---- the model (truth first) ---------------------------------------------
// Resting adult: 72 bpm, stroke volume 70 mL, end-diastolic volume 120 mL,
// 5 L of blood, PR interval 0.16 s, atrial systole 0.1 s, breathing 14 / min.
const MODEL = `
const BLOOD_ML = 5000;
function physiology(hr) {
  const sv = Math.min(100, Math.max(58, 70 + 0.3 * (hr - 72)));
  const esv = Math.min(55, Math.max(32, 50 - 0.12 * (hr - 72)));
  const T = 60 / hr;
  const sys = 0.3 * Math.sqrt(T / 0.8333);
  const rr = Math.min(40, Math.max(10, 14 + 0.22 * (hr - 72)));
  return { hr, sv, esv, edv: esv + sv, T, sys, ts: 0.16, rr, co: (hr * sv) / 1000, lap: (BLOOD_ML / (hr * sv)) * 60 };
}
// phase t in seconds since the P wave of this beat
function heart(t, ph) {
  const { T, sys, ts, sv, esv, edv } = ph;
  const te = ts + sys;
  const tau = 0.09;
  const fillF = (x) => (1 - Math.exp(-(x - te) / tau)) / (1 - Math.exp(-(T - te) / tau));
  const ease = (u) => 1 - (1 - u) * (1 - u);
  let V, Va, art, av;
  if (t < 0.1) { const u = t / 0.1; V = edv - 0.2 * sv * (1 - u); Va = 45 - 15 * u; art = 0; av = -0.2 + 0.2 * u; }
  else if (t < ts) { V = edv; Va = 30 + 30 * (t - 0.1) / (te - 0.1); art = 0; av = 0; }
  else if (t < te) { const u = (t - ts) / sys; V = edv - sv * ease(u); Va = 30 + 30 * (t - 0.1) / (te - 0.1); art = ease(u); av = 0; }
  else { const f = fillF(t); V = esv + 0.8 * sv * f; Va = 60 - 15 * f; art = 1; av = 0.8 * f; }
  return { V, Va, art, av, avOpen: t < 0.1 || t >= te, semiOpen: t >= ts && t < te, te };
}
`;

// ---- camera ----------------------------------------------------------------
const P = k.fitProjection(
  [...k.boxCorners(BENCH, -BENCH_H - FOOT_H, 0), [0, 0, 84], [-212, 0, 64], [END_X, LY, ATOP + 4], [-END_X, -LY, ATOP + 4]],
  WIDTH,
  HEIGHT,
  { pad: 18, azimuth: 70 },
);
const KS = G.scaleOf(P);
const V = G.viewOf(P);

const at = (p) => k.iso(p, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const byDepth = (points) => [...points].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));

const R = A.recorder(P);
const record = R.solid;
let uid = 0;
const nameFor = (base) => `${base}#${++uid}`;
function put(ref, svg, { bias = 0, shapes = [], name, route, chunk, key } = {}) {
  R.put({ at: ref, bias, svg, shapes, name: name ?? nameFor("item"), route, chunk, ...(key !== undefined ? { key } : {}) });
}
const tint = (ox, inner) => `<g class="blood" style="--ox:${ox}%">${inner}</g>`;
const slabC = (plan, z, h) => [plan.x + plan.w / 2, plan.y + plan.d / 2, z + h / 2];
function box(plan, z, h, style = {}, { bevel = 0.5, steps = 3, extra = "", bias = 0, name = "box", inner } = {}) {
  const id = nameFor(name);
  put(slabC(plan, z, h), S(k.slabOf(plan, z, h, P, steps, bevel), { tone: "mid", ...style, inner }) + extra, {
    bias,
    name: id,
    shapes: [record(A.slab(plan, z, h, { name: id }, steps))],
  });
}
function cyl(cx, cy, r, z, h, style = {}, { steps = 24, bevel = 0, extra = "", bias = 0, name = "cyl" } = {}) {
  const id = nameFor(name);
  put([cx, cy, z + h / 2], S(k.cylinder(cx, cy, r, z, h, P, steps, bevel), { tone: "mid", ...style }) + extra, {
    bias,
    name: id,
    shapes: [record(A.cylinder(cx, cy, r, z, h, { name: id }))],
  });
}
function discX(cx, cy, cz, r, thick, style = {}, { name = "disc", owner, extra = "" } = {}) {
  const F = G.frameAlong([cx, cy, cz], [1, 0, 0]);
  const id = nameFor(name);
  put([cx, cy, cz], S(G.disc(-thick / 2, thick / 2, r, F, P), { tone: "mid", ...style }) + extra, {
    name: id,
    shapes: [record(A.disc(F, -thick / 2, thick / 2, r, { name: id, owner }))],
  });
}
function ball(c, r, style = {}, name = "tee") {
  const id = nameFor(name);
  put(c, S(G.sphereOf(c, r, P), { tone: "mid", ...style }), { name: id, shapes: [record(A.ball(c, r, { name: id }))] });
}

// Blood-carrying tubes. Pieces carry their route and arc span so the page can
// draw the cells moving through each one in its own painter's slot.
const ROUTES = [];
function bloodTube(name, control, r, { ox, oxTo = ox, gaps = [], kind, maxLength = 14, bend = 9 } = {}) {
  const line = control.length > 2 ? G.fillet(control, bend, 10, { P, tube: r }) : control;
  const id = nameFor(name);
  const total = G.pathLength(line);
  R.route(id, line, r, { owner: id, gaps });
  const pieces = tubePieces(line, r, P, { maxLength, spacing: 1.2, gaps });
  const dense = G.resample(line, 1);
  ROUTES.push({ id, kind, total, ox, oxTo, screen: dense.map((p) => at(p).map((v) => Math.round(v * 100) / 100)), step: total / (dense.length - 1) });
  pieces.forEach((piece, index) => {
    const mid = (piece.from + piece.to) / 2;
    const o = Math.round(ox + (oxTo - ox) * (mid / total));
    put(piece.mid, tint(o, tubeSvg(piece, { tone: "hi" }) + `<path class="cells" data-route="${ROUTES.length - 1}" data-from="${(piece.from + (piece.ends[0] ? 1.3 : -1.6)).toFixed(2)}" data-to="${(piece.to - (piece.ends[1] ? 1.3 : -1.6)).toFixed(2)}" d=""/>`), {
      name: `${id}:${index}`,
      route: id,
      chunk: index,
      shapes: [A.tube(piece.points, piece.radii)],
    });
  });
  return { line, total, id };
}

// ---- bench, plinths and floor parts (drawn under the sorted layer) ---------
function bench() {
  const out = [`<path class="iso-halo" d="${k.haloOf(BENCH, -BENCH_H - FOOT_H, BENCH_H, P)}"/>`];
  for (const [x, y] of byDepth(k.corners(BENCH, 24))) {
    out.push(S(k.cylinder(x, y, 8, -BENCH_H - FOOT_H, 1.6, P, 28), { tone: "lo" }));
    out.push(S(k.cylinder(x, y, 6, -BENCH_H - FOOT_H + 1.6, FOOT_H - 1.6, P, 28), { tone: "mid" }));
  }
  out.push(S(k.slabOf(BENCH, -BENCH_H, BENCH_H, P, 8, 1.6), { tone: "mid", inner: L(k.sideSeam(BENCH, -BENCH_H / 2, P, 8), { tone: "faint" }) }));
  out.push(L(k.planOutline(k.insetPlan(BENCH, 5), 0, P), { tone: "lo" }));
  const screws = k.corners(BENCH, 11);
  out.push(L(screws.map(([x, y]) => k.ring(x, y, 2.4, 0, P, 16)).join(""), { tone: "lo" }));
  out.push(D(screws.map(([x, y]) => at([x, y, 0])), { size: 0.5 }));
  // ruler strip along the near edge: one tick per 10 units of pipe
  const strip = { x: -214, y: BENCH.y + BENCH.d - 13, w: 300, d: 6, r: 1 };
  out.push(S(k.slabOf(strip, 0, 0.6, P, 3), { tone: "lo", crease: "none" }));
  const ticks = k.topTicks(strip.x + 4, strip.x + strip.w - 4, 5, 5, strip.y + 0.8, 0.6, [1.8, 3.4], P);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  out.push(D([at([strip.x + 2, strip.y + 3, 0.6]), at([strip.x + strip.w - 2, strip.y + 3, 0.6])], { size: 0.45 }));
  // label plate
  const label = { x: 116, y: BENCH.y + BENCH.d - 16, w: 70, d: 10, r: 1.2 };
  out.push(S(k.slabOf(label, 0, 0.8, P, 4), { tone: "mid", crease: "none" }));
  out.push(L(k.planOutline(k.insetPlan(label, 1.6), 0.8, P), { tone: "faint" }));
  out.push(L(k.lineOnTop([label.x + 6, label.y + 3.4], [label.x + 46, label.y + 3.4], 0.8, P), { tone: "lo", free: true }));
  out.push(L(k.lineOnTop([label.x + 6, label.y + 6.4], [label.x + 34, label.y + 6.4], 0.8, P), { tone: "lo", free: true }));
  out.push(D([at([label.x + 3, label.y + 5, 0.8]), at([label.x + label.w - 3, label.y + 5, 0.8])], { size: 0.45 }));
  out.push(k.faceTextSvg(k.topMatrix([label.x + 58, label.y + 6.2], 0.8, P, "x"), "5 L", { size: 3, tone: "lo", anchor: "middle" }));
  return out.join("");
}

function plinth(plan) {
  const out = [`<path class="iso-halo" d="${k.haloOf(plan, 0, PL, P)}" style="filter:blur(3px)"/>`];
  out.push(S(k.slabOf(plan, 0, PL, P, 6, 0.8), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(plan, 4), PL, P), { tone: "faint" }));
  const screws = k.corners(plan, 7);
  out.push(D(screws.map(([x, y]) => at([x, y, PL])), { size: 0.5 }));
  out.push(L(screws.map(([x, y]) => k.ring(x, y, 1.8, PL, P, 14)).join(""), { tone: "lo" }));
  return out.join("");
}

// Conduction wires on the heart plinth: pacemaker box to each valve block.
const WIRES = {
  RA: [[6, -7], [6, -12], [25, -12], [25, -17]],
  RV: [[-6, -7], [-6, -11], [-25, -11], [-25, -15]],
  LA: [[-6, 7], [-6, 11], [-25, 11], [-25, 17]],
  LV: [[6, 7], [6, 10], [25, 10], [25, 15]],
};
function wires() {
  const out = [];
  for (const [, pts] of Object.entries(WIRES)) {
    out.push(L(k.onTop(pts, PL + 0.05, P), { tone: "lo" }));
    out.push(D([at([...pts[pts.length - 1], PL + 0.05])], { size: 0.6, tone: "mid" }));
  }
  out.push(`<path class="iso-dot" data-part="pulses" data-tone="lit" d="" style="fill:var(--anatomy-lit)"/>`);
  return out.join("");
}

// ---- heart -----------------------------------------------------------------
// The bellows are rebuilt each frame from this one function, in the build and
// in the page, so both draw the same part.
function bellowsSvg(K, P, cx, cy, z, R, h, ox) {
  const out = [];
  const folds = 5;
  const band = h / (folds * 2);
  out.push(K.solidSvg(K.cylinder(cx, cy, R + 1.6, z, 2, P, 32), { tone: "mid" }));
  let zz = z + 2;
  const body = [];
  for (let i = 0; i < folds * 2; i++) {
    const r = i % 2 === 0 ? R : R - 2.2;
    body.push(K.solidSvg(K.cylinder(cx, cy, r, zz, band, P, 32), { tone: "hi", crease: "lo" }));
    zz += band;
  }
  out.push(`<g class="blood" style="--ox:${ox}%">${body.join("")}</g>`);
  out.push(K.solidSvg(K.cylinder(cx, cy, R + 1.6, zz, 2.4, P, 36, 0.6), { tone: "mid" }));
  out.push(K.lineSvg(K.ring(cx, cy, R - 1, zz + 2.4, P, 32), { tone: "faint" }));
  out.push(K.solidSvg(K.cylinder(cx, cy, 3, zz + 2.4, 2.4, P, 20), { tone: "mid" }));
  out.push(K.lineSvg(K.knurl(cx, cy, 3, zz + 2.4, zz + 4.8, 14, P), { tone: "lo" }));
  const bolts = [0, 1, 2, 3, 4, 5].map((j) => K.iso([cx + Math.cos((j * Math.PI) / 3 + 0.3) * (R + 0.4), cy + Math.sin((j * Math.PI) / 3 + 0.3) * (R + 0.4), zz + 2.4], P));
  out.push(K.dotsSvg(bolts, { size: 0.42, tone: "mid" }));
  return out.join("");
}

// Valve handle: a lever on the housing top, along the pipe when open,
// across it when shut, like a ball valve.
function handleSvg(K, P, x, y, z, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const pt = (u, v) => [x + u * c - v * s, y + u * s + v * c];
  const ring = [pt(-2, -1.1), pt(9, -1.1), pt(9, 1.1), pt(-2, 1.1)];
  return K.solidSvg(K.extrude(ring, z + 1.6, 1.2, P), { tone: "hi", crease: "faint" }) + K.solidSvg(K.cylinder(x, y, 2, z, 3.2, P, 18), { tone: "mid" }) + K.dotsSvg([K.iso([x, y, z + 3.2], P)], { size: 0.5, tone: "hi" });
}

const K = { solidSvg: k.solidSvg, cylinder: k.cylinder, lineSvg: k.lineSvg, ring: k.ring, knurl: k.knurl, dotsSvg: k.dotsSvg, iso: k.iso, extrude: k.extrude };

function heartParts() {
  // septum rib and pacemaker
  box({ x: -42, y: -2, w: 84, d: 4, r: 1 }, PL, 4, { tone: "mid" }, { name: "septum" });
  box({ x: -10, y: -7, w: 20, d: 14, r: 2 }, PL + 4, 12, { tone: "mid" }, {
    bevel: 0.6,
    name: "pacemaker",
    inner: L(k.sideSeam({ x: -10, y: -7, w: 20, d: 14, r: 2 }, PL + 9, P, 3), { tone: "faint" }),
    extra: D([at([-7.5, 5, PL + 16]), at([7.5, -5, PL + 16]), at([-7.5, -5, PL + 16]), at([7.5, 5, PL + 16])], { size: 0.42 }),
  });
  // lamp (lit) and rate knob are live
  const top = PL + 16;
  put([-4, 0, top + 2], `<g data-part="lamp">${S(k.cylinder(-4.5, 0, 2.6, top, 2.6, P, 20), { tone: "hi", lit: true })}<circle data-part="glow" cx="${at([-4.5, 0, top + 2.6])[0]}" cy="${at([-4.5, 0, top + 2.6])[1]}" r="${(4.2 * KS).toFixed(1)}" style="fill:var(--anatomy-lit);opacity:0"/></g>`, {
    name: "lamp",
    shapes: [record(A.cylinder(-4.5, 0, 2.6, top, 2.6, { name: "lamp" }))],
  });
  put([4.5, 0, top + 2], `<g data-part="knob">${knobSvg(72)}</g>`, { name: "knob", shapes: [record(A.cylinder(4.5, 0, 3.6, top, 4, { name: "knob" }))] });

  for (const [name, ch] of Object.entries(CHAMBERS)) {
    const [cx, cy] = ch.c;
    const plan = { x: cx - ch.half, y: cy - ch.half, w: ch.half * 2, d: ch.half * 2, r: 2 };
    box(plan, PL, BLOCK_H, { tone: "mid" }, {
      bevel: 0.7,
      name: `block.${name}`,
      inner: L(k.sideSeam(plan, PL + 6, P, 3), { tone: "faint" }),
      extra: D(k.corners(plan, 2.6).map(([x, y]) => at([x, y, BZ])), { size: 0.45 }) + L(k.planOutline(k.insetPlan(plan, 3.4), BZ, P, 3), { tone: "faint" }),
    });
    const hMax = ch.kind === "ventricle" ? 48 : 30;
    const h0 = ch.kind === "ventricle" ? 12 + 0.28 * 120 : 13 + 0.32 * 45;
    put([cx, cy, BZ + hMax / 2], `<g data-part="bellows" data-ch="${name}">${bellowsSvg(K, P, cx, cy, BZ, ch.R, h0, ch.ox)}</g>`, {
      name: `bellows.${name}`,
      shapes: [record(A.cylinder(cx, cy, ch.R + 1.6, BZ, h0 + 9, { name: `bellows.${name}` }))],
    });
  }
  // valve housings, handles are live
  for (const [name, v] of Object.entries(VALVES)) {
    const plan = { x: v.x - VALVE_HALF, y: v.y - 8, w: VALVE_HALF * 2, d: 16, r: 1.4 };
    box(plan, PL, BLOCK_H, { tone: "mid" }, {
      bevel: 0.5,
      name: `valve.${name}`,
      inner: L(k.sideSeam(plan, PL + 15, P, 3), { tone: "faint" }),
      extra: D([at([v.x, v.y - 6, BZ]), at([v.x, v.y + 6, BZ])], { size: 0.42 }),
    });
    const angle = v.kind === "av" ? 0 : Math.PI / 2;
    put([v.x + 2, v.y, BZ + 2], `<g data-part="handle" data-valve="${name}">${handleSvg(K, P, v.x, v.y, BZ, angle)}</g>`, {
      name: `handle.${name}`,
      shapes: [record(A.cylinder(v.x, v.y, 2, BZ, 3.2, { name: `handle.${name}` }))],
    });
  }
}

function knobSvg(hr) {
  const top = PL + 16;
  const [x, y] = [4.5, 0];
  const a = ((hr - 40) / 140 - 0.5) * 1.5 * Math.PI;
  return (
    S(k.cylinder(x, y, 3.6, top, 4, P, 28), { tone: "mid" }) +
    L(k.knurl(x, y, 3.6, top, top + 4, 22, P), { tone: "lo" }) +
    L(k.lineOnTop([x, y], [x + Math.sin(a) * 3.2, y - Math.cos(a) * 3.2], top + 4, P), { tone: "hi" })
  );
}

// ---- pipes -----------------------------------------------------------------
const FL_T = 1.6;
const FL_R = 6;
function flangeX(x, y, side, ox) {
  // a flange whose back face sits on the block face at x
  const cx = x + (side * FL_T) / 2;
  discX(cx, y, PZ, FL_R, FL_T, { tone: "mid" }, { name: "flange", extra: "" });
  return cx;
}

function mainLines() {
  // gaps on a straight route along x, from x0 toward x1
  const gapsOn = (x0, x1, spans) => {
    const dir = Math.sign(x1 - x0);
    return spans.map(([a, b]) => {
      const s0 = (a - x0) * dir, s1 = (b - x0) * dir;
      return [Math.min(s0, s1), Math.max(s0, s1)];
    });
  };
  const teeGap = (x) => [x - 3.6, x + 3.6];
  const bandGap = (x) => [x - BAND_T / 2, x + BAND_T / 2];
  const valveGap = (x) => [x - VALVE_HALF, x + VALVE_HALF];
  const flGap = (xFace, side) => (side > 0 ? [xFace, xFace + FL_T] : [xFace - FL_T, xFace]);

  // R1 vena cava + body outlet header: from the far end to the right atrium
  bloodTube("vena-cava", [[END_X, -LY, PZ], [36, -LY, PZ]], PR, { ox: 0, kind: "vein", gaps: gapsOn(END_X, 36, [...BODY_X.map(teeGap), bandGap(80), flGap(36, 1)]) });
  // R2 tricuspid: RA -> RV
  bloodTube("tricuspid", [[14, -LY, PZ], [-12, -LY, PZ]], PR, { ox: 0, kind: "av", gaps: gapsOn(14, -12, [flGap(14, -1), valveGap(1), flGap(-12, 1)]) });
  // R3 pulmonary artery + lung inlet header
  bloodTube("pulmonary-artery", [[-38, -LY, PZ], [-END_X, -LY, PZ]], PR, { ox: 0, kind: "art", gaps: gapsOn(-38, -END_X, [flGap(-38, -1), valveGap(-52), bandGap(-80), ...LUNG_X.map(teeGap)]) });
  // R4 pulmonary vein: lung outlet header -> LA
  bloodTube("pulmonary-vein", [[-END_X, LY, PZ], [-36, LY, PZ]], PR, { ox: 100, kind: "vein", gaps: gapsOn(-END_X, -36, [...LUNG_X.map(teeGap), bandGap(-80), flGap(-36, -1)]) });
  // R5 mitral: LA -> LV
  bloodTube("mitral", [[-14, LY, PZ], [12, LY, PZ]], PR, { ox: 100, kind: "av", gaps: gapsOn(-14, 12, [flGap(-14, 1), valveGap(1), flGap(12, -1)]) });
  // R6 aorta + body inlet header
  bloodTube("aorta", [[38, LY, PZ], [END_X, LY, PZ]], PR, { ox: 100, kind: "art", gaps: gapsOn(38, END_X, [flGap(38, 1), valveGap(52), bandGap(80), ...BODY_X.map(teeGap)]) });

  // flanges on the chamber faces
  flangeX(36, -LY, 1); flangeX(14, -LY, -1); flangeX(-12, -LY, 1); flangeX(-38, -LY, -1);
  flangeX(-36, LY, -1); flangeX(-14, LY, 1); flangeX(12, LY, -1); flangeX(38, LY, 1);
  // blind end caps
  for (const y of [-LY, LY]) {
    discX(END_X + 1.2, y, PZ, 5.2, 2.4, { tone: "mid" }, { name: "cap" });
    discX(-END_X - 1.2, y, PZ, 5.2, 2.4, { tone: "mid" }, { name: "cap" });
  }
  // tee balls
  for (const x of [...LUNG_X, ...BODY_X]) for (const y of [-LY, LY]) ball([x, y, PZ], 5.4, { tone: "mid" });
  // pipe supports between the plinths
  for (const [x, y] of SUPPORTS) {
    cyl(x, y, 4.4, 0, 1.2, { tone: "lo" }, { name: "stand.foot", extra: D([at([x - 3, y, 1.2]), at([x + 3, y, 1.2])], { size: 0.4 }) });
    cyl(x, y, 2, 1.2, PZ - 5.6 - 1.2 - 1.6, { tone: "mid", crease: "none" }, { name: "support.post" });
    box({ x: x - 2.4, y: y - 4, w: 4.8, d: 8, r: 1 }, PZ - 5.6 - 1.6, 1.6, { tone: "mid" }, { name: "support.saddle" });
    discX(x, y, PZ, 5.6, BAND_T, { tone: "mid" }, { name: "support.band" });
  }
}

function arches() {
  const legZ = PZ + Math.sqrt(5.4 * 5.4 - AR * AR);
  for (const x of LUNG_X)
    bloodTube("lung-capillary", [[x, -LY, legZ], [x, -LY, ATOP], [x, LY, ATOP], [x, LY, legZ]], AR, { ox: 0, oxTo: 100, kind: "cap", bend: 9, maxLength: 10 });
  for (const x of BODY_X)
    bloodTube("body-capillary", [[x, LY, legZ], [x, LY, ATOP], [x, -LY, ATOP], [x, -LY, legZ]], AR, { ox: 100, oxTo: 0, kind: "cap", bend: 9, maxLength: 10 });
}

function rack(xs) {
  // two posts at each end carry a rail the arches rest on
  const x0 = xs[0] - 12, x1 = xs[xs.length - 1] + 12;
  const railTop = ATOP - AR;
  for (const x of [x0, x1]) {
    for (const y of [-10, 10]) cyl(x, y, 2, PL, railTop - 3.4 - 3 - PL, { tone: "mid", crease: "none" }, { name: "rack.post", steps: 18 });
    box({ x: x - 3, y: -13, w: 6, d: 26, r: 1.2 }, railTop - 3.4 - 3, 3, { tone: "mid" }, { name: "rack.bridge", extra: D([at([x, -10, railTop - 3.4]), at([x, 10, railTop - 3.4])], { size: 0.42 }) });
  }
  const rail = { x: x0 - 3, y: -2.5, w: x1 - x0 + 6, d: 5, r: 1 };
  box(rail, railTop - 3.4, 3.4, { tone: "mid" }, { name: "rack.rail", bevel: 0.4 });
}

function lungs() {
  const chest = { x: -184, y: -16, w: 76, d: 32, r: 3 };
  const top = PL + 24;
  const slots = LUNG_X.slice(0, -1).map((x) => k.planOutline({ x: x + 4, y: -11, w: 8, d: 22, r: 3 }, top, P, 4)).join("");
  box(chest, PL, 24, { tone: "mid" }, { name: "lungs.chest", bevel: 0.8, steps: 4, inner: L(k.sideSeam(chest, PL + 4, P, 4), { tone: "faint" }), extra: L(slots, { tone: "lo" }) + D(k.corners(chest, 3).map(([x, y]) => at([x, y, top])), { size: 0.45 }) });
  rack(LUNG_X);
  // breathing bellows on its own block, with an air duct into the chest
  const blk = { x: -226, y: -12, w: 24, d: 24, r: 2 };
  box(blk, PL, 10, { tone: "mid" }, { name: "lungs.blower", bevel: 0.6, extra: D(k.corners(blk, 2.6).map(([x, y]) => at([x, y, PL + 10])), { size: 0.42 }) });
  put([-214, 0, PL + 26], `<g data-part="breath">${breathSvg(K, P, 18)}</g>`, { name: "lungs.bellows", shapes: [record(A.cylinder(-214, 0, 11.6, PL + 10, 32, { name: "lungs.bellows" }))] });
  const duct = [[-202, 0, PL + 5], [-184, 0, PL + 5]];
  const id = nameFor("duct");
  R.route(id, duct, 2.6, { owner: id });
  tubePieces(duct, 2.6, P, { maxLength: 20 }).forEach((piece, i) => put(piece.mid, tubeSvg(piece, { tone: "mid" }), { name: `${id}:${i}`, route: id, chunk: i, shapes: [A.tube(piece.points, piece.radii)] }));
}

function breathSvg(K, P, h) {
  const out = [];
  const cx = -214, cy = 0, z = PL + 10, R = 10;
  out.push(K.solidSvg(K.cylinder(cx, cy, R + 1.6, z, 1.6, P, 32), { tone: "mid" }));
  let zz = z + 1.6;
  const folds = 4, band = h / (folds * 2);
  for (let i = 0; i < folds * 2; i++) {
    out.push(K.solidSvg(K.cylinder(cx, cy, i % 2 ? R - 2.2 : R, zz, band, P, 32), { tone: "mid", crease: "lo" }));
    zz += band;
  }
  out.push(K.solidSvg(K.cylinder(cx, cy, R + 1.6, zz, 2.2, P, 36, 0.6), { tone: "mid" }));
  out.push(K.lineSvg(K.ring(cx, cy, R - 1.5, zz + 2.2, P, 32), { tone: "faint" }));
  out.push(K.solidSvg(K.cylinder(cx, cy, 2.6, zz + 2.2, 2.2, P, 18), { tone: "mid" }));
  return out.join("");
}

function body() {
  const tray = { x: 104, y: -16, w: 84, d: 32, r: 3 };
  const top = PL + 12;
  box(tray, PL, 12, { tone: "mid" }, { name: "body.tray", bevel: 0.8, steps: 4, inner: L(k.sideSeam(tray, PL + 4, P, 4), { tone: "faint" }), extra: D(k.corners(tray, 3).map(([x, y]) => at([x, y, top])), { size: 0.45 }) });
  rack(BODY_X);
  // tissue: rows of cells on the tray, between the arches
  for (const x of [122, 138, 154, 170])
    for (const y of [-8, 8]) {
      const id = nameFor("body.cell");
      put([x, y, top + 2], S(k.cylinder(x, y, 4.6, top, 4, P, 28, 0.5), { tone: "hi", crease: "lo" }) + L(k.ring(x, y, 2, top + 4, P, 16), { tone: "faint" }) + D([at([x, y, top + 4])], { size: 0.5, tone: "mid" }), {
        name: id,
        shapes: [record(A.cylinder(x, y, 4.6, top, 4, { name: id }))],
      });
    }
}

// ---- build -----------------------------------------------------------------
heartParts();
mainLines();
arches();
lungs();
body();

A.settle(R, P);
R.items.sort((a, b) => a.key - b.key);
A.auditOrExit(R, P, { crowd: [] });

const svg = k.figureSvg({
  width: WIDTH,
  height: HEIGHT,
  label:
    "Circulation bench. Four bellows pumps stand for the heart's chambers. The right atrium and ventricle push dark blue blood along the far line into five capillary arches over an air chest, the lungs, where it turns red. It returns along the near line to the left atrium and ventricle, which push it through five arches over a tissue tray, the body, where it turns blue again and flows back to the right atrium. A pacemaker box fires each beat.",
  body: [
    bench(),
    plinth(LUNG_PLINTH),
    plinth(HEART_PLINTH),
    plinth(BODY_PLINTH),
    wires(),
    ...R.items.map((item) => item.svg),
  ],
});

const live = `
${MODEL}
const P = ${JSON.stringify(P)};
const KS = ${KS};
const PL = ${PL}, BZ = ${BZ};
const CHAMBERS = ${JSON.stringify(CHAMBERS)};
const VALVES = ${JSON.stringify(VALVES)};
const ROUTES = ${JSON.stringify(ROUTES.map(({ kind, total, screen, step }) => ({ kind, total, screen, step })))};
const WIRES = ${JSON.stringify(WIRES)};
const K = { solidSvg, cylinder, lineSvg, ring, knurl, dotsSvg, iso, extrude };
${bellowsSvg.toString()}
${handleSvg.toString()}
${breathSvg.toString().replace(/PL \+ 10/g, "PL + 10")}
const knobTop = PL + 16;
function knobSvg(hr) {
  const x = 4.5, y = 0, top = knobTop;
  const a = ((hr - 40) / 140 - 0.5) * 1.5 * Math.PI;
  return solidSvg(cylinder(x, y, 3.6, top, 4, P, 28), { tone: "mid" }) + lineSvg(knurl(x, y, 3.6, top, top + 4, 22, P), { tone: "lo" }) + lineSvg(lineOnTop([x, y], [x + Math.sin(a) * 3.2, y - Math.cos(a) * 3.2], top + 4, P), { tone: "hi" });
}

const stage = document.querySelector(".iso-stage");
const svgEl = stage.querySelector("svg");
const readout = document.querySelector("[data-readout]");
const still = matchMedia("(prefers-reduced-motion: reduce)");
const bellows = [...svgEl.querySelectorAll('[data-part="bellows"]')].map((el) => ({ el, ch: CHAMBERS[el.dataset.ch] }));
const handles = [...svgEl.querySelectorAll('[data-part="handle"]')].map((el) => ({ el, v: VALVES[el.dataset.valve], a: VALVES[el.dataset.valve].kind === "av" ? 0 : Math.PI / 2 }));
const cells = [...svgEl.querySelectorAll(".cells")].map((el) => ({ el, r: +el.dataset.route, from: +el.dataset.from, to: +el.dataset.to }));
const breath = svgEl.querySelector('[data-part="breath"]');
const knob = svgEl.querySelector('[data-part="knob"]');
const glow = svgEl.querySelector('[data-part="glow"]');
const pulses = svgEl.querySelector('[data-part="pulses"]');
const wireScreen = Object.fromEntries(Object.entries(WIRES).map(([n, pts]) => [n, pts.map((p) => iso([p[0], p[1], PL + 0.05], P))]));

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const GAP = 7; // cell spacing along a pipe
const CAP_RATIO = (4 * 4) / (5 * 2.2 * 2.2); // five arches share the flow
// Visual lap matches the true lap: distance per beat D so that the loop of
// main pipes (L_main) and arches (L_cap) takes BLOOD_ML / SV beats.
const L_MAIN = ROUTES.filter((r) => r.kind !== "cap").reduce((s, r) => s + r.total, 0);
const L_CAP = ROUTES.filter((r) => r.kind === "cap").reduce((s, r) => s + r.total, 0) / 5;
const perBeat = (sv) => ((L_MAIN + L_CAP / CAP_RATIO) * sv) / BLOOD_ML;

let hr = 72, target = 72, t = 0, bt = 0.45, breathT = 0;
let disp = { art: 0, av: 0, vein: 0, cap: 0 };
let last = 0, frame = 0, visible = false, touring = true, tour = 0, idle = 0;
let ph = physiology(hr);
let state = heart(bt, ph);
const handleAngle = handles.map((h) => h.a);

function at(route, s) {
  const pts = route.screen;
  const f = s / route.step;
  const i = Math.min(pts.length - 2, Math.max(0, Math.floor(f)));
  const u = f - i;
  return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u];
}
const cellR = (kind) => (kind === "cap" ? 0.95 : 1.35) * KS;
function drawCells() {
  const offs = ROUTES.map((r) => ((disp[r.kind] % GAP) + GAP) % GAP);
  for (const c of cells) {
    const route = ROUTES[c.r];
    const off = offs[c.r];
    const rr = cellR(route.kind);
    let d = "";
    let s = off + Math.ceil((c.from - off) / GAP) * GAP;
    for (; s < c.to; s += GAP) {
      const [x, y] = at(route, s);
      d += "M" + (x - rr).toFixed(1) + " " + y.toFixed(1) + "a" + rr.toFixed(2) + " " + rr.toFixed(2) + " 0 1 0 " + (2 * rr).toFixed(2) + " 0a" + rr.toFixed(2) + " " + rr.toFixed(2) + " 0 1 0 " + (-2 * rr).toFixed(2) + " 0";
    }
    if (c.el.getAttribute("d") !== d) c.el.setAttribute("d", d);
  }
}
function pointOnWire(pts, u) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); segs.push(l); total += l; }
  let s = u * total;
  for (let i = 0; i < segs.length; i++) { if (s <= segs[i]) { const f = s / segs[i]; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f]; } s -= segs[i]; }
  return pts[pts.length - 1];
}
function draw() {
  for (const b of bellows) {
    const h = b.ch.kind === "ventricle" ? 12 + 0.28 * state.V : 13 + 0.32 * state.Va;
    b.el.innerHTML = bellowsSvg(K, P, b.ch.c[0], b.ch.c[1], BZ, b.ch.R, h, b.ch.ox);
  }
  handles.forEach((h, i) => { h.el.innerHTML = handleSvg(K, P, h.v.x, h.v.y, BZ, handleAngle[i]); });
  breath.innerHTML = breathSvg(K, P, 14 + 10 * (0.5 - 0.5 * Math.cos(2 * Math.PI * breathT)));
  knob.innerHTML = knobSvg(hr);
  glow.style.opacity = (0.55 * Math.exp(-bt / 0.07)).toFixed(3);
  // conduction: the impulse reaches the atria first, the ventricles after the AV delay
  let d = "";
  const dot = (p) => { const r = 1.1 * KS; d += "M" + (p[0] - r).toFixed(1) + " " + p[1].toFixed(1) + "a" + r + " " + r + " 0 1 0 " + 2 * r + " 0a" + r + " " + r + " 0 1 0 " + -2 * r + " 0"; };
  if (bt < 0.08) { dot(pointOnWire(wireScreen.RA, bt / 0.08)); dot(pointOnWire(wireScreen.LA, bt / 0.08)); }
  if (bt >= 0.08 && bt < 0.16) { dot(pointOnWire(wireScreen.RV, (bt - 0.08) / 0.08)); dot(pointOnWire(wireScreen.LV, (bt - 0.08) / 0.08)); }
  pulses.setAttribute("d", d);
  drawCells();
  const text = "דופק " + Math.round(hr) + " · " + ph.co.toFixed(1) + " ליטר/דקה · הקפה " + Math.round(ph.lap) + " שנ׳";
  if (readout.textContent !== text) readout.textContent = text;
  if (slider && document.activeElement !== slider) slider.value = String(Math.round(hr));
  if (sliderOut) sliderOut.textContent = Math.round(hr) + " פעימות בדקה";
  stage.setAttribute("aria-valuenow", String(Math.round(hr)));
  stage.setAttribute("aria-valuetext", text);
}
function step(dt) {
  if (touring) {
    tour += dt;
    const cyc = tour % 24;
    target = cyc < 10 ? 72 : cyc < 12 ? 72 + (cyc - 10) * 34 : cyc < 22 ? 140 : 140 - (cyc - 22) * 34;
  }
  hr += (target - hr) * (1 - Math.exp(-dt / 1.2));
  ph = physiology(hr);
  const before = heart(bt, ph);
  bt += dt;
  let wrapped = false;
  if (bt >= ph.T) { bt -= ph.T; wrapped = true; }
  state = heart(bt, ph);
  const D = perBeat(ph.sv);
  const inc = (a, b) => (wrapped ? 1 + b - a : b - a);
  disp.art += D * inc(before.art, state.art);
  disp.av += D * inc(before.av, state.av);
  disp.vein += (D * dt) / ph.T;
  disp.cap += ((D * dt) / ph.T) * CAP_RATIO;
  breathT = (breathT + (dt * ph.rr) / 60) % 1;
  handles.forEach((h, i) => {
    const open = h.v.kind === "av" ? state.avOpen : state.semiOpen;
    const want = open ? 0 : Math.PI / 2;
    handleAngle[i] += (want - handleAngle[i]) * (1 - Math.exp(-dt / 0.035));
  });
}
function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 20) : 1 / 60;
  last = now;
  step(dt);
  draw();
  frame = visible && !still.matches ? requestAnimationFrame(tick) : 0;
}
const run = () => { if (!frame && visible && !still.matches) { last = 0; frame = requestAnimationFrame(tick); } };
const steer = (next) => {
  touring = false;
  target = clamp(Math.round(next), 40, 180);
  clearTimeout(idle);
  idle = setTimeout(() => { touring = true; tour = 0; }, 8000);
  if (still.matches) { hr = target; ph = physiology(hr); draw(); }
  run();
};
new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; if (visible) run(); }, { rootMargin: "120px 0px" }).observe(stage);
if (still.matches) touring = false;
let dragging = false;
stage.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") return; dragging = true; stage.setPointerCapture?.(e.pointerId); move(e); });
stage.addEventListener("pointerup", () => { dragging = false; });
stage.addEventListener("pointercancel", () => { dragging = false; });
function move(e) {
  const box = svgEl.getBoundingClientRect();
  const share = clamp(((e.clientX - box.left) / box.width - 0.1) / 0.8, 0, 1);
  steer(40 + share * 140);
}
stage.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") move(e); });
const slider = document.querySelector("#hr-range");
const sliderOut = document.querySelector("#hr-value");
slider?.addEventListener("input", () => steer(+slider.value));
if (stage.scrollWidth > stage.clientWidth + 4) stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
if (matchMedia("(pointer: coarse)").matches) { const hint = document.querySelector('[data-corner="hint"]'); if (hint) hint.textContent = "המחוון למטה משנה את הדופק"; }
stage.addEventListener("keydown", (e) => {
  let next = null;
  if (e.key === "ArrowRight" || e.key === "ArrowUp") next = target + 5;
  if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = target - 5;
  if (e.key === "Home") next = 40;
  if (e.key === "End") next = 180;
  if (e.key === "r" || e.key === "R") next = 72;
  if (next === null) return;
  e.preventDefault();
  steer(next);
});
draw();
`;

const BLOOD_CSS = `
.iso{--b-s0:var(--anatomy-shade-0);--b-s1:var(--anatomy-shade-1);--b-s2:var(--anatomy-shade-2);--b-s3:var(--anatomy-shade-3);--b-top:var(--anatomy-top);--b-paper:var(--anatomy-paper);--b-hi:var(--anatomy-hi);--b-lo:var(--anatomy-lo);--b-strong:var(--anatomy-strong);--b-red:var(--anatomy-red);--b-blue:var(--anatomy-blue)}
.blood{--tint:color-mix(in oklab,var(--b-red) var(--ox),var(--b-blue));
 --anatomy-shade-0:color-mix(in oklab,var(--tint) 30%,var(--b-s0));--anatomy-shade-1:color-mix(in oklab,var(--tint) 34%,var(--b-s1));
 --anatomy-shade-2:color-mix(in oklab,var(--tint) 40%,var(--b-s2));--anatomy-shade-3:color-mix(in oklab,var(--tint) 46%,var(--b-s3));
 --anatomy-top:color-mix(in oklab,var(--tint) 30%,var(--b-top));--anatomy-paper:color-mix(in oklab,var(--tint) 24%,var(--b-paper));
 --anatomy-hi:color-mix(in oklab,var(--tint) 72%,var(--b-hi));--anatomy-lo:color-mix(in oklab,var(--tint) 45%,var(--b-lo))}
.cells{fill:color-mix(in oklab,var(--tint) 55%,var(--b-strong));stroke:none;pointer-events:none}
.iso-stage{cursor:ew-resize;outline:none}
@media (max-width:620px){.iso-stage{overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:thin}.iso-stage>svg{min-width:640px}}
.hr-control{display:flex;align-items:center;gap:12px;direction:rtl;padding:14px 4px 0;font-size:14px;color:var(--anatomy-text)}
.hr-control label{white-space:nowrap;color:var(--anatomy-strong)}
.hr-control input{flex:1;min-width:0;accent-color:var(--anatomy-red)}
.hr-control output{font-family:var(--anatomy-mono);font-size:12px;white-space:nowrap;min-width:9.5em;text-align:left;font-variant-numeric:tabular-nums}
.hr-presets{display:flex;gap:8px;direction:rtl;padding:10px 4px 0;flex-wrap:wrap}
.hr-presets button{font:inherit;font-size:13px;color:var(--anatomy-strong);background:var(--anatomy-card);border:1px solid var(--anatomy-lo);border-radius:999px;padding:4px 12px;cursor:pointer}
.hr-presets button:hover{border-color:var(--anatomy-mid)}
.hr-presets button:focus-visible{outline:2px solid var(--anatomy-mid);outline-offset:2px}
.iso-stage:focus-visible{box-shadow:0 0 0 2px var(--anatomy-mid);border-radius:8px}
.iso-legend{direction:rtl;text-align:right}
.iso-plate-corner{unicode-bidi:plaintext}
`;

const bodyHtml = k.plateHtml({
  fig: "איור 1",
  title: "מחזור הדם",
  hint: "גררו ↔ לשינוי הדופק",
  readout: "דופק 72 · 5.0 ליטר/דקה · הקפה 60 שנ׳",
  keys: [
    { mark: "red", label: "דם עשיר בחמצן: מהריאות, דרך צד שמאל של הלב, אל הגוף" },
    { mark: "blue", label: "דם דל בחמצן: מהגוף, דרך צד ימין של הלב, אל הריאות" },
    { mark: "lit", label: "הקוצב (צומת הסינוס): מצית כל פעימה" },
  ],
  caption:
    "הלב הוא שתי משאבות שעובדות יחד. העליות (המפוחים הקטנים) מתמלאות ודוחפות את הדם לחדרים, ואחרי השהיה של עשירית שנייה החדרים (המפוחים הגדולים) נלחצים ושולחים אותו הלאה. ידיות השסתומים עומדות לאורך הצינור כשהשסתום פתוח, ולרוחבו כשהוא סגור. החדר הימני שולח דם כחול לקשתות הנימים שמעל תיבת האוויר (הריאות, שהמפוח שלהן נושם), ושם הוא נטען בחמצן ומאדים. החדר השמאלי שולח אותו לקשתות שמעל מגש הרקמות (הגוף), שם הוא מוסר את החמצן ומכחיל, וחוזר לעלייה הימנית. במנוחה (72 פעימות, 70 מ״ל בכל פעימה) הלב מזרים 5 ליטר בדקה, וכל 5 ליטרי הדם בגוף משלימים הקפה בערך בדקה. התאים בצינורות נעים בדיוק בקצב הזה.",
  body: `<div class="iso-stage" tabindex="0" role="slider" aria-label="דופק: החצים משנים את קצב הלב" aria-valuemin="40" aria-valuemax="180" aria-valuenow="72">${svg}</div>`,
});

const controls = `<div class="hr-control"><label for="hr-range">קצב הלב</label><input id="hr-range" type="range" min="40" max="180" step="1" value="72"><output id="hr-value" for="hr-range">72 פעימות בדקה</output></div><div class="hr-presets" role="group" aria-label="מצבים"><button type="button" data-hr="55">שינה · 55</button><button type="button" data-hr="72">מנוחה · 72</button><button type="button" data-hr="110">הליכה מהירה · 110</button><button type="button" data-hr="160">ריצה · 160</button></div>`;
const presetsJs = `document.querySelectorAll("[data-hr]").forEach((b) => b.addEventListener("click", () => steer(+b.dataset.hr)));`;
const page = k.pageHtml({ title: "מחזור הדם", theme, body: bodyHtml.replace("</figure>", controls + "</figure>"), script: kitScript() + live + presetsJs, width: 760 }).replace("</style>", BLOOD_CSS + "</style>").replace('<html lang="en">', '<html lang="he">');
// Theme-aware fragment for publishing: follows the viewer's light or dark setting.
const THEME_JS = `(() => { const wrap = document.querySelector(".iso"); const root = document.documentElement; const mq = matchMedia("(prefers-color-scheme: dark)"); const apply = () => { wrap.dataset.theme = root.dataset.theme || (mq.matches ? "dark" : "light"); }; apply(); mq.addEventListener("change", apply); new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ["data-theme"] }); })();`;
const FRAG_CSS = `
:root{--page:#f2f2ef;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--page:#0b0b0b;color-scheme:dark}}
:root[data-theme="dark"]{--page:#0b0b0b;color-scheme:dark}
*{box-sizing:border-box}
body{background:var(--page);margin:0}
.shell{background:var(--anatomy-page);color:var(--anatomy-text);font:15px/1.65 "Assistant",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;min-height:100%;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:28px 72px}
.iso-page{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
.intro{direction:rtl;display:flex;flex-direction:column;gap:4px}
.intro h1{margin:0;font-size:clamp(24px,5vw,32px);line-height:1.15;font-weight:700;color:var(--anatomy-strong);text-wrap:balance}
.intro p{margin:0;max-width:60ch;color:var(--anatomy-text)}
`;
const intro = `<header class="intro"><h1>מחזור הדם</h1><p>הלב הוא שתי משאבות בטור. כל טיפת דם עוברת בריאות, חוזרת ללב, יוצאת לגוף וחוזרת שוב, בערך פעם בדקה.</p></header>`;
const fragment = `<title>מחזור הדם</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700&display=swap">
<style>${k.ISO_CSS}${FRAG_CSS}${BLOOD_CSS}</style>
<div class="iso shell" data-theme="light" lang="he"><main class="iso-page">${intro}${bodyHtml.replace("</figure>", controls + "</figure>")}</main></div>
<script type="module">${(THEME_JS + kitScript() + live + presetsJs).replace(/<\/(script)/gi, "<\\/$1")}</script>`;
if (argv.includes("--fragment")) {
  writeFileSync(join(HERE, "circulation-artifact.html"), fragment);
  writeFileSync(join(HERE, "circulation-site.html"), `<!doctype html><html lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${fragment.replace(/<div class="iso shell"/, "</head><body><div class=\"iso shell\"")}</body></html>`);
  console.log("wrote fragment + site page", (fragment.length / 1024).toFixed(0) + " KB");
}
const file = OUT ?? join(HERE, theme === "light" ? "circulation-light.html" : "circulation.html");
writeFileSync(file, page);
console.log("wrote", file, (page.length / 1024).toFixed(0) + " KB", R.items.length + " items");
