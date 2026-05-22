using Microsoft.EntityFrameworkCore;
using ColorApi.ImageBank.Models;

namespace ColorApi.ImageBank.Data;

public sealed class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<PublishedImage> Images => Set<PublishedImage>();
    public DbSet<ImageColor> Colors => Set<ImageColor>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<PublishedImage>(e =>
        {
            e.ToTable("images");
            e.HasKey(x => x.Uuid);
            e.Property(x => x.Uuid).HasColumnName("uuid");
            e.Property(x => x.IiifUrl).HasColumnName("iiif_url");
            e.Property(x => x.IiifThumbUrl).HasColumnName("iiif_thumb_url");
            e.Property(x => x.ViewType).HasColumnName("view_type");
            e.Property(x => x.Sequence).HasColumnName("sequence");
            e.Property(x => x.Width).HasColumnName("width");
            e.Property(x => x.Height).HasColumnName("height");
            e.Property(x => x.MaxPixels).HasColumnName("max_pixels");
            e.Property(x => x.OpenAccess).HasColumnName("open_access");
            e.Property(x => x.Created).HasColumnName("created");
            e.Property(x => x.Modified).HasColumnName("modified");
            e.Property(x => x.AssistiveText).HasColumnName("assistive_text");
            e.Property(x => x.ColorsExtractedAt).HasColumnName("colors_extracted_at");

            e.HasIndex(x => x.OpenAccess);
            e.HasIndex(x => x.ViewType);
            e.HasIndex(x => x.ColorsExtractedAt); // find unprocessed images fast
        });

        b.Entity<ImageColor>(e =>
        {
            e.ToTable("colors");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id").ValueGeneratedOnAdd();
            e.Property(x => x.ImageUuid).HasColumnName("image_uuid");
            e.Property(x => x.R).HasColumnName("r");
            e.Property(x => x.G).HasColumnName("g");
            e.Property(x => x.B).HasColumnName("b");
            e.Property(x => x.Hex).HasColumnName("hex").HasMaxLength(6);
            e.Property(x => x.Percentage).HasColumnName("percentage");

            e.HasOne(x => x.Image)
                .WithMany(i => i.Colors)
                .HasForeignKey(x => x.ImageUuid)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasIndex(x => x.ImageUuid);
            // Composite index on the channels: lets the future "colours near X"
            // query range-prune instead of scanning every row.
            e.HasIndex(x => new { x.R, x.G, x.B });
        });
    }
}
