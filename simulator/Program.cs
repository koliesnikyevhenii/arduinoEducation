using System.Globalization;
using MQTTnet;
using MQTTnet.Client;

// Fake telemetry publisher — stands in for the ESP32 so you can drive the
// MQTT -> RabbitMQ -> consumer -> Postgres -> API flow with no hardware.
//
// It publishes over MQTT to the RabbitMQ MQTT plugin (port 1883), exactly like
// the real device: topic "sensors/<device>/<metric>", payload a bare number.
//
// Usage (from the simulator/ folder):
//   dotnet run                                  # every 500ms, forever, default devices
//   dotnet run -- --interval 1000 --count 20    # 20 messages, one per second, then stop
//   dotnet run -- --host localhost --port 1883 --user guest --pass guest
//
// Stop an endless run with Ctrl+C.

var opts = SimOptions.Parse(args);

// Each (device, metric) keeps a value that drifts a little each tick (random walk),
// so the data looks plausible rather than pure noise.
var series = new List<Series>
{
    new("livingroom", "temperature", value: 22.0, min: 18, max: 26, step: 0.3),
    new("livingroom", "humidity",    value: 45.0, min: 35, max: 60, step: 0.8),
    new("kitchen",    "temperature", value: 23.5, min: 19, max: 28, step: 0.3),
    new("bedroom",    "temperature", value: 20.5, min: 17, max: 24, step: 0.3),

    // MPU6050 tilt (lesson 20) — same "esp32" device the firmware uses.
    // Wide swings so the dashboard's Pitch/Roll gauges visibly move.
    new("esp32", "pitch", value: 0.0, min: -90, max: 90, step: 6),
    new("esp32", "roll",  value: 0.0, min: -90, max: 90, step: 6),
};

var factory = new MqttFactory();
using var client = factory.CreateMqttClient();

var clientOptions = new MqttClientOptionsBuilder()
    .WithTcpServer(opts.Host, opts.Port)
    .WithCredentials(opts.User, opts.Pass) // guest/guest works from localhost
    .WithClientId($"telemetry-simulator-{Environment.ProcessId}")
    .WithCleanSession()
    .Build();

// Graceful Ctrl+C.
using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;   // don't kill the process abruptly; let us disconnect cleanly
    cts.Cancel();
};

Console.WriteLine($"Connecting to MQTT at {opts.Host}:{opts.Port} as '{opts.User}'...");
await client.ConnectAsync(clientOptions, cts.Token);
Console.WriteLine("Connected. Publishing readings (Ctrl+C to stop).\n");

var random = new Random();
var sent = 0;

try
{
    while (!cts.IsCancellationRequested)
    {
        foreach (var s in series)
        {
            s.Advance(random);

            var topic = $"sensors/{s.Device}/{s.Metric}";
            var payload = s.Value.ToString("0.0", CultureInfo.InvariantCulture);

            var message = new MqttApplicationMessageBuilder()
                .WithTopic(topic)
                .WithPayload(payload)
                .Build();

            await client.PublishAsync(message, cts.Token);
            Console.WriteLine($"-> {topic} = {payload}");

            sent++;
            if (opts.Count > 0 && sent >= opts.Count)
            {
                Console.WriteLine($"\nReached --count {opts.Count}, stopping.");
                cts.Cancel();
                break;
            }
        }

        if (cts.IsCancellationRequested) break;
        await Task.Delay(opts.IntervalMs, cts.Token);
    }
}
catch (OperationCanceledException)
{
    // normal shutdown via Ctrl+C / --count
}
finally
{
    if (client.IsConnected)
        await client.DisconnectAsync();
    Console.WriteLine($"Disconnected. Sent {sent} message(s).");
}

/// <summary>One simulated metric whose value drifts within [min, max] each tick.</summary>
internal sealed class Series
{
    public string Device { get; }
    public string Metric { get; }
    public double Value { get; private set; }

    private readonly double _min;
    private readonly double _max;
    private readonly double _step;

    public Series(string device, string metric, double value, double min, double max, double step)
    {
        Device = device;
        Metric = metric;
        Value = value;
        _min = min;
        _max = max;
        _step = step;
    }

    /// <summary>Nudge the value by a small random amount, clamped to the range.</summary>
    public void Advance(Random random)
    {
        var delta = (random.NextDouble() * 2 - 1) * _step;
        Value = Math.Clamp(Value + delta, _min, _max);
    }
}

/// <summary>Command-line options with sensible defaults.</summary>
internal sealed record SimOptions(string Host, int Port, string User, string Pass, int IntervalMs, int Count)
{
    public static SimOptions Parse(string[] args)
    {
        string host = "localhost";
        int port = 1883;
        string user = "guest";
        string pass = "guest";
        int interval = 500;   // lively enough for the near-real-time pitch/roll dashboard
        int count = 0; // 0 = endless

        for (var i = 0; i < args.Length - 1; i++)
        {
            switch (args[i])
            {
                case "--host": host = args[++i]; break;
                case "--port": port = int.Parse(args[++i], CultureInfo.InvariantCulture); break;
                case "--user": user = args[++i]; break;
                case "--pass": pass = args[++i]; break;
                case "--interval": interval = int.Parse(args[++i], CultureInfo.InvariantCulture); break;
                case "--count": count = int.Parse(args[++i], CultureInfo.InvariantCulture); break;
            }
        }

        return new SimOptions(host, port, user, pass, interval, count);
    }
}
