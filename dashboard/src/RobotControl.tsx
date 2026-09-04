import { useCallback, useEffect, useRef, useState } from "react";
import { sendDrive, type DriveCommand } from "./robotApi";
import { rumbleGamepads, useGamepad } from "./useGamepad";

/**
 * Whether this controller's axes run the other way round — see `FLIP` in useGamepad.
 * The default is a property of the pad plugged into this machine, so it lives in
 * `dashboard/.env` (`VITE_PAD_INVERT`) rather than being hard-coded, and the strip
 * under the pad can flip it at runtime; the choice sticks in localStorage.
 */
const PAD_INVERT_DEFAULT = import.meta.env.VITE_PAD_INVERT !== "false";
const PAD_INVERT_KEY = "pad.invert";

function readPadInvert(): boolean {
  try {
    const stored = localStorage.getItem(PAD_INVERT_KEY);
    return stored === null ? PAD_INVERT_DEFAULT : stored === "true";
  } catch {
    return PAD_INVERT_DEFAULT; // storage blocked — the env default still applies
  }
}

// While a direction is held we resend it on this cadence (keepalive). The firmware
// stops the motors if it hears nothing for FAILSAFE_MS (700ms), so a closed tab or
// dropped Wi-Fi halts the robot instead of letting it run away.
const KEEPALIVE_MS = 300;

// Arrow keys and WASD → direction.
const KEY_MAP: Record<string, DriveCommand> = {
  ArrowUp: "forward",
  ArrowDown: "back",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "forward",
  s: "back",
  a: "left",
  d: "right",
};

/**
 * Who is currently holding a direction. Three inputs drive the same robot, so
 * whoever grabbed it keeps it until they let go — otherwise releasing an arrow key
 * would stop a robot the gamepad is still pushing forward.
 */
type Source = "pointer" | "key" | "pad";

interface RobotControlProps {
  /**
   * The firmware's tilt guard (metric `guard`, lesson 22) is active: the ESP32 is
   * refusing drive commands until it's level again. We still send them — the device
   * is the authority — but the pad shows why nothing is moving.
   */
  blocked?: boolean;
}

