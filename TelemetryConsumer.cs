using System.Globalization;
using System.Text;
using Microsoft.Extensions.Options;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;
using TelemetryApi.Data;
using TelemetryApi.Domain;

namespace TelemetryApi.Messaging;

/// <summary>
/// Listens to the RabbitMQ queue into which the MQTT plugin places
/// device telemetry, and writes the readings to PostgreSQL.
/// Written for RabbitMQ.Client 7.x (fully asynchronous API).
/// </summary>
public class TelemetryConsumer : BackgroundService
{
    private readonly RabbitMqOptions _options;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<TelemetryConsumer> _logger;

    private IConnection? _connection;
    private IChannel? _channel;

    public TelemetryConsumer(
        IOptions<RabbitMqOptions> options,
        IServiceScopeFactory scopeFactory,
        ILogger<TelemetryConsumer> logger)
    {
        _options = options.Value;
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var factory = new ConnectionFactory
        {
            HostName = _options.Host,
            Port = _options.Port,
            UserName = _options.User,
            Password = _options.Password,
            VirtualHost = _options.VirtualHost
        };

        _connection = await factory.CreateConnectionAsync(stoppingToken);
        _channel = await _connection.CreateChannelAsync(cancellationToken: stoppingToken);

        // Declare the queue and bind it to amq.topic using our routing key.
        await _channel.QueueDeclareAsync(
            queue: _options.Queue,
            durable: true,
            exclusive: false,
            autoDelete: false,
            cancellationToken: stoppingToken);

        await _channel.QueueBindAsync(
            queue: _options.Queue,
            exchange: _options.Exchange,
            routingKey: _options.RoutingKey,
            cancellationToken: stoppingToken);

        // Do not hand the consumer more than 50 unacknowledged messages at a time.
        await _channel.BasicQosAsync(0, 50, false, stoppingToken);

        var consumer = new AsyncEventingBasicConsumer(_channel);
        consumer.ReceivedAsync += OnMessageAsync;

        await _channel.BasicConsumeAsync(
            queue: _options.Queue,
            autoAck: false,            // acknowledge manually after writing to the DB
            consumer: consumer,
            cancellationToken: stoppingToken);

        _logger.LogInformation("Telemetry consumer started, queue '{Queue}'", _options.Queue);

        // Keep the service alive until the application stops.
        try
        {
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            // normal shutdown
        }
    }

    private async Task OnMessageAsync(object sender, BasicDeliverEventArgs ea)
    {
        try
        {
            // The body is only valid during processing -> parse it right away.
            var reading = ParseReading(ea.RoutingKey, ea.Body.Span);

            // BackgroundService is a singleton, while DbContext is scoped,
            // so create a scope per message.
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<TelemetryDbContext>();

            db.SensorReadings.Add(reading);
            await db.SaveChangesAsync();

            await _channel!.BasicAckAsync(ea.DeliveryTag, multiple: false);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to process message, routing key '{Key}'", ea.RoutingKey);

            // requeue: false — don't loop a malformed message forever.
            // Extension point: configure a dead-letter exchange.
            await _channel!.BasicNackAsync(ea.DeliveryTag, multiple: false, requeue: false);
        }
    }

    /// <summary>
    /// Contract: routing key = sensors.&lt;device&gt;.&lt;metric&gt;, body = a number ("23.5").
    /// This is exactly what the sample ESP32 firmware sends. If you want to send JSON,
    /// only this method needs to change.
    /// </summary>
    private static SensorReading ParseReading(string routingKey, ReadOnlySpan<byte> body)
    {
        var parts = routingKey.Split('.');
        var device = parts.Length > 1 ? parts[1] : "unknown";
        var metric = parts.Length > 2 ? parts[2] : "unknown";

        var raw = Encoding.UTF8.GetString(body);
        var value = double.Parse(raw, CultureInfo.InvariantCulture);

        return new SensorReading
        {
            DeviceId = device,
            Metric = metric,
            Value = value,
            RecordedAt = DateTime.UtcNow   // UTC is required for timestamptz
        };
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        if (_channel is not null)
            await _channel.CloseAsync(cancellationToken);
        if (_connection is not null)
            await _connection.CloseAsync(cancellationToken);

        await base.StopAsync(cancellationToken);
    }

    public override void Dispose()
    {
        _channel?.Dispose();
        _connection?.Dispose();
        base.Dispose();
        GC.SuppressFinalize(this);
    }
}
