/* =====================================================================
   GIGABYTE STAGE — Phase 1 VRM cast room
   Two cast members (Flowexecutor + MISTY) as VRM 1.0 characters on a
   desk stage, driven live by the Gigabyte show feed:
     - Rhubarb viseme lip-sync (server-generated tracks) w/ amplitude fallback
     - speaker gaze choreography + procedural gesture layer
     - idle life: blink / breath / sway / spring bones (via three-vrm)
     - portrait fallback when WebGL or models are unavailable
   No build step. Vendored three@0.186 + @pixiv/three-vrm@3.5.5 (MIT).
   ===================================================================== */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

/* ---------------- config ---------------- */
const Q = new URLSearchParams(location.search);
const FEED_BASE = (Q.get('feed') || '').replace(/\/$/, '');           // '' = same origin
const VISEME_BASE = (Q.get('visemes') || '').replace(/\/$/, '');      // '' = ./visemes/ next to the page
export const CONFIG = {
  stateUrl: Q.get('state') || `${FEED_BASE}/api/gigabyte-state`,
  audioUrl: (id) => Q.get('audio') ? Q.get('audio').replace('{id}', id) : `${FEED_BASE}/api/gigabyte-audio?id=${id}`,
  // PREVIEW TWEAK (preview copy only): VISEME_BASE may be a {id} template
  // (e.g. an API route like /api/gigabyte-preview-viseme?id={id}).
  visemeUrl: (id) => VISEME_BASE ? (VISEME_BASE.includes('{id}') ? VISEME_BASE.replace('{id}', id) : `${VISEME_BASE}/${id}.json`) : `./visemes/${id}.json`,
  pollMs: 1500,
  maxPixelRatio: 2,
  testLine: Q.get('testline') ? parseInt(Q.get('testline'), 10) : null,
  forceFallback: Q.get('fallback') === '1',
  models: {
    // NOTE: until the bespoke MPFB/VRoid cast models land, both slots load
    // licensed sample VRMs (see assets/models/PROVENANCE.md). The host slot
    // gets a runtime material tint + slight scale so the two read as
    // distinct silhouettes on stage; tint is skipped for custom models
    // (set tint:null when swapping in the real cast files).
    // PREVIEW TWEAK (preview copy only): the two local model files are
    // byte-identical copies of pixiv's official VRM 1.0 sample (md5
    // b36a6fbb65316d5684de896dedee4f26 — see assets/models/PROVENANCE.md),
    // so the preview loads that exact file from its canonical public URL
    // (served with Access-Control-Allow-Origin: *) instead of shipping
    // 21MB of binaries for a private preview. Production ships local files.
    FLOWEXECUTOR: { url: 'https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm', accent: 0xe8b84b, plate: 'FLOWEXECUTOR · HOST', tint: new THREE.Color(0.72, 0.66, 0.85), scale: 1.035 },
    MISTY:        { url: 'https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm', accent: 0x37e0d8, plate: 'MISTY · THE CHAMPION', tint: null, scale: 1.0 },
  },
};
const ON_STAGE = Object.keys(CONFIG.models);

/* ---------------- tiny utils ---------------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
// smooth pseudo-noise from summed sines (deterministic per seed)
const noise1 = (t, s) => Math.sin(t * 0.9 + s) * 0.55 + Math.sin(t * 0.53 + s * 1.7) * 0.3 + Math.sin(t * 1.7 + s * 0.6) * 0.15;

/* =====================================================================
   STAGE
   ===================================================================== */
