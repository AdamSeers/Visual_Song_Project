using ColorApi.ImageBank.Data;
using Microsoft.EntityFrameworkCore;

namespace ColorApi.ImageBank.Colors;

/// <summary>
/// Finds the image whose extracted palette best corresponds to a set of
/// requested colours + weights.
///
/// Strategy:
///  1. Turn <c>accuracy</c> into an RGB tolerance radius.
///  2. SQL pre-filter: pull only colour rows that fall inside the bounding
///     box of *any* requested colour (uses the (r,g,b) index, so we never
///     load the whole ~800k-row colours table).
///  3. Group the surviving rows by image and score each image in memory
///     with the real Euclidean distance + weight penalty.
///  4. Return the lowest-scoring image.
/// </summary>
public sealed class ColorSearchService(AppDbContext db)
{
    /// <summary>Max RGB distance at accuracy = 0 (very loose).</summary>
    private const double MaxRadius = 45.0;

    /// <summary>Max RGB distance at accuracy = 1 (very strict).</summary>
    private const double MinRadius = 10.0;

    /// <summary>Penalty added when the image has no colour near a requested one.</summary>
    private const double MissingColorPenalty = 100.0;

    /// <summary>Penalty per unit of (saturation x coverage) for vivid colors
    /// the caller didn't request. Higher = stricter "rest must be greyscale".</summary>
    private const double UnwantedColorPenalty = 220.0;

    public async Task<ColorSearchResponse?> SearchAsync(
        ColorSearchRequest req, CancellationToken ct)
    {
        if (req.Colors.Count == 0) return null;

        var accuracy = Math.Clamp(req.Accuracy, 0.0, 1.0);
        // Linear interpolate radius: high accuracy -> small radius.
        var radius = MaxRadius - (MaxRadius - MinRadius) * accuracy;
        var radiusInt = (int)Math.Ceiling(radius);

        // ---- 1. SQL pre-filter -----------------------------------------
        // Build one OR'd bounding-box predicate covering every requested
        // colour. EF translates this to SQL and the (r,g,b) index prunes it.
        var query = db.Colors.AsNoTracking();

        var predicate = PredicateOr(req.Colors, radiusInt);

        var candidateRows = await query
            .Where(predicate)
            .Select(c => new RawColor(c.ImageUuid, c.R, c.G, c.B, c.Percentage))
            .Take(20000)
            .ToListAsync(ct);

        if (candidateRows.Count == 0)
        {
            // Pre-filter found nothing inside any colour box. Rather than giving
            // up (which becomes a 404 and a colour-bar frame), fall back to a
            // bounded sample of the whole table and return the closest match.
            candidateRows = await db.Colors.AsNoTracking()
                .OrderBy(c => c.Id)          // deterministic; any stable order is fine
                .Take(20000)
                .Select(c => new RawColor(c.ImageUuid, c.R, c.G, c.B, c.Percentage))
                .ToListAsync(ct);

            if (candidateRows.Count == 0) return null;   // genuinely empty DB
        }

        // ---- 2. Score each candidate image in memory -------------------
        var scored = new List<(string Uuid, double Score)>();

        foreach (var grp in candidateRows.GroupBy(r => r.ImageUuid))
        {
            var palette = grp.ToList();
            double score = 0;

            foreach (var want in req.Colors)
            {
                double bestDist = double.MaxValue;
                double matchedPct = 0;

                foreach (var have in palette)
                {
                    var d = Distance(want.R, want.G, want.B, have.R, have.G, have.B);
                    if (d < bestDist)
                    {
                        bestDist = d;
                        matchedPct = have.Percentage;
                    }
                }

                if (bestDist > radius)
                {
                    score += MissingColorPenalty * Math.Max(want.Weight, 0.01);
                    continue;
                }

                var weightGap = Math.Abs(want.Weight - matchedPct);
                score += (bestDist * Math.Max(want.Weight, 0.01)) + (weightGap * 50.0);
            }

            // Penalize vivid colors in the image that the caller did NOT ask for.
            // Goal: requested colors pop against a near-greyscale rest of the image.
            foreach (var have in palette)
            {
                // How "colorful" is this palette entry? Greys/blacks/whites have
                // low saturation; vivid colors high. Saturation ~ (max-min)/max.
                int mx = Math.Max(have.R, Math.Max(have.G, have.B));
                int mn = Math.Min(have.R, Math.Min(have.G, have.B));
                double saturation = mx == 0 ? 0.0 : (mx - mn) / (double)mx;

                if (saturation < 0.25)
                    continue;   // already near-neutral, no penalty

                // Is this vivid color one the caller actually wanted? If it's close
                // to any requested color, it's fine. If not, it's an unwanted vivid
                // color and should count against the image.
                double nearestRequested = double.MaxValue;
                foreach (var want in req.Colors)
                {
                    var d = Distance(want.R, want.G, want.B, have.R, have.G, have.B);
                    if (d < nearestRequested) nearestRequested = d;
                }

                if (nearestRequested > radius)
                {
                    // Unwanted vivid color. Penalty scales with how vivid it is and
                    // how much of the image it occupies.
                    score += saturation * have.Percentage * UnwantedColorPenalty;
                }
            }

            scored.Add((grp.Key, score));
        }

        if (scored.Count == 0) return null;

        // Take the top 12 best matches, pick one at random. Same palette no longer
        // always yields the same image, but it's still a good color match.
        var topMatches = scored.OrderBy(s => s.Score).Take(12).ToList();
        var pick = topMatches[Random.Shared.Next(topMatches.Count)];
        var best = (Uuid: (string?)pick.Uuid, Score: pick.Score);

        if (best.Uuid is null) return null;

        // ---- 3. Resolve the winning image to a URL ---------------------
        var img = await db.Images.AsNoTracking()
            .FirstOrDefaultAsync(i => i.Uuid == best.Uuid, ct);
        if (img is null) return null;

        return new ColorSearchResponse
        {
            ImageUrl = img.ImageUrl(800),
            Score = Math.Round(best.Score, 1),
        };
    }

