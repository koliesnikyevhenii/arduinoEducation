# CLAUDE.md

Baseline guidance for working in this repo. Keep it short; prefer pointers over copies.

> Architecture and feature plans live in `/docs` (to be created). ALWAYS consult `/docs`
> before making a change. If `/docs` is missing or silent on the area you're touching,
> say so rather than guessing.

## What this is

An IoT telemetry + robot-control backend with a live React dashboard. Devices (an ESP32)
publish sensor values over MQTT to RabbitMQ; a background consumer reads them off an AMQP
queue, writes them to PostgreSQL, and pushes each reading to browsers over SignalR; an
ASP.NET Core minimal API exposes read endpoints. The dashboard also **drives** the robot:
commands flow the other way, browser → API → broker → ESP32 → motors.

Telemetry flow (device → us):
`ESP32 --MQTT--> RabbitMQ (mqtt plugin) --AMQP--> TelemetryConsumer --> PostgreSQL`,
and in parallel `TelemetryConsumer --SignalR--> React dashboard` (see `README.md:1`).

Command flow (us → device):
`Browser --HTTP--> RobotEndpoints --AMQP--> RabbitMQ --MQTT--> ESP32 --> TB6612FNG motors`.

The matching firmware lives in a **separate repo** (`../scatchesEsp/esp32-lessons`):
lesson 19 = MQTT telemetry, lesson 20 = MPU6050 pitch/roll/yaw, lesson 21 = motor control,
lesson 22 = both at once (drive + tilt in one sketch, plus a device-side tilt cutoff).
Metrics in play today: `temperature`, `humidity`, `pitch`, `roll`, `yaw`, `guard`.

This is a learning / pet project. Some production shortcuts are accepted on purpose and
flagged below — don't "fix" them without checking intent.

## Tech stack

- **.NET 8**, ASP.NET Core minimal API (`TelemetryApi.csproj`).
- **EF Core + Npgsql** against **PostgreSQL**, with `snake_case` naming (`Program.cs:9`).
- **RabbitMQ.Client 7.x** — async-first API, used both to consume telemetry
  (`TelemetryConsumer.cs`) and to publish robot commands (`RobotCommandPublisher.cs`).
- **SignalR** — real-time push of readings to the dashboard (`TelemetryHub.cs`, hub at
  `/hub/telemetry`, camelCase JSON).
- **Swashbuckle/Swagger** for trying the API in dev (`Program.cs`).
- **docker-compose** brings up RabbitMQ + PostgreSQL (`docker-compose.yml`).
- **MQTTnet** in `simulator/` — a console app that fakes an ESP32 over MQTT
  (`simulator/Program.cs`). Publishes telemetry only (incl. `pitch`/`roll`/`yaw`); it does
  **not** send drive commands.
- **React 18 + Vite + TypeScript** dashboard in `dashboard/`, with `@microsoft/signalr`,
  `recharts` (live chart), and `@react-three/fiber` + `three.js` (3D robot model).

## Repo layout

The **API** is flat at the repo root — no source subfolders. Code is organized by C#
namespace instead of directory:

- `TelemetryApi.Api` — read endpoints (`TelemetryEndpoints.cs`) + robot command endpoints
  (`RobotEndpoints.cs`)
- `TelemetryApi.Data` — `DbContext` (`TelemetryDbContext.cs`)
- `TelemetryApi.Domain` — entities (`SensorReading.cs`)
- `TelemetryApi.Messaging` — broker consumer, command publisher + options
  (`TelemetryConsumer.cs`, `RobotCommandPublisher.cs`, `RabbitMqOptions.cs`)
- `TelemetryApi.Realtime` — SignalR hub + broadcast DTO (`TelemetryHub.cs`)

`Program.cs` is the composition root.

Two subfolders, both **excluded from the Web SDK's globbing** in `TelemetryApi.csproj`:

- **`simulator/`** — a standalone console project (`TelemetrySimulator.csproj`) that publishes
  fake telemetry over MQTT. The API is a `Microsoft.NET.Sdk.Web` project at the repo root and
  globs all `*.cs` recursively, so `simulator/**` is `<Compile Remove>`d to keep the two `Main`
  methods from colliding.
- **`dashboard/`** — the React app. No `.cs`, but its `node_modules/`/`dist/` are removed from
  the SDK's `Content`/`None` globs so the build doesn't scan them.

**NEVER** add another `.cs` project — or any large asset folder like `node_modules` — under
the repo root without a matching `<Compile Remove>` / `<Content Remove>` in the API csproj.

## Hard constraints

- **ALWAYS** set `SensorReading.RecordedAt` to UTC (`DateTimeKind.Utc`). Postgres
  `timestamptz` + Npgsql throw at runtime otherwise. (`SensorReading.cs:19`)
