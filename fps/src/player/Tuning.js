/**
 * ============================================================================
 *  PLAYER TUNING — every magic number the controller uses, in one place.
 * ============================================================================
 *  Units: metres, seconds, radians (unless a name says DEG).
 *
 *  Design notes that matter for feel:
 *
 *  · Ground acceleration uses the Quake formulation `accel * wishSpeed * dt`
 *    rather than a flat m/s². A flat accel with a constant friction pins the
 *    terminal speed at accel/friction (62/9.5 = 6.53 m/s) which makes the
 *    7.4 m/s tactical sprint physically unreachable. Scaling the accel by the
 *    requested speed keeps the *shape* of the ramp identical at every gait
 *    (~0.19 s to 90 %, ~0.29 s to 100 %) and lets every gait actually reach
 *    its number. GROUND_ACCEL below is the accel measured at sprint speed,
 *    i.e. exactly the 62 m/s² the design asks for; ACCEL_K is the derived
 *    Quake coefficient.
 *
 *  · Everything that decays uses an exact exponential (see Player._groundMove)
 *    so the trajectory is bit-comparable at 30 / 60 / 144 Hz.
 * ============================================================================
 */

const DEG = Math.PI / 180;

/* ---------------------------------------------------------------- body --- */
export const RADIUS = 0.32;          // ART_DIRECTION 4
export const STAND_HEIGHT = 1.80;
export const CROUCH_HEIGHT = 1.15;
export const EYE_STAND = 1.68;       // ART_DIRECTION 4
export const EYE_CROUCH = 1.05;      // ART_DIRECTION 4
export const EYE_LAMBDA = 15.0;      // eye-height smoothing (1/s)
export const STAND_CLEARANCE = 0.06; // slack required over STAND_HEIGHT to uncrouch

/* -------------------------------------------------------------- speeds --- */
export const WALK_SPEED = 3.4;
export const SPRINT_SPEED = 6.1;
export const TAC_SPRINT_SPEED = 7.4;
export const CROUCH_SPEED = 1.9;
export const ADS_SPEED = 2.2;
/** Directional falloff — you are slower sideways, slower still backwards. */
export const STRAFE_SPEED_MUL = 0.93;
export const BACK_SPEED_MUL = 0.86;

/* --------------------------------------------------------- acceleration --- */
export const GROUND_ACCEL = 62.0;                        // m/s², measured at SPRINT_SPEED
export const ACCEL_K = GROUND_ACCEL / SPRINT_SPEED;      // 10.164 /s  (Quake sv_accelerate)
export const FRICTION = 9.5;                             // 1/s
export const STOP_DECEL = 13.0;                          // m/s² constant brake with no input

/** Quake-style air control: projected accel with a hard cap on lateral gain. */
export const AIR_ACCEL_K = 13.0;         // /s  — how fast you can redirect
export const AIR_SPEED_CAP = 1.6;        // m/s — max speed gain along wishdir
export const AIR_SPEED_LIMIT_MUL = 1.30; // soft ceiling = targetSpeed * this
export const AIR_DRAG_OVER = 2.4;        // 1/s drag applied only above that ceiling

/* ---------------------------------------------------------- jump / grav --- */
export const GRAVITY = -21.0;            // game gravity, not 9.81
export const JUMP_APEX = 0.62;           // metres
/** Derived, never hardcoded: v = sqrt(2 g h). */
export const JUMP_VELOCITY = Math.sqrt(2 * Math.abs(GRAVITY) * JUMP_APEX); // 5.1029 m/s
export const COYOTE_TIME = 0.110;
export const JUMP_BUFFER = 0.140;
export const JUMP_LOCKOUT = 0.09;        // ignore `grounded` right after leaving the floor
export const GROUND_STICK = 2.0;         // downward bias that keeps you glued to slopes
export const LAND_HARD_SPEED = 4.0;      // impact speed that counts as a "hard" landing
export const FALL_DAMAGE_SPEED = 12.0;   // below this, falling never hurts
export const FALL_DAMAGE_PER_MS = 7.5;   // hp per m/s over the threshold

/* --------------------------------------------------------------- crouch --- */
export const CROUCH_TOGGLE = false;      // configurable: hold (false) or toggle (true)

/* ---------------------------------------------------------------- slide --- */
export const SLIDE_TIME = 0.65;
export const SLIDE_ENTRY_SPEED = 8.0;    // speed the boost snaps you to
export const SLIDE_MIN_ENTRY_SPEED = 4.6;
export const SLIDE_FRICTION = 2.0;       // 1/s — 8.0 -> ~2.2 m/s over 0.65 s
export const SLIDE_STEER_ACCEL = 5.5;    // m/s² of lateral steering authority
export const SLIDE_COOLDOWN = 0.55;
export const SLIDE_JUMP_KEEP = 0.88;     // horizontal speed retained cancelling into a jump
export const SLIDE_ROLL = 5.5 * DEG;
export const SLIDE_DIP = 0.14;

