// A `.yparticle` as the game runs it, tick by tick: the game's client
// particle (`Particle`, `SingleQuadParticle`) and Yog's on top of it
// (`YogParticle` on every host) — so the designer's preview moves, fades
// and changes frames exactly as the game will.

/** A `.yparticle` with every default filled in (`format.complete`). */
export interface ParticleLook {
  textures: string[];
  frames: "random" | "age";
  frame_speed: number;
  frame_settle: boolean;
  lifetime: { min: number; max: number };
  size: number;
  size_per_tick: number;
  alpha: number;
  fade: boolean;
  friction: number;
  gravity: number;
  gravity_needs_motion: boolean;
  physics: boolean;
  slide_when_blocked: boolean;
  random_roll: boolean;
  render: { blend: "opaque" | "translucent" | "additive"; depth_write: boolean; glow: boolean };
}

/** The game's particle, as its client makes and moves one. */
const GAME = {
  /** A spawn's motion gets up to this much added on each axis… */
  JITTER: 0.4,
  /** …then is scaled to a speed of (r + r + 1) × this × SPEED_SCALE… */
  SPEED_BASE: 0.15,
  SPEED_SCALE: 0.4,
  /** …and lifted by this. */
  LIFT: 0.1,
  /** Blocks a tick² a gravity of 1 pulls. */
  GRAVITY_SCALE: 0.04,
  /** Sideways speed kept on the ground, and gained when stopped rising or falling. */
  GROUND_FRICTION: 0.7,
  SLIDE: 1.1,
  /** A quad's half size: this × (r × QUAD_RANDOM + QUAD_RANDOM) × QUAD_SCALE blocks. */
  QUAD_BASE: 0.1,
  QUAD_RANDOM: 0.5,
  QUAD_SCALE: 2,
} as const;

const TURN = Math.PI * 2;
/** A colour channel's largest value. */
const CHANNEL = 255;

/** One particle alive in the preview. */
export interface Live {
  x: number;
  y: number;
  z: number;
  /** Where it was last tick (drawn in between). */
  xo: number;
  yo: number;
  zo: number;
  xd: number;
  yd: number;
  zd: number;
  age: number;
  lifetime: number;
  gravity: number;
  /** Half its quad's side, blocks. */
  quadSize: number;
  alpha: number;
  roll: number;
  /** Its picture: an index into the look's textures. */
  frame: number;
  rgb: [number, number, number];
  onGround: boolean;
  removed: boolean;
}

/** `0xRRGGBB` as channels 0–1. */
export function channels(color: number): [number, number, number] {
  return [((color >> 16) & 0xff) / CHANNEL, ((color >> 8) & 0xff) / CHANNEL, (color & 0xff) / CHANNEL];
}

/** The game's spawn motion: jittered, then scaled to its own speed and lifted. */
function spawnMotion([dx, dy, dz]: [number, number, number], random: () => number): [number, number, number] {
  const jitter = () => (random() * 2 - 1) * GAME.JITTER;
  const x = dx + jitter(), y = dy + jitter(), z = dz + jitter();
  const speed = (random() + random() + 1) * GAME.SPEED_BASE;
  const len = Math.hypot(x, y, z) || 1;
  const k = (speed * GAME.SPEED_SCALE) / len;
  return [x * k, y * k + GAME.LIFT, z * k];
}

/** A particle of `look` spawned at `at` moving by `motion`, in `color`. */
export function spawn(look: ParticleLook, at: [number, number, number], motion: [number, number, number], color: number, frames: number, random: () => number = Math.random): Live {
  const [xd, yd, zd] = spawnMotion(motion, random);
  const everyAxis = motion.every((m) => m !== 0);
  const { min, max } = look.lifetime;
  const p: Live = {
    x: at[0], y: at[1], z: at[2], xo: at[0], yo: at[1], zo: at[2], xd, yd, zd,
    age: 0,
    lifetime: min + Math.floor(random() * (Math.max(max - min, 0) + 1)),
    gravity: look.gravity_needs_motion && !everyAxis ? 0 : look.gravity,
    quadSize: GAME.QUAD_BASE * (random() * GAME.QUAD_RANDOM + GAME.QUAD_RANDOM) * GAME.QUAD_SCALE * look.size,
    alpha: look.alpha,
    roll: look.random_roll ? random() * TURN : 0,
    frame: look.frames === "random" ? Math.floor(random() * frames) : 0,
    rgb: channels(color),
    onGround: false,
    removed: false,
  };
  if (look.frames === "age") p.frame = frameAt(look, p, frames);
  return p;
}

/** The frame for `p`'s age: `frame_speed` times as fast as it lives; past its life the last, or (settling) its age's. */
export function frameAt(look: ParticleLook, p: Live, frames: number): number {
  let at = Math.floor(p.age * look.frame_speed);
  if (at > p.lifetime) at = look.frame_settle ? p.age : p.lifetime;
  return p.lifetime > 0 ? Math.floor((at * (frames - 1)) / p.lifetime) : 0;
}

/** Moves `p` by its motion; with physics, it stops on the ground at `floor`. */
function move(look: ParticleLook, p: Live, floor: number) {
  p.x += p.xd;
  p.z += p.zd;
  const y = p.y + p.yd;
  if (look.physics && y < floor) {
    p.y = floor;
    p.yd = 0;
    p.onGround = true;
  } else {
    p.y = y;
    p.onGround = false;
  }
}

/** One game tick of `p` (`Particle.tick`, then `YogParticle.tick`). */
export function tick(look: ParticleLook, p: Live, frames: number, floor: number) {
  p.xo = p.x;
  p.yo = p.y;
  p.zo = p.z;
  if (p.age++ >= p.lifetime) {
    p.removed = true;
    return;
  }
  p.yd -= GAME.GRAVITY_SCALE * p.gravity;
  move(look, p, floor);
  if (look.slide_when_blocked && p.y === p.yo) {
    p.xd *= GAME.SLIDE;
    p.zd *= GAME.SLIDE;
  }
  p.xd *= look.friction;
  p.yd *= look.friction;
  p.zd *= look.friction;
  if (p.onGround) {
    p.xd *= GAME.GROUND_FRICTION;
    p.zd *= GAME.GROUND_FRICTION;
  }
  if (look.frames === "age") p.frame = frameAt(look, p, frames);
  if (look.fade) p.alpha = look.alpha * (1 - p.age / p.lifetime);
  p.quadSize *= look.size_per_tick;
}
