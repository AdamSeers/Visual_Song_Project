using Microsoft.EntityFrameworkCore;
using ColorApi.ImageBank.Colors;
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

        // The colour search. Body = accuracy + list of {r,g,b,weight}.
        // Returns the single best-corresponding image and its score
        // (lower score = better match).
        app.MapPost("/api/colors", async (
            ColorSearchRequest body,
            ColorSearchService search,
            CancellationToken ct) =>
        {
            if (body.Colors is null || body.Colors.Count == 0)
                return Results.BadRequest(new { error = "Provide at least one colour." });

            var result = await search.SearchAsync(body, ct);
            return result is null
                ? Results.NotFound(new { error = "No matching image found." })
                : Results.Ok(new
                {
                    image_url = result.ImageUrl,
                    score = result.Score,
                });
        });
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