export class Stage {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    this.chars = {};            // id -> CharRig
    this.speaker = null;        // member id currently holding the floor
    this.addressee = null;      // member id the speaker is talking to (or 'CAMERA')
    this.clock = new THREE.Clock();
    this.fps = 0; this._frames = 0; this._fpsT = 0;
    this.quality = 'auto';      // auto | high | low
    this._prLevel = 0;          // pixel-ratio step-down level
    this._slowT = 0;
    this.onStats = null;        // callback(hud)
  }

  async init() {
    if (CONFIG.forceFallback) throw new Error('fallback forced');
    // --- WebGL capability probe
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) throw new Error('WebGL unavailable');

    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, CONFIG.maxPixelRatio));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05060a);
    scene.fog = new THREE.Fog(0x05060a, 7, 14);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(37, 1, 0.1, 40);
    camera.position.set(0, 1.42, 3.95);
    camera.lookAt(0, 1.10, 0);
    this.camera = camera;

    this._buildSet();
    this._buildLights();
    await this._loadCast();
    this._resize();
    addEventListener('resize', () => this._resize());
    this.ok = true;
    this._loop();
    return this;
  }

  /* ---------- set: desk, backdrop, plates, blob shadows ---------- */
  _canvasTexture(w, h, draw) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  }

  _buildSet() {
    const S = this.scene;
    // floor
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(7, 48),
      new THREE.MeshStandardMaterial({ color: 0x0a0d16, roughness: 0.95, metalness: 0 })
    );
    floor.rotation.x = -Math.PI / 2; S.add(floor);
    // glowing floor ring
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.55, 2.62, 64),
      new THREE.MeshBasicMaterial({ color: 0x274b63, transparent: true, opacity: 0.8 })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.002; S.add(ring);

    // backdrop with GIGABYTE sign
    const backTex = this._canvasTexture(2048, 1024, (g, w, h) => {
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#0b1120'); grad.addColorStop(0.65, '#080b13'); grad.addColorStop(1, '#05060a');
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(70,110,160,0.13)'; g.lineWidth = 2;
      for (let x = 0; x <= w; x += 128) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
      for (let y = 0; y <= h; y += 128) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      g.textAlign = 'center';
      g.font = '800 190px Arial, sans-serif';
      g.shadowColor = '#e8b84b'; g.shadowBlur = 46;
      g.fillStyle = '#f4c95d'; g.fillText('GIGABYTE', w / 2, 400);
      g.shadowBlur = 0; g.font = '600 44px Arial, sans-serif'; g.fillStyle = '#7f8ca3';
      g.fillText('L I V E   F R O M   T H E   D E S K', w / 2, 488);
    });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(11, 5.5), new THREE.MeshBasicMaterial({ map: backTex }));
    back.position.set(0, 1.55, -1.7); S.add(back);
    // side light pillars
    for (const x of [-3.1, 3.1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.14, 3.4, 0.14),
        new THREE.MeshStandardMaterial({ color: 0x11182a, emissive: x < 0 ? 0xe8b84b : 0x37e0d8, emissiveIntensity: 0.55, roughness: 0.6 }));
      pillar.position.set(x, 1.7, -1.1); S.add(pillar);
    }

    // desk — long, dark, with an emissive front strip and name plates
    const desk = new THREE.Group();
    const top = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.09, 0.85),
      new THREE.MeshStandardMaterial({ color: 0x141a29, roughness: 0.35, metalness: 0.55 }));
    top.position.y = 0.86; desk.add(top);
    const front = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.82, 0.07),
      new THREE.MeshStandardMaterial({ color: 0x0d1220, roughness: 0.7, metalness: 0.2 }));
    front.position.set(0, 0.44, 0.42); desk.add(front);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.035, 0.012),
      new THREE.MeshBasicMaterial({ color: 0xe8b84b }));
    strip.position.set(0, 0.83, 0.462); desk.add(strip);
    S.add(desk);
    this.deskStrip = strip;

    // name plates on the desk front (canvas textures; glow when speaking)
    this.plates = {};
    const plateX = { FLOWEXECUTOR: -0.92, MISTY: 0.92 };
    for (const id of ON_STAGE) {
      const cfg = CONFIG.models[id];
      const mat = new THREE.MeshBasicMaterial({
        map: this._plateTexture(cfg.plate, '#8b96ad'),
        transparent: true,
      });
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(1.28, 0.30), mat);
      plate.position.set(plateX[id], 0.47, 0.462);
      S.add(plate);
      this.plates[id] = { mesh: plate, cfg, active: false };
    }
    // blob shadows under characters
    const blobTex = this._canvasTexture(256, 256, (g, w, h) => {
      const rg = g.createRadialGradient(w/2, h/2, 10, w/2, h/2, w/2);
      rg.addColorStop(0, 'rgba(0,0,0,0.55)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg; g.fillRect(0, 0, w, h);
    });
    for (const id of ON_STAGE) {
      const blob = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.6),
        new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }));
      blob.rotation.x = -Math.PI / 2;
      blob.position.set(id === 'FLOWEXECUTOR' ? -0.92 : 0.92, 0.004, 0.1);
      S.add(blob);
    }
  }

  _plateTexture(text, color) {
    return this._canvasTexture(1024, 240, (g, w, h) => {
      g.fillStyle = 'rgba(10,13,22,0.92)'; g.fillRect(0, 0, w, h);
      g.strokeStyle = color; g.lineWidth = 5; g.strokeRect(8, 8, w - 16, h - 16);
      g.fillStyle = color; g.textAlign = 'center';
      g.font = '800 74px Arial, sans-serif';
      g.fillText(text, w / 2, h / 2 + 27);
    });
  }

  setPlateActive(id, active) {
    for (const [pid, p] of Object.entries(this.plates || {})) {
      const on = pid === id && active;
      if (on !== p.active) {
        p.active = on;
        p.mesh.material.map = this._plateTexture(p.cfg.plate, on ? '#ffd873' : '#8b96ad');
        p.mesh.material.needsUpdate = true;
      }
    }
  }

  _buildLights() {
    const S = this.scene;
    S.add(new THREE.HemisphereLight(0x8fa3c7, 0x0a0c12, 0.85));
    const key = new THREE.DirectionalLight(0xfff1d6, 1.6);
    key.position.set(1.6, 3.2, 3.4); S.add(key); this.keyLight = key;
    const rimL = new THREE.PointLight(0xe8b84b, 12, 9); rimL.position.set(-2.6, 2.0, -0.8); S.add(rimL);
    const rimR = new THREE.PointLight(0x37e0d8, 12, 9); rimR.position.set(2.6, 2.0, -0.8); S.add(rimR);
    this.rims = [rimL, rimR];
  }

  /* ---------- cast loading ---------- */
  async _loadCast() {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const jobs = ON_STAGE.map(async (id) => {
      const cfg = CONFIG.models[id];
      const gltf = await loader.loadAsync(cfg.url);
      const vrm = gltf.userData.vrm;
      if (!vrm) throw new Error(`${id}: not a VRM file`);
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      if (cfg.tint) {
        vrm.scene.traverse((o) => {
          if (o.isMesh) {
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) { if (m && m.color) m.color.multiply(cfg.tint); }
          }
        });
      }
      if (cfg.scale && cfg.scale !== 1) vrm.scene.scale.setScalar(cfg.scale);
      vrm.scene.position.set(id === 'FLOWEXECUTOR' ? -0.92 : 0.92, 0, -0.15);
      this.scene.add(vrm.scene);
      this.chars[id] = new CharRig(id, vrm, cfg);
    });
    await Promise.all(jobs);
    // gaze targets shared by all rigs
    this.gazePoints = {
      CAMERA: new THREE.Object3D(), PARTNER_L: new THREE.Object3D(), PARTNER_R: new THREE.Object3D(), DOOR: new THREE.Object3D(),
    };
    this.gazePoints.CAMERA.position.set(0, 1.32, 5);
    this.gazePoints.PARTNER_L.position.set(-0.92, 1.45, -0.15);
    this.gazePoints.PARTNER_R.position.set(0.92, 1.45, -0.15);
    this.gazePoints.DOOR.position.set(3.4, 1.4, 1.6);
    for (const p of Object.values(this.gazePoints)) this.scene.add(p);
    for (const rig of Object.values(this.chars)) {
      rig.vrm.lookAt.target = this.gazePoints.CAMERA;
      rig.setGazePoint(this.gazePoints.CAMERA);
    }
  }

  /* ---------- public control surface (feed drives these) ---------- */
  setSpeaker(id, addressee = 'CAMERA') {
    this.speaker = id; this.addressee = addressee;
    this.setPlateActive(id, !!id);
    for (const rig of Object.values(this.chars)) {
      if (id && rig.id === id) rig.state = 'speaking';
      else if (id) rig.state = 'listening';
      else rig.state = 'idle';
      // offstage cast member is talking: the whole stage looks to the door
      if (!id && addressee === 'DOOR') { rig.setGazePoint(this.gazePoints.DOOR); continue; }
      // gaze choreography
      if (rig.state === 'speaking') {
        rig.setGazePoint(addressee === 'PARTNER' ? this._partnerPoint(rig.id)
          : addressee === 'DOOR' ? this.gazePoints.DOOR : this.gazePoints.CAMERA);
      } else if (rig.state === 'listening') {
        rig.setGazePoint(this._partnerPoint(rig.id)); // look at the speaker
      } else {
        rig.setGazePoint(this.gazePoints.CAMERA);
      }
    }
    if (this.keyLight) this.keyLight.intensity = id ? 1.85 : 1.6;
  }
  _partnerPoint(id) { return id === 'FLOWEXECUTOR' ? this.gazePoints.PARTNER_R : this.gazePoints.PARTNER_L; }

  setMouth(id, weights) { const r = this.chars[id]; if (r) r.mouthTarget = weights; }
  setMouthAmp(id, v) { const r = this.chars[id]; if (r) r.mouthAmp = v; }

  setQuality(mode) {
    this.quality = mode;
    if (!this.renderer) return;
    if (mode === 'high') { this.renderer.setPixelRatio(Math.min(devicePixelRatio, CONFIG.maxPixelRatio)); this._prLevel = 0; }
    if (mode === 'low') { this.renderer.setPixelRatio(1); this._prLevel = 3; }
    this._resize();
  }

  _resize() {
    if (!this.renderer) return;
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  _loop() {
    const tick = () => {
      requestAnimationFrame(tick);
      const dt = Math.min(this.clock.getDelta(), 0.05);
      const t = this.clock.elapsedTime;
      for (const rig of Object.values(this.chars)) rig.update(dt, t, this);
      // desk strip breathes gold when someone holds the floor
      if (this.deskStrip) this.deskStrip.material.color.setHex(this.speaker ? 0xffd873 : 0xe8b84b);
      this.renderer.render(this.scene, this.camera);
      // fps + adaptive quality
      this._frames++; this._fpsT += dt;
      if (this._fpsT >= 0.5) {
        this.fps = Math.round(this._frames / this._fpsT);
        this._frames = 0; this._fpsT = 0;
        if (this.onStats) {
          const info = this.renderer.info.render;
          this.onStats({ fps: this.fps, tris: info.triangles, calls: info.calls, prLevel: this._prLevel });
        }
        if (this.quality === 'auto') {
          if (this.fps > 0 && this.fps < 42) { this._slowT += 0.5; } else this._slowT = 0;
          if (this._slowT >= 3 && this._prLevel < 3) {
            this._slowT = 0; this._prLevel++;
            const pr = [Math.min(devicePixelRatio, CONFIG.maxPixelRatio), 1.5, 1.25, 1][this._prLevel];
            this.renderer.setPixelRatio(pr); this._resize();
          }
        }
      }
    };
    tick();
  }
}

