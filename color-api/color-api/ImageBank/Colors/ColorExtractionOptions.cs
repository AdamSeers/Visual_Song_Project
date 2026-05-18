namespace ColorApi.ImageBank.Colors;

/// <summary>
/// Tunables for the background colour extractor. Bind from the
/// "ColorExtraction" config section, or just rely on these defaults.
/// </summary>
public sealed class ColorExtractionOptions
{
    /// <summary>Turn the whole background crawl on/off.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Only process open-access images. Default: process all.</summary>
    public bool OpenAccessOnly { get; set; } = false;

    /// <summary>Only the "primary" view of each artwork (skip alternates).</summary>
    public bool PrimaryViewOnly { get; set; } = true;

    /// <summary>Images pulled from the DB per pass.</summary>
    public int BatchSize { get; set; } = 200;

    /// <summary>Parallel image downloads (be polite to api.nga.gov).</summary>
    public int MaxConcurrentDownloads { get; set; } = 4;

    /// <summary>Longest edge the thumbnail is resized to before analysis.</summary>
    public int AnalysisSize { get; set; } = 100;

    /// <summary>Levels per RGB channel when bucketing colours (higher = finer).</summary>
    public int LevelsPerChannel { get; set; } = 6;

    /// <summary>Max palette entries kept per image.</summary>
    public int MaxColorsPerImage { get; set; } = 8;

    /// <summary>Drop palette colours covering less than this fraction (0-1).</summary>
    public double MinPercentage { get; set; } = 0.02;

    /// <summary>Pause between passes, milliseconds.</summary>
    public int DelayBetweenBatchesMs { get; set; } = 250;

    /// <summary>Stop after this many images in one process run. 0 = no cap.</summary>
    public int MaxImagesPerRun { get; set; } = 0;

    /// <summary>Per-image HTTP timeout, seconds.</summary>
    public int RequestTimeoutSeconds { get; set; } = 30;
}