/* --------------------------------------------------------------- mantle --- */
export const MANTLE_TIME = 0.42;
export const MANTLE_MIN_H = 0.50;
export const MANTLE_MAX_H = 1.60;
export const MANTLE_REACH = 0.45;        // forward probe past the capsule surface
export const MANTLE_PROBE = 0.30;        // how far past the wall we look for the top
export const MANTLE_LAND_FWD = 0.34;     // how far onto the ledge we finish
export const MANTLE_CLEAR = 1.22;        // headroom required above the ledge
export const MANTLE_COOLDOWN = 0.30;
export const MANTLE_EXIT_SPEED = 1.8;
export const MANTLE_PITCH = 7.0 * DEG;   // camera arcs up over the lip
export const MANTLE_ROLL = 4.5 * DEG;    // hand-over-hand roll
export const MANTLE_SURGE = 0.055;       // forward camera push

/* ----------------------------------------------------------------- lean --- */
export const LEAN_ANGLE = 14.0 * DEG;
export const LEAN_OFFSET = 0.28;
export const LEAN_LAMBDA = 11.0;
export const LEAN_PROBE_PAD = 0.22;      // keep the eye this far off a wall

/* ------------------------------------------------------------- sprint UX --- */
export const TAC_DOUBLE_TAP = 0.30;      // double-tap window for tactical sprint
export const TAC_HOLD_TIME = 1.20;       // ...or just hold sprint this long
export const SPRINT_MIN_FWD = 0.45;      // forward stick needed to sprint

/* ---------------------------------------------------------------- look --- */
export const PITCH_LIMIT = 88.0 * DEG;

/* ------------------------------------------------------------ head bob --- */
/** Distance travelled per full figure-8 (= two footfalls). */
export const BOB_CYCLE_DIST = 3.40;
export const BOB_AMP_LAT = 0.018;        // ART_DIRECTION 7
export const BOB_AMP_VERT = 0.024;       // ART_DIRECTION 7
export const BOB_ADS_MUL = 0.5;
export const BOB_CROUCH_MUL = 0.62;
export const BOB_AIR_LAMBDA = 9.0;       // how fast bob amplitude tracks speed
export const BOB_ROLL = 0.55 * DEG;      // tiny roll coupled to the lateral swing

/* ------------------------------------------------------- camera reactions --- */
export const SPRINT_ROLL = 0.95 * DEG;   // oscillating roll while sprinting
export const SPRINT_PITCH = 1.60 * DEG;  // steady forward (downward) pitch
export const SPRINT_CAM_LAMBDA = 6.0;
export const STRAFE_ROLL = 1.40 * DEG;
export const STRAFE_LAMBDA = 7.0;

export const LAND_OMEGA = 19.0;          // critically damped spring
export const LAND_DIP_PER_MS = 0.0165;   // metres of dip per m/s of impact
export const LAND_DIP_MAX = 0.26;
export const LAND_PITCH_MUL = 0.30;      // rad of pitch per metre of dip

/* ----------------------------------------------------- trauma / recoil --- */
export const TRAUMA_DECAY = 1.35;        // 1/s, linear
export const TRAUMA_MAX = 1.0;
export const SHAKE_POS = 0.055;          // metres at trauma = 1
export const SHAKE_ROT = 0.048;          // radians at trauma = 1
export const SHAKE_FREQ = 13.0;          // Hz of the smooth-noise sampling

/* ------------------------------------------------------------ breathing --- */
export const BREATH_RATE = 0.24;         // Hz
export const BREATH_POS = 0.0035;
export const BREATH_ROT = 0.0016;
export const BREATH_ADS_MUL = 2.4;       // amplified when aiming
export const BREATH_TIRED_MUL = 3.2;     // ...and much worse with no stamina

/* ---------------------------------------------------------------- state --- */
export const MAX_HEALTH = 100;
export const REGEN_DELAY = 4.5;
export const REGEN_RATE = 22;
export const LOW_HEALTH_AT = 45;         // hp where uLowHealth starts ramping

export const MAX_STAMINA = 100;
export const TAC_DRAIN = 34;             // per second
export const SPRINT_DRAIN = 6;
export const STAMINA_REGEN = 20;
export const STAMINA_DELAY = 0.85;

/* ---------------------------------------------------------------- death --- */
export const DEATH_TIME = 1.4;
export const DEATH_EYE = 0.30;
export const DEATH_ROLL = 72 * DEG;
export const DEATH_PITCH = -18 * DEG;
export const DEATH_LAMBDA = 3.2;
