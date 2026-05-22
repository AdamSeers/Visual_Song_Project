namespace ColorApi.ImageBank.Models;

/// <summary>
/// A published image (IIIF asset) from the NGA. Maps
/// <c>data/published_images.csv</c>.
///
/// <see cref="ColorsExtractedAt"/> is the "is this image linked with a colours
/// object yet" marker: null means the colour extractor hasn't processed it.
/// </summary>
public sealed class PublishedImage
{
    /// <summary>Persistent GUID for the image (primary key).</summary>
    public string Uuid { get; set; } = string.Empty;

    /// <summary>Base IIIF Image API URL, e.g. https://api.nga.gov/iiif/{uuid}</summary>
    public string? IiifUrl { get; set; }

    /// <summary>Pre-built ~200x200 thumbnail URL.</summary>
    public string? IiifThumbUrl { get; set; }

    /// <summary>"primary" or "alternate".</summary>
    public string? ViewType { get; set; }

    public string? Sequence { get; set; }

    public int? Width { get; set; }

    public int? Height { get; set; }

    public int? MaxPixels { get; set; }

    /// <summary>True when usable with no restrictions under the NGA open-access policy.</summary>
    public bool OpenAccess { get; set; }

    /// <summary>Source creation timestamp, kept as the original ISO text.</summary>
    public string? Created { get; set; }

    /// <summary>Source modification timestamp, kept as the original ISO text.</summary>
    public string? Modified { get; set; }

    public string? AssistiveText { get; set; }

    /// <summary>
    /// When the colour palette was extracted. Null = not yet linked with a
    /// colours object; the background extractor will pick it up.
    /// </summary>
    public DateTimeOffset? ColorsExtractedAt { get; set; }

    /// <summary>The extracted palette for this image (one row per colour).</summary>
    public ICollection<ImageColor> Colors { get; set; } = new List<ImageColor>();

    /// <summary>IIIF "render at size" JPEG URL fitting a size x size box.</summary>
    public string ImageUrl(int size = 800)
    {
        var baseUrl = !string.IsNullOrWhiteSpace(IiifUrl)
            ? IiifUrl!.TrimEnd('/')
            : $"https://api.nga.gov/iiif/{Uuid}";
        var clamped = Math.Clamp(size, 32, 4000);
        return $"{baseUrl}/full/!{clamped},{clamped}/0/default.jpg";
    }

    /// <summary>Small URL used for colour analysis (cheap to download).</summary>
    public string ThumbUrl(int size = 120)
        => !string.IsNullOrWhiteSpace(IiifThumbUrl) && size <= 200
            ? IiifThumbUrl!
            : ImageUrl(size);
}
