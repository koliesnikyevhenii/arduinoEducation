import { useCallback, useEffect, useRef, useState } from "react";
import { sendDrive, type DriveCommand } from "./robotApi";

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

export function RobotControl() {
  const [active, setActive] = useState<DriveCommand | null>(null);
  const timer = useRef<number | null>(null);
  const activeRef = useRef<DriveCommand | null>(null);

  const clearTimer = () => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  };

  // Start driving in a direction: send immediately, then keep resending while held.
  const begin = useCallback((command: DriveCommand) => {
    if (activeRef.current === command) return;
    activeRef.current = command;
    setActive(command);
    void sendDrive(command);
    clearTimer();
    timer.current = window.setInterval(() => void sendDrive(command), KEEPALIVE_MS);
  }, []);

  // Release: stop resending and tell the robot to stop.
  const end = useCallback(() => {
    if (activeRef.current === null) return;
    activeRef.current = null;
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
        begin(cmd);
      } else if (e.key === " ") {
        e.preventDefault();
        end();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const cmd = KEY_MAP[e.key];
      if (cmd && cmd === activeRef.current) end();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      clearTimer();
    };
  }, [begin, end]);

  // Hold-to-drive button. Pointer events cover mouse + touch; releasing or leaving stops.
  const holdProps = (command: DriveCommand) => ({
    className: `pad__btn${active === command ? " pad__btn--active" : ""}`,
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      begin(command);
    },
    onPointerUp: end,
    onPointerLeave: () => {
      if (activeRef.current === command) end();
    },
    onPointerCancel: end,
  });

  return (
    <div className="drive">
      <div className="drive__title">
        <span>Drive (hold a button, or use arrow keys / WASD)</span>
        <span className="drive__active">{active ? active.toUpperCase() : "idle"}</span>
      </div>

      <div className="pad">
        <button {...holdProps("forward")} style={{ gridArea: "up" }} aria-label="forward">▲</button>
        <button {...holdProps("left")} style={{ gridArea: "left" }} aria-label="left">◀</button>
        <button
          className="pad__btn pad__btn--stop"
          style={{ gridArea: "stop" }}
          onPointerDown={(e) => {
            e.preventDefault();
            end();
            void sendDrive("stop");
          }}
          aria-label="stop"
        >
          ■
        </button>
        <button {...holdProps("right")} style={{ gridArea: "right" }} aria-label="right">▶</button>
        <button {...holdProps("back")} style={{ gridArea: "down" }} aria-label="back">▼</button>
      </div>
    </div>
  );
}
