import * as THREE from 'three';
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
loadSound('music', { loop: true, volume: 0.4 });

// ---------- Three.js setup ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#8ec5ff');
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 100);
camera.position.set(0, -START_HOLD_Y, 50);

function resize() {
  const aspect = window.innerWidth / window.innerHeight;
  camera.left = (-VIEW_H * aspect) / 2;
  camera.right = (VIEW_H * aspect) / 2;
  camera.top = VIEW_H / 2;
  camera.bottom = -VIEW_H / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);
resize();

const matCache = {};
const mat = (color) => (matCache[color] ??= new THREE.MeshBasicMaterial({ color }));
// Matter y points down, Three y points up.
function rect(x, y, w, h, color, z = 0, parent = scene) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat(color));
  m.position.set(x, -y, z);
  parent.add(m);
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

// Background skyline
for (let i = -6; i <= 6; i++) {
  if (Math.abs(i) < 2) continue;
  const h = 800 + ((i * 7919) % 5 + 5) % 5 * 500;
  rect(i * 330, -h / 2, 300, h, '#6f9cc9', -5);
}
rect(0, 400, 20000, 800, '#5b5b5b', -4);            // street
rect(0, 30, 20000, 60, '#9a9a9a', -3);              // sidewalk
// Building facade
rect(0, -BUILDING_HEIGHT / 2, BUILDING_HALF_W * 2, BUILDING_HEIGHT, '#b5654a', -2);
rect(0, ROOF_Y - 8, BUILDING_HALF_W * 2 + 30, 16, '#7a3f2c', -1);
for (let f = 0; f < BUILDING_HEIGHT / FLOOR_H; f++) {
  const fy = -f * FLOOR_H;
  rect(0, fy - 4, BUILDING_HALF_W * 2, 8, '#9c5340', -1.5);
  if (f === 0) continue;
  for (let c = -2; c <= 2; c++) {
    rect(c * 200, fy - FLOOR_H / 2 - 10, 96, 126, '#e8e1d0', -1.4);
    rect(c * 200, fy - FLOOR_H / 2 - 10, 84, 114, (f + c) % 3 ? '#2d4a6b' : '#f3d27a', -1.3);
  }
}
// Front entrance
rect(0, -70, 120, 140, '#5a3a22', -1);
rect(0, -150, 140, 20, '#e8e1d0', -1);
const entrance = textSprite('APARTMENTS', 140, 18, '#e8e1d0', '#7a3f2c');
entrance.position.set(0, 150, -0.9); scene.add(entrance);

// Penthouse + door on the roof
const { door } = level;
rect(door.x, ROOF_Y - 100, 280, 200, '#efe6d2', -1);
rect(door.x, door.y, door.w, door.h, '#6b3e1f', 1);
rect(door.x + 26, door.y, 10, 10, '#ffd23f', 1.1);
const sign = textSprite('PENTHOUSE', 160, 26, '#2b2b2b', '#ffd23f');
sign.position.set(door.x, -(door.y - door.h / 2 - 28), 1.1); scene.add(sign);

const HOLD_COLORS = { sill: '#f2efe8', ledge: '#c9c3b5', pipe: '#4a5a4f', railing: '#3a3a3a' };
for (const h of level.holds) {
  rect(h.x, h.y, h.w, h.h, HOLD_COLORS[h.type], 2);
  if (h.type === 'railing') {
    for (let x = -BUILDING_HALF_W; x <= BUILDING_HALF_W; x += 40) rect(x, ROOF_Y - 20, 4, 40, '#3a3a3a', 2);
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

function bodyMesh(body) {
  const colors = { torso: '#d6322b', head: '#f2c79a', arm: '#f2c79a', hand: '#f2c79a', leg: '#2a4d8f', shoe: '#22355e', pizza: '#c8a165' };
  const color = colors[body.kind] || '#ff00ff';
  const z = body.kind === 'pizza' ? 6 : body.kind === 'torso' ? 5 : body.kind === 'head' ? 5.5 : 4;
  let geo;
  if (body.circleRadius) geo = new THREE.CircleGeometry(body.circleRadius, 16);
  else geo = new THREE.PlaneGeometry(body.bounds.max.x - body.bounds.min.x, body.bounds.max.y - body.bounds.min.y);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
  m.position.z = z;
  if (body.kind === 'pizza') {
    m.add(rect(0, 0, 50, 3, '#b8311f', 0.1, m));
  }
  if (body.kind === 'head') {
    m.add(rect(0, -9, 26, 8, '#d6322b', 0.1, m));  // cap
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
  camera.position.y = -start.y;
}

function startGame() {
  reset();
  state = 'playing';
  overlay.classList.add('hidden');
  hud.classList.remove('hidden');
  help.classList.remove('hidden');
  if (!musicStarted) { play('music'); musicStarted = true; }
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

function mouseWorld() {
  const x = camera.position.x + camera.left + (mouse.x / window.innerWidth) * (camera.right - camera.left);
  const y = camera.position.y + camera.top - (mouse.y / window.innerHeight) * (camera.top - camera.bottom);
  return { x, y: -y };
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
  showOverlay('<h1>PIZZA RUINED!</h1><p class="big">The customer is not going to tip for that.</p><p class="sub">Restarting…</p>');
}

function deliver() {
  state = 'delivered';
  best = Math.max(best, BUILDING_HEIGHT / SCALE);
  saveBest();
  const stars = starsFor(elapsed);
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
    m.mesh.material.color.set(grips[side] ? '#ffd23f' : '#f2c79a');
  }

  const t = climber.torso.position;
  const targetY = Math.max(-t.y + 60, VIEW_H / 2 - 120);
  camera.position.y += (targetY - camera.position.y) * 0.08;
  camera.position.x += (t.x * 0.6 - camera.position.x) * 0.05;

  $('hud-height').textContent = Math.max(0, -climber.head.position.y / SCALE).toFixed(1);
  $('hud-time').textContent = fmtTime(elapsed);
  $('hud-best').textContent = best.toFixed(1);

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

if (import.meta.env.DEV) {
  window.__tfd = { get state() { return state; }, get climber() { return climber; }, get pizza() { return pizza; }, get grips() { return grips; }, level, mouseWorld, startAt: (i) => { reset(typeof i === 'number' ? level.holds[i] : i); state = 'playing'; overlay.classList.add('hidden'); },
    worldToScreen: (x, y) => ({ x: ((x - camera.position.x - camera.left) / (camera.right - camera.left)) * window.innerWidth, y: ((camera.position.y + camera.top + y) / (camera.top - camera.bottom)) * window.innerHeight }) };
}
