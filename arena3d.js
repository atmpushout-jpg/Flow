/**
 * Flow Arena 3D — the living arena.
 *
 * Client-side only ($0 to run): Three.js renders stylized fighter rigs built
 * from primitives; the fighters "talk" with the browser's built-in
 * SpeechSynthesis (per-persona pitch/rate), or with the recorded voice clip
 * when a feed event carries one (intro/elimination audio in the state).
 *
 * Data: the SAME state files arena.html polls —
 *   live:  arena-live.json (when liveMode) else arena-state.json
 *   demo:  arena3d-demo.json — the recorded Match 3 state, replayed and
 *          labeled REPLAY on screen. Nothing here fabricates a "live" label.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
function angLerp(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
const money = (n) => "$" + Number(n || 0).toFixed(2);

/* Per-persona SpeechSynthesis profiles, derived from each persona's recorded
 * voice character (voiceName in the state): brash, polished, boomy, bubbly… */
const VOICE_PROFILES = {
  vex:      { pitch: 0.75, rate: 1.12, gb: false }, // Blustery Gong (Brash)
  audrey:   { pitch: 1.15, rate: 0.95, gb: true  }, // Soothing Ribbon (Polished British)
  echo:     { pitch: 1.35, rate: 1.08, gb: false }, // Cheeky Bubble (Sarcastic)
  fade:     { pitch: 0.55, rate: 0.88, gb: true  }, // Boomy Mountain (Regal British)
  longshot: { pitch: 0.70, rate: 0.92, gb: false }, // Gruff Brick (Blunt)
  rook:     { pitch: 1.25, rate: 1.14, gb: false }, // Bubbly Pompom (Energetic)
  flowx:    { pitch: 0.90, rate: 1.00, gb: false }, // Dramatic Canyon
  guest:    { pitch: 1.00, rate: 1.00, gb: false },
  host:     { pitch: 1.00, rate: 1.02, gb: false },
};

/* Fighters who join the cast beyond any single match's state file. */
const FLOWX_PERSONA = {
  id: "flowx", name: "FLOWX", emoji: "🌊", color: "#38bdf8",
  strategy: "Patient Anchor — one WETH anchor, one late spike shot, exits into strength. Exhibition class.",
};
const GUEST_PERSONA = {
  id: "guest", name: "YOUR BOT", emoji: "🤖", color: "#e2e8f0",
  strategy: "Open seat — reserved for the first outside bot that proves a money-making record on the floor.",
};

/* ------------------------------------------------------------------ state */
async function fetchJson(url) {
  const r = await fetch(url + "?t=" + Date.now());
  if (!r.ok) throw new Error(url + " -> " + r.status);
  return r.json();
}
/* Same binding as arena.html: live broadcast state wins, else last match. */
async function loadLiveState() {
  try {
    const L = await fetchJson("arena-live.json");
    if (L && L.liveMode) return L;
  } catch (e) { /* no live state yet */ }
  return fetchJson("arena-state.json");
}

/* ------------------------------------------------------------------ scene */
let renderer, scene, camera, controls;
try {
  if (!window.WebGLRenderingContext) throw new Error("no WebGL");
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
} catch (e) {
  $("fallback").style.display = "flex";
  $("sound-gate").style.display = "none";
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$("scene").appendChild(renderer.domElement);

scene = new THREE.Scene();
scene.background = new THREE.Color(0x070b16);
scene.fog = new THREE.Fog(0x070b16, 20, 46);

camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, 0.1, 120);
camera.position.set(0, 5.4, 13.5);

controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.5, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.52;
controls.minDistance = 5;
controls.maxDistance = 26;
controls.enabled = false; // auto camera drives until the user grabs it

scene.add(new THREE.HemisphereLight(0x8fb4ff, 0x0a0f1e, 0.85));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(6, 12, 7);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.left = -11; key.shadow.camera.right = 11;
key.shadow.camera.top = 11; key.shadow.camera.bottom = -11;
scene.add(key);
const rim = new THREE.DirectionalLight(0x00e5ff, 1.05);
rim.position.set(-8, 6, -9);
scene.add(rim);

/* stage */
{
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(12.5, 72),
    new THREE.MeshStandardMaterial({ color: 0x0d1424, roughness: 0.92, metalness: 0.05 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.PolarGridHelper(12.5, 16, 7, 72, 0x22345c, 0x16223c);
  grid.position.y = 0.01;
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  scene.add(grid);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(7.95, 8.25, 96),
    new THREE.MeshBasicMaterial({ color: 0x00e5a0, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  scene.add(ring);

  // backdrop pillars with emissive caps
  const pilGeo = new THREE.BoxGeometry(0.7, 1, 0.7);
  const pilMat = new THREE.MeshStandardMaterial({ color: 0x111a2e, roughness: 0.8 });
  const capMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff });
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const h = 3.2 + ((i * 37) % 5) * 0.7;
    const p = new THREE.Mesh(pilGeo, pilMat);
    p.scale.y = h;
    p.position.set(Math.sin(a) * 13.6, h / 2, Math.cos(a) * 13.6);
    scene.add(p);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.09, 0.78), capMat);
    cap.position.set(p.position.x, h + 0.05, p.position.z);
    scene.add(cap);
  }
}

/* ------------------------------------------------------------- rig factory */
const SPOT_R = 7.2;
function spotFor(i, n) {
  const spread = Math.min(118, 30 + n * 13); // degrees of arc used
  const deg = n === 1 ? 0 : -spread / 2 + (spread * i) / (n - 1);
  const a = (deg * Math.PI) / 180;
  return { pos: new THREE.Vector3(Math.sin(a) * SPOT_R, 0, Math.cos(a) * SPOT_R), rotY: a };
}

function emblemTexture(persona) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.beginPath(); g.arc(128, 128, 112, 0, Math.PI * 2);
  g.fillStyle = "rgba(8,12,22,0.92)"; g.fill();
  g.lineWidth = 13; g.strokeStyle = persona.color; g.stroke();
  g.font = "118px serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(persona.emoji || "◆", 128, 136);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

/* ------------------------------------------------- rig factory (v2: sleek)
 * Procedural "wallpaper" rigs in the brand-art language: dark gunmetal
 * rounded armor, a glowing visor band, a glowing circular chest core with
 * the persona glyph, emissive persona-color trim, segmented capsule limbs,
 * and a per-persona silhouette (fins / dome / pauldrons / antenna).
 * Still 100% code — no external models. The animation contract is unchanged:
 * root/tilt pivots, hip + shoulder pivots, `mouth` is the jaw light the tick
 * flaps while speaking, `visorMat` dims on elimination. */
