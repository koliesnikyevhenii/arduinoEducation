# TelemetryApi

Backend for IoT telemetry:

```
ESP32 --MQTT--> RabbitMQ (rabbitmq_mqtt plugin) --AMQP--> TelemetryConsumer --> PostgreSQL
                                                                ↕
                                                  ASP.NET Core API --> (later) React
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

## Where to extend next

- `TelemetryConsumer.ParseReading` — the payload format (switch to JSON).
- `Domain/SensorReading` — add fields (qos, raw payload in jsonb).
- `Api/TelemetryEndpoints` — aggregates (hourly average), pagination, SignalR
  for pushing fresh data to React in real time.
- A dead-letter exchange for malformed messages.
- For high write volumes — batching instead of SaveChanges per message,
  or adopting TimescaleDB.
