import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCameraStats } from "./useCameraStats";

/**
 * Live video from the ESP32-CAM (lesson 26), inline next to the drive pad so one tab
 * shows the feed, the tilt gauges and the controls together.
 *
 * The feed is a plain MJPEG stream served by the camera's *second* HTTP server on
 * port 81 (`streamServer` in lesson 26). An `<img>` renders it directly — no library,
 * no canvas, no fetch: the browser keeps the multipart response open and repaints on
 * each part. That also sidesteps CORS entirely, because an image is allowed to be
 * cross-origin; the firmware's `Access-Control-Allow-Origin: *` on `/stream` is only
 * needed by callers that want to *read* the bytes.
 *
 * The camera's address is not fixed: it's a DHCP lease on the LAN, so it moves. The
 * default comes from `VITE_CAM_URL` in `dashboard/.env`, and the panel lets you retype
 * it without a rebuild, remembering the last one in localStorage.
 *
 * WHY THIS PANEL HAS A WATCHDOG
 * -----------------------------
 * An MJPEG `<img>` cannot recover on its own, and the way it dies is silent. The
 * firmware's stream loop calls `httpd_resp_send_chunk` once per frame, and
 * esp_http_server abandons a send after `send_wait_timeout` (5 s by default). So if
 * the browser stops draining the socket for a few seconds — the tab goes to the
 * background, the machine gets busy, this very page is also decoding a 12 fps stream
 * beside a live chart and a three.js canvas — the ESP32's send fails, the handler
 * returns and the connection closes. To the browser that multipart response merely
 * *ended*: a completed load, not an error, so `onError` never fires and the last frame
 * stays on screen forever.
 *
 * Measured: the same stream read by `curl` ran 45 s and 2.5 MB without a hiccup, while
 * `/stats` reported `fps=0` for the whole time the page sat frozen — the camera was
 * fine, its handler had exited.
 *
 * Hence two mechanisms, one preventive and one corrective:
 *   1. drop the stream while the tab is hidden and re-open it on return. A hidden tab
 *      was going to stall the socket anyway, so closing cleanly beats being killed —
 *      and it hands back the camera's CPU, which matters because the same board also
 *      republishes drive commands;
 *   2. a watchdog on the fps heartbeat. The firmware zeroes `streamFps` exactly when
 *      the handler exits and publishes it over SignalR every 2 s, so `fps === 0` is a
 *      reliable "the stream is gone" signal — with no polling of the camera at all.
 */

const CAM_URL = import.meta.env.VITE_CAM_URL ?? "http://192.168.0.12";
const STORAGE_KEY = "cam.url";

/** MJPEG lives on port 81; lesson 26 keeps :80 for the page, /drive and /stats. */
const STREAM_PORT = "81";

/** No fps reading for this long and we call the camera offline (it publishes every 2s). */
const STALE_MS = 8000;

/** How often the watchdog looks at the heartbeat. */
const WATCHDOG_MS = 2000;

/**
 * Quiet period after (re)opening the stream. The camera publishes fps every 2 s and the
 * first frames take a moment, so a fresh stream legitimately reads 0 for a beat —
 * without this the watchdog would reconnect on top of its own reconnect.
 */
const RECONNECT_GRACE_MS = 6000;

/**
 * A stale heartbeat is not the same claim as `fps === 0`. `fps === 0` is the firmware
 * telling us its handler exited — precise, act on it. A heartbeat that stopped arriving
 * says only that the *telemetry* path is down (broker, API, hub); the video may well be
 * flowing, and re-opening it on that basis would chop up a working stream every few
 * seconds. So this case retries far more slowly — enough to recover a camera that
 * actually rebooted, rare enough not to matter if it was only MQTT that hiccuped.
 */
const STALE_RETRY_MS = 30000;

/** Accepts "192.168.0.12", "http://192.168.0.12" or "http://192.168.0.12:80". */
function streamUrlFrom(base: string): string | null {
  const trimmed = base.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    url.port = STREAM_PORT;
    url.pathname = "/stream";
    return url.toString();
  } catch {
    return null;
  }
}

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? CAM_URL;
  } catch {
    return CAM_URL; // private mode / storage blocked — the env default still works
  }
}

interface CameraPanelProps {
  apiUrl: string;
}