    private static double Distance(int r1, int g1, int b1,
                                   int r2, int g2, int b2)
    {
        double dr = r1 - r2, dg = g1 - g2, dbl = b1 - b2;
        return Math.Sqrt(dr * dr + dg * dg + dbl * dbl);
    }

    /// <summary>
    /// Builds an expression: row is inside the cube around colour A OR
    /// colour B OR ... Each cube is index-friendly (range on r, g, b).
    /// </summary>
    private static System.Linq.Expressions.Expression<Func<Models.ImageColor, bool>>
        PredicateOr(List<ColorQueryItem> colors, int rad)
    {
        var param = System.Linq.Expressions.Expression
            .Parameter(typeof(Models.ImageColor), "c");

        System.Linq.Expressions.Expression? body = null;

        foreach (var col in colors)
        {
            var box = Box(param, "R", col.R, rad);
            box = System.Linq.Expressions.Expression.AndAlso(
                box, Box(param, "G", col.G, rad));
            box = System.Linq.Expressions.Expression.AndAlso(
                box, Box(param, "B", col.B, rad));

            body = body is null
                ? box
                : System.Linq.Expressions.Expression.OrElse(body, box);
        }

        return System.Linq.Expressions.Expression
            .Lambda<Func<Models.ImageColor, bool>>(body!, param);
    }

    private static System.Linq.Expressions.Expression Box(
        System.Linq.Expressions.ParameterExpression p,
        string prop, int center, int rad)
    {
        var member = System.Linq.Expressions.Expression.Property(p, prop);
        var lo = System.Linq.Expressions.Expression.Constant(
            Math.Max(0, center - rad));
        var hi = System.Linq.Expressions.Expression.Constant(
            Math.Min(255, center + rad));
        return System.Linq.Expressions.Expression.AndAlso(
            System.Linq.Expressions.Expression.GreaterThanOrEqual(member, lo),
            System.Linq.Expressions.Expression.LessThanOrEqual(member, hi));
    }

    private readonly record struct RawColor(
        string ImageUuid, int R, int G, int B, double Percentage);
}