const _geoCache = new Map();
function capsuleGeo(r, len) {
  const k = `cap${r}:${len}`;
  if (!_geoCache.has(k)) _geoCache.set(k, new THREE.CapsuleGeometry(r, len, 6, 14));
  return _geoCache.get(k);
}
function ballGeo(r, w = 18, h = 14) {
  const k = `sph${r}:${w}:${h}`;
  if (!_geoCache.has(k)) _geoCache.set(k, new THREE.SphereGeometry(r, w, h));
  return _geoCache.get(k);
}
function rboxGeo(w, h, d, r) {
  const k = `rb${w}:${h}:${d}:${r}`;
  if (!_geoCache.has(k)) _geoCache.set(k, new RoundedBoxGeometry(w, h, d, 3, r));
  return _geoCache.get(k);
}
function mesh(geo, mat, x, y, z, parent, shadow = false) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  if (parent) parent.add(m);
  return m;
}
/* soft radial glow texture (core halo + floor light pool) */
const glowTex = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 2, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.32)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();

/* Per-persona silhouette language (colors come from the state personas). */
const RIG_STYLE = {
  vex:      { pauldron: 1.28, angular: true, fin: "pauldronSpikes", build: 1.03 },
  audrey:   { pauldron: 0.95, dome: true,    fin: "none",            build: 1.0 },
  echo:     { pauldron: 1.0,                 fin: "twin",            build: 0.98 },
  fade:     { pauldron: 1.05,                fin: "tallTwin",        build: 1.05, slim: 0.94 },
  longshot: { pauldron: 0.78,                fin: "antennaLong",     build: 1.03, slim: 0.8 },
  rook:     { pauldron: 1.22, round: true,   fin: "antennaBall",     build: 0.92, stocky: 1.14 },
  flowx:    { pauldron: 1.0,                 fin: "single",          build: 1.0 },
  guest:    { pauldron: 0.9,                 fin: "antenna",         build: 1.0, neutral: true },
};

