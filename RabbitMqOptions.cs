namespace TelemetryApi.Messaging;

public class RabbitMqOptions
{
    public const string SectionName = "RabbitMq";

    public string Host { get; set; } = "localhost";
    public int Port { get; set; } = 5672;           // AMQP port (not MQTT!)
    public string User { get; set; } = "guest";
    public string Password { get; set; } = "guest";
    public string VirtualHost { get; set; } = "/";

    // By default the RabbitMQ MQTT plugin routes MQTT messages
    // into the "amq.topic" topic exchange. MQTT topic levels separated by "/"
    // are turned into a routing key with "." as the separator:
    //   MQTT topic  sensors/livingroom/temperature
    //   routing key sensors.livingroom.temperature
    public string Exchange { get; set; } = "amq.topic";

    // Our working queue that we bind to.
    public string Queue { get; set; } = "telemetry.ingest";

    // "#" matches any number of levels -> all sensors.*
    public string RoutingKey { get; set; } = "sensors.#";
}
