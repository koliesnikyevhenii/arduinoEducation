using Microsoft.EntityFrameworkCore;
using TelemetryApi.Data;

namespace TelemetryApi.Api;

/// <summary>
/// Read endpoints — these are what React will call later.
/// Writes don't go here; they come from the broker (TelemetryConsumer).
/// </summary>
public static class TelemetryEndpoints
{
    public static void MapTelemetryEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/telemetry").WithTags("Telemetry");

        // The latest N readings, optionally for a specific device.
        group.MapGet("/latest", async (
            TelemetryDbContext db,
            string? device,
            int take = 100) =>
        {
            var query = db.SensorReadings.AsNoTracking();

            if (!string.IsNullOrWhiteSpace(device))
                query = query.Where(r => r.DeviceId == device);

            var items = await query
                .OrderByDescending(r => r.RecordedAt)
                .Take(Math.Clamp(take, 1, 1000))
                .ToListAsync();

            return Results.Ok(items);
        });

        // The list of devices that have ever sent data.
        group.MapGet("/devices", async (TelemetryDbContext db) =>
        {
            var devices = await db.SensorReadings
                .AsNoTracking()
                .Select(r => r.DeviceId)
                .Distinct()
                .ToListAsync();

            return Results.Ok(devices);
        });
    }
}
