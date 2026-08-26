using Microsoft.AspNetCore.SignalR;

namespace TelemetryApi.Realtime;

/// <summary>
/// Real-time push channel for the React dashboard. The API is still read-only over
/// HTTP (writes come from the broker); this hub only pushes freshly-ingested readings
/// out to connected browsers. Clients don't invoke anything on it — they just listen
/// for the "reading" event.
/// </summary>
public class TelemetryHub : Hub
{
}

/// <summary>
/// Shape pushed to the browser for each ingested reading. Deliberately mirrors the
/// columns the dashboard cares about; e.g. metric "pitch"/"roll"/"yaw" for the MPU6050
/// lesson, or "guard" (0/1) for the lesson-22 tilt cutoff — all just numbers here.
/// Serialized as camelCase (see AddJsonProtocol in Program.cs).
/// </summary>
public record ReadingDto(string Device, string Metric, double Value, DateTime RecordedAt);
