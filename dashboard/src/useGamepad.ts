import { useEffect, useRef, useState } from "react";
import type { DriveCommand } from "./robotApi";

/**
 * Reads a USB/Bluetooth game controller through the browser Gamepad API and turns
 * it into the same `DriveCommand`s the on-screen pad and the keyboard produce.
 *
 * Written for no-name DirectInput pads (a "Defender Omega" and friends), not just
 * XInput ones, so it accepts three different ways a pad can report a direction:
 * the standard-mapping D-pad, a hat switch on axis 9, or an analog stick. The
 * first of those that reports movement wins.
 *
 * The browser hides gamepads until the user presses a button on one — a privacy
 * rule, not a bug — so the pad only shows up a moment after the first press.
 */

const STICK_DEADZONE = 0.5;

// Chrome exposes a DirectInput hat switch as axis 9, with one value per direction
// (-1 = up, stepping by 2/7 clockwise) and a *neutral* value outside [-1, 1].
const HAT_AXIS = 9;
const HAT_NEUTRAL_MIN = 1.05; // above this the hat is centred, not pointing anywhere

// How often the raw axes/buttons readout re-renders while the mapping panel is open.
const DEBUG_INTERVAL_MS = 100;

/**
 * Turns a decoded direction into its opposite. Cheap DirectInput pads disagree about
 * which end of an axis is "up" — some report a hat starting at its bottom position,
 * some hand out an inverted stick Y — and either way the whole decode comes out
 * rotated by 180 degrees: pushing up drives back, and left turns right. One flip at
 * the end fixes both halves, which is why this is a single switch and not one per
 * axis. See the `invert` option.
 */
const FLIP: Record<DriveCommand, DriveCommand> = {
  forward: "back",
  back: "forward",
  left: "right",
  right: "left",
  stop: "stop",
};

export interface GamepadState {
  connected: boolean;
  /** The pad's self-reported name, e.g. "USB Gamepad (Vendor: 0079 Product: 0006)". */
  id: string | null;
  /** Direction currently being asked for, or null when centred. */
  command: DriveCommand | null;
  /** Raw values — only kept current while `debug` is on, for mapping an unknown pad. */
  axes: number[];
  buttons: boolean[];
}

interface UseGamepadOptions {
  /** Called when the pad starts asking for a direction, and on every change of direction. */
  onCommand: (command: DriveCommand) => void;
  /** Called when the pad returns to centre. */
  onRelease: () => void;
  /** Called when a face button (0–3) goes down — the pad's emergency stop. */
  onStop: () => void;
  /** Populate `axes`/`buttons` for the mapping panel. Off by default; it re-renders. */
  debug?: boolean;
  /**
   * Flip every decoded direction end for end, for a pad whose axes run the other way.
   * Defaults from `VITE_PAD_INVERT`; the Drive panel exposes it as a toggle because
   * it is a property of the controller, not of the robot.
   */
  invert?: boolean;
}

const IDLE: GamepadState = { connected: false, id: null, command: null, axes: [], buttons: [] };

/**
 * Decodes axis 9 as a hat switch. Returns nothing unless this pad has already been
 * *confirmed* to have one: a real hat rests outside the normal [-1, 1] axis range,
 * so seeing that value once proves axis 9 isn't an ordinary stick axis — which,
 * resting at 0, would otherwise decode as a permanent "back".
 */
function readHat(gp: Gamepad, confirmed: Set<number>): DriveCommand[] {
  const v = gp.axes[HAT_AXIS];
  if (v === undefined) return [];
  if (Math.abs(v) > HAT_NEUTRAL_MIN) {
    confirmed.add(gp.index); // centred, and out of stick range — it's a hat
    return [];
  }
  if (!confirmed.has(gp.index)) return [];

  const dir = Math.round((v + 1) * 3.5); // 0 = up, 1 = up-right, … 7 = up-left
  if (dir < 0 || dir > 7) return [];
  const held: DriveCommand[] = [];
  if (dir === 7 || dir === 0 || dir === 1) held.push("forward");
  if (dir >= 1 && dir <= 3) held.push("right");
  if (dir >= 3 && dir <= 5) held.push("back");
  if (dir >= 5 && dir <= 7) held.push("left");
  return held;
}