/* =====================================================================
   CharRig — one cast member's procedural performance
   ===================================================================== */
const BONE = { head:'head', neck:'neck', chest:'chest', spine:'spine',
  lUA:'leftUpperArm', lLA:'leftLowerArm', lHand:'leftHand',
  rUA:'rightUpperArm', rLA:'rightLowerArm', rHand:'rightHand',
  lSh:'leftShoulder', rSh:'rightShoulder' };
// Arm control is AIM-based (world-space directions), not Euler guesses:
// VRM normalized-bone local axes vary per model, so each arm bone is
// steered by aiming the bone->child direction at a desired world
// direction. Directions are (x outward, y up, z toward camera).
const ARM_DIRS = {
  idle:     { lUA:[ 0.30,-1, 0.02], lLA:[ 0.10,-1, 0.38], rUA:[-0.30,-1, 0.02], rLA:[-0.10,-1, 0.38] },
  listening:{ lUA:[ 0.26,-1, 0.05], lLA:[ 0.06,-1, 0.48], rUA:[-0.26,-1, 0.05], rLA:[-0.06,-1, 0.48] },
  speaking: { lUA:[ 0.42,-1, 0.10], lLA:[ 0.16,-0.72, 0.75], rUA:[-0.42,-1, 0.10], rLA:[-0.16,-0.72, 0.75] },
};
const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _wq = new THREE.Quaternion(), _pq = new THREE.Quaternion();

