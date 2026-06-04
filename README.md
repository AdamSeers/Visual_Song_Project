# Visual Song Project

The visual song project is a project started by [Adam Seers](https://www.linkedin.com/in/adam-seers-69122336a) to try to discover if there is a cognitive link between light and sound harmony. The goal of the website is to have a fun tool to play around with to facilitate the potential discovery of such a link. 

## Setup Docker

Install Docker Desktop

```bash
git clone https://github.com/AdamSeers/Visual_Song_Project.git Visual_Song_Project
cd Visual_Song_Project
docker compose up --build
```

Open <http://localhost:5000>.

## Setup Development

### Requirements

- Python 3.10+
- `ffmpeg` on `PATH` (command on windows: `winget install ffmpeg`)
- .NET 10+
- Docker Desktop (optional, for containerized run)
- Packages in `requirements.txt` (install command later)

### Setup

```bash
git clone https://github.com/AdamSeers/Visual_Song_Project.git Visual_Song_Project
cd Visual_Song_Project\visual-song-flask
pip install -r requirements.txt
```

### Run (local)

Start the .NET service:

```bash
cd color-api
dotnet run --launch-profile https
```

Start the Flask app:

```bash
cd Visual_Song_Project\visual-song-flask
python app.py
```

Start the React app:

```bash
cd Visual_Song_Project\visual-song-react
npm run dev
```

Open <http://localhost:5173/>.

## Configuration

- `MAX_UPLOAD_BYTES` in `app.py` — upload size limit (default 75 MB)
- `COLOR_API_BASE` env var — .NET service URL (default `https://localhost:7170`)

## Supported audio formats

mp3, wav, flac, ogg, m4a, aac, opus

## Images database

The Images page matches song colors to real paintings from the 
[**National Gallery of Art**](https://www.nga.gov/artworks/free-images-and-open-access) open-access collection (free, no copyright restrictions).