function buildRig(persona, i, n) {
  const style = RIG_STYLE[persona.id] || RIG_STYLE.guest;
  const color = new THREE.Color(persona.color || "#e2e8f0");
  // dark gunmetal armor with a whisper of the persona hue; glow = persona color
  const armorCol = style.neutral
    ? new THREE.Color(0x3a4260)
    : new THREE.Color(0x272f47).lerp(color, 0.16);
  const armor = new THREE.MeshStandardMaterial({ color: armorCol, roughness: 0.38, metalness: 0.62 });
  const armorDark = new THREE.MeshStandardMaterial({ color: 0x171e30, roughness: 0.5, metalness: 0.55 });
  const faceMat = new THREE.MeshStandardMaterial({ color: 0x0c1220, roughness: 0.22, metalness: 0.65 });
  const glow = new THREE.MeshBasicMaterial({ color });
  const visorMat = new THREE.MeshBasicMaterial({ color });
  const jawMat = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(0.75) });

  const spot = spotFor(i, n);
  const root = new THREE.Group();
  root.position.copy(spot.pos).multiplyScalar(1.7).setY(0); // starts outside, walks in
  root.rotation.y = spot.rotY;
  scene.add(root);

  // glowing base ring (stays level when the body slumps) + persona light pool
  const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  const ringMesh = new THREE.Mesh(new THREE.RingGeometry(0.52, 0.68, 40), ringMat);
  ringMesh.rotation.x = -Math.PI / 2;
  ringMesh.position.y = 0.03;
  root.add(ringMesh);
  const pool = new THREE.Mesh(
    new THREE.PlaneGeometry(2.1, 2.1),
    new THREE.MeshBasicMaterial({ map: glowTex, color, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.015;
  root.add(pool);

  const tilt = new THREE.Group();
  root.add(tilt);
  const body = new THREE.Group(); // per-persona build scale lives here
  body.scale.setScalar(style.build);
  tilt.add(body);
  const slim = style.slim || 1;
  const stocky = style.stocky || 1;
  const wide = slim * stocky;

  /* legs — hip pivots, capsule segments, sphere knees, emissive thigh trim */
  function leg(side) {
    const hip = new THREE.Group();
    hip.position.set(0.16 * side * stocky, 0.9, 0);
    mesh(capsuleGeo(0.095, 0.2), armor, 0, -0.2, 0, hip, true);          // thigh
    mesh(ballGeo(0.096), armorDark, 0, -0.4, 0, hip);                    // knee
    mesh(capsuleGeo(0.074, 0.2), armor, 0, -0.58, 0, hip);               // shin
    mesh(rboxGeo(0.035, 0.18, 0.014, 0.006), glow, 0, -0.2, 0.098, hip); // thigh light
    mesh(rboxGeo(0.17, 0.1, 0.33, 0.04), armorDark, 0, -0.83, 0.05, hip); // foot
    body.add(hip);
    return hip;
  }
  const legL = leg(-1), legR = leg(1);

  /* pelvis, glowing belt, slim waist, tapered torso */
  mesh(rboxGeo(0.46 * stocky, 0.22, 0.3, 0.07), armorDark, 0, 0.98, 0, body, true); // pelvis
  mesh(rboxGeo(0.48 * stocky, 0.035, 0.31, 0.015), glow, 0, 1.08, 0, body);          // belt light
  const waist = mesh(ballGeo(0.19), armorDark, 0, 1.16, 0, body);
  waist.scale.set(0.95, 0.55, 0.8);
  mesh(rboxGeo(0.52 * wide, 0.3, 0.34, 0.08), armor, 0, 1.3, 0, body, true);   // abs plate
  mesh(rboxGeo(0.76 * wide, 0.56, 0.44, 0.1), armor, 0, 1.56, 0, body, true);  // chest plate
  mesh(rboxGeo(0.8 * wide, 0.12, 0.46, 0.05), armorDark, 0, 1.85, 0, body);    // yoke
  mesh(rboxGeo(0.3, 0.03, 0.02, 0.01), glow, 0, 1.85, 0.235, body);            // yoke light

  /* the glowing circular chest core — persona glyph inside an emissive ring */
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  halo.scale.set(0.72, 0.72, 1);
  halo.position.set(0, 1.56, 0.3);
  body.add(halo);
  mesh(new THREE.TorusGeometry(0.135, 0.02, 10, 36), glow, 0, 1.56, 0.225, body);
  const coreDisc = new THREE.Mesh(
    new THREE.CircleGeometry(0.125, 36),
    new THREE.MeshBasicMaterial({ map: emblemTexture(persona), transparent: true })
  );
  coreDisc.position.set(0, 1.56, 0.23);
  body.add(coreDisc);

  /* back fins — silhouette identity, mounted behind the torso */
  function backFin(x, h, tiltBack, spread) {
    const g = new THREE.Group();
    g.position.set(x, 1.6, -0.24);
    g.rotation.x = -tiltBack;
    g.rotation.z = spread;
    mesh(rboxGeo(0.055, h, 0.15, 0.02), armor, 0, h / 2, 0, g, true);
    mesh(rboxGeo(0.02, h * 0.92, 0.02, 0.008), glow, 0, h / 2, -0.085, g);
    body.add(g);
    return g;
  }
  if (style.fin === "tallTwin") { backFin(-0.17, 0.85, 0.15, 0.06); backFin(0.17, 0.85, 0.15, -0.06); }
  if (style.fin === "twin") { backFin(-0.3, 0.45, 0.25, 0.3); backFin(0.3, 0.45, 0.25, -0.3); }
  if (style.fin === "single") backFin(0, 0.6, 0.2, 0);

  /* arms — shoulder pivots; the pauldron rides the pivot so it gestures too */
  function arm(side) {
    const sh = new THREE.Group();
    sh.position.set(0.47 * wide * side, 1.74, 0);
    if (style.angular) {
      const paul = mesh(rboxGeo(0.36, 0.2, 0.38, 0.04), armor, 0.03 * side, 0.07, 0, sh, true);
      paul.rotation.z = -0.12 * side;
      mesh(new THREE.ConeGeometry(0.045, 0.2, 8), armorDark, 0.05 * side, 0.22, -0.1, sh);
      mesh(new THREE.ConeGeometry(0.045, 0.2, 8), armorDark, 0.05 * side, 0.22, 0.08, sh);
      mesh(rboxGeo(0.3, 0.03, 0.02, 0.01), glow, 0.03 * side, 0.02, 0.19, sh);
    } else if (style.round) {
      const paul = mesh(ballGeo(0.19, 20, 14), armor, 0.02 * side, 0.05, 0, sh, true);
      paul.scale.set(1.18, 0.82, 1.18);
      mesh(rboxGeo(0.26, 0.028, 0.02, 0.01), glow, 0.02 * side, -0.02, 0.17, sh);
    } else {
      const paul = mesh(ballGeo(0.165, 20, 14), armor, 0.02 * side, 0.055, 0, sh, true);
      paul.scale.set(1.12 * style.pauldron, 0.74, 1.12);
      mesh(rboxGeo(0.24, 0.026, 0.02, 0.01), glow, 0.02 * side, -0.01, 0.155, sh);
    }
    mesh(capsuleGeo(0.075, 0.18), armor, 0, -0.17, 0, sh, true);  // upper arm
    mesh(ballGeo(0.08), armorDark, 0, -0.35, 0, sh);              // elbow
    mesh(capsuleGeo(0.09, 0.16), armor, 0, -0.52, 0, sh);        // forearm
    const trim = mesh(new THREE.TorusGeometry(0.095, 0.013, 8, 20), glow, 0, -0.44, 0, sh);
    trim.rotation.x = Math.PI / 2;                               // forearm light ring
    mesh(ballGeo(0.095, 14, 10), armorDark, 0, -0.72, 0, sh);    // hand
    body.add(sh);
    return sh;
  }
  const armL = arm(-1), armR = arm(1);

  /* head — smooth helm, glossy face wedge, glowing visor band + jaw light */
  mesh(new THREE.CylinderGeometry(0.085, 0.1, 0.16, 14), armorDark, 0, 1.95, 0, body); // neck
  const head = new THREE.Group();
  head.position.set(0, 2.06, 0);
  body.add(head);
  const helm = mesh(ballGeo(0.26, 24, 18), armor, 0, 0.03, 0, head, true);
  helm.scale.set(style.dome ? 1.06 : 0.96, style.dome ? 1.02 : 1.05, style.dome ? 1.06 : 0.98);
  const wedge = mesh(rboxGeo(0.34, 0.32, 0.12, 0.05), faceMat, 0, -0.02, 0.21, head);
  wedge.rotation.x = 0.05;
  if (!style.dome) mesh(rboxGeo(0.035, 0.025, 0.42, 0.01), glow, 0, 0.29, -0.02, head); // crown light
  const visor = new THREE.Mesh(rboxGeo(0.36, 0.06, 0.026, 0.012), visorMat);
  visor.position.set(0, 0.05, 0.272);
  visor.rotation.x = -0.05;
  head.add(visor);
  const mouth = new THREE.Mesh(rboxGeo(0.15, 0.032, 0.02, 0.01), jawMat); // jaw light
  mouth.position.set(0, -0.08, 0.272);
  head.add(mouth);

  /* antenna variants (longshot's long whip, rook's ball, the guest's invite) */
  function antenna(h, tipR, x) {
    const g = new THREE.Group();
    g.position.set(x, 0.27, 0);
    mesh(new THREE.CylinderGeometry(0.012, 0.016, h, 8), armorDark, 0, h / 2, 0, g);
    mesh(ballGeo(tipR, 10, 8), glow, 0, h + 0.02, 0, g);
    head.add(g);
    return g;
  }
  if (style.fin === "antennaLong") antenna(0.55, 0.035, 0.14);
  if (style.fin === "antennaBall") antenna(0.2, 0.055, 0.15);
  if (style.fin === "antenna") antenna(0.34, 0.04, 0.16);

  // floating nameplate
  const plate = document.createElement("div");
  plate.className = "plate" + (persona.id === "guest" ? " guest" : "");
  plate.innerHTML = `<span class="nm" style="color:${persona.color}">${persona.emoji} ${persona.name}</span><br><span class="st"></span>`;
  $("plates").appendChild(plate);

  return {
    id: persona.id, persona, root, tilt, head, mouth, visor, visorMat, ringMat,
    armL, armR, legL, legR, plate,
    spot: spot.pos, homeRotY: spot.rotY,
    mode: "idle", modeT: 0, modeStart: performance.now(), speaking: false,
    phase: Math.random() * 10, elim: false,
    walkFrom: root.position.clone(), walkTo: spot.pos.clone(), walkT: 1, walkDur: 1, walkStart: 0,
  };
}

/* Mode changes are timestamp-based so animation speed survives low fps. */
function setMode(r, m) { r.mode = m; r.modeStart = performance.now(); r.modeT = 0; }

/* ------------------------------------------------------------------- cast */
let rigs = [];
let rigById = {};
let S = null;               // current arena state
let mode = "demo";          // 'demo' (replay) | 'live'
let runGen = 0;             // increments on mode/cast rebuild; stale drivers stop
let currentSpeaker = null;
let paceScale = 1;          // replay speed multiplier
let soundOn = false;

function buildCast(state) {
  for (const r of rigs) { scene.remove(r.root); r.plate.remove(); }
  rigs = []; rigById = {};
  const cast = [...(state.personas || [])];
  if (!cast.some((p) => p.id === "flowx")) cast.push(FLOWX_PERSONA);
  cast.push(GUEST_PERSONA);
  cast.forEach((p, i) => {
    const rig = buildRig(p, i, cast.length);
    rigs.push(rig);
    rigById[p.id] = rig;
  });
  applyStandings(state);
  tapeReset(state, mode === "live");
}

function walkIn() {
  const now = performance.now();
  rigs.forEach((r, i) => {
    r.walkFrom = r.root.position.clone();
    r.walkTo = r.spot.clone();
    r.walkT = 0;
    r.walkDur = 1.15;
    r.walkStart = now + i * 140; // staggered entrances
    setMode(r, "walk");
  });
}

/* ------------------------------------------------------------------- HUD */
function plateLine(rig, state) {
  const el = rig.plate.querySelector(".st");
  if (rig.id === "guest") { el.innerHTML = "OPEN SEAT — qualify on the floor"; return; }
  if (rig.id === "flowx") { el.innerHTML = "EXHIBITION · Patient Anchor"; return; }
  const row = (state.leaderboard || []).find((x) => x.agentId === rig.id);
  const ag = (state.agents || {})[rig.id];
  const treasury = row ? row.treasury : ag ? ag.cash : null;
  const data = row ? row.dataSpend : ag ? ag.dataSpend : null;
  el.innerHTML = treasury == null ? "" :
    `<b>${money(treasury)}</b> treasury · data ${money(data)}${row && row.rank === 1 ? " · 👑" : ""}`;
}

function applyStandings(state) {
  if (!state) return;
  const pool = state.pool || {};
  if (pool.collected != null) {
    $("pool-line").innerHTML =
      `${money(pool.collected)} pool → <span class="amt">${money(pool.distributable)} prizes</span> · ${money(pool.rake)} rake`;
  }
  $("round-line").innerHTML = `${state.currentRound ?? "—"} / ${state.totalRounds ?? "—"}` +
    `<div style="font-size:10.5px;color:#66707f;font-weight:600">${state.matchId || ""}</div>`;
  const rows = (state.leaderboard || []).map((row) => {
    const p = (state.personas || []).find((x) => x.id === row.agentId) || {};
    return `<div class="row${row.eliminated ? " dead" : ""}">
      <span class="who" style="color:${p.color || "#fff"}">${row.rank}. ${row.name}</span>
      <span class="num"><b>${money(row.treasury)}</b> · data ${money(row.dataSpend)}</span></div>`;
  }).join("");
  $("board-rows").innerHTML = rows || `<div class="row"><span class="num">Standings appear with the match state.</span></div>`;
  $("board-foot").textContent = mode === "demo"
    ? "Recorded final ledger — Match 3 replay. Skill stat: prize won per cent of data spent."
    : "Skill stat: prize won per cent of data spent. Same tape, same prices, every fighter.";
  for (const rig of rigs) {
    plateLine(rig, state);
    const ag = (state.agents || {})[rig.id];
    if (ag && ag.eliminated && !rig.elim) setEliminated(rig, true);
  }
}

function setRound(r) {
  if (S) $("round-line").innerHTML = `${r ?? S.currentRound ?? "—"} / ${S.totalRounds ?? "—"}` +
    `<div style="font-size:10.5px;color:#66707f;font-weight:600">${S.matchId || ""}</div>`;
}

function setModeBadge() {
  const b = $("mode-badge");
  if (mode === "demo") { b.className = "badge replay"; b.textContent = "REPLAY"; $("btn-mode").textContent = "📺 Mode: Replay"; }
  else if (S && (S.status === "live" || S.status === "scheduled")) { b.className = "badge live"; b.textContent = "● LIVE"; $("btn-mode").textContent = "📺 Mode: Live"; }
  else { b.className = "badge replay"; b.textContent = "STANDBY"; $("btn-mode").textContent = "📺 Mode: Live"; }
  renderTape();
}

/* ------------------------------------------------------- ON THE TAPE board
 * What the fighters are trading on — reconstructed ONLY from the match feed.
 * BUY / SELL / FINAL_CLOSE events carry symbol + price prints; a position
 * opens on BUY and closes on SELL / FINAL_CLOSE (engine semantics: one
 * position per agent+symbol). Mark = the symbol's last price print; uPnL is
 * vs the entry print. No venue quotes, no invented fields: if the feed did
 * not print it, it does not appear on this board. */
const tape = {
  prints: new Map(), // SYM -> {first, last, count}
  open: new Map(),   // agentId|SYM -> {agentId, symbol, amountUsd, entry}
  scrambleSym: null,
  round: null,
};
function personaOf(id) {
  return ((S && S.personas) || []).find((p) => p.id === id) ||
    (id === "flowx" ? FLOWX_PERSONA : id === "guest" ? GUEST_PERSONA : { id, name: String(id || "?").toUpperCase(), emoji: "", color: "#e8ecf4" });
}
function fmtPx(p) {
  if (p == null || isNaN(p)) return "—";
  if (p >= 100) return "$" + p.toFixed(2);
  if (p >= 1) return "$" + p.toFixed(3);
  if (p >= 0.01) return "$" + p.toFixed(4);
  return "$" + p.toPrecision(3);
}
function tapePrint(ev) {
  if (!ev || !ev.symbol || typeof ev.price !== "number") return;
  if (ev.type !== "BUY" && ev.type !== "SELL" && ev.type !== "FINAL_CLOSE") return;
  const sym = String(ev.symbol).toUpperCase();
  const cur = tape.prints.get(sym);
  if (cur) { cur.last = ev.price; cur.count++; }
  else tape.prints.set(sym, { first: ev.price, last: ev.price, count: 1 });
}
function tapeReset(state, syncFromState) {
  tape.prints.clear();
  tape.open.clear();
  tape.scrambleSym = state && state.scramble && state.scramble.symbol
    ? String(state.scramble.symbol).toUpperCase() : null;
  tape.round = state ? state.currentRound : null;
  if (syncFromState && state) {
    // Live binding: price prints come from scanning the feed history, open
    // positions from the state's own agent ledgers (authoritative there).
    for (const ev of state.feed || []) tapePrint(ev);
    for (const [id, ag] of Object.entries(state.agents || {})) {
      for (const p of ag.positions || []) {
        const sym = String(p.symbol || "").toUpperCase();
        if (!sym) continue;
        tape.open.set(id + "|" + sym, { agentId: id, symbol: sym, amountUsd: p.costUsd, entry: p.entryPrice });
      }
    }
  }
  renderTape();
}
function tapeOnEvent(ev) {
  if (!ev) return;
  if (ev.round != null) tape.round = ev.round;
  tapePrint(ev);
  const sym = ev.symbol ? String(ev.symbol).toUpperCase() : null;
  if (ev.type === "SCRAMBLE" && sym) tape.scrambleSym = sym;
  if (ev.agentId && sym) {
    const k = ev.agentId + "|" + sym;
    if (ev.type === "BUY" && typeof ev.price === "number") {
      const prev = tape.open.get(k);
      if (prev) { // engine prevents re-buys while held; weight the entry if data ever says otherwise
        const add = ev.amountUsd || 0;
        const tot = prev.amountUsd + add;
        prev.entry = tot ? (prev.entry * prev.amountUsd + ev.price * add) / tot : ev.price;
        prev.amountUsd = tot;
      } else {
        tape.open.set(k, { agentId: ev.agentId, symbol: sym, amountUsd: ev.amountUsd || 0, entry: ev.price });
      }
    }
    if (ev.type === "SELL" || ev.type === "FINAL_CLOSE") tape.open.delete(k);
  }
  renderTape();
}
function renderTape() {
  const rowsEl = $("tape-rows");
  if (!rowsEl) return;
  const live = mode !== "demo" && S && (S.status === "live" || S.status === "scheduled");
  const badge = $("tape-mode");
  if (badge) {
    badge.textContent = mode === "demo" ? "REPLAY" : live ? "● LIVE" : "STANDBY";
    badge.className = "tmode " + (live ? "live" : "replay");
  }
  const rl = $("tape-round");
  if (rl) rl.textContent = "ROUND " + (tape.round ?? "—") + (S && S.totalRounds ? " / " + S.totalRounds : "") +
    (S && S.matchId ? " · " + S.matchId : "");

  const holdersOf = (sym) => [...tape.open.values()].filter((p) => p.symbol === sym);
  const syms = [...tape.prints.entries()];
  syms.sort((a, b) => holdersOf(b[0]).length - holdersOf(a[0]).length || b[1].count - a[1].count);
  if (!syms.length) {
    rowsEl.innerHTML = `<div class="empty">No trades printed yet — the tape fills as the fighters deal.</div>`;
  } else {
    rowsEl.innerHTML = syms.map(([sym, pr]) => {
      const mv = pr.count > 1 && pr.first ? ((pr.last - pr.first) / pr.first) * 100 : null;
      const mvHtml = mv == null ? `<span class="mv flat">—</span>`
        : `<span class="mv ${mv > 0.005 ? "up" : mv < -0.005 ? "dn" : "flat"}">${mv >= 0 ? "+" : ""}${mv.toFixed(2)}%</span>`;
      const chips = holdersOf(sym).map((p) => {
        const per = personaOf(p.agentId);
        return `<span class="chip" style="color:${per.color};border-color:${per.color};background:${per.color}1f">${per.emoji || ""} ${per.name}</span>`;
      }).join("");
      return `<div class="trow"><span class="sym">${sym}</span>${tape.scrambleSym === sym ? `<span class="scram">⚡ SCRAMBLE</span>` : ""}` +
        `<span class="px">${fmtPx(pr.last)}</span><div>${mvHtml} <span class="prints">· ${pr.count} print${pr.count === 1 ? "" : "s"} · match move</span></div>` +
        (chips ? `<div class="chips">${chips}</div>` : "") + `</div>`;
    }).join("");
  }

  const posEl = $("tape-pos");
  if (posEl) {
    const pos = [...tape.open.values()];
    pos.sort((a, b) => personaOf(a.agentId).name.localeCompare(personaOf(b.agentId).name) || a.symbol.localeCompare(b.symbol));
    if (!pos.length) {
      posEl.innerHTML = `<div class="empty">No open positions.</div>`;
    } else {
      posEl.innerHTML = pos.map((p) => {
        const per = personaOf(p.agentId);
        const pr = tape.prints.get(p.symbol);
        const mark = pr ? pr.last : null;
        let pd;
        if (mark == null || !p.entry) {
          pd = `<b>${p.symbol}</b> @ ${fmtPx(p.entry)} · no mark print yet`;
        } else {
          const u = (mark / p.entry - 1) * (p.amountUsd || 0);
          pd = `<b>${p.symbol}</b> ${fmtPx(p.entry)} → ${fmtPx(mark)} · <span class="${u >= 0 ? "pnl-up" : "pnl-dn"}">${u >= 0 ? "+" : "−"}$${Math.abs(u).toFixed(2)}</span>`;
        }
        return `<div class="prow"><span class="pf" style="color:${per.color}">${per.emoji || ""} ${per.name}</span><span class="pd">${pd}</span></div>`;
      }).join("");
    }
  }
}

/* ------------------------------------------------- BACKGROUND · FLASH HUNT
 * The house works behind the arena. offchain/house-pulse.js publishes
 * house-pulse.json from the REAL arb watcher artifacts (attempts log,
 * watchdog heartbeats, systemd). This strip renders only what that file
 * says, with the file's own timestamps. Missing file → the strip hides.
 * Stale file → the strip says so. Freshness is never fabricated — and the
 * hunt is real-time even while the match above it is a replay. */
let housePulse = null;
function fmtET(iso) {
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(iso)) + " ET";
  } catch (e) { return ""; }
}
function shortPair(pair) {
  if (!pair) return "";
  return pair.length > 40 ? pair.slice(0, 40) + "…" : pair;
}
function renderHouse() {
  const strip = $("house-strip");
  if (!strip) return;
  if (!housePulse || !housePulse.generatedAt) { strip.style.display = "none"; return; }
  const p = housePulse;
  const ageSec = (Date.now() - Date.parse(p.generatedAt)) / 1000;
  const stale = !(ageSec >= 0) || ageSec > 300;
  strip.style.display = "";
  const dot = $("hs-dot");
  if (dot) dot.className = stale ? "stale" : "fresh";
  const w = p.watcher || {};
  const parts = [];
  if (w.status === "armed-scanning") parts.push("watcher <b>ARMED · scanning</b>");
  else if (w.status === "armed-quiet") parts.push("watcher <b>ARMED · quiet</b>");
  else if (w.status === "down") parts.push("watcher <b>DOWN</b>");
  else parts.push("watcher status unknown");
  if (p.scans && p.scans.evals != null) parts.push(`evals <b>${Number(p.scans.evals).toLocaleString("en-US")}</b>`);
  if (p.fires && p.fires.real != null) parts.push(`fires <b>${p.fires.real}</b>`);
  if (p.bestGap) {
    const g = p.bestGap;
    if (g.bps > 0) parts.push(`best gap <b>${g.bps} bps</b> ${shortPair(g.pair)} <span class="hs-note">(scan print — not fill-verified)</span>`);
    else parts.push(`best gap <b>${g.bps} bps</b> <span class="hs-note">— nothing profitable at size</span>`);
  }
  if (p.lastAttempt && p.lastAttempt.ts) parts.push(`last eval ${fmtET(p.lastAttempt.ts)}`);
  $("hs-line").innerHTML = `<span class="hsl">BACKGROUND · FLASH HUNT</span>` +
    (stale ? `pulse stale — last update ${fmtET(p.generatedAt)} · ` : "") +
    parts.join(" · ") +
    (stale ? "" : ` · pulse ${fmtET(p.generatedAt)}`);
  strip.title = (p.sources || []).join(" · ");
}
async function pollHouse() {
  for (;;) {
    try { housePulse = await fetchJson("house-pulse.json"); }
    catch (e) { housePulse = null; }
    renderHouse();
    await sleep(20000);
  }
}