class CharRig {
  constructor(id, vrm, cfg) {
    this.id = id; this.vrm = vrm; this.cfg = cfg;
    this.state = 'idle';
    this.seed = id === 'FLOWEXECUTOR' ? 3.1 : 7.7;
    this.bones = {};
    for (const [k, name] of Object.entries(BONE)) this.bones[k] = vrm.humanoid.getNormalizedBoneNode(name);
    this.rest = {};
    for (const [k, b] of Object.entries(this.bones)) if (b) this.rest[k] = b.quaternion.clone();
    // mouth state
    this.mouthTarget = { aa:0, ih:0, ou:0, ee:0, oh:0 };
    this.mouthCur = { aa:0, ih:0, ou:0, ee:0, oh:0 };
    this.mouthAmp = 0;
    // blink state
    this._nextBlink = rand(1.2, 3.5); this._blinkT = -1;
    this._gazePoint = null;
    this._nod = 0; // emphasis nod impulse (set by audio peaks via feed)
  }
  setGazePoint(p) { this._gazePoint = p; if (this.vrm.lookAt) this.vrm.lookAt.target = p; }
  nod() { this._nod = Math.min(1, this._nod + 0.7); }

  _aimBone(key, childKey, dirArr, jitter, dt, rate = 6) {
    const b = this.bones[key], c = this.bones[childKey];
    if (!b || !c) return;
    b.updateWorldMatrix(true, false);
    b.getWorldPosition(_v1); c.getWorldPosition(_v2);
    _v2.sub(_v1).normalize();                                   // current bone direction (world)
    _v3.set(dirArr[0] + (jitter?.[0] || 0), dirArr[1] + (jitter?.[1] || 0), dirArr[2] + (jitter?.[2] || 0)).normalize();
    _q.setFromUnitVectors(_v2, _v3);                            // world-space correction
    b.getWorldQuaternion(_wq);
    _q.multiply(_wq);                                           // desired world orientation
    b.parent.getWorldQuaternion(_pq).invert();
    _q.premultiply(_pq);                                        // -> local orientation
    b.quaternion.slerp(_q, 1 - Math.exp(-rate * dt));
  }

