# TelemetryApi

Backend for IoT telemetry:

```
ESP32 --MQTT--> RabbitMQ (rabbitmq_mqtt plugin) --AMQP--> TelemetryConsumer --> PostgreSQL
                                                                |
                                                          SignalR hub --> React dashboard (pitch/roll)
                                                                ↕
                                                          ASP.NET Core read API
```

## Running the infrastructure

```bash
docker compose up -d
```

Brings up RabbitMQ (with the `management` and `mqtt` plugins enabled) and PostgreSQL.
Management UI: http://localhost:15672 (guest / guest).

## Running the API

```bash
# one-time — create the migration (requires the dotnet-ef tool)
dotnet tool install --global dotnet-ef
dotnet ef migrations add Initial

# run (migrations are applied automatically on startup)
dotnet run
```

Swagger: http://localhost:5xxx/swagger

## Testing the end-to-end flow without hardware

Publish a test MQTT message (simulating the ESP32). For example, use any
MQTT client to publish to the topic `sensors/livingroom/temperature` with the body `23.5`.
The message travels: MQTT -> amq.topic -> queue telemetry.ingest ->
consumer -> table sensor_readings. Then:

```
GET http://localhost:5xxx/api/telemetry/latest?device=livingroom
```

## Important note about connecting the ESP32 over the network

By default the `guest` user in RabbitMQ works ONLY from localhost.
To let an ESP32 on the network publish, create a separate user
(management UI -> Admin -> Add user), e.g. `esp` / `esp-pass`, and grant
it permissions on vhost `/`. Use those credentials in the firmware.

## Simulating a device (no hardware)

`simulator/` is a small .NET console app that publishes fake readings over MQTT
(port 1883) just like the ESP32 would — topic `sensors/<device>/<metric>`, body a
bare number. Use it to drive the whole flow without the UI or hardware.

```bash
cd simulator
dotnet run                                # every 2s, forever (Ctrl+C to stop)
dotnet run -- --interval 1000 --count 20  # 20 messages, 1/sec, then stop
```

Options: `--host` (default `localhost`), `--port` (`1883`), `--user`/`--pass`
(`guest`/`guest` — works from localhost), `--interval` ms (default `500`),
`--count` (0 = endless).
Watch the readings arrive via `GET /api/telemetry/latest` or `/api/telemetry/devices`.

The simulator publishes `esp32/pitch` and `esp32/roll` (swinging ±90°) alongside the
room temperature/humidity series, so the pitch/roll dashboard below has live data with
no ESP32 attached.

## Real-time dashboard (Pitch / Roll — MPU6050 lesson 20)

The ESP32 MPU6050 lesson publishes tilt as two ordinary metrics —
`sensors/esp32/pitch` and `sensors/esp32/roll`, each a bare number. The backend needs
**no special handling**: `TelemetryConsumer` ingests them like any other metric and, after
the DB write, pushes each reading to connected browsers over a SignalR hub at
`/hub/telemetry`. The React app filters device `esp32` / metrics `pitch`,`roll` and draws
two live gauges plus a rolling chart — near real-time.

```bash
cd dashboard
npm install     # first time only
npm run dev     # http://localhost:5173
```