/* ------------------------------------------------------------------ speech */
const speechLog = [];
function estSeconds(line) {
  const w = String(line || "").trim().split(/\s+/).filter(Boolean).length;
  return clamp(w / 2.35, 1.5, 7);
}
function pickVoice(profile) {
  try {
    const vs = window.speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
    if (!vs.length) return null;
    if (profile.gb) { const gb = vs.find((v) => /en[-_]GB/i.test(v.lang)); if (gb) return gb; }
    return vs.find((v) => /en[-_]US/i.test(v.lang)) || vs[0];
  } catch (e) { return null; }
}

/**
 * Speak one feed line. Recorded clip wins when present; else SpeechSynthesis;
 * else silent (bubble + mouth still perform). Resolves when the line is done.
 */
function speakLine(personaId, line, audio) {
  return new Promise((resolve) => {
    const rig = rigById[personaId] || null;
    const profile = VOICE_PROFILES[personaId] || VOICE_PROFILES.host;
    const who = rig ? rig.persona : { name: "FLOW ARENA", color: "#00e5ff", emoji: "🏟" };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (rig) rig.speaking = false;
      if (currentSpeaker === rig) currentSpeaker = null;
      $("bubble").style.display = "none";
      resolve();
    };

    if (rig) { rig.speaking = true; setMode(rig, "speak"); currentSpeaker = rig; }
    const bub = $("bubble");
    bub.style.display = "block";
    bub.style.borderColor = who.color || "#3a4a6b";
    bub.querySelector(".who").textContent = `${who.emoji || ""} ${who.name}`;
    bub.querySelector(".who").style.color = who.color || "#e8ecf4";
    bub.querySelector(".txt").textContent = line;
    $("now-line").textContent = line;

    const est = estSeconds(line) / paceScale;
    let how = "silent";

    if (soundOn && audio) {
      how = "clip";
      const clip = new Audio(audio);
      clip.playbackRate = clamp(paceScale, 1, 1.5);
      clip.onended = finish;
      clip.onerror = () => { if (!finished) { how = "clip-failed→tts"; ttsFallback(); } };
      const p = clip.play();
      if (p && p.catch) p.catch(() => { if (!finished) ttsFallback(); });
      setTimeout(finish, (est + 4) * 1000);
    } else if (soundOn && "speechSynthesis" in window) {
      how = "tts";
      ttsFallback();
      setTimeout(finish, (est + 3.5) * 1000);
    } else {
      setTimeout(finish, est * 1000);
    }

    function ttsFallback() {
      if (finished || !("speechSynthesis" in window)) { setTimeout(finish, est * 1000); return; }
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(line);
        u.pitch = profile.pitch;
        u.rate = clamp(profile.rate * paceScale, 0.5, 1.6);
        const v = pickVoice(profile);
        if (v) u.voice = v;
        u.onend = finish;
        u.onerror = finish;
        window.speechSynthesis.speak(u);
      } catch (e) { setTimeout(finish, est * 1000); }
    }

    speechLog.push({ t: new Date().toISOString(), mode: how, personaId: personaId || "host", line: String(line).slice(0, 90) });
    console.info("[arena3d speak]", how, personaId || "host", "—", String(line).slice(0, 60));
  });
}