- **NEVER** add telemetry write endpoints to the API. Sensor-reading writes come only from
  the broker via `TelemetryConsumer`; the telemetry API is read-only. (`TelemetryEndpoints.cs:6`)
  (Robot **command** dispatch is a separate concern and *is* allowed: `/api/robot/*` publishes
  to the broker via `RobotCommandPublisher` and never touches PostgreSQL. `RobotEndpoints.cs`)
- **ALWAYS** clamp caller-supplied page sizes. `/latest` clamps `take` to 1–1000; keep
  that bound on any new list endpoint. (`TelemetryEndpoints.cs:29`)
- **ALWAYS** resolve `TelemetryDbContext` from a per-message scope inside the consumer.
  It's a singleton `BackgroundService`; the `DbContext` is scoped. (`TelemetryConsumer.cs:95`)
- **ALWAYS** ack manually after a successful DB write (`autoAck: false`). On failure,
  nack **without requeue** to avoid poison-message loops. (`TelemetryConsumer.cs:71`, `:109`)
- **NEVER** change the routing-key contract `sensors.<device>.<metric>` without updating
  both the parser and the firmware/docs that depend on it. (`TelemetryConsumer.cs:115`)
- **ALWAYS** keep the `(device_id, recorded_at)` index in step with the dominant
  "latest per device" query — don't drop it casually. (`TelemetryDbContext.cs:21`)
- **NEVER** widen CORS beyond what's needed. Only the Vite dev origin
  `http://localhost:5173` is allowed, **with `AllowCredentials()`** (required for the SignalR
  WebSocket handshake — which is why `AllowAnyOrigin()` must never be used here). (`Program.cs`)
- **ALWAYS** broadcast to SignalR only *after* a successful DB write + ack, and never let a
  broadcast failure fail the message (it's already persisted/acked). (`TelemetryConsumer.cs`)
- **NEVER** widen the robot command allowlist without updating the firmware. Only
  `forward`/`back`/`left`/`right`/`stop` are accepted; anything else is a 400.
  (`RobotEndpoints.cs`)
- **NEVER** treat a 202 from `/api/robot/*` as "the robot moved". It means the command
  reached the broker; the device is the authority and may decline (lesson-22 tilt guard).
  (`RobotEndpoints.cs`)

### Accepted pet-project shortcuts (do not "fix" silently)

- Migrations are applied automatically on startup (`Program.cs:30`). Fine here; would be a
  separate step in production.
- Secrets are split: the Postgres password / db are in a git-ignored `.env`
  (template `.env.example`), consumed by `docker-compose.yml` via `${VAR}`; the API's
  Postgres connection string is in **user-secrets** (`appsettings.json` holds the
  `USE_USER_SECRETS` placeholder). RabbitMQ `guest/guest` is still in `appsettings.json` —
  acceptable for local-only use. If this ever leaves localhost, finish moving those out too.
- Postgres is mapped to host port **5433** (`docker-compose.yml`), not the default 5432,
  to avoid colliding with a native Postgres install on the dev machine. The API connects
  via 5433; inside the compose network it's still `postgres:5432`.

## Glossary

- **Routing key** — `sensors.<device>.<metric>`, e.g. `sensors.livingroom.temperature`.
  Body is a bare number like `23.5`. (`TelemetryConsumer.cs:115`)
- **amq.topic** — the topic exchange the RabbitMQ MQTT plugin publishes into; MQTT topic
  levels (`/`) become routing-key segments (`.`). (`RabbitMqOptions.cs:13`)
- **telemetry.ingest** — the durable working queue bound to `amq.topic` with `sensors.#`.
  (`RabbitMqOptions.cs:21`)
- **Metric** — the measured quantity on a reading, e.g. `temperature`, `humidity`.
  (`SensorReading.cs:14`)
- **`guard`** — lesson-22 metric, `0`/`1`: the firmware's tilt cutoff is engaged and the
  device is ignoring drive commands. An *event*, so the device publishes it only when it
  flips (not on the 5 Hz angle timer); the dashboard latches the last value and keeps it out
  of the chart history. Needs no special backend handling — it's just another number.
- **Command routing key** — `commands.<device>.drive`, body a bare word
  (`forward`/`back`/`left`/`right`/`stop`). Published by `RobotCommandPublisher` into
  `amq.topic`; the MQTT plugin delivers it to the ESP32's `commands/<device>/drive`
  subscription. Separate namespace from `sensors.#`. (`RobotCommandPublisher.cs`)

## Running locally

See `README.md` for the up-to-date commands (`docker compose up -d`, then `dotnet ef
migrations add Initial` once, then `dotnet run`; `cd simulator && dotnet run` to generate
fake telemetry without hardware; and `cd dashboard && npm install && npm run dev` for the
live dashboard at `http://localhost:5173`). The dashboard reads the API base URL from
`dashboard/.env` (`VITE_API_URL`, default `http://localhost:54344`). Don't duplicate those
steps here.