export function RobotControl({ blocked = false }: RobotControlProps) {
  const [active, setActive] = useState<DriveCommand | null>(null);
  const [showMapping, setShowMapping] = useState(false);
  const [padInvert, setPadInvert] = useState(readPadInvert);
  const timer = useRef<number | null>(null);
  const activeRef = useRef<DriveCommand | null>(null);
  const sourceRef = useRef<Source | null>(null);

  const clearTimer = () => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  };

  // Start driving in a direction: send immediately, then keep resending while held.
  const begin = useCallback((command: DriveCommand, source: Source) => {
    if (activeRef.current === command && sourceRef.current === source) return;
    activeRef.current = command;
    sourceRef.current = source;
    setActive(command);
    void sendDrive(command);
    clearTimer();
    timer.current = window.setInterval(() => void sendDrive(command), KEEPALIVE_MS);
  }, []);

  // Release: stop resending and tell the robot to stop. Only the input that took
  // control can give it up — a stray keyup won't cut off the gamepad.
  const end = useCallback((source: Source) => {
    if (activeRef.current === null || sourceRef.current !== source) return;
    activeRef.current = null;
    sourceRef.current = null;
    setActive(null);
    clearTimer();
    void sendDrive("stop");
  }, []);

  // Emergency stop, from any input: drop whoever holds control and stop.
  const stopNow = useCallback(() => {
    activeRef.current = null;
    sourceRef.current = null;
    setActive(null);
    clearTimer();
    void sendDrive("stop");
  }, []);

  // Keyboard control.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return; // holding a key auto-repeats; keepalive handles that
      const cmd = KEY_MAP[e.key];
      if (cmd) {
        e.preventDefault();
        begin(cmd, "key");
      } else if (e.key === " ") {
        e.preventDefault();
        stopNow();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const cmd = KEY_MAP[e.key];
      if (cmd && cmd === activeRef.current) end("key");
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      clearTimer();
    };
  }, [begin, end, stopNow]);

  // Game controller: D-pad / hat / stick drive, face buttons stop. Same begin/end
  // path as the on-screen pad, so it inherits the keepalive and the failsafe.
  const gamepad = useGamepad({
    onCommand: (command) => begin(command, "pad"),
    onRelease: () => end("pad"),
    onStop: stopNow,
    debug: showMapping,
    invert: padInvert,
  });

  // Flipping the axes takes effect on the next poll; if a direction is being held
  // right now, let go of it first so the robot doesn't keep the pre-flip command.
  const toggleInvert = useCallback(() => {
    setPadInvert((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PAD_INVERT_KEY, String(next));
      } catch {
        /* remembering is a nicety; the flip itself still works this session */
      }
      return next;
    });
    end("pad");
  }, [end]);

  // Buzz the pad when the firmware's tilt guard engages — a driver looking at the
  // robot (or at the FPV feed) isn't looking at this panel.
  useEffect(() => {
    if (blocked) rumbleGamepads(400);
  }, [blocked]);

  // Hold-to-drive button. Pointer events cover mouse + touch; releasing or leaving stops.
  const holdProps = (command: DriveCommand) => ({
    className: `pad__btn${active === command ? " pad__btn--active" : ""}`,
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      begin(command, "pointer");
    },
    onPointerUp: () => end("pointer"),
    onPointerLeave: () => {
      if (activeRef.current === command) end("pointer");
    },
    onPointerCancel: () => end("pointer"),
  });

  return (
    <div className="drive">
      <div className="drive__title">
        <span>Drive (hold a button, arrow keys / WASD, or a game controller)</span>
        {blocked ? (
          <span className="drive__guard">TILT GUARD — commands ignored</span>
        ) : (
          <span className="drive__active">{active ? active.toUpperCase() : "idle"}</span>
        )}
      </div>

      <div className={`pad${blocked ? " pad--blocked" : ""}`}>
        <button {...holdProps("forward")} style={{ gridArea: "up" }} aria-label="forward">▲</button>
        <button {...holdProps("left")} style={{ gridArea: "left" }} aria-label="left">◀</button>
        <button
          className="pad__btn pad__btn--stop"
          style={{ gridArea: "stop" }}
          onPointerDown={(e) => {
            e.preventDefault();
            stopNow();
          }}
          aria-label="stop"
        >
          ■
        </button>
        <button {...holdProps("right")} style={{ gridArea: "right" }} aria-label="right">▶</button>
        <button {...holdProps("back")} style={{ gridArea: "down" }} aria-label="back">▼</button>
      </div>

      <div className="gamepad">
        <span className={`gamepad__dot${gamepad.connected ? " gamepad__dot--on" : ""}`} />
        {gamepad.connected ? (
          <>
            <span className="gamepad__id" title={gamepad.id ?? ""}>
              {gamepad.id}
            </span>
            <span className="gamepad__hint">D-pad / stick drives · any face button stops</span>
          </>
        ) : (
          // Browsers only reveal a pad after it sends input, so "not detected" is
          // the normal state until the first button press.
          <span className="gamepad__hint">
            No controller — plug one in and press any button on it
          </span>
        )}
        <button
          type="button"
          className={`gamepad__toggle${padInvert ? " gamepad__toggle--on" : ""}`}
          onClick={toggleInvert}
          title="Flip the pad's directions end for end, for a controller whose axes run backwards"
        >
          axes: {padInvert ? "flipped" : "normal"}
        </button>
        <button
          type="button"
          className="gamepad__toggle gamepad__toggle--raw"
          onClick={() => setShowMapping((v) => !v)}
        >
          {showMapping ? "hide raw input" : "raw input"}
        </button>
      </div>

      {/* Live axis/button readout. Cheap pads report their D-pad in wildly different
          places, so this is how you find out what yours actually sends. */}
      {showMapping && (
        <div className="gamepad__raw">
          {gamepad.connected ? (
            <>
              <div>
                {gamepad.axes.map((v, i) => (
                  <span key={i} className="gamepad__axis">
                    ax{i} <b>{v.toFixed(2)}</b>
                  </span>
                ))}
              </div>
              <div>
                {gamepad.buttons.map((pressed, i) => (
                  <span key={i} className={`gamepad__bit${pressed ? " gamepad__bit--on" : ""}`}>
                    {i}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <span className="gamepad__hint">Press a button on the controller…</span>
          )}
        </div>
      )}
    </div>
  );
}
