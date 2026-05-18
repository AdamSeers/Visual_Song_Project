using ColorApi.ImageBank.Models;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;

namespace ColorApi.ImageBank.Colors;

/// <summary>
/// Turns image bytes into a small palette. Each returned colour carries the
/// fraction of the image's pixels it represents, which is exactly what the
/// later "colours + percentage" search needs.
/// </summary>
public static class PaletteExtractor
{
    public static async Task<List<ImageColor>> ExtractAsync(
        Stream imageStream,
        string imageUuid,
        ColorExtractionOptions opt,
        CancellationToken ct)
    {
        using var image = await Image.LoadAsync<Rgba32>(imageStream, ct);

        image.Mutate(x => x.Resize(new ResizeOptions
        {
            Size = new Size(opt.AnalysisSize, opt.AnalysisSize),
            Mode = ResizeMode.Max,
        }));

        var levels = Math.Clamp(opt.LevelsPerChannel, 2, 32);
        var step = 256.0 / levels;

        // bucket key -> (sumR, sumG, sumB, count)
        var buckets = new Dictionary<int, (long R, long G, long B, int C)>();
        long total = 0;

        image.ProcessPixelRows(accessor =>
        {
            for (var y = 0; y < accessor.Height; y++)
            {
                var rowSpan = accessor.GetRowSpan(y);
                for (var x = 0; x < rowSpan.Length; x++)
                {
                    var px = rowSpan[x];
                    if (px.A < 128) continue; // skip transparent

                    int rb = (int)(px.R / step);
                    int gb = (int)(px.G / step);
                    int bb = (int)(px.B / step);
                    int key = (rb * levels + gb) * levels + bb;

                    var cur = buckets.TryGetValue(key, out var v)
                        ? v
                        : default;
                    buckets[key] = (cur.R + px.R, cur.G + px.G,
                                    cur.B + px.B, cur.C + 1);
                    total++;
                }
            }
        });

        if (total == 0) return [];

        var ordered = buckets.Values
            .OrderByDescending(v => v.C)
            .ToList();

        var result = new List<ImageColor>(opt.MaxColorsPerImage);
        foreach (var v in ordered)
        {
            if (result.Count >= opt.MaxColorsPerImage) break;

            var pct = (double)v.C / total;
            // Always keep the single biggest colour even if below threshold.
            if (pct < opt.MinPercentage && result.Count > 0) break;

            int r = (int)(v.R / v.C);
            int g = (int)(v.G / v.C);
            int b = (int)(v.B / v.C);

            result.Add(new ImageColor
            {
                ImageUuid = imageUuid,
                R = r,
                G = g,
                B = b,
                Hex = $"{r:X2}{g:X2}{b:X2}",
                Percentage = pct,
            });
        }

        return result;
    }
}
