using Microsoft.EntityFrameworkCore;
using ColorApi.ImageBank.Data;
using ColorApi.ImageBank.Models;

namespace ColorApi.ImageBank.Endpoints;

public static class ApiEndpoints
{
    public static void MapApi(this IEndpointRouteBuilder app)
    {
        app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

        app.MapGet("/api/stats", async (AppDbContext db) =>
        {
            var images = await db.Images.CountAsync();
            return Results.Ok(new
            {
                images,
                openAccessImages = await db.Images.CountAsync(i => i.OpenAccess),
                imagesWithColors =
                    await db.Images.CountAsync(i => i.ColorsExtractedAt != null),
                imagesRemaining =
                    await db.Images.CountAsync(i => i.ColorsExtractedAt == null),
                colorRows = await db.Colors.CountAsync(),
            });
        });

        app.MapGet("/api/images/{uuid}", async (string uuid, AppDbContext db) =>
        {
            var img = await db.Images
                .AsNoTracking()
                .Include(i => i.Colors)
                .FirstOrDefaultAsync(i => i.Uuid == uuid);
            return img is null ? Results.NotFound() : Results.Ok(ToDto(img));
        });

        app.MapGet("/api/images/random", async (
            AppDbContext db,
            bool openAccess = true,
            bool withColors = false) =>
        {
            var q = db.Images.AsNoTracking()
                .Include(i => i.Colors)
                .Where(i => i.ViewType == "primary");
            if (openAccess) q = q.Where(i => i.OpenAccess);
            if (withColors) q = q.Where(i => i.ColorsExtractedAt != null);

            var img = await q.OrderBy(_ => EF.Functions.Random())
                             .FirstOrDefaultAsync();
            return img is null ? Results.NotFound() : Results.Ok(ToDto(img));
        });

        app.MapGet("/api/images/{uuid}/raw", async (
            string uuid, AppDbContext db, int size = 800) =>
        {
            var img = await db.Images.AsNoTracking()
                .FirstOrDefaultAsync(i => i.Uuid == uuid);
            return img is null
                ? Results.NotFound()
                : Results.Redirect(img.ImageUrl(size));
        });

        // The colour-search endpoint. Intentionally not implemented yet -
        // this is the "later" step: accept colours + target percentages and
        // return images whose palette is close.
        app.MapGet("/api/images/by-color", (string hex) =>
            Results.Json(new
            {
                error = "not_implemented",
                message = "Colour search is the next step. The colors table " +
                          "is now being populated by the background extractor.",
                requested = hex,
            }, statusCode: StatusCodes.Status501NotImplemented));
    }

    private static object ToDto(PublishedImage i) => new
    {
        i.Uuid,
        viewType = i.ViewType,
        i.Width,
        i.Height,
        openAccess = i.OpenAccess,
        thumbnailUrl = i.IiifThumbUrl,
        imageUrl = i.ImageUrl(800),
        rawEndpoint = $"/api/images/{i.Uuid}/raw",
        colorsExtracted = i.ColorsExtractedAt,
        colors = i.Colors
            .OrderByDescending(c => c.Percentage)
            .Select(c => new
            {
                c.Hex,
                c.R,
                c.G,
                c.B,
                percentage = Math.Round(c.Percentage, 4),
            }),
        assistiveText = i.AssistiveText,
    };
}