/** Which direction this pad is asking for, or null if it's centred. */
function readDirection(gp: Gamepad, hatPads: Set<number>): DriveCommand | null {
  // 1. Standard-mapping D-pad (buttons 12–15). Cheap DirectInput pads report
  //    fewer than 16 buttons, so the length check keeps us off their face buttons.
  if (gp.buttons.length > 15) {
    if (gp.buttons[12].pressed) return "forward";
    if (gp.buttons[13].pressed) return "back";
    if (gp.buttons[14].pressed) return "left";
    if (gp.buttons[15].pressed) return "right";
  }

  // 2. Hat switch. The robot understands four discrete moves, so a diagonal has
  //    to pick one: forward/back wins, because up-right still mostly means "go".
  const hat = readHat(gp, hatPads);
  if (hat.length) {
    return hat.find((c) => c === "forward" || c === "back") ?? hat[0];
  }

  // 3. Analog sticks — left (axes 0/1) and right (axes 2/3). The stick pushed
  //    furthest wins; the deadzone is deliberately large so a worn-out
  //    potentiometer that never quite returns to zero can't drive the robot.
  let x = 0;
  let y = 0;
  for (const [ax, ay] of [
    [0, 1],
    [2, 3],
  ]) {
    const sx = gp.axes[ax] ?? 0;
    const sy = gp.axes[ay] ?? 0;
    if (Math.hypot(sx, sy) > Math.hypot(x, y)) {
      x = sx;
      y = sy;
    }
  }
  if (Math.abs(y) > Math.abs(x)) {
    if (y <= -STICK_DEADZONE) return "forward";
    if (y >= STICK_DEADZONE) return "back";
  } else {
    if (x <= -STICK_DEADZONE) return "left";
    if (x >= STICK_DEADZONE) return "right";
  }
  return null;
}

/** True while any of the four face buttons is held — the pad's stop button. */
function stopPressed(gp: Gamepad): boolean {
  return gp.buttons.slice(0, 4).some((b) => b.pressed);
}

/** First pad the browser is currently reporting, or null. */
function firstPad(): Gamepad | null {
  const pads = navigator.getGamepads?.() ?? [];
  for (const gp of pads) {
    if (gp && gp.connected) return gp;
  }
  return null;
}

export function useGamepad({
  onCommand,
  onRelease,
  onStop,
  debug = false,
  invert = false,
}: UseGamepadOptions): GamepadState {
  const [state, setState] = useState<GamepadState>(IDLE);

  // Handlers live in a ref so the polling loop never has to be torn down and
  // restarted, which would drop a held direction mid-drive.
  const handlers = useRef({ onCommand, onRelease, onStop });
  handlers.current = { onCommand, onRelease, onStop };
  const debugRef = useRef(debug);
  debugRef.current = debug;
  const invertRef = useRef(invert);
  invertRef.current = invert;

  // What the last setState published, so the loop can skip redundant renders
  // without depending on `state` (which would restart it).
  const shownCommand = useRef<DriveCommand | null>(null);

  useEffect(() => {
    let frame = 0;
    let lastCommand: DriveCommand | null = null;
    let lastStop = false;
    let lastId: string | null = null;
    let lastDebugAt = 0;
    const hatPads = new Set<number>();

    const poll = () => {
      frame = requestAnimationFrame(poll);
      const gp = firstPad();

      if (!gp) {
        if (lastId !== null) {
          lastId = null;
          shownCommand.current = null;
          if (lastCommand !== null) {
            lastCommand = null;
            handlers.current.onRelease(); // pad unplugged mid-drive — let go
          }
          setState(IDLE);
        }
        return;
      }

      const decoded = readDirection(gp, hatPads);
      const command = decoded && invertRef.current ? FLIP[decoded] : decoded;
      const stop = stopPressed(gp);

      if (command !== lastCommand) {
        lastCommand = command;
        if (command) handlers.current.onCommand(command);
        else handlers.current.onRelease();
      }
      if (stop && !lastStop) handlers.current.onStop();
      lastStop = stop;

      // Re-render only when something the UI shows actually changed. This runs
      // ~60x/s next to a live chart, so an unconditional setState would hurt.
      const now = performance.now();
      const wantDebug = debugRef.current && now - lastDebugAt >= DEBUG_INTERVAL_MS;
      if (gp.id !== lastId || command !== shownCommand.current || wantDebug) {
        if (wantDebug) lastDebugAt = now;
        lastId = gp.id;
        shownCommand.current = command;
        setState({
          connected: true,
          id: gp.id,
          command,
          axes: debugRef.current ? Array.from(gp.axes) : [],
          buttons: debugRef.current ? gp.buttons.map((b) => b.pressed) : [],
        });
      }
    };

    frame = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(frame);
  }, []);

  return state;
}

/**
 * Buzzes every connected pad that has a motor. Used to signal the firmware's tilt
 * guard, which the on-screen pad can show but a driver watching the robot itself
 * (or the FPV camera feed) would otherwise miss. A silent no-op on pads and
 * browsers without haptics.
 */
export function rumbleGamepads(durationMs = 250, strength = 0.8): void {
  for (const gp of navigator.getGamepads?.() ?? []) {
    const actuator = gp?.vibrationActuator;
    if (!actuator?.playEffect) continue;
    void actuator
      .playEffect("dual-rumble", {
        duration: durationMs,
        strongMagnitude: strength,
        weakMagnitude: strength,
      })
      .catch(() => {
        /* pad doesn't support this effect — not worth surfacing */
      });
  }
}
