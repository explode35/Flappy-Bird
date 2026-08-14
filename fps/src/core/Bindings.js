/**
 * ============================================================================
 *  Bindings.js — named actions, so keys can be rebound.
 * ============================================================================
 *  Every key in the game used to be a string literal at the point of use:
 *  `input.down('KeyW')` in the player, `input.hit('Digit1')` in the weapons,
 *  thirteen of them across three systems. That works right up until someone
 *  asks to change the layout, at which point there is nothing to change.
 *
 *  An action is a name plus a list of key codes. The list matters: crouch is
 *  genuinely two keys, and sprint has to accept either shift, because a
 *  keyboard reports ShiftLeft and ShiftRight as different codes and no player
 *  thinks of them as different keys. Rebinding replaces the primary (first)
 *  code and leaves any alternate in place.
 *
 *  Codes are `KeyboardEvent.code`, not `.key`, so a binding survives the
 *  player switching keyboard layout — W is the same physical key on AZERTY
 *  even though it types Z.
 * ============================================================================
 */

/** @typedef {{id: string, label: string, group: string, def: string[]}} Action */

/** @type {Action[]} */
export const ACTIONS = [
  { id: 'forward',   label: 'Move forward',   group: 'Movement', def: ['KeyW'] },
  { id: 'back',      label: 'Move back',      group: 'Movement', def: ['KeyS'] },
  { id: 'left',      label: 'Strafe left',    group: 'Movement', def: ['KeyA'] },
  { id: 'right',     label: 'Strafe right',   group: 'Movement', def: ['KeyD'] },
  { id: 'sprint',    label: 'Sprint',         group: 'Movement', def: ['ShiftLeft', 'ShiftRight'] },
  { id: 'crouch',    label: 'Crouch / slide', group: 'Movement', def: ['ControlLeft', 'KeyC'] },
  { id: 'jump',      label: 'Jump / mantle',  group: 'Movement', def: ['Space'] },
  { id: 'leanLeft',  label: 'Lean left',      group: 'Movement', def: ['KeyQ'] },
  { id: 'leanRight', label: 'Lean right',     group: 'Movement', def: ['KeyE'] },

  { id: 'reload',    label: 'Reload',         group: 'Combat', def: ['KeyR'] },
  { id: 'grenade',   label: 'Grenade',        group: 'Combat', def: ['KeyG'] },
  { id: 'inspect',   label: 'Inspect weapon', group: 'Combat', def: ['KeyF'] },
  { id: 'slot1',     label: 'Rifle',          group: 'Combat', def: ['Digit1'] },
  { id: 'slot2',     label: 'SMG',            group: 'Combat', def: ['Digit2'] },
  { id: 'slot3',     label: 'Pistol',         group: 'Combat', def: ['Digit3'] },
];

const STORE_KEY = 'blackout.bindings.v1';

/** Defaults as a fresh object, safe to mutate. */
export function defaultBindings() {
  const out = {};
  for (const a of ACTIONS) out[a.id] = a.def.slice();
  return out;
}

/**
 * Load from localStorage, falling back to defaults for anything missing or
 * malformed — a stored blob from an older build must never be able to leave
 * the player unable to walk.
 */
export function loadBindings() {
  const out = defaultBindings();
  let raw;
  try { raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { raw = null; }
  if (!raw || typeof raw !== 'object') return out;
  for (const a of ACTIONS) {
    const v = raw[a.id];
    if (Array.isArray(v) && v.length && v.every((c) => typeof c === 'string' && c)) out[a.id] = v.slice();
  }
  return out;
}

export function saveBindings(b) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(b)); } catch { /* private mode, ignore */ }
}

export function clearBindings() {
  try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
}

/** Which action, if any, already uses this code. */
export function findConflict(bindings, code, exceptId) {
  for (const a of ACTIONS) {
    if (a.id === exceptId) continue;
    if ((bindings[a.id] || []).includes(code)) return a;
  }
  return null;
}

const NAMED = {
  Space: 'SPACE', Escape: 'ESC', Enter: 'ENTER', Tab: 'TAB', Backspace: 'BKSP',
  ShiftLeft: 'L SHIFT', ShiftRight: 'R SHIFT',
  ControlLeft: 'L CTRL', ControlRight: 'R CTRL',
  AltLeft: 'L ALT', AltRight: 'R ALT',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Backquote: '`', Backslash: '\\',
  Comma: ',', Period: '.', Slash: '/', CapsLock: 'CAPS',
};

/** Human label for a KeyboardEvent.code. */
export function keyLabel(code) {
  if (!code) return '—';
  if (NAMED[code]) return NAMED[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'NUM ' + code.slice(6);
  if (/^F\d+$/.test(code)) return code;
  return code.toUpperCase();
}