/* ------------------------------------------------------------- event engine */
function setEliminated(rig, silent) {
  if (!rig || rig.elim) return;
  rig.elim = true;
  setMode(rig, "slump");
  rig.visorMat.color.set(0x39445c);
  rig.ringMat.opacity = 0.25;
  rig.plate.classList.add("dead");
  if (!silent) console.info("[arena3d] eliminated:", rig.id);
}
function celebrate(rig) {
  if (!rig || rig.elim) return;
  setMode(rig, "celebrate");
}

async function processEvent(ev, state) {
  tapeOnEvent(ev);
  if (ev.round != null) setRound(ev.round);
  const rig = ev.agentId ? rigById[ev.agentId] : null;

  if (ev.type === "SCRAMBLE") {
    for (const r of rigs) if (!r.elim && r.id !== "guest") setMode(r, "alert");
  }
  if (ev.line) {
    await speakLine(ev.agentId || null, ev.line, ev.audio || null);
  } else {
    $("now-line").textContent = ev.note || ev.type || "";
    await sleep(500 / paceScale);
  }
  if (ev.type === "ELIMINATION" && rig) setEliminated(rig);
  if (ev.type === "MATCH_END" && state.pool && state.pool.payouts) {
    const winners = Object.entries(state.pool.payouts).sort((a, b) => b[1] - a[1]);
    winners.forEach(([id], idx) => setTimeout(() => celebrate(rigById[id]), idx * 350));
  }
  if (rig && rig.mode === "speak") setMode(rig, "idle");
}