The dashboard reads the API base URL from `dashboard/.env` (`VITE_API_URL`, default
`http://localhost:54344` — the API's HTTP dev endpoint). It relies on the `react` CORS
policy, which allows origin `http://localhost:5173` **with credentials** (required for the
SignalR WebSocket handshake).

`dashboard/.env` is git-ignored; every setting in it is documented inline there:

| Variable | Default | What it does |
| --- | --- | --- |
| `VITE_API_URL` | `http://localhost:54344` | API + SignalR hub base URL |
| `VITE_CAM_URL` | `http://192.168.0.12` | ESP32-CAM address for the video panel (below) |
| `VITE_PAD_INVERT` | `true` | Flip the game controller's directions (below) |

To see it end-to-end: `docker compose up -d`, run the API (`dotnet run`), start the
dashboard (`npm run dev`), then drive data with `cd simulator && dotnet run` (or the real
ESP32 running lesson 20).

## Driving the robot (lesson 21 — TB6612FNG motors)

This is the **reverse** direction of the telemetry flow: commands go browser → API → broker → ESP32.

```
Browser --HTTP--> ASP.NET --AMQP--> RabbitMQ --MQTT(1883)--> ESP32 --> TB6612FNG --> motors
```

- **Endpoint:** `POST /api/robot/{device}/drive` with body `{ "command": "forward" }`.
  Allowed commands: `forward`, `back`, `left`, `right`, `stop` (anything else → 400).
- This is **command dispatch, not telemetry** — `RobotCommandPublisher` publishes to `amq.topic`
  with routing key `commands.<device>.drive`; it never writes to PostgreSQL. The MQTT plugin
  turns that key back into topic `commands/<device>/drive`, which the firmware subscribes to.
  The `commands.*` namespace is separate from `sensors.#`, so the telemetry consumer ignores it.
- **Dashboard:** the *Drive* panel — hold a button, use arrow keys / WASD, or plug in a **game
  controller** (see below). While a direction is held the browser resends the command every
  300 ms; on release it sends `stop`. The firmware has a **failsafe** — if it hears nothing for
  700 ms it stops the motors, so a closed tab or dropped Wi-Fi can't leave the robot running.

### Driving with a game controller

`dashboard/src/useGamepad.ts` reads a USB/Bluetooth pad through the browser **Gamepad API** and
feeds the *same* `begin`/`end` path as the on-screen buttons, so it inherits the 300 ms keepalive
and the failsafe for free. No API, broker or firmware change — it's another way to press the same
buttons.

- **Detection:** browsers hide gamepads until the pad sends input, so the strip under the D-pad
  reads *"No controller"* until you **press any button on it once**. Chrome/Edge work over plain
  `http://localhost`; Firefox exposes fewer pads and has no rumble.
- **Mapping** — cheap DirectInput pads (a no-name "Defender Omega", say) don't use the standard
  layout, so three sources are tried in order: the standard-mapping D-pad (buttons 12–15), a
  **hat switch on axis 9**, then the analog sticks (axes 0/1 and 2/3, deadzone 0.5). Axis 9 is
  only trusted as a hat once it has been seen at its out-of-range neutral value — otherwise an
  ordinary stick axis resting at `0` would decode as a permanent "back".
- **Buttons:** direction = drive (held), any face button (0–3) = **stop**. Diagonals resolve to
  forward/back, since the robot only understands four discrete moves.
- **Axes backwards?** Cheap pads disagree about which end of an axis is "up", and a pad that
  reports it the other way comes out rotated 180 degrees — push up and the robot reverses, and
  the turns are mirrored along with it. The **axes: flipped / normal** toggle in the strip
  flips every decoded direction end for end (one switch, because both halves invert together);
  the choice sticks in `localStorage`, and `VITE_PAD_INVERT` sets the default. This is a
  property of the controller, so it happens in `useGamepad.ts` — the API, broker and firmware
  never see it.
- **Unknown pad?** Hit **raw input** in the strip for a live axis/button readout and press things
  until you find yours — that's the fastest way to see what your controller actually reports.
- The pad **buzzes** (where supported) when the lesson-22 tilt guard trips, since a driver
  watching the robot isn't watching this panel.

The simulator does **not** drive motors (it's a telemetry publisher only); test the drive path
with the real ESP32 running lesson 21, or by POSTing to the endpoint (Swagger / curl).

## Full robot (lesson 22 — drive *and* tilt in one firmware)

Lesson 22 merges lessons 20 and 21 on the device: **one** ESP32 sketch publishes tilt and
subscribes to drive commands at the same time, so you steer from the dashboard and watch the
robot lean in the same breath. Both directions run over the same broker:

```
Browser --HTTP--> ASP.NET --AMQP--> RabbitMQ --MQTT--> ESP32 --> motors
Browser <--SignalR-- ASP.NET <--AMQP-- RabbitMQ <--MQTT-- ESP32 <-- MPU6050
```

**The backend needed no contract change** — that's the point. Telemetry still arrives as
`sensors.<device>.<metric>` with a bare-number body, commands still leave as
`commands.<device>.drive`. What lesson 22 adds is one more ordinary metric:

- **`guard`** — the firmware's own **tilt cutoff**: `1` while |pitch| or |roll| exceeds 45°
  (released below 35° — hysteresis), `0` otherwise. While it's `1` the device stops the motors
  and *ignores* movement commands (`stop` is always honoured). It rides the normal telemetry
  pipeline as a `0`/`1` reading, so `TelemetryConsumer` ingests and broadcasts it untouched.
  It arms only once that tilt has **held for 300 ms** *and* the accelerometer is trustworthy
  (|a| ≈ 1 g). Both filters exist because the angles are derived from the acceleration vector:
  without them the motors' own starting jolt read as 45–48° on a level floor, and the guard cut
  the motors it had just started — the robot twitched and stood still. Nothing on this side
  changed for that fix; it just means far fewer `guard` rows.
- The device publishes `guard` **only when it flips** (an event), not on the 5 Hz timer the
  angles use (a measurement stream) — so it costs a couple of rows per session, not 5/sec.
- The dashboard latches it: the *Drive* pad greys out and shows **TILT GUARD — commands
  ignored** instead of the active direction. `useTelemetry` returns it as `guard: boolean | null`
  and deliberately keeps it out of the chart history.
- `POST /api/robot/{device}/drive` still answers **202 Accepted** — we only know the command
  reached the broker; with the tilt guard tripped the device may well decline to act on it.

The simulator doesn't publish `guard`, so the badge stays dark without the real robot.

## Camera in the dashboard (lesson 26 — ESP32-S3-CAM)

The FPV camera is a **second board** with its own IP, and the dashboard shows its video in
the same tab as the drive pad and the tilt gauges (`dashboard/src/CameraPanel.tsx`):

```
Browser <--MJPEG :81/stream-- ESP32-CAM          (video, straight from the camera)
Browser <--SignalR-- ASP.NET <--AMQP-- RabbitMQ <--MQTT-- ESP32-CAM   (its fps / rssi)
```

- **Video** is a plain `<img>` pointed at the camera's second HTTP server, `:81/stream`.
  The browser holds the `multipart/x-mixed-replace` response open and repaints on each part —
  no library, no canvas, no `fetch`. An image is allowed to be cross-origin, so **CORS never
  comes into it**; the firmware's `Access-Control-Allow-Origin: *` on `/stream` only matters
  to callers that want to read the bytes.
- **fps / rssi** in the panel header come off the **SignalR hub**, not from the camera: lesson 26
  already publishes them as ordinary metrics under device `esp32cam`, so they ride the normal
  pipeline into PostgreSQL and out to the browser. Nothing was added to the backend for this.
  (The camera's own `/stats` endpoint sets no CORS header, so fetching *that* from the dev
  origin would be blocked — the hub sidesteps the problem entirely.)
- **The camera serves one MJPEG client at a time.** Open its own FPV page at
  `http://<cam-ip>/` while the dashboard panel is streaming and the second viewer gets
  nothing. That's what **pause** is for — it closes the stream and hands the camera's CPU and
  Wi-Fi back, which matters because the same board also republishes drive commands.
- **The address is a DHCP lease and moves.** `VITE_CAM_URL` sets the default; clicking it in
  the panel retypes it without a rebuild and remembers it in `localStorage`. Give the plain
  host (`http://192.168.0.12`) — the panel derives `:81/stream` itself.
- "Offline" is decided by the fps heartbeat rather than by the `<img>`: a dead MJPEG stream
  usually just stops repainting without firing an error.

## Where to extend next

- `TelemetryConsumer.ParseReading` — the payload format (switch to JSON).
- `Domain/SensorReading` — add fields (qos, raw payload in jsonb).
- `Api/TelemetryEndpoints` — aggregates (hourly average), pagination.
- SignalR push is live (`TelemetryHub`, `/hub/telemetry`). Next: per-device hub groups
  so a client subscribes to one device instead of filtering all readings client-side.
- A dead-letter exchange for malformed messages.
- For high write volumes — batching instead of SaveChanges per message,
  or adopting TimescaleDB.
