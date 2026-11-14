import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import Matter from 'matter-js';
import { createClimber, createPizza, CAT } from './climber.js';
import { generateLevel, SCALE, ROOF_Y, BUILDING_HEIGHT, BUILDING_HALF_W, FLOOR_H, START_HOLD_Y } from './level.js';
import { loadSound, play } from './audio.js';

const { Engine, Bodies, Body, Constraint, Composite } = Matter;

const STEP = 1000 / 60;
const VIEW_H = 900;            // visible world height in px (~11 m)
const HAND_K = 0.00012;        // hand pull per px of distance (in g)
const HAND_MAX = 0.0032;       // max hand pull (in g * arm mass)
const BODY_K = 0.00003;        // torso pull while gripping
const BODY_MAX = 0.0012;      // max torso pull (fraction of g * total mass)
const GRAB_PAD = 9;
const HAND_DAMP = 0.00015;     // velocity damping on a reaching hand
const BODY_DAMP_Y = 0.0003;    // vertical damping on the torso while hanging (stops the fling)
const BODY_DAMP_X = 0.00006;   // light horizontal damping so swinging still works
const PULL_RAMP = 450;         // ms for the pull-up to build after a grip change
const MAX_RISE = 3.5;          // max upward torso speed while hanging (px/step)

loadSound('grab', { volume: 0.7 });
loadSound('fall');
loadSound('ruined');
loadSound('music', { loop: true, volume: 0.3 });
loadSound('voice', { volume: 1 });   // delivery guy's grumbling monologue, once per page load

// ---------- Three.js setup ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();

// Sunset sky gradient + light fog so distant layers fade.
{
  const c = document.createElement('canvas');
  c.width = 2; c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#2c3f7c'); grad.addColorStop(0.45, '#c0668a'); grad.addColorStop(0.75, '#f39a6b'); grad.addColorStop(1, '#ffd29a');
  g.fillStyle = grad; g.fillRect(0, 0, 2, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
}
scene.fog = new THREE.Fog('#e98f78', 2600, 9000);

// Side-on perspective camera, narrow FOV, slight downward tilt. Gameplay stays on the z = 0 plane.
const FOV = 35, TILT = THREE.MathUtils.degToRad(4);
const CAM_D = VIEW_H / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
const camera = new THREE.PerspectiveCamera(FOV, 1, 20, 20000);
const focus = new THREE.Vector3(0, -START_HOLD_Y, 0);
function placeCamera() {
  camera.position.set(focus.x, focus.y + CAM_D * Math.tan(TILT), CAM_D);
  camera.lookAt(focus);
  camera.updateMatrixWorld();
}
placeCamera();

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);
resize();

// Lighting: warm low sunset sun with soft shadows on the wall, plus ambient fill.
scene.add(new THREE.HemisphereLight('#ffe2c4', '#5a4a6a', 1.3));
const sun = new THREE.DirectionalLight('#ffb27a', 2.4);
const SUN_OFFSET = new THREE.Vector3(-700, 550, 650);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -900, right: 900, top: 900, bottom: -900, near: 10, far: 3000 });
sun.shadow.bias = -0.0005;
sun.shadow.radius = 4;
scene.add(sun, sun.target);

const matCache = {};
const mat = (color) => (matCache[color] ??= new THREE.MeshStandardMaterial({ color, roughness: 0.9 }));
// Matter y points down, Three y points up.
function rect(x, y, w, h, color, z = 0, parent = scene) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat(color));
  m.position.set(x, -y, z);
  parent.add(m);
  return m;
}
// A box whose front face sits at zFront and extends `d` back from it.
function box(x, y, w, h, d, color, zFront = 0, { cast = false, receive = true } = {}) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  m.position.set(x, -y, zFront - d / 2);
  m.castShadow = cast; m.receiveShadow = receive;
  scene.add(m);
  return m;
}