/* ---------------------------------------------------------------- drivers */
async function runDemo(gen) {
  const state = await fetchJson("arena3d-demo.json");
  if (gen !== runGen) return;
  S = state;
  buildCast(state);
  setModeBadge();
  walkIn();
  await sleep(1400);
  let i = 0;
  while (gen === runGen) {
    const ev = state.feed[i];
    const nxt = state.feed[i + 1];
    $("next-line").textContent = nxt ? (nxt.line || nxt.type) : "Final whistle — then the replay starts over.";
    await processEvent(ev, state);
    await sleep(260 / paceScale);
    i++;
    if (i >= state.feed.length) {
      $("next-line").textContent = "Replay restarting…";
      await sleep(6000);
      if (gen !== runGen) return;
      for (const r of rigs) { if (r.elim) { r.elim = false; setMode(r, "idle"); r.visorMat.color.set(r.persona.color); r.ringMat.opacity = 0.85; r.plate.classList.remove("dead"); r.tilt.rotation.x = 0; r.tilt.position.y = 0; r.head.rotation.x = 0; r.armL.rotation.x = r.armR.rotation.x = 0; } }
      tapeReset(state, false);
      i = 0;
    }
  }
}

let seenFeed = 0;
const liveQueue = [];
let liveWorking = false;
async function liveWorker(gen) {
  if (liveWorking) return;
  liveWorking = true;
  while (gen === runGen && liveQueue.length) {
    const ev = liveQueue.shift();
    const nxt = liveQueue[0];
    $("next-line").textContent = nxt ? (nxt.line || nxt.type) : "Listening for the next call…";
    await processEvent(ev, S);
  }
  liveWorking = false;
}

