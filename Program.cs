using Microsoft.EntityFrameworkCore;
using TelemetryApi.Api;
using TelemetryApi.Data;
using TelemetryApi.Messaging;

var builder = WebApplication.CreateBuilder(args);

// --- PostgreSQL + snake_case naming ---
builder.Services.AddDbContext<TelemetryDbContext>(opt =>
    opt.UseNpgsql(builder.Configuration.GetConnectionString("Postgres"))
       .UseSnakeCaseNamingConvention());

// --- RabbitMQ consumer ---
builder.Services.Configure<RabbitMqOptions>(
    builder.Configuration.GetSection(RabbitMqOptions.SectionName));
builder.Services.AddHostedService<TelemetryConsumer>();

// --- API + Swagger + CORS for the future React app (Vite dev server) ---
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.AddCors(o => o.AddPolicy("react", p =>
    p.WithOrigins("http://localhost:5173")
     .AllowAnyHeader()
     .AllowAnyMethod()));

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

app.Run();
