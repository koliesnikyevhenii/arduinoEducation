# CLAUDE.md

Baseline guidance for working in this repo. Keep it short; prefer pointers over copies.

> Architecture and feature plans live in `/docs` (to be created). ALWAYS consult `/docs`
> before making a change. If `/docs` is missing or silent on the area you're touching,
> say so rather than guessing.

## What this is

An IoT telemetry backend. Devices (e.g. an ESP32) publish sensor values over MQTT to
RabbitMQ; a background consumer reads them off an AMQP queue and writes them to PostgreSQL;
an ASP.NET Core minimal API exposes read endpoints for a future React frontend.

Flow: `ESP32 --MQTT--> RabbitMQ (mqtt plugin) --AMQP--> TelemetryConsumer --> PostgreSQL`,
with the read API alongside (see `README.md:1`).

This is a learning / pet project. Some production shortcuts are accepted on purpose and
flagged below — don't "fix" them without checking intent.

## Tech stack

- **.NET 8**, ASP.NET Core minimal API (`TelemetryApi.csproj`).
- **EF Core + Npgsql** against **PostgreSQL**, with `snake_case` naming (`Program.cs:9`).
- **RabbitMQ.Client 7.x** — async-first API (`TelemetryConsumer.cs:14`).
- **Swashbuckle/Swagger** for trying the API in dev (`Program.cs:38`).
- **docker-compose** brings up RabbitMQ + PostgreSQL (`docker-compose.yml`).
- **MQTTnet** in `simulator/` — a console app that fakes an ESP32 over MQTT
  (`simulator/Program.cs`).

## Repo layout

The **API** is flat at the repo root — no source subfolders. Code is organized by C#
namespace instead of directory:

- `TelemetryApi.Api` — read endpoints (`TelemetryEndpoints.cs`)
- `TelemetryApi.Data` — `DbContext` (`TelemetryDbContext.cs`)
- `TelemetryApi.Domain` — entities (`SensorReading.cs`)
- `TelemetryApi.Messaging` — broker consumer + options (`TelemetryConsumer.cs`, `RabbitMqOptions.cs`)

`Program.cs` is the composition root.

The only subfolder is **`simulator/`** — a standalone console project (`TelemetrySimulator.csproj`)
that publishes fake readings over MQTT. Because the API is a `Microsoft.NET.Sdk.Web` project
at the repo root, it globs all `*.cs` recursively; `simulator/**` is explicitly excluded in
`TelemetryApi.csproj` so the two `Main` methods don't collide. **NEVER** add another `.cs`
project under the repo root without a matching `<Compile Remove>` in the API csproj.

## Hard constraints

- **ALWAYS** set `SensorReading.RecordedAt` to UTC (`DateTimeKind.Utc`). Postgres
  `timestamptz` + Npgsql throw at runtime otherwise. (`SensorReading.cs:19`)
- **NEVER** add telemetry write endpoints to the API. Writes come only from the broker
  via `TelemetryConsumer`; the API is read-only. (`TelemetryEndpoints.cs:6`)
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
  `http://localhost:5173` is allowed today. (`Program.cs:21`)

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

## Running locally

See `README.md` for the up-to-date commands (`docker compose up -d`, then `dotnet ef
migrations add Initial` once, then `dotnet run`; and `cd simulator && dotnet run` to
generate fake telemetry without hardware). Don't duplicate those steps here.