async function pollLive(gen) {
  while (gen === runGen) {
    try {
      const state = await loadLiveState();
      if (gen !== runGen) return;
      if (!S || state.matchId !== S.matchId || state.status !== S.status) {
        S = state;
        buildCast(state);
        setModeBadge();
        walkIn();
        seenFeed = state.feed ? state.feed.length : 0; // never speak a backlog
        if (state.feed && state.feed.length) {
          $("now-line").textContent = state.feed[state.feed.length - 1].line || "On air.";
        }
      } else {
        S = state;
        applyStandings(state);
        setModeBadge();
        const feed = state.feed || [];
        if (feed.length > seenFeed) {
          for (const ev of feed.slice(seenFeed)) liveQueue.push(ev);
          seenFeed = feed.length;
          liveWorker(gen);
        }
      }
    } catch (e) {
      $("now-line").textContent = "Arena state not available yet — retrying.";
    }
    await sleep(S && (S.status === "live" || S.status === "scheduled") ? 4000 : 15000);
  }
}

/* -------------------------------------------------------------- animation */
const clock = new THREE.Clock();
let autoCam = true;
let camTargetPos = new THREE.Vector3(0, 5.4, 13.5);
let camTargetLook = new THREE.Vector3(0, 1.5, 0);
let fpsAcc = 0, fpsN = 0, degraded = false;
const V = new THREE.Vector3();

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;

  // cheap perf guard: drop pixel ratio once if frames run long
  if (!degraded) {
    fpsAcc += dt; fpsN++;
    if (fpsN >= 150) {
      if (fpsAcc / fpsN > 0.024) { renderer.setPixelRatio(1); degraded = true; }
      fpsAcc = 0; fpsN = 0;
    }
  }

  for (const r of rigs) {
    r.modeT = (performance.now() - r.modeStart) / 1000;
    const breathe = Math.sin(t * 1.7 + r.phase) * 0.02;

    if (r.mode === "walk") {
      r.walkT = clamp((performance.now() - r.walkStart) / (r.walkDur * 1000), 0, 1);
      const k = r.walkT;
      r.root.position.lerpVectors(r.walkFrom, r.walkTo, k);
      const sw = Math.sin(t * 11 + r.phase) * 0.5 * (1 - k * 0.3);
      r.legL.rotation.x = sw; r.legR.rotation.x = -sw;
      r.tilt.position.y = Math.abs(Math.sin(t * 11 + r.phase)) * 0.05;
      r.armL.rotation.x = -sw * 0.6; r.armR.rotation.x = sw * 0.6;
      if (k >= 1) { setMode(r, "idle"); r.legL.rotation.x = r.legR.rotation.x = 0; }
    } else if (r.mode === "celebrate") {
      r.tilt.position.y = Math.abs(Math.sin(r.modeT * 6.5)) * 0.34;
      r.armL.rotation.z = 2.45; r.armR.rotation.z = -2.45;
      r.armL.rotation.x = 0; r.armR.rotation.x = 0;
      if (r.modeT < 2.2) r.root.rotation.y += dt * 1.6;
      if (r.modeT > 3.4) { setMode(r, "idle"); r.armL.rotation.z = r.armR.rotation.z = 0; r.tilt.position.y = 0; }
    } else if (r.mode === "slump") {
      const k = clamp(r.modeT * 1.6, 0, 1);
      r.tilt.rotation.x = 0.52 * k;
      r.tilt.position.y = -0.3 * k;
      r.armL.rotation.x = 0.45 * k; r.armR.rotation.x = 0.45 * k;
      r.head.rotation.x = 0.4 * k;
    } else if (r.mode === "alert") {
      r.tilt.position.y = Math.abs(Math.sin(r.modeT * 14)) * 0.1;
      if (r.modeT > 0.7) { setMode(r, "idle"); r.tilt.position.y = 0; }
    } else { // idle / speak base
      r.tilt.position.y = breathe;
      r.tilt.rotation.z = Math.sin(t * 0.8 + r.phase) * 0.014;
      r.armL.rotation.x = Math.sin(t * 1.3 + r.phase) * 0.05;
      r.armR.rotation.x = Math.sin(t * 1.3 + r.phase + 1) * 0.05;
      if (r.mode === "speak") {
        r.armR.rotation.x = -0.95 + Math.sin(t * 3.1 + r.phase) * 0.28; // gesturing
        r.head.rotation.x = Math.sin(t * 2.3 + r.phase) * 0.06;
      }
    }

    // jaw light + visor pulse while speaking (the "talking" cue)
    if (r.speaking) {
      r.mouth.scale.y = 0.5 + Math.abs(Math.sin(t * 26 + r.phase * 3)) * 1.9;
      r.mouth.position.y = -0.08 - r.mouth.scale.y * 0.012;
      if (r.visor) r.visor.scale.y = 1 + Math.sin(t * 26 + r.phase * 3) * 0.45;
    } else {
      if (r.mouth.scale.y !== 1) r.mouth.scale.y = lerp(r.mouth.scale.y, 1, 0.3);
      if (r.visor && r.visor.scale.y !== 1) r.visor.scale.y = lerp(r.visor.scale.y, 1, 0.3);
    }

    // facing: speakers turn to the camera; everyone else holds their spot angle
    let want = r.homeRotY + (r.mode === "idle" ? Math.sin(t * 0.3 + r.phase) * 0.16 : 0);
    if (r.speaking) want = Math.atan2(camera.position.x - r.root.position.x, camera.position.z - r.root.position.z);
    if (r.mode !== "walk" && r.mode !== "celebrate") r.root.rotation.y = angLerp(r.root.rotation.y, want, clamp(dt * 5, 0, 1));
  }

  // camera: slow cinematic orbit, cut to the speaker while they talk
  if (autoCam) {
    if (currentSpeaker && !currentSpeaker.elim) {
      const p = currentSpeaker.root.position;
      const out = V.set(p.x, 0, p.z).normalize();
      camTargetPos.set(p.x + out.x * 6.6, 3.0, p.z + out.z * 6.6);
      camTargetLook.set(p.x, 1.8, p.z);
    } else {
      const a = t * 0.055;
      camTargetPos.set(Math.sin(a) * 13.8, 6.3 + Math.sin(t * 0.12) * 0.9, Math.cos(a) * 13.8);
      camTargetLook.set(0, 1.35, 0);
    }
    const kp = 1 - Math.exp(-dt * 2.0);
    camera.position.lerp(camTargetPos, kp);
    controls.target.lerp(camTargetLook, kp);
    camera.lookAt(controls.target);
  } else {
    controls.update();
  }

  // project nameplates + bubble
  for (const r of rigs) {
    r.head.getWorldPosition(V);
    V.y += 0.62;
    V.project(camera);
    if (V.z > 1) { r.plate.style.opacity = "0"; continue; }
    r.plate.style.opacity = "";
    r.plate.style.left = ((V.x * 0.5 + 0.5) * innerWidth) + "px";
    r.plate.style.top = ((-V.y * 0.5 + 0.5) * innerHeight) + "px";
  }
  const bub = $("bubble");
  if (bub.style.display !== "none") {
    if (currentSpeaker) {
      currentSpeaker.head.getWorldPosition(V);
      V.y += 1.35;
      V.project(camera);
      const hw = bub.offsetWidth / 2 + 10;
      bub.style.left = clamp((V.x * 0.5 + 0.5) * innerWidth, hw, innerWidth - hw) + "px";
      bub.style.top = Math.max(108, (-V.y * 0.5 + 0.5) * innerHeight) + "px";
    } else { // announcer line: park the bubble top-center
      bub.style.left = (innerWidth / 2) + "px";
      bub.style.top = "150px";
    }
  }

  renderer.render(scene, camera);
}

