using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TelemetryApi.Api;
using TelemetryApi.Data;
using TelemetryApi.Messaging;
using TelemetryApi.Realtime;

var builder = WebApplication.CreateBuilder(args);

// --- PostgreSQL + snake_case naming ---
builder.Services.AddDbContext<TelemetryDbContext>(opt =>
    opt.UseNpgsql(builder.Configuration.GetConnectionString("Postgres"))
       .UseSnakeCaseNamingConvention());

// --- RabbitMQ consumer ---
builder.Services.Configure<RabbitMqOptions>(
    builder.Configuration.GetSection(RabbitMqOptions.SectionName));
builder.Services.AddHostedService<TelemetryConsumer>();

// --- Robot command dispatch (browser -> broker -> ESP32). Not telemetry. ---
builder.Services.AddSingleton<RobotCommandPublisher>();

// --- SignalR: pushes freshly-ingested readings (e.g. pitch/roll) to the dashboard ---
// camelCase so the TS client sees { device, metric, value, recordedAt }.
builder.Services.AddSignalR()
    .AddJsonProtocol(o =>
        o.PayloadSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);

// --- API + Swagger + CORS for the React app (Vite dev server) ---
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
// SignalR's WebSocket handshake sends credentials, so the policy needs
// AllowCredentials() — which requires an explicit origin (no AllowAnyOrigin).
builder.Services.AddCors(o => o.AddPolicy("react", p =>
    p.WithOrigins("http://localhost:5173")
     .AllowAnyHeader()
     .AllowAnyMethod()
     .AllowCredentials()));

var app = builder.Build();

// Apply migrations on startup — convenient for a pet project.
// (In production this is usually not done; migrations are run as a separate step.)
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<TelemetryDbContext>();
    await db.Database.MigrateAsync();
}

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseCors("react");
app.MapTelemetryEndpoints();
app.MapRobotEndpoints();
app.MapHub<TelemetryHub>("/hub/telemetry");

app.Run();
