const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:54344";

export type DriveCommand = "forward" | "back" | "left" | "right" | "stop";

/**
 * POSTs a drive command to the API, which relays it over the broker to the ESP32.
 * Fire-and-forget from the UI's point of view — errors are logged, not thrown, so a
 * dropped packet never breaks the control loop (the next keepalive resends anyway).
 */
export async function sendDrive(command: DriveCommand, device = "esp32"): Promise<void> {
  try {
    await fetch(`${API_URL}/api/robot/${device}/drive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
    });
  } catch (err) {
    console.warn("drive command failed", command, err);
  }
}
