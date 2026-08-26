using System.Text;
using Microsoft.Extensions.Options;
using RabbitMQ.Client;

namespace TelemetryApi.Messaging;

/// <summary>
/// Publishes drive commands to the robot. This is the reverse of <see cref="TelemetryConsumer"/>:
/// the API sends a command into RabbitMQ, the MQTT plugin turns routing key
/// <c>commands.&lt;device&gt;.drive</c> back into MQTT topic <c>commands/&lt;device&gt;/drive</c>,
/// and the ESP32 firmware (lesson 21/22) — subscribed to it — drives the motors.
///
/// NOTE: this is command dispatch, not telemetry. It only publishes to the broker and
/// never writes to PostgreSQL, so the "API is read-only for telemetry" rule still holds.
///
/// Singleton with a lazily-opened AMQP connection. RabbitMQ.Client 7.x channels are not
/// thread-safe, so publishes are serialized through a semaphore (command volume is tiny).
/// </summary>
public sealed class RobotCommandPublisher : IAsyncDisposable
{
    private readonly RabbitMqOptions _options;
    private readonly ILogger<RobotCommandPublisher> _logger;
    private readonly SemaphoreSlim _gate = new(1, 1);

    private IConnection? _connection;
    private IChannel? _channel;

    public RobotCommandPublisher(
        IOptions<RabbitMqOptions> options,
        ILogger<RobotCommandPublisher> logger)
    {
        _options = options.Value;
        _logger = logger;
    }

    public async Task PublishDriveAsync(string device, string command, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await EnsureChannelAsync(ct);

            // Same exchange as telemetry (amq.topic), but a separate routing-key
            // namespace: commands.* — so the telemetry consumer (sensors.#) ignores it.
            var routingKey = $"commands.{device}.drive";
            var body = Encoding.UTF8.GetBytes(command);
            var props = new BasicProperties { DeliveryMode = DeliveryModes.Transient };

            await _channel!.BasicPublishAsync(
                exchange: _options.Exchange,
                routingKey: routingKey,
                mandatory: false,
                basicProperties: props,
                body: body,
                cancellationToken: ct);

            _logger.LogInformation("Robot command -> {RoutingKey} = {Command}", routingKey, command);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task EnsureChannelAsync(CancellationToken ct)
    {
        if (_channel is { IsOpen: true }) return;

        // A previous connection/channel died — tear it down before reconnecting.
        if (_channel is not null) { try { await _channel.DisposeAsync(); } catch { /* ignore */ } _channel = null; }
        if (_connection is not null) { try { await _connection.DisposeAsync(); } catch { /* ignore */ } _connection = null; }

        var factory = new ConnectionFactory
        {
            HostName = _options.Host,
            Port = _options.Port,
            UserName = _options.User,
            Password = _options.Password,
            VirtualHost = _options.VirtualHost
        };

        _connection = await factory.CreateConnectionAsync(ct);
        _channel = await _connection.CreateChannelAsync(cancellationToken: ct);
    }

    public async ValueTask DisposeAsync()
    {
        if (_channel is not null) await _channel.DisposeAsync();
        if (_connection is not null) await _connection.DisposeAsync();
        _gate.Dispose();
    }
}
