// World units are pixels in Matter.js space (y points DOWN). 80 px = 1 m.
export const SCALE = 80;
export const BUILDING_HEIGHT = 60 * SCALE;
export const ROOF_Y = -BUILDING_HEIGHT;
export const BUILDING_HALF_W = 520;
export const FLOOR_H = 3 * SCALE;
export const START_HOLD_Y = -220;
// x of the green drainpipes on the building model, so pipe holds sit on them.
export const BUILDING_PIPES_X = [-111, 205];

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;

// Holds are axis-aligned rects {x, y, w, h, type} centred on (x, y).
export function generateLevel(seed = 7) {
  const rnd = mulberry32(seed);
  const holds = [];
  const maxX = BUILDING_HALF_W - 70;

  // Entrance awning to start from.
  holds.push({ type: 'ledge', x: 0, y: START_HOLD_Y, w: 300, h: 16 });

  let x = 0;
  let y = START_HOLD_Y;
  while (y > ROOF_Y + 80) {
    const t = Math.min(1, -y / BUILDING_HEIGHT);
    y -= lerp(50, 72, t) + rnd() * lerp(5, 10, t);
    const dir = rnd() < 0.5 ? -1 : 1;
    x += dir * lerp(20, 110, t) * (0.5 + rnd() * 0.5);
    if (x > maxX) x = 2 * maxX - x;
    if (x < -maxX) x = -2 * maxX - x;

    const r = rnd();
    const pipeX = BUILDING_PIPES_X.reduce((p, q) => (Math.abs(q - x) < Math.abs(p - x) ? q : p));
    if (r < lerp(0.3, 0.12, t) && Math.abs(pipeX - x) < 60) {
      const h = lerp(190, 90, t);
      holds.push({ type: 'pipe', x: pipeX, y: y + h / 2 - 10, w: 12, h });
    } else if (r < lerp(0.3, 0.12, t)) {
      holds.push({ type: 'ledge', x, y: y - 10, w: lerp(200, 110, t), h: 16 });
    } else if (r < lerp(0.5, 0.2, t)) {
      holds.push({ type: 'ledge', x, y, w: lerp(320, 160, t), h: 16 });
    } else {
      holds.push({ type: 'sill', x, y, w: lerp(130, 56, t), h: 12 });
    }

    // Occasional decoy / alternative sill off to the side.
    if (rnd() < lerp(0.6, 0.3, t)) {
      let dx = x + (rnd() < 0.5 ? -1 : 1) * (150 + rnd() * 200);
      dx = Math.max(-maxX, Math.min(maxX, dx));
      holds.push({ type: 'sill', x: dx, y: y + (rnd() - 0.5) * 60, w: lerp(110, 60, t), h: 12 });
    }
  }

  // Roof railing running along the top of the building.
  holds.push({ type: 'railing', x: 0, y: ROOF_Y - 40, w: BUILDING_HALF_W * 2, h: 10 });

  const doorX = Math.max(-maxX + 60, Math.min(maxX - 60, x + (rnd() < 0.5 ? -1 : 1) * 160));
  const door = { x: doorX, y: ROOF_Y - 70, w: 80, h: 140 };
  return { holds, door };
}