export function CameraPanel({ apiUrl }: CameraPanelProps) {
  const [base, setBase] = useState(readStored);
  const [draft, setDraft] = useState(base);
  const [editing, setEditing] = useState(false);
  const [live, setLive] = useState(true);
  const [failed, setFailed] = useState(false);
  /** Bumped to force the browser to re-open the stream (the same URL would be reused). */
  const [attempt, setAttempt] = useState(0);
  /** How many times the watchdog has had to step in — shown, not hidden. */
  const [recoveries, setRecoveries] = useState(0);
  const [hidden, setHidden] = useState(() => document.visibilityState === "hidden");

  const { fps, rssi, lastSeen } = useCameraStats(apiUrl);

  // A stream URL is only "new" when the address or the attempt counter changes, so
  // unrelated re-renders (an fps reading every 2s) don't restart the video.
  const src = useMemo(() => {
    const url = streamUrlFrom(base);
    return url ? `${url}?t=${attempt}` : null;
  }, [base, attempt]);

  const streaming = live && !hidden && !!src;

  const reopen = useCallback(() => {
    setFailed(false);
    setAttempt((n) => n + 1);
  }, []);

  const reload = useCallback(() => {
    setLive(true);
    reopen();
  }, [reopen]);

  const apply = useCallback(() => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === base) return;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* not being able to remember it is not a reason to refuse it */
    }
    setBase(next);
    reopen();
  }, [draft, base, reopen]);

  // Tab visibility: release the stream while hidden, re-open on return. See the note above.
  useEffect(() => {
    const onVisibility = () => {
      const isHidden = document.visibilityState === "hidden";
      setHidden(isHidden);
      if (!isHidden) reopen(); // the old socket is stale by now — start a fresh one
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [reopen]);

  // Watchdog. The heartbeat lives in refs so the interval never restarts: fps arrives
  // every 2s, and a re-created interval would keep resetting its own clock.
  const beat = useRef({ fps, lastSeen });
  beat.current = { fps, lastSeen };
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;

  const openedAt = useRef(Date.now());
  useEffect(() => {
    openedAt.current = Date.now();
  }, [src, streaming]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (!streamingRef.current) return;
      const { fps: f, lastSeen: seen } = beat.current;
      const since = t - openedAt.current;

      const dead = f === 0 && since >= RECONNECT_GRACE_MS;
      const quiet =
        (seen === null || t - seen > STALE_MS) && since >= STALE_RETRY_MS;

      if (dead || quiet) {
        openedAt.current = t;
        setRecoveries((n) => n + 1);
        reopen();
      }
    }, WATCHDOG_MS);
    return () => clearInterval(id);
  }, [reopen]);

  const stale = lastSeen === null || now - lastSeen > STALE_MS;
  const flowing = streaming && !failed && !stale && fps !== null && fps > 0;

  return (
    <section className="cam">
      <div className="cam__title">
        <span>Camera — FPV feed</span>
        <span className="cam__stats">
          <span className={`cam__dot${flowing ? " cam__dot--on" : ""}`} />
          {fps !== null ? `${fps.toFixed(1)} fps` : "— fps"}
          {rssi !== null && <span className="cam__rssi"> · {rssi} dBm</span>}
        </span>
      </div>

      <div className="cam__frame">
        {streaming && !failed ? (
          <img
            key={src}
            className="cam__video"
            src={src ?? undefined}
            alt="ESP32-CAM live feed"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="cam__placeholder">
            {failed ? (
              <>
                <b>No feed from {base}</b>
                <span>
                  Retrying every few seconds. Check the camera is powered and on the LAN —
                  its address is a DHCP lease and may have changed.
                </span>
              </>
            ) : hidden ? (
              <span>Feed released while the tab is in the background</span>
            ) : (
              <span>Feed paused</span>
            )}
          </div>
        )}
      </div>

      <div className="cam__bar">
        <button type="button" className="cam__btn" onClick={() => setLive((v) => !v)}>
          {live ? "pause" : "resume"}
        </button>
        <button type="button" className="cam__btn" onClick={reload}>
          reload
        </button>
        {recoveries > 0 && (
          <span
            className="cam__recovery"
            title="Times the stream died and the panel re-opened it by itself"
          >
            auto-reconnects: {recoveries}
          </span>
        )}

        {editing ? (
          <>
            <input
              className="cam__input"
              value={draft}
              autoFocus
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") apply();
                if (e.key === "Escape") {
                  setDraft(base);
                  setEditing(false);
                }
              }}
              aria-label="camera address"
            />
            <button type="button" className="cam__btn" onClick={apply}>
              save
            </button>
          </>
        ) : (
          <button
            type="button"
            className="cam__addr"
            onClick={() => {
              setDraft(base);
              setEditing(true);
            }}
            title="Click to change the camera address"
          >
            {base}
            <span className="cam__addr-port">:{STREAM_PORT}/stream</span>
          </button>
        )}
      </div>
    </section>
  );
}
