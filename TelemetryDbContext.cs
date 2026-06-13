using Microsoft.EntityFrameworkCore;
using TelemetryApi.Domain;

namespace TelemetryApi.Data;

public class TelemetryDbContext : DbContext
{
    public TelemetryDbContext(DbContextOptions<TelemetryDbContext> options)
        : base(options) { }

    public DbSet<SensorReading> SensorReadings => Set<SensorReading>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<SensorReading>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.DeviceId).HasMaxLength(64).IsRequired();
            e.Property(x => x.Metric).HasMaxLength(64).IsRequired();

            // The most frequent dashboard query is "latest values per device".
            // An index on (device_id, recorded_at) serves it.
            e.HasIndex(x => new { x.DeviceId, x.RecordedAt });
        });
    }
}
