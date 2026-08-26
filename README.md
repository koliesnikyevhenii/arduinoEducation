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
- **Dashboard:** the *Drive* panel (hold a button, or arrow keys / WASD). While a direction is
  held the browser resends the command every 300 ms; on release it sends `stop`. The firmware has
  a **failsafe** — if it hears nothing for 700 ms it stops the motors, so a closed tab or dropped
  Wi-Fi can't leave the robot running.

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
- The device publishes `guard` **only when it flips** (an event), not on the 5 Hz timer the
  angles use (a measurement stream) — so it costs a couple of rows per session, not 5/sec.
- The dashboard latches it: the *Drive* pad greys out and shows **TILT GUARD — commands
  ignored** instead of the active direction. `useTelemetry` returns it as `guard: boolean | null`
  and deliberately keeps it out of the chart history.
- `POST /api/robot/{device}/drive` still answers **202 Accepted** — we only know the command
  reached the broker; with the tilt guard tripped the device may well decline to act on it.

The simulator doesn't publish `guard`, so the badge stays dark without the real robot.

## Where to extend next

- `TelemetryConsumer.ParseReading` — the payload format (switch to JSON).
- `Domain/SensorReading` — add fields (qos, raw payload in jsonb).
- `Api/TelemetryEndpoints` — aggregates (hourly average), pagination.
- SignalR push is live (`TelemetryHub`, `/hub/telemetry`). Next: per-device hub groups
  so a client subscribes to one device instead of filtering all readings client-side.
- A dead-letter exchange for malformed messages.
- For high write volumes — batching instead of SaveChanges per message,
  or adopting TimescaleDB.
