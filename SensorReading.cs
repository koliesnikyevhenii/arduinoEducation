namespace TelemetryApi.Domain;

/// <summary>
/// A single sensor reading. A denormalized "flat" model,
/// convenient both for writing from the broker and for reading by the frontend.
/// </summary>
public class SensorReading
{
    public long Id { get; set; }

    /// <summary>Device identifier, e.g. "livingroom".</summary>
    public string DeviceId { get; set; } = default!;

    /// <summary>Metric, e.g. "temperature", "humidity".</summary>
    public string Metric { get; set; } = default!;

    public double Value { get; set; }

    /// <summary>
    /// Time the reading was recorded. ALWAYS in UTC: the PostgreSQL timestamptz type + Npgsql
    /// require DateTimeKind.Utc, otherwise there will be a runtime error on write.
    /// </summary>
    public DateTime RecordedAt { get; set; }
}
