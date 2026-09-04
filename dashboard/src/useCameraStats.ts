import { useEffect, useState } from "react";
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from "@microsoft/signalr";
import type { Reading } from "./useTelemetry";

/**
 * Latches the ESP32-CAM's own telemetry — `fps` and `rssi`, published by lesson 26
 * under its own device id (`esp32cam`) every 2 seconds.
 *
 * These already ride the ordinary telemetry pipeline (MQTT -> broker -> consumer ->
 * PostgreSQL -> SignalR), so the video panel needs no new backend and no request to
 * the camera itself. That matters: the camera's own `/stats` endpoint sets no CORS
 * header (only `/stream` does), so fetching it from the dev origin would be blocked
 * — whereas the hub is already allowed and already carrying these numbers.
 *
 * Note the shortcut: this opens a *second* hub connection next to `useTelemetry`
 * rather than sharing one. The hub broadcasts every reading to every client and both
 * hooks filter client-side, so sharing would need the per-device groups listed as a
 * future step in the README. Keeping the connections separate leaves the working
 * tilt hook untouched.
 */
export function useCameraStats(apiUrl: string, device = "esp32cam") {
  const [fps, setFps] = useState<number | null>(null);
  const [rssi, setRssi] = useState<number | null>(null);
  /** When the last reading arrived (epoch ms) — the camera going quiet is the signal. */
  const [lastSeen, setLastSeen] = useState<number | null>(null);

  useEffect(() => {
    const connection: HubConnection = new HubConnectionBuilder()
      .withUrl(`${apiUrl}/hub/telemetry`)
      .withAutomaticReconnect()
      .configureLogging(LogLevel.Warning)
      .build();

    connection.on("reading", (r: Reading) => {
      if (r.device !== device) return;
      if (r.metric === "fps") setFps(r.value);
      else if (r.metric === "rssi") setRssi(r.value);
      else return;
      setLastSeen(Date.now());
    });

    connection.start().catch(() => {
      /* the tilt panel already surfaces hub trouble — don't double-report it */
    });

    return () => {
      if (connection.state !== HubConnectionState.Disconnected) {
        void connection.stop();
      }
    };
  }, [apiUrl, device]);

  return { fps, rssi, lastSeen };
}
