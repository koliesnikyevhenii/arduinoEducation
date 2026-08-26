import { useEffect, useRef, useState } from "react";
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from "@microsoft/signalr";

/** Matches the camelCase ReadingDto broadcast by the API's TelemetryConsumer. */
export interface Reading {
  device: string;
  metric: string;
  value: number;
  recordedAt: string;
}

/** One row of the rolling history chart: latest pitch/roll at a moment in time. */
export interface TiltPoint {
  t: number; // epoch ms, for the time axis
  pitch: number | null;
  roll: number | null;
}

export type ConnState = "connecting" | "connected" | "reconnecting" | "disconnected";

const HISTORY_LIMIT = 150; // ~30s of history at 5 readings/sec

interface UseTelemetry {
  device: string;
  metrics?: string[];
}

type LatestValues = { pitch: number | null; roll: number | null; yaw: number | null };

/** Tilt metrics that feed the gauges, the chart and the 3D model. */
const TILT_METRICS = ["pitch", "roll", "yaw"];

/**
 * Subscribes to the API's SignalR hub and keeps the latest pitch/roll plus a
 * rolling window of history for the given device. Pitch and roll arrive as
 * separate messages, so each message appends a point carrying the newest value
 * of both.
 *
 * `guard` (lesson 22) rides the same pipeline as an ordinary 0/1 metric, but the
 * firmware publishes it only when it flips — so it's latched, not charted.
 */
export function useTelemetry(
  apiUrl: string,
  { device, metrics = [...TILT_METRICS, "guard"] }: UseTelemetry
) {
  const [state, setState] = useState<ConnState>("connecting");
  const [pitch, setPitch] = useState<number | null>(null);
  const [roll, setRoll] = useState<number | null>(null);
  const [yaw, setYaw] = useState<number | null>(null);
  const [guard, setGuard] = useState<boolean | null>(null);
  const [history, setHistory] = useState<TiltPoint[]>([]);

  // Newest values held in a ref so the SignalR handler (registered once) always
  // sees current state without re-subscribing on every reading.
  const latest = useRef<LatestValues>({ pitch: null, roll: null, yaw: null });

  useEffect(() => {
    const connection: HubConnection = new HubConnectionBuilder()
      .withUrl(`${apiUrl}/hub/telemetry`)
      .withAutomaticReconnect()
      .configureLogging(LogLevel.Warning)
      .build();

    connection.on("reading", (r: Reading) => {
      if (r.device !== device || !metrics.includes(r.metric)) return;

      if (r.metric === "pitch") {
        latest.current.pitch = r.value;
        setPitch(r.value);
      } else if (r.metric === "roll") {
        latest.current.roll = r.value;
        setRoll(r.value);
      } else if (r.metric === "yaw") {
        latest.current.yaw = r.value;
        setYaw(r.value);
      } else if (r.metric === "guard") {
        // Event, not a measurement: latch it and don't add a chart point.
        setGuard(r.value !== 0);
        return;
      }

      const point: TiltPoint = {
        t: Date.parse(r.recordedAt),
        pitch: latest.current.pitch,
        roll: latest.current.roll,
      };
      setHistory((prev) => [...prev, point].slice(-HISTORY_LIMIT));
    });

    connection.onreconnecting(() => setState("reconnecting"));
    connection.onreconnected(() => setState("connected"));
    connection.onclose(() => setState("disconnected"));

    setState("connecting");
    connection
      .start()
      .then(() => setState("connected"))
      .catch(() => setState("disconnected"));

    return () => {
      // Only stop a live/starting connection; stopping a already-stopped one is a no-op error.
      if (connection.state !== HubConnectionState.Disconnected) {
        void connection.stop();
      }
    };
  }, [apiUrl, device, metrics.join(",")]);

  return { state, pitch, roll, yaw, guard, history };
}
