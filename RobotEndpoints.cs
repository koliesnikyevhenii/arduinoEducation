using TelemetryApi.Messaging;

namespace TelemetryApi.Api;

/// <summary>
/// Robot control endpoints — command dispatch, NOT telemetry. These publish to the
/// broker (see <see cref="RobotCommandPublisher"/>); they never write to the database.
/// The browser calls this to drive the ESP32 (lesson 21, and lesson 22 where the same
/// firmware also streams tilt back).
/// </summary>
public static class RobotEndpoints
{
    // Exactly the commands the firmware understands. Anything else is rejected.
    private static readonly HashSet<string> Allowed =
        new(StringComparer.OrdinalIgnoreCase) { "forward", "back", "left", "right", "stop" };

    public record DriveRequest(string Command);

    public static void MapRobotEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/robot").WithTags("Robot");

        group.MapPost("/{device}/drive", async (
            string device,
            DriveRequest body,
            RobotCommandPublisher publisher,
            CancellationToken ct) =>
        {
            var command = body.Command?.Trim().ToLowerInvariant() ?? "";
            if (!Allowed.Contains(command))
                return Results.BadRequest(
                    new { error = $"command must be one of: {string.Join(", ", Allowed)}" });

            await publisher.PublishDriveAsync(device, command, ct);

            // 202, deliberately: we only know the command reached the broker. The device
            // may legitimately not act on it — the lesson-22 firmware ignores movement
            // commands while its tilt guard is tripped (it reports that as metric "guard").
            return Results.Accepted($"/api/robot/{device}/drive", new { device, command });
        });
    }
}
