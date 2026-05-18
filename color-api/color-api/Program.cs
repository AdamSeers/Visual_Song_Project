using ColorApi.ImageBank.Data;
using ColorApi.ImageBank.Endpoints;
using ColorApi.ImageBank.Import;
using Microsoft.EntityFrameworkCore;
using ColorApi.ImageBank.Colors;

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
    await scope.ServiceProvider.GetRequiredService<AppDbContext>()
        .Database.EnsureCreatedAsync();

app.MapApi(); // adds /api/images/*, /api/objects/*, /api/stats, /health

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseHttpsRedirection();

app.UseAuthorization();

app.MapControllers();

app.Run();
