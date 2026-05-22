using ColorApi.ImageBank.Data;
using ColorApi.ImageBank.Endpoints;
using ColorApi.ImageBank.Import;
using Microsoft.EntityFrameworkCore;
using ColorApi.ImageBank.Colors;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.

builder.Services.AddControllers();
// Learn more about configuring OpenAPI at https://aka.ms/aspnet/openapi
builder.Services.AddOpenApi();

builder.Services.AddDbContext<AppDbContext>(opt =>
    opt.UseSqlite(builder.Configuration.GetConnectionString("Default")
                  ?? "Data Source=nga.db"));
builder.Services.AddScoped<NgaDataImporter>();

builder.Services.Configure<ColorExtractionOptions>(
    builder.Configuration.GetSection("ColorExtraction"));
builder.Services.AddHttpClient(nameof(ColorExtractionService), c =>
    c.DefaultRequestHeaders.UserAgent.ParseAdd("ColorApi/1.0"));
builder.Services.AddHostedService<ColorExtractionService>();

builder.Services.AddScoped<ColorSearchService>();

var app = builder.Build();

// `dotnet run -- import --source nga-data` loads the NGA data, then exits.
if (args.Length > 0 && args[0].Equals("import", StringComparison.OrdinalIgnoreCase))
{
    var src = args.Length > 2 && args[1] == "--source" ? args[2] : "nga-data";
    using var scope = app.Services.CreateScope();
    await scope.ServiceProvider.GetRequiredService<NgaDataImporter>()
        .RunAsync(Path.GetFullPath(src));
    return;
}

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await db.Database.EnsureCreatedAsync();

    var search = new ColorSearchService(db);
    try
    {
        await search.SearchAsync(
            new ColorSearchRequest
            {
                Accuracy = 0.7,
                Colors = { new ColorQueryItem { R = 128, G = 128, B = 128, Weight = 1.0 } }
            },
            CancellationToken.None);
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[warmup] non-fatal: {ex.Message}");
    }
}

app.MapApi(); // adds /api/images/*, /api/objects/*, /api/stats, /health

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}

app.UseAuthorization();

app.MapControllers();

app.Run();