/* --------------------------------------------------------------- controls */
$("sound-gate").addEventListener("click", () => {
  soundOn = true;
  $("sound-gate").style.display = "none";
  $("btn-mute").style.display = "";
  try { window.speechSynthesis.getVoices(); } catch (e) {}
});
$("btn-mute").addEventListener("click", () => {
  soundOn = !soundOn;
  $("btn-mute").textContent = soundOn ? "🔊 Sound: ON" : "🔇 Sound: OFF";
  $("btn-mute").classList.toggle("on", soundOn);
  if (!soundOn && "speechSynthesis" in window) window.speechSynthesis.cancel();
});
$("btn-cam").addEventListener("click", () => {
  autoCam = !autoCam;
  controls.enabled = !autoCam;
  $("btn-cam").textContent = autoCam ? "🎥 Auto camera: ON" : "🎥 Auto camera: OFF (drag to orbit)";
  $("btn-cam").classList.toggle("on", autoCam);
});
renderer.domElement.addEventListener("pointerdown", () => {
  if (autoCam) $("btn-cam").click();
});
const SPEEDS = [1, 2, 4];
let speedIdx = 0;
$("btn-speed").addEventListener("click", () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  paceScale = SPEEDS[speedIdx];
  $("btn-speed").textContent = `⏩ Replay speed: ${paceScale}×`;
});
{
  const tapeEl = $("tape");
  const tog = $("tape-toggle");
  if (tapeEl && tog) {
    if (innerWidth <= 760) { tapeEl.classList.add("collapsed"); tog.textContent = "+"; }
    tog.addEventListener("click", () => {
      const collapsed = tapeEl.classList.toggle("collapsed");
      tog.textContent = collapsed ? "+" : "–";
    });
  }
}
/* ------------------------------------------------------- mode switching
 * BUG (Match 4 broadcast, 2026-10-12): the mode used to be decided ONCE
 * in boot(). A page opened during the pre-show booted into demo, and
 * runDemo() loops the recorded replay forever without ever re-reading
 * arena-live.json — so when Match 4 flipped the state file to live at
 * 20:20:48, the page stayed in demo until an operator forced the flip
 * by hand. Symmetrically, a page booted live never returned to replay
 * after the final whistle.
 *
 * Fix: one shared setMatchMode() switch (the old button handler's body), a
 * pure desiredMode(state) decision, and a watcher that re-evaluates it
 * every 5s. A mode pinned by URL (?mode=live|demo) or by the mode
 * button is a human's choice — the watcher stands down for it. */
const POST_MATCH_GRACE_MS = 5 * 60 * 1000; // hold final standings before replay resumes
let modePinned = false;

function desiredMode(st, now = Date.now()) {
  if (!st || !st.liveMode) return "demo";
  if (st.status === "live" || st.status === "scheduled") return "live";
  if (st.status === "finished" && st.endedAt && now - Date.parse(st.endedAt) < POST_MATCH_GRACE_MS) return "live";
  return "demo";
}

function setMatchMode(next) {
  runGen++;
  const gen = runGen;
  mode = next;
  seenFeed = 0; liveQueue.length = 0;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  if (mode === "demo") runDemo(gen);
  else { S = null; pollLive(gen); }
  console.info("[arena3d] mode ->", mode);
}

async function watchMode() {
  for (;;) {
    await sleep(5000);
    if (modePinned) continue;
    try {
      const st = await loadLiveState();
      const want = desiredMode(st);
      if (want !== mode) setMatchMode(want);
    } catch (e) { /* state unreachable — hold the current mode */ }
  }
}

$("btn-mode").addEventListener("click", async () => {
  modePinned = true; // a human chose — the auto watcher stands down
  setMatchMode(mode === "demo" ? "live" : "demo");
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* ------------------------------------------------------------------- boot */
window.__A3D__ = {
  ready: false,
  speechLog,
  rigs: () => rigById,
  mode: () => mode,
  desiredMode: (st, now) => desiredMode(st, now),
  pinned: () => modePinned,
  state: () => S,
  celebrate: (id) => celebrate(rigById[id]),
  eliminate: (id) => setEliminated(rigById[id]),
  speak: (id, line) => speakLine(id, line, null),
};

(async function boot() {
  const qs = new URLSearchParams(location.search);
  const pin = qs.get("mode");
  modePinned = pin === "live" || pin === "demo";
  let liveState = null;
  try { liveState = await loadLiveState(); } catch (e) { /* demo will carry */ }
  mode = modePinned ? pin : desiredMode(liveState);
  pollHouse(); // the flash hunt runs in real time, independent of match mode
  tick();
  setMatchMode(mode);
  watchMode(); // auto-flip watcher — stands down when the mode is pinned
  window.__A3D_BOOTED = true;
  window.__A3D__.ready = true;
  console.info("[arena3d] booted in", mode, "mode");
})();
