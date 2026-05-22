using ColorApi.ImageBank.Data;
using ColorApi.ImageBank.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace ColorApi.ImageBank.Colors;

/// <summary>
/// Runs in the background while the API is up. It repeatedly grabs images
/// that aren't linked with a colours object yet (colors_extracted_at IS NULL),
/// extracts a palette for each, writes the <c>colors</c> rows, and stamps the
/// image as processed. Resumable: stop/restart any time and it continues.
/// </summary>
public sealed class ColorExtractionService(
    IServiceScopeFactory scopeFactory,
    IHttpClientFactory httpFactory,
    IOptions<ColorExtractionOptions> options,
    ILogger<ColorExtractionService> log)
    : BackgroundService
{
    private readonly ColorExtractionOptions _opt = options.Value;
    private readonly HashSet<string> _failed = new();

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (!_opt.Enabled)
        {
            log.LogInformation("Colour extraction is disabled.");
            return;
        }

        // Let the web host finish starting before we hammer the network.
        try { await Task.Delay(TimeSpan.FromSeconds(3), ct); }
        catch (OperationCanceledException) { return; }

        log.LogInformation("Colour extraction started.");
        var processed = 0;

        while (!ct.IsCancellationRequested)
        {
            List<PublishedImage> batch;
            using (var scope = scopeFactory.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                batch = await BuildQuery(db)
                    .OrderBy(i => i.Uuid)
                    .Take(_opt.BatchSize)
                    .ToListAsync(ct);
            }

            if (batch.Count == 0)
            {
                log.LogInformation(
                    "No more images to process. {Count} done this run.", processed);
                break;
            }

            var sem = new SemaphoreSlim(Math.Max(1, _opt.MaxConcurrentDownloads));
            var tasks = batch.Select(img => ProcessOneAsync(img, sem, ct));
            var results = await Task.WhenAll(tasks);

            var ok = results.Where(r => r is not null).Cast<ImageResult>().ToList();

            if (ok.Count > 0)
            {
                using var scope = scopeFactory.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                var now = DateTimeOffset.UtcNow;

                foreach (var r in ok)
                {
                    db.Colors.AddRange(r.Colors);
                    // Stamp the image as linked without reloading it.
                    var stub = new PublishedImage { Uuid = r.Uuid };
                    db.Images.Attach(stub);
                    stub.ColorsExtractedAt = now;
                    db.Entry(stub).Property(x => x.ColorsExtractedAt).IsModified = true;
                }

                await db.SaveChangesAsync(ct);
                processed += ok.Count;
                log.LogInformation(
                    "Palettes written: {Batch} (total this run: {Total})",
                    ok.Count, processed);
            }
            else
            {
                // Whole batch failed (network down?). Don't spin hot.
                log.LogWarning("Batch produced no palettes; backing off.");
                try { await Task.Delay(TimeSpan.FromSeconds(10), ct); }
                catch (OperationCanceledException) { break; }
            }

            if (_opt.MaxImagesPerRun > 0 && processed >= _opt.MaxImagesPerRun)
            {
                log.LogInformation(
                    "Reached MaxImagesPerRun ({Max}); stopping.",
                    _opt.MaxImagesPerRun);
                break;
            }

            if (_opt.DelayBetweenBatchesMs > 0)
            {
                try { await Task.Delay(_opt.DelayBetweenBatchesMs, ct); }
                catch (OperationCanceledException) { break; }
            }
        }
    }

    private IQueryable<PublishedImage> BuildQuery(AppDbContext db)
    {
        var q = db.Images.AsNoTracking().Where(i => i.ColorsExtractedAt == null);

        if (_opt.OpenAccessOnly) q = q.Where(i => i.OpenAccess);
        if (_opt.PrimaryViewOnly) q = q.Where(i => i.ViewType == "primary");

        // Skip images that have already failed this process lifetime so the
        // queue can drain instead of retrying the same broken ones forever.
        if (_failed.Count > 0)
        {
            var failed = _failed; // captured for translation
            q = q.Where(i => !failed.Contains(i.Uuid));
        }

        return q;
    }

    private async Task<ImageResult?> ProcessOneAsync(
        PublishedImage img, SemaphoreSlim sem, CancellationToken ct)
    {
        await sem.WaitAsync(ct);
        try
        {
            var client = httpFactory.CreateClient(nameof(ColorExtractionService));
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(_opt.RequestTimeoutSeconds));

            var bytes = await client.GetByteArrayAsync(
                img.ThumbUrl(_opt.AnalysisSize), cts.Token);

            using var ms = new MemoryStream(bytes);
            var colors = await PaletteExtractor.ExtractAsync(
                ms, img.Uuid, _opt, cts.Token);

            if (colors.Count == 0)
            {
                MarkFailed(img.Uuid);
                return null;
            }

            return new ImageResult(img.Uuid, colors);
        }
        catch (Exception ex) when (ex is not OperationCanceledException
                                   || !ct.IsCancellationRequested)
        {
            log.LogDebug("Failed {Uuid}: {Msg}", img.Uuid, ex.Message);
            MarkFailed(img.Uuid);
            return null;
        }
        finally
        {
            sem.Release();
        }
    }

    private void MarkFailed(string uuid)
    {
        lock (_failed) { _failed.Add(uuid); }
    }

    private sealed record ImageResult(string Uuid, List<ImageColor> Colors);
}
