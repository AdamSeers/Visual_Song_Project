namespace ColorApi.ImageBank.Colors;

/// <summary>One requested colour and how much of the image should be it.</summary>
public sealed class ColorQueryItem
{
    public int R { get; set; }
    public int G { get; set; }
    public int B { get; set; }

    /// <summary>
    /// Desired fraction of the image in this colour (0.0-1.0). Matches the
    /// "weight" field in the request body. Weights don't have to sum to 1.
    /// </summary>
    public double Weight { get; set; }
}

/// <summary>
/// POST /api/colors body.
/// </summary>
public sealed class ColorSearchRequest
{
    /// <summary>
    /// 0.0-1.0. How strictly a stored colour must match a requested one.
    /// Low  = a requested red also accepts orange / magenta (wide tolerance).
    /// High = only near-exact reds count (narrow tolerance).
    /// </summary>
    public double Accuracy { get; set; } = 0.7;

    public List<ColorQueryItem> Colors { get; set; } = [];
}

/// <summary>
/// POST /api/colors response. <c>Score</c> is a penalty: lower is better,
/// and the returned image is the lowest-scoring (best) match.
/// </summary>
public sealed class ColorSearchResponse
{
    public string ImageUrl { get; set; } = string.Empty;
    public double Score { get; set; }
}
