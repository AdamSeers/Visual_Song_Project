# ---- build stage ----
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Copy csproj first for layer caching, then restore
COPY *.csproj ./
RUN dotnet restore

# Copy everything else and publish a release build
COPY . .
RUN dotnet publish -c Release -o /app/publish

# ---- runtime stage ----
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /app/publish .

# Listen on protocol:
#  - HTTP 5050 for internal traffic from the Python container (no cert needed)
ENV ASPNETCORE_URLS=http://+:5050
EXPOSE 5050

ENTRYPOINT ["dotnet", "color-api.dll"]