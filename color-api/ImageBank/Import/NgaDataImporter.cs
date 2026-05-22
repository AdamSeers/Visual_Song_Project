using System.Diagnostics;
using System.Globalization;
using CsvHelper;
using CsvHelper.Configuration;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using ColorApi.ImageBank.Data;

namespace ColorApi.ImageBank.Import;

/// <summary>
/// Loads the NGA published-images CSV into the local SQLite database.
/// (Objects are no longer imported - this project only deals with images.)
/// Schema is created by EF Core; rows are bulk-inserted with raw ADO.NET in
/// a single transaction, far faster than EF change tracking for ~129k rows.
/// </summary>
public sealed class NgaDataImporter(AppDbContext db, ILogger<NgaDataImporter> log)
{
    private const int ReportEvery = 25_000;

    public async Task RunAsync(string dataDir, CancellationToken ct = default)
    {
        var imagesCsv = Path.Combine(dataDir, "published_images.csv");

        if (!File.Exists(imagesCsv))
        {
            throw new FileNotFoundException(
                $"Expected 'published_images.csv' in '{dataDir}'. " +
                "Run the fetch-data script first.");
        }

        log.LogInformation("Creating schema (if needed)...");
        await db.Database.EnsureCreatedAsync(ct);

        var connectionString = db.Database.GetConnectionString()
            ?? throw new InvalidOperationException("No connection string configured.");

        await using var conn = new SqliteConnection(connectionString);
        await conn.OpenAsync(ct);

        await Exec(conn, "PRAGMA journal_mode=MEMORY;");
        await Exec(conn, "PRAGMA synchronous=OFF;");
        await Exec(conn, "PRAGMA foreign_keys=OFF;");

        var sw = Stopwatch.StartNew();
        var images = await ImportImagesAsync(conn, imagesCsv, ct);
        sw.Stop();

        log.LogInformation(
            "Import complete: {Images:N0} images in {Elapsed:N1}s.",
            images, sw.Elapsed.TotalSeconds);
    }

    private async Task<long> ImportImagesAsync(
        SqliteConnection conn, string path, CancellationToken ct)
    {
        const string sql = """
            INSERT OR REPLACE INTO images
              (uuid, iiif_url, iiif_thumb_url, view_type, sequence,
               width, height, max_pixels, open_access, created, modified,
               assistive_text, colors_extracted_at)
            VALUES ($u,$iu,$itu,$vt,$seq,$w,$h,$mp,$oa,$cr,$mo,$at,NULL);
            """;

        await using var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = sql;
        var p = AddParams(cmd,
            "$u", "$iu", "$itu", "$vt", "$seq", "$w", "$h", "$mp", "$oa",
            "$cr", "$mo", "$at");

        long n = 0;
        foreach (var row in ReadCsv(path))
        {
            var uuid = CsvValue.Str(row["uuid"]);
            if (uuid is null) continue;

            p["$u"].Value = uuid;
            p["$iu"].Value = (object?)CsvValue.Str(row["iiifurl"]) ?? DBNull.Value;
            p["$itu"].Value = (object?)CsvValue.Str(row["iiifthumburl"]) ?? DBNull.Value;
            p["$vt"].Value = (object?)CsvValue.Str(row["viewtype"]) ?? DBNull.Value;
            p["$seq"].Value = (object?)CsvValue.Str(row["sequence"]) ?? DBNull.Value;
            p["$w"].Value = (object?)CsvValue.Int(row["width"]) ?? DBNull.Value;
            p["$h"].Value = (object?)CsvValue.Int(row["height"]) ?? DBNull.Value;
            p["$mp"].Value = (object?)CsvValue.Int(row["maxpixels"]) ?? DBNull.Value;
            p["$oa"].Value = CsvValue.Bool(row["openaccess"]) ? 1 : 0;
            p["$cr"].Value = (object?)CsvValue.Date(row["created"])?.ToString("o") ?? DBNull.Value;
            p["$mo"].Value = (object?)CsvValue.Date(row["modified"])?.ToString("o") ?? DBNull.Value;
            p["$at"].Value = (object?)CsvValue.Str(row["assistivetext"]) ?? DBNull.Value;

            await cmd.ExecuteNonQueryAsync(ct);
            if (++n % ReportEvery == 0) log.LogInformation("  images: {N:N0}", n);
        }

        await tx.CommitAsync(ct);
        return n;
    }

    private static IEnumerable<IDictionary<string, string?>> ReadCsv(string path)
    {
        var cfg = new CsvConfiguration(CultureInfo.InvariantCulture)
        {
            HasHeaderRecord = true,
            DetectColumnCountChanges = false,
            BadDataFound = null,
            MissingFieldFound = null,
            TrimOptions = TrimOptions.None,
        };

        using var reader = new StreamReader(path, detectEncodingFromByteOrderMarks: true);
        using var csv = new CsvReader(reader, cfg);

        csv.Read();
        csv.ReadHeader();
        var headers = csv.HeaderRecord ?? [];

        while (csv.Read())
        {
            var dict = new Dictionary<string, string?>(
                headers.Length, StringComparer.OrdinalIgnoreCase);
            foreach (var h in headers)
                dict[h] = csv.TryGetField<string>(h, out var val) ? val : null;
            yield return dict;
        }
    }

    private static Dictionary<string, SqliteParameter> AddParams(
        SqliteCommand cmd, params string[] names)
    {
        var map = new Dictionary<string, SqliteParameter>(names.Length);
        foreach (var name in names)
        {
            var prm = cmd.CreateParameter();
            prm.ParameterName = name;
            cmd.Parameters.Add(prm);
            map[name] = prm;
        }
        return map;
    }

    private static async Task Exec(SqliteConnection conn, string sql)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        await cmd.ExecuteNonQueryAsync();
    }
}