  update(dt, t, stage) {
    this.age += dt;
    if (!this._springsReset && this.age > 2.5) {
      this._springsReset = true;
      try { this.vrm.springBoneManager?.reset(); } catch { /* older builds */ }
    }
    const v = this.vrm, s = this.seed, speaking = this.state === 'speaking';
    const dirs = ARM_DIRS[this.state] || ARM_DIRS.idle;
    const amp = speaking ? 1 : 0.35;
    // --- gesture layer: aim arms at state directions + speech noise
    const gest = speaking ? (0.5 + this.mouthAmpLevel() * 0.9) : 0.25;
    const nL = noise1(t * 1.35, s) * 0.22 * gest, nR = noise1(t * 1.22, s + 40) * 0.22 * gest;
    const liftL = speaking ? Math.max(0, noise1(t * 0.9, s)) * 0.18 * gest : 0;
    const liftR = speaking ? Math.max(0, noise1(t * 0.83, s + 31)) * 0.18 * gest : 0;
    this._aimBone('lUA', 'lLA', dirs.lUA, [0, liftL, nL * 0.4], dt);
    this._aimBone('rUA', 'rLA', dirs.rUA, [0, liftR, -nR * 0.4], dt);
    this._aimBone('lLA', 'lHand', dirs.lLA, [nL * 0.5, liftL * 0.7, noise1(t * 1.6, s + 9) * 0.2 * gest], dt);
    this._aimBone('rLA', 'rHand', dirs.rLA, [-nR * 0.5, liftR * 0.7, noise1(t * 1.5, s + 21) * 0.2 * gest], dt);
    // --- breath + sway on spine/chest
    const breath = Math.sin(t * 1.45 + s) * 0.012;
    if (this.bones.chest) { _e.set(breath, 0, noise1(t * 0.4, s + 5) * 0.008); _q.setFromEuler(_e); this.bones.chest.quaternion.slerp(_q, 1 - Math.exp(-6 * dt)); }
    if (this.bones.spine) { _e.set(breath * 0.5, noise1(t * 0.31, s + 11) * 0.01, 0); _q.setFromEuler(_e); this.bones.spine.quaternion.slerp(_q, 1 - Math.exp(-6 * dt)); }
    // --- emphasis nod decay on neck (lookAt owns the head itself)
    this._nod = Math.max(0, this._nod - dt * 3.2);
    if (this.bones.neck) {
      const nodX = Math.sin(Math.min(1, this._nod) * Math.PI) * 0.09 + noise1(t * 0.8, s + 3) * 0.012 * amp + 0.02;
      _e.set(nodX, noise1(t * 0.5, s + 8) * 0.03 * amp, 0); _q.setFromEuler(_e);
      this.bones.neck.quaternion.slerp(_q, 1 - Math.exp(-8 * dt));
    }
    // --- blink (randomized, never periodic)
    this._nextBlink -= dt;
    if (this._nextBlink <= 0 && this._blinkT < 0) { this._blinkT = 0; this._nextBlink = rand(1.8, 5.2) * (speaking ? 1.25 : 1); }
    let blinkW = 0;
    if (this._blinkT >= 0) {
      this._blinkT += dt;
      const p = this._blinkT / 0.16;
      blinkW = p < 0.5 ? p * 2 : Math.max(0, 2 - p * 2);
      if (p >= 1) this._blinkT = -1;
    }
    // --- mouth: viseme targets, else amplitude flap
    const em = v.expressionManager;
    if (em) {
      const hasViseme = Object.values(this.mouthTarget).some((w) => w > 0.02);
      const tgt = { ...this.mouthTarget };
      if (!hasViseme && this.mouthAmp > 0.02) { tgt.aa = clamp(this.mouthAmp, 0, 1); tgt.ih = tgt.aa * 0.18; }
      const atk = 1 - Math.exp(-22 * dt), rel = 1 - Math.exp(-13 * dt);
      for (const k of ['aa', 'ih', 'ou', 'ee', 'oh']) {
        const target = tgt[k] || 0, cur = this.mouthCur[k];
        this.mouthCur[k] = cur + (target - cur) * (target > cur ? atk : rel);
        try { em.setValue(k, this.mouthCur[k]); } catch { /* model lacks shape */ }
      }
      try { em.setValue('blink', blinkW); } catch { /* no blink shape */ }
    }
    v.update(dt);
  }
  mouthAmpLevel() { return clamp(this.mouthAmp * 1.4 + (this.mouthCur.aa || 0) * 0.5, 0, 1); }
}

/* =====================================================================
   Portrait fallback (WebGL missing / model failed / user toggle)
   ===================================================================== */
export function showFallback(reason) {
  document.getElementById('stage').style.display = 'none';
  document.getElementById('hud').style.display = 'none';
  const fb = document.getElementById('fallback');
  fb.classList.add('show');
  const note = document.getElementById('fallbackNote');
  if (note && reason) note.textContent = `PORTRAIT MODE — ${reason}. The conversation feed stays live below.`;
}
export function fallbackSetSpeaker(id) {
  for (const pid of ON_STAGE) {
    const card = document.getElementById(`card${pid}`);
    if (card) card.classList.toggle('speaking', pid === id);
  }
}
