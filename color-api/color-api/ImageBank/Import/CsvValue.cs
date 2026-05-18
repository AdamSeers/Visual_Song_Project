using System.Globalization;
using System.Text.RegularExpressions;

namespace ColorApi.ImageBank.Import;

/// <summary>
/// The NGA CSVs use a few conventions that need careful parsing:
/// blanks for nulls, "1"/"0" for booleans, and timestamps with a short
/// offset like "2013-07-05 15:41:08-04" (no ":00" on the offset).
/// </summary>
internal static partial class CsvValue
{
    [GeneratedRegex(@"([+-]\d{2})$")]
    private static partial Regex ShortOffset();

    public static string? Str(string? v)
        => string.IsNullOrWhiteSpace(v) ? null : v.Trim();

    public static int? Int(string? v)
        => int.TryParse(Str(v), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n)
            ? n
            : null;

    public static bool Bool(string? v)
        => Str(v) is "1" or "true" or "True";

    public static DateTimeOffset? Date(string? v)
    {
        var s = Str(v);
        if (s is null) return null;

        // Normalise "...-04" / "...+05" to "...-04:00" so the parser accepts it.
        s = ShortOffset().Replace(s, "$1:00");

        return DateTimeOffset.TryParse(
            s,
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
            out var dto)
            ? dto
            : null;
    }
}
