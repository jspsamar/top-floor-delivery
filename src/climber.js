import Matter from 'matter-js';

const { Bodies, Body, Constraint, Composite } = Matter;

export const CAT = { WORLD: 0x0001, LIMB: 0x0002, PIZZA: 0x0004, HEAD: 0x0008 };

const TW = 26, TH = 52;          // torso
const UA = 32, LA = 30, HR = 7;  // upper arm, lower arm, hand radius
const UL = 34, LL = 34;          // upper leg, lower leg

// Builds the ragdoll with the torso centred at (x, y), arms raised.
export function createClimber(world, x, y) {
  const group = Body.nextGroup(true);
  const limbFilter = { group, category: CAT.LIMB, mask: CAT.WORLD };
  const headFilter = { group, category: CAT.HEAD, mask: CAT.WORLD | CAT.PIZZA };
  const base = { frictionAir: 0.03, friction: 0.8, density: 0.002 };
  const bodies = [];
  const constraints = [];
  const add = (b, kind) => { b.kind = kind; bodies.push(b); return b; };
  const pin = (bodyA, pointA, bodyB, pointB, stiffness = 1) => {
    constraints.push(Constraint.create({ bodyA, pointA, bodyB, pointB, length: 0, stiffness, damping: 0.05 }));
  };

  const torso = add(Bodies.rectangle(x, y, TW, TH, { ...base, density: 0.003, chamfer: { radius: 6 }, collisionFilter: headFilter }), 'torso');
  const head = add(Bodies.rectangle(x, y - TH / 2 - 14, 24, 24, {
    ...base, friction: 1, frictionStatic: 3, chamfer: { radius: 7 }, collisionFilter: headFilter,
  }), 'head');
  pin(torso, { x: 0, y: -TH / 2 }, head, { x: 0, y: 14 });

  const hands = {};
  const arms = {};
  for (const [side, s] of [['left', -1], ['right', 1]]) {
    const sx = x + s * (TW / 2 - 2), sy = y - TH / 2 + 6;
    const upper = add(Bodies.rectangle(sx, sy - UA / 2, 10, UA, { ...base, collisionFilter: limbFilter }), 'arm');
    const lower = add(Bodies.rectangle(sx, sy - UA - LA / 2, 9, LA, { ...base, collisionFilter: limbFilter }), 'arm');
    const hand = add(Bodies.circle(sx, sy - UA - LA, HR, { ...base, collisionFilter: limbFilter }), 'hand');
    pin(torso, { x: s * (TW / 2 - 2), y: -TH / 2 + 6 }, upper, { x: 0, y: UA / 2 });
    pin(upper, { x: 0, y: -UA / 2 }, lower, { x: 0, y: LA / 2 });
    pin(lower, { x: 0, y: -LA / 2 }, hand, { x: 0, y: 0 });
    hands[side] = hand;
    arms[side] = [upper, lower, hand];

    const hx = x + s * 7, hy = y + TH / 2 - 4;
    const thigh = add(Bodies.rectangle(hx, hy + UL / 2, 12, UL, { ...base, collisionFilter: limbFilter }), 'leg');
    const shin = add(Bodies.rectangle(hx, hy + UL + LL / 2, 11, LL, { ...base, collisionFilter: limbFilter }), 'shoe');
    pin(torso, { x: s * 7, y: TH / 2 - 4 }, thigh, { x: 0, y: -UL / 2 });
    pin(thigh, { x: 0, y: UL / 2 }, shin, { x: 0, y: -LL / 2 });
  }

  Composite.add(world, [...bodies, ...constraints]);
  const totalMass = bodies.reduce((m, b) => m + b.mass, 0);
  const armMass = (side) => arms[side].reduce((m, b) => m + b.mass, 0);
  return { torso, head, hands, arms, bodies, totalMass, armMass, handRadius: HR };
}

export function createPizza(world, head) {
  const pizza = Bodies.rectangle(head.position.x, head.position.y - 12 - 5, 50, 9, {
    friction: 1, frictionStatic: 3, frictionAir: 0.01, density: 0.0008, chamfer: { radius: 2 },
    collisionFilter: { category: CAT.PIZZA, mask: CAT.HEAD | CAT.WORLD },
  });
  pizza.kind = 'pizza';
  Composite.add(world, pizza);
  return pizza;
}
