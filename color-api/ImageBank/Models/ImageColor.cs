namespace ColorApi.ImageBank.Models;

/// <summary>
/// One colour in an image's palette. An image gets several of these rows.
/// Designed for the later query: "given colours + the fraction of the image
/// each should cover, find images whose palette is close."
/// </summary>
public sealed class ImageColor
{
    public long Id { get; set; }

    /// <summary>FK to <see cref="PublishedImage.Uuid"/>.</summary>
    public string ImageUuid { get; set; } = string.Empty;

    public PublishedImage? Image { get; set; }

    /// <summary>Representative colour channels, 0-255.</summary>
    public int R { get; set; }
    public int G { get; set; }
    public int B { get; set; }

    /// <summary>Uppercase hex without '#', e.g. "A1B2C3".</summary>
    public string Hex { get; set; } = string.Empty;

    /// <summary>
    /// Fraction of the image's pixels that fall in this colour, 0.0-1.0.
    /// This is the "percentage of the image that has this colour".
    /// </summary>
    public double Percentage { get; set; }
}