function textSprite(text, w, h, bg, fg) {
  const c = document.createElement('canvas');
  c.width = w * 2; c.height = h * 2;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = fg; g.font = `bold ${h * 1.2}px system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
}

// ---------- Static scenery ----------
const level = generateLevel();

const WALL_Z = -22;   // building face, right behind the climber

// Far skyline: simple 3D blocks (plus the building model once loaded). Perspective gives the parallax.
const skyline = [];
for (let i = 0; i < 26; i++) {
  const r = (n) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
  const z = -1800 - r(1) * 3500, w = 300 + r(2) * 400, h = 1200 + r(3) * 4200;
  const x = (i - 13) * 520 + r(4) * 200;
  if (z > -2600 && Math.abs(x) < 900) continue;
  skyline.push({ x, z, w, h });
  box(x, -h / 2, w, h, w, ['#6b5a7e', '#7a6283', '#5d5674'][i % 3], z + w / 2, { receive: false });
}
// Ground: street plane reaching into the distance, plus a sidewalk strip in front of the building.
const ground = new THREE.Mesh(new THREE.PlaneGeometry(30000, 12000), mat('#4d4a55'));
ground.rotation.x = -Math.PI / 2; ground.position.set(0, -1, -5000); ground.receiveShadow = true; scene.add(ground);
box(0, 4, 30000, 8, 400, '#a59e98', 300);
// Building: the Meshy building model, stacked 3x up the 60 m wall (lower copies clipped below their roofs).
renderer.localClippingEnabled = true;
const BLD_FACADE = 0.72;      // fraction of the model's height below its roofline
box(0, ROOF_Y - 8, BUILDING_HALF_W * 2 + 30, 16, 300, '#7a3f2c', WALL_Z + 15);
// Front entrance
box(0, -70, 120, 140, 6, '#5a3a22', WALL_Z + 2);
box(0, -150, 140, 20, 10, '#e8e1d0', WALL_Z + 6);
const entrance = textSprite('APARTMENTS', 140, 18, '#e8e1d0', '#7a3f2c');
entrance.position.set(0, 150, WALL_Z + 6.5); scene.add(entrance);

// Penthouse + door on the roof
const { door } = level;
box(door.x, ROOF_Y - 100, 280, 200, 300, '#efe6d2', -2, { cast: true });
box(door.x, door.y, door.w, door.h, 4, '#6b3e1f', 1);
box(door.x + 26, door.y, 10, 10, 4, '#ffd23f', 3);
const sign = textSprite('PENTHOUSE', 160, 26, '#2b2b2b', '#ffd23f');
sign.position.set(door.x, -(door.y - door.h / 2 - 28), 2); scene.add(sign);

// Holds stick out of the wall up to the play plane (z = 0) and cast shadows on it.
const HOLD_COLORS = { sill: '#f2efe8', ledge: '#c9c3b5', pipe: '#4a5a4f', railing: '#3a3a3a' };
for (const h of level.holds) {
  box(h.x, h.y, h.w, h.h, h.type === 'pipe' ? 12 : -WALL_Z, HOLD_COLORS[h.type], h.type === 'pipe' ? WALL_Z + 12 : 0, { cast: true });
  if (h.type === 'railing') {
    for (let x = -BUILDING_HALF_W; x <= BUILDING_HALF_W; x += 40) box(x, ROOF_Y - 20, 4, 40, 4, '#3a3a3a', 0, { cast: true });
  }
}

// ---------- GLB models (Meshy) ----------
const loader = new GLTFLoader();
const mixers = [];
const models = {};
const asset = (f) => `${import.meta.env.BASE_URL}assets/${f}`;
// Scale a model so its height is `h` px, feet at its origin, centred in x/z.
function fitModel(obj, h, shadows = true) {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj), size = b.getSize(new THREE.Vector3());
  const s = h / size.y;
  obj.scale.multiplyScalar(s);
  const c = b.getCenter(new THREE.Vector3());
  obj.position.set(-c.x * s, -b.min.y * s, -c.z * s);
  const wrap = new THREE.Group();
  wrap.add(obj);
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = shadows; if (o.isSkinnedMesh) o.frustumCulled = false; } });
  return wrap;
}
function animate(root, clips, name, timeScale = 1) {
  const mixer = new THREE.AnimationMixer(root);
  const clip = clips.find((c) => c.name === name) || clips[0];
  if (clip) mixer.clipAction(clip).setEffectiveTimeScale(timeScale).play();
  mixers.push(mixer);
  return mixer;
}
loader.load(asset('building.glb'), (g) => {
  const bb = new THREE.Box3().setFromObject(g.scene), size = bb.getSize(new THREE.Vector3());
  const COPIES = 3, seg = BUILDING_HEIGHT / COPIES, sy = seg / BLD_FACADE / size.y, sx = (BUILDING_HALF_W * 2 + 20) / size.x;
  for (let i = 0; i < COPIES; i++) {
    const m = g.scene.clone(true);
    m.scale.set(sx, sy, sx);
    m.position.set(-(bb.min.x + size.x / 2) * sx, i * seg - bb.min.y * sy, WALL_Z - bb.max.z * sx);
    const clip = i < COPIES - 1 ? [new THREE.Plane(new THREE.Vector3(0, -1, 0), (i + 1) * seg)] : null;
    m.traverse((o) => {
      if (!o.isMesh) return;
      o.receiveShadow = true;
      if (clip) { o.material = o.material.clone(); o.material.clippingPlanes = clip; }
    });
    scene.add(m);
    if (i > 0) box(0, -i * seg, BUILDING_HALF_W * 2 + 24, 22, 40, '#8a4a38', WALL_Z + 6);  // band hides the seam
  }
  for (const s of skyline.filter((s) => s.z < -2400).slice(0, 4)) {
    const m = fitModel(g.scene.clone(), Math.min(2600, s.h * 0.7), false);
    m.position.set(s.x + s.w * 0.6, 0, s.z - 400);
    scene.add(m);
  }
}, undefined, () => {});
// The climber: Meshy character playing its full climbing animation, carried by the ragdoll.
// Only the arm bones are re-aimed each frame so the model's hands follow the physics hands.
loader.load(asset('climber_hang.glb'), (g) => {
  const wrap = fitModel(g.scene, CHAR_H);
  g.scene.rotation.y = Math.PI;  // face the wall, back to the camera
  g.scene.position.x *= -1; g.scene.position.z *= -1;
  animate(g.scene, g.animations, 'Grab_Wall_Midair_Idle');
  const b = (n) => g.scene.getObjectByName(n);
  models.climber = { wrap, head: b('Head'), arms: { left: [b('LeftArm'), b('LeftForeArm'), b('LeftHand')], right: [b('RightArm'), b('RightForeArm'), b('RightHand')] } };
  scene.add(wrap); syncModels();
}, undefined, () => {});
loader.load(asset('character.glb'), (g) => {
  const cust = fitModel(cloneSkinned(g.scene), 150);
  cust.position.set(door.x + 90, -ROOF_Y, -40);
  cust.rotation.y = -0.4;
  animate(cust.children[0], g.animations, 'Walking', 0.15);
  models.customer = cust; scene.add(cust);
  syncModels();
}, undefined, () => {});
// Show the animated character where physics isn't in control (title / delivered).
function syncModels() {
  for (const { body, mesh } of meshes) mesh.visible = !models.climber || body.kind === 'pizza' || body.kind === 'hand';
}

const _a = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3();
const _q = new THREE.Quaternion(), _wq = new THREE.Quaternion(), _pq = new THREE.Quaternion();
// Rotate `bone` (in world space) so the direction to `child` points at (tx, ty) on the bone's own depth.
function aimBone(bone, child, tx, ty) {
  bone.getWorldPosition(_a); child.getWorldPosition(_c);
  _c.sub(_a); _c.z = 0;
  _t.set(tx - _a.x, ty - _a.y, 0);
  if (_c.lengthSq() < 1e-6 || _t.lengthSq() < 1e-6) return;
  _q.setFromUnitVectors(_c.normalize(), _t.normalize());
  bone.getWorldQuaternion(_wq);
  bone.parent.getWorldQuaternion(_pq);
  bone.quaternion.copy(_pq.invert().multiply(_q.multiply(_wq)));
  bone.updateMatrixWorld(true);
}
function updateClimberModel() {
  const c = models.climber;
  if (!c) return;
  const { torso, head } = climber;
  c.wrap.position.set(torso.position.x, -torso.position.y, MODEL_Z);
  c.wrap.rotation.z = -torso.angle;
  c.wrap.updateMatrixWorld(true);
  c.head.getWorldPosition(_a);
  c.wrap.position.x += head.position.x - _a.x;
  c.wrap.position.y += -head.position.y - HEAD_DROP - _a.y;
  c.wrap.updateMatrixWorld(true);
  for (const side of ['left', 'right']) {
    const [upper, lower, hand] = climber.arms[side];
    const [sh, el, wr] = c.arms[side];
    if (!sh || !el || !wr) continue;
    const ex = (upper.position.x + lower.position.x) / 2, ey = (upper.position.y + lower.position.y) / 2;
    aimBone(sh, el, ex, -ey);
    aimBone(el, wr, hand.position.x, -hand.position.y);
  }
}

// ---------- UI ----------
const $ = (id) => document.getElementById(id);
const overlay = $('overlay');
const overlayContent = $('overlay-content');
const hud = $('hud');
const help = $('help');
let best = parseFloat(localStorage.getItem('tfd-best') || '0');
$('hud-best').textContent = best.toFixed(1);

function showOverlay(html) {
  overlayContent.innerHTML = html;
  overlay.classList.remove('hidden');
}
const fmtTime = (ms) => {
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};
function starsFor(ms) {
  const s = ms / 1000;
  return s <= 90 ? 5 : s <= 150 ? 4 : s <= 240 ? 3 : s <= 360 ? 2 : 1;
}
const RATING_TEXT = ['', '"Cold. Soggy. Never again."', '"Took forever, but I guess it\'s pizza."', '"Decent. A bit lukewarm."', '"Hot and fresh! Nice climbing."', '"WOW. Still steaming! Keep the change!"'];

// ---------- Game state ----------
let engine, climber, pizza, meshes = [];
let state = 'title';
let grips = { left: null, right: null };
let held = { left: false, right: false };
let mouse = { x: window.innerWidth / 2, y: window.innerHeight / 3 };
let gripChangeT = 0, elapsed = 0, fallTimer = 0, fallPlayed = false, ruinTimer = 0, musicStarted = false;

// Ragdoll visuals use the character model's colours (red jersey, dark trousers/gloves, white cap).
const HAND_COLOR = '#3a3a3e', GRIP_COLOR = '#ffd23f';
const CHAR_H = 165, HEAD_DROP = 8, MODEL_Z = 34;
function bodyMesh(body) {
  const w = body.bounds.max.x - body.bounds.min.x, h = body.bounds.max.y - body.bounds.min.y;
  const colors = { torso: '#c8102e', head: '#e8b48f', arm: w >= 10 ? '#c8102e' : '#e8b48f', hand: HAND_COLOR, leg: '#2b2b30', shoe: '#1d1d22', pizza: '#c8a165' };
  const color = colors[body.kind] || '#ff00ff';
  const depth = { torso: 26, pizza: 54, leg: 14, shoe: 13, arm: 10 }[body.kind] || 12;
  const z = { pizza: 14, torso: 10, head: 12 }[body.kind] || 16;
  let geo;
  if (body.circleRadius) geo = new THREE.SphereGeometry(body.circleRadius, 12, 8);
  else if (body.kind === 'head') geo = new THREE.SphereGeometry(w / 2 + 1, 16, 12);
  else geo = new THREE.BoxGeometry(w, h, depth);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
  m.castShadow = true;
  m.position.z = z;
  if (body.kind === 'pizza') {
    m.add(rect(0, 0, w + 0.5, 3, '#b8311f', depth / 2 + 0.3, m));
  }
  if (body.kind === 'head') {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(w / 2 + 2, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat('#f2f2f2'));
    cap.position.y = 2; m.add(cap);
    const brim = new THREE.Mesh(new THREE.BoxGeometry(14, 3, 20), mat('#c8102e'));
    brim.position.set(10, 3, 0); m.add(brim);
  }
  scene.add(m);
  return { body, mesh: m };
}

function reset(start = level.holds[0]) {
  for (const { mesh } of meshes) scene.remove(mesh);
  engine = Engine.create();
  engine.positionIterations = 10;
  engine.constraintIterations = 6;
  const world = engine.world;
  Composite.add(world, Bodies.rectangle(0, 50, 20000, 100, {
    isStatic: true, friction: 1, collisionFilter: { category: CAT.WORLD, mask: 0xffff },
  }));
  climber = createClimber(world, start.x, start.y + 82);
  pizza = createPizza(world, climber.head);
  meshes = [...climber.bodies, pizza].map(bodyMesh);
  grips = { left: null, right: null };
  held = { left: true, right: true };   // start hanging; first release lets go
  tryGrip('left', true); tryGrip('right', true);
  elapsed = 0; fallTimer = 0; fallPlayed = false; ruinTimer = 0; gripChangeT = 0;
  focus.y = -start.y;
  syncModels();
}

function startGame() {
  reset();
  state = 'playing';
  overlay.classList.add('hidden');
  hud.classList.remove('hidden');
  help.classList.remove('hidden');
  if (!musicStarted) { play('music'); play('voice'); musicStarted = true; }
  syncModels();
}

function tryGrip(side, silent = false) {
  const hand = climber.hands[side];
  const { x, y } = hand.position;
  const pad = climber.handRadius + GRAB_PAD;
  for (const h of level.holds) {
    if (Math.abs(x - h.x) <= h.w / 2 + pad && Math.abs(y - h.y) <= h.h / 2 + pad) {
      const px = Math.max(h.x - h.w / 2, Math.min(h.x + h.w / 2, x));
      const py = Math.max(h.y - h.h / 2, Math.min(h.y + h.h / 2, y));
      grips[side] = Constraint.create({ bodyA: hand, pointB: { x: px, y: py }, length: 0, stiffness: 0.7, damping: 0.1 });
      Composite.add(engine.world, grips[side]);
      if (!silent) play('grab');
      return;
    }
  }
}

function release(side) {
  if (!grips[side]) return;
  Composite.remove(engine.world, grips[side]);
  grips[side] = null;
}

// Cursor -> point on the z = 0 gameplay plane.
const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), hit = new THREE.Vector3();
const PLAY_PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
function mouseWorld() {
  ndc.set((mouse.x / window.innerWidth) * 2 - 1, -(mouse.y / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  if (!raycaster.ray.intersectPlane(PLAY_PLANE, hit)) return { x: focus.x, y: -focus.y };
  return { x: hit.x, y: -hit.y };
}

function pull(body, tx, ty, k, max, mass, dampX = 0, dampY = dampX) {
  const dx = tx - body.position.x, dy = ty - body.position.y;
  const d = Math.max(1, Math.hypot(dx, dy));
  const mag = Math.min(d * k, max) * mass;
  Body.applyForce(body, body.position, {
    x: (dx / d) * mag - body.velocity.x * dampX * mass,
    y: (dy / d) * mag - body.velocity.y * dampY * mass,
  });
}

function step() {
  const { torso, head, hands } = climber;
  if (state === 'playing') {
    for (const side of ['left', 'right']) {
      if (held[side] && !grips[side]) { tryGrip(side); if (grips[side]) gripChangeT = 0; }
      if (!held[side] && grips[side]) { release(side); gripChangeT = 0; }
    }
    gripChangeT += STEP;
    const m = mouseWorld();
    for (const [side, off] of [['left', -10], ['right', 10]]) {
      if (!grips[side]) pull(hands[side], m.x + off, m.y, HAND_K, HAND_MAX, climber.armMass(side), HAND_DAMP);
    }
    const anchors = [grips.left, grips.right].filter(Boolean).map((g) => g.pointB.y);
    if (anchors.length) {
      // Pull-up strength fades as the torso rises to the grip, so you can't vault over it.
      const top = Math.min(...anchors);
      const below = torso.position.y - top;
      // Only pull up when the cursor is above the grip; otherwise just hang and swing.
      const ty = m.y < top ? m.y : torso.position.y;
      const k = Math.max(0, Math.min(1, below / 45)) * Math.min(1, gripChangeT / PULL_RAMP);
      pull(torso, m.x, ty, BODY_K, BODY_MAX * k, climber.totalMass, BODY_DAMP_X, BODY_DAMP_Y);
      if (torso.velocity.y < -MAX_RISE) Body.setVelocity(torso, { x: torso.velocity.x, y: -MAX_RISE });
    }
    elapsed += STEP;
  }
  // Keep the head (and pizza) roughly level, and the torso from spinning wildly.
  Body.setAngle(head, head.angle * 0.85);
  Body.setAngularVelocity(head, head.angularVelocity * 0.7);
  Body.setAngularVelocity(torso, torso.angularVelocity * 0.98 - torso.angle * 0.004);

  // A little "balance": the pizza is gently nudged back toward the middle of the head while resting on it.
  const pdx = pizza.position.x - head.position.x, pdy = pizza.position.y - head.position.y;
  if (pdy < -8 && pdy > -30 && Math.abs(pdx) < 32) {
    const rvx = pizza.velocity.x - head.velocity.x;
    Body.applyForce(pizza, pizza.position, { x: (-pdx * 0.00005 - rvx * 0.0004) * pizza.mass, y: 0 });
  }

  Engine.update(engine, STEP);

  if (state === 'playing') {
    const falling = !grips.left && !grips.right && torso.velocity.y > 2;
    fallTimer = falling ? fallTimer + STEP : 0;
    if (fallTimer > 1000 && !fallPlayed) { play('fall'); fallPlayed = true; }
    if (grips.left || grips.right) fallPlayed = false;

    const height = Math.max(0, -head.position.y / SCALE);
    if (height > best) best = height;

    const dx = pizza.position.x - head.position.x;
    if ((pizza.position.y > head.position.y + 12 || Math.abs(dx) > 70) && !window.__tfdNoRuin) return ruin();

    if (Math.abs(head.position.x - door.x) < door.w / 2 + 70 && head.position.y < ROOF_Y + 60) return deliver();
  } else if (state === 'ruined') {
    ruinTimer += STEP;
    if (ruinTimer > 2200) startGame();
  }
}

function saveBest() { localStorage.setItem('tfd-best', best.toFixed(1)); }

function ruin() {
  state = 'ruined';
  release('left'); release('right');
  play('ruined');
  saveBest();
  syncModels();
  showOverlay('<h1>PIZZA RUINED!</h1><p class="big">The customer is not going to tip for that.</p><p class="sub">Restarting…</p>');
}

function deliver() {
  state = 'delivered';
  best = Math.max(best, BUILDING_HEIGHT / SCALE);
  saveBest();
  const stars = starsFor(elapsed);
  syncModels();
  showOverlay(`<h1>DELIVERED!</h1>
    <p class="big">Time: <b>${fmtTime(elapsed)}</b></p>
    <div class="stars">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</div>
    <p class="big">${RATING_TEXT[stars]}</p>
    <p class="blink">Click or press R to deliver again</p>`);
}

// ---------- Input ----------
const SIDE = { 0: 'left', 2: 'right' };
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
window.addEventListener('mousedown', (e) => { if (state === 'playing' && SIDE[e.button]) held[SIDE[e.button]] = true; });
window.addEventListener('mouseup', (e) => { if (state === 'playing' && SIDE[e.button]) held[SIDE[e.button]] = false; });
overlay.addEventListener('click', () => { if (state === 'title' || state === 'delivered') startGame(); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') { if (state !== 'title') { saveBest(); startGame(); } }
});
window.addEventListener('beforeunload', saveBest);

// ---------- Loop ----------
reset();
let last = performance.now(), acc = 0;
const clock = new THREE.Clock();
function frame(now) {
  acc += Math.min(now - last, 100);
  last = now;
  if (state !== 'title') {
    while (acc >= STEP) { step(); acc -= STEP; }
  } else acc = 0;

  for (const { body, mesh } of meshes) {
    mesh.position.x = body.position.x;
    mesh.position.y = -body.position.y;
    mesh.rotation.z = -body.angle;
  }
  for (const side of ['left', 'right']) {
    const m = meshes.find((o) => o.body === climber.hands[side]);
    m.mesh.material.color.set(grips[side] ? GRIP_COLOR : HAND_COLOR);
  }

  const t = climber.torso.position;
  const targetY = Math.max(-t.y + 60, VIEW_H / 2 - 120);
  focus.y += (targetY - focus.y) * 0.08;
  focus.x += (t.x * 0.6 - focus.x) * 0.05;
  placeCamera();
  sun.target.position.copy(focus);
  sun.position.copy(focus).add(SUN_OFFSET);
  const dt = clock.getDelta();
  for (const mx of mixers) mx.update(dt);
  updateClimberModel();

  $('hud-height').textContent = Math.max(0, -climber.head.position.y / SCALE).toFixed(1);
  $('hud-time').textContent = fmtTime(elapsed);
  $('hud-best').textContent = best.toFixed(1);

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

if (import.meta.env.DEV) {
  window.__tfd = { get state() { return state; }, get climber() { return climber; }, get pizza() { return pizza; }, get grips() { return grips; }, level, mouseWorld, startAt: (i) => { reset(typeof i === 'number' ? level.holds[i] : i); state = 'playing'; overlay.classList.add('hidden'); },
    worldToScreen: (x, y) => { const v = new THREE.Vector3(x, -y, 0).project(camera); return { x: (v.x + 1) / 2 * window.innerWidth, y: (1 - v.y) / 2 * window.innerHeight }; } };
}
