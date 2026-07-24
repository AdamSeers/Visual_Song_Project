"""Flask app: upload an audio file, get back a visualization MP4."""

from __future__ import annotations

import os
import threading
import time
import uuid
from typing import Dict
import atexit
import subprocess
import tempfile
import shutil

import re
import requests
from dotenv import load_dotenv

load_dotenv()

from flask import Flask, jsonify, render_template, request, send_from_directory, Response, send_file, abort
from werkzeug.utils import secure_filename

from visualizer.pipeline import process_audio_to_video


UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "outputs")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

ALLOWED_EXTENSIONS = {"mp3", "wav", "flac", "ogg", "m4a", "aac", "opus"}
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024   # 2 GB

# Simple in-memory cache so the same video is never quota-checked twice.
_license_cache: Dict[str, bool] = {}
_license_cache_lock = threading.Lock()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES


# Very small in-memory job table. For a production deployment, swap for a
# proper queue / Redis / DB.
_jobs: Dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _allowed(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def _update_job(job_id: str, **fields) -> None:
    with _jobs_lock:
        if job_id in _jobs:
            _jobs[job_id].update(fields)


def _get_float(name: str, default: float, lo: float, hi: float) -> float:
    try:
        v = float(request.form.get(name, default))
    except (TypeError, ValueError):
        v = default
    return max(lo, min(hi, v))


def _get_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        v = int(float(request.form.get(name, default)))
    except (TypeError, ValueError):
        v = default
    return max(lo, min(hi, v))

def _extract_video_id(url: str) -> str | None:
    """Extract an 11-character YouTube video ID from common URL formats."""
    pattern = r'(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})'
    m = re.search(pattern, url)
    return m.group(1) if m else None


def _check_creative_commons(video_id: str) -> bool:
    """True if the video's license is Creative Commons. Costs 1 quota unit
    on first check per video; cached afterward."""
    with _license_cache_lock:
        if video_id in _license_cache:
            return _license_cache[video_id]

    api_key = os.environ.get("YOUTUBE_API_KEY")
    if not api_key:
        raise RuntimeError("YOUTUBE_API_KEY is not configured on the server")

    resp = requests.get(
        "https://www.googleapis.com/youtube/v3/videos",
        params={"part": "status", "id": video_id, "key": api_key},
        timeout=10,
    )
    resp.raise_for_status()
    items = resp.json().get("items", [])
    if not items:
        raise ValueError("Video not found or unavailable")

    is_cc = items[0]["status"].get("license") == "creativeCommon"
    with _license_cache_lock:
        _license_cache[video_id] = is_cc
    return is_cc


def _download_youtube_audio(video_id: str, job_id: str) -> tuple[str, str]:
    """Download and extract audio from a YouTube video. Returns (path, title)."""
    import yt_dlp

    out_template = os.path.join(UPLOAD_DIR, f"{job_id}_yt.%(ext)s")
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": out_template,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }],
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "max_filesize": 200 * 1024 * 1024,
    }
    url = f"https://www.youtube.com/watch?v={video_id}"
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        title = info.get("title", "youtube_audio")

    final_path = os.path.join(UPLOAD_DIR, f"{job_id}_yt.mp3")
    if not os.path.isfile(final_path):
        raise RuntimeError("Audio extraction failed — output file not found")
    return final_path, title


def _submit_youtube_job(is_image_job: bool):
    url = (request.form.get("youtube_url") or "").strip()
    if not url:
        return jsonify({"error": "No YouTube URL provided"}), 400

    video_id = _extract_video_id(url)
    if not video_id:
        return jsonify({"error": "Could not read a video ID from that URL"}), 400

    try:
        is_cc = _check_creative_commons(video_id)
    except Exception as exc:
        return jsonify({"error": f"Could not verify video license: {exc}"}), 502

    if not is_cc:
        return jsonify({
            "error": "This video isn't Creative Commons licensed. "
                     "Try uploading your own audio file instead."
        }), 403

    job_id = uuid.uuid4().hex
    try:
        in_path, title = _download_youtube_audio(video_id, job_id)
    except Exception as exc:
        return jsonify({"error": f"Could not download audio: {exc}"}), 502

    safe_title = secure_filename(title) or "youtube_audio"
    out_path = os.path.join(OUTPUT_DIR, f"{job_id}.mp4")

    if is_image_job:
        display_name = safe_title + "_images.mp4"
        settings = {
            "images_per_beat": _get_float("images_per_beat", 2.0, 0.1, 16.0),
            "accuracy": _get_float("accuracy", 0.9, 0.1, 1.0),
            "audio_offset": _get_float("audio_offset", 0.0, 0.0, 1.0),
            "debug_no_images": request.form.get("debug_no_images") == "on",
        }
        runner = _run_image_job
    else:
        display_name = safe_title + "_visual.mp4"
        settings = {
            "amplitude_floor": _get_float("amplitude_floor", 0.20, 0.0, 1.0),
            "min_observed_frames": _get_int("min_observed_frames", 7, 1, 60),
            "freq_smooth": _get_float("freq_smooth", 0.18, 0.01, 1.0),
            "fade_in_frames": _get_int("fade_in_frames", 3, 1, 30),
            "fade_out_frames": _get_int("fade_out_frames", 8, 1, 60),
            "audio_offset": _get_float("audio_offset", 0.2, 0.0, 1.0),
        }
        runner = _run_job

    with _jobs_lock:
        _jobs[job_id] = {"status": "queued", "progress": 0.0, "submitted_at": time.time(), "settings": settings}

    thread = threading.Thread(target=runner, args=(job_id, in_path, out_path, display_name, settings), daemon=True)
    thread.start()
    return jsonify({"job_id": job_id}), 202


def _run_job(job_id: str, input_path: str, output_path: str, display_name: str, settings: dict) -> None:
    def progress(p: float) -> None:
        _update_job(job_id, progress=float(p))

    _update_job(job_id, status="processing", progress=0.0)
    try:
        process_audio_to_video(
            input_path, output_path, progress_callback=progress, **settings
        )
        _update_job(
            job_id,
            status="done",
            progress=1.0,
            output_filename=os.path.basename(output_path),
            display_name=display_name,
            finished_at=time.time(),
        )
    except Exception as exc:   # noqa: BLE001 - surface to client
        _update_job(job_id, status="error", error=str(exc))
    finally:
        try:
            os.remove(input_path)
        except OSError:
            pass

def _run_image_job(job_id: str, input_path: str, output_path: str, display_name: str, settings: dict) -> None:
    from visualizer.image_render import process_audio_to_image_video

    def progress(p: float) -> None:
        _update_job(job_id, progress=float(p))

    _update_job(job_id, status="processing", progress=0.0)
    try:
        process_audio_to_image_video(
            input_path, output_path, progress_callback=progress, **settings
        )
        _update_job(
            job_id, status="done", progress=1.0,
            output_filename=os.path.basename(output_path),
            display_name=display_name, finished_at=time.time(),
        )
    except Exception as exc:
        _update_job(job_id, status="error", error=str(exc))
    finally:
        try:
            os.remove(input_path)
        except OSError:
            pass

@app.route("/jobs", methods=["POST"])
def submit_job():
    if "audio" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
    f = request.files["audio"]
    if not f.filename:
        return jsonify({"error": "No file selected"}), 400
    if not _allowed(f.filename):
        return jsonify({"error": "Unsupported file type"}), 400

    job_id = uuid.uuid4().hex
    safe = secure_filename(f.filename)
    in_path = os.path.join(UPLOAD_DIR, f"{job_id}_{safe}")
    out_name = f"{job_id}.mp4"
    out_path = os.path.join(OUTPUT_DIR, out_name)
    f.save(in_path)

    display_name = os.path.splitext(safe)[0] + "_visual.mp4"

    settings = {
        "amplitude_floor": _get_float("amplitude_floor", 0.20, 0.0, 1.0),
        "min_observed_frames": _get_int("min_observed_frames", 7, 1, 60),
        "freq_smooth": _get_float("freq_smooth", 0.18, 0.01, 1.0),
        "fade_in_frames": _get_int("fade_in_frames", 3, 1, 30),
        "fade_out_frames": _get_int("fade_out_frames", 8, 1, 60),
        "audio_offset": _get_float("audio_offset", 0.2, 0.0, 1.0),
    }

    with _jobs_lock:
        _jobs[job_id] = {
            "status": "queued",
            "progress": 0.0,
            "submitted_at": time.time(),
            "settings": settings,
        }

    thread = threading.Thread(
        target=_run_job,
        args=(job_id, in_path, out_path, display_name, settings),
        daemon=True,
    )
    thread.start()

    return jsonify({"job_id": job_id}), 202

@app.route("/jobs/images", methods=["POST"])
def submit_image_job():
    if "audio" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
    f = request.files["audio"]
    if not f.filename:
        return jsonify({"error": "No file selected"}), 400
    if not _allowed(f.filename):
        return jsonify({"error": "Unsupported file type"}), 400

    job_id = uuid.uuid4().hex
    safe = secure_filename(f.filename)
    in_path = os.path.join(UPLOAD_DIR, f"{job_id}_{safe}")
    out_name = f"{job_id}.mp4"
    out_path = os.path.join(OUTPUT_DIR, out_name)
    f.save(in_path)
    display_name = os.path.splitext(safe)[0] + "_images.mp4"

    settings = {
        "images_per_beat": _get_float("images_per_beat", 2.0, 0.1, 16.0),
        "accuracy": _get_float("accuracy", 0.9, 0.1, 1.0),
        "audio_offset": _get_float("audio_offset", 0.0, 0.0, 1.0),
        "debug_no_images": request.form.get("debug_no_images") == "on",
    }

    with _jobs_lock:
        _jobs[job_id] = {
            "status": "queued", "progress": 0.0,
            "submitted_at": time.time(), "settings": settings,
        }

    thread = threading.Thread(
        target=_run_image_job,
        args=(job_id, in_path, out_path, display_name, settings),
        daemon=True,
    )
    thread.start()

    return jsonify({"job_id": job_id}), 202


@app.route("/jobs/<job_id>")
def job_status(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return jsonify({"error": "unknown job"}), 404
        return jsonify({"job_id": job_id, **job})


@app.route("/jobs/<job_id>/video")
def job_video(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None or job.get("status") != "done":
        return jsonify({"error": "not ready"}), 404
    return send_from_directory(
        OUTPUT_DIR,
        job["output_filename"],
        as_attachment=True,
        download_name=job.get("display_name", "visualization.mp4"),
    )

@app.route("/jobs/youtube", methods=["POST"])
def submit_youtube_job():
    return _submit_youtube_job(is_image_job=False)


@app.route("/jobs/images/youtube", methods=["POST"])
def submit_youtube_image_job():
    return _submit_youtube_job(is_image_job=True)

# I added /mux-video here, i dont know if order has importance
@app.route('/mux-video', methods=['POST'])
def mux_video():
    if 'video' not in request.files or 'audio' not in request.files:
        return {'error': 'Missing video or audio'}, 400

    video_file = request.files['video']
    audio_file = request.files['audio']

    # Determine input extension so ffmpeg recognises the container
    video_ext = os.path.splitext(video_file.filename or 'input.mp4')[1] or '.mp4'

    video_tmp = tempfile.NamedTemporaryFile(suffix=video_ext, delete=False)
    audio_tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    output_tmp = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)

    try:
        video_file.save(video_tmp.name)   # Werkzeug already streams to disk for large files
        audio_file.save(audio_tmp.name)   # when using save() directly — this is fine
        video_tmp.close()
        audio_tmp.close()
        output_tmp.close()

        result = subprocess.run([
            'ffmpeg', '-y',
            '-i', video_tmp.name,
            '-i', audio_tmp.name,
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-c:v', 'copy',       # copy video stream, no re-encode
            '-c:a', 'aac',
            '-b:a', '192k',
            '-shortest',
            output_tmp.name,
        ], capture_output=True, text=True, timeout=300)

        if result.returncode != 0:
            app.logger.error('ffmpeg error: %s', result.stderr)
            return {'error': 'ffmpeg failed', 'detail': result.stderr[-500:]}, 500

        return send_file(
            output_tmp.name,
            mimetype='video/mp4',
            as_attachment=True,
            download_name='video-to-sound.mp4',
        )
    except subprocess.TimeoutExpired:
        return {'error': 'Processing timed out'}, 504
    finally:
        for f in [video_tmp.name, audio_tmp.name]:
            try: os.unlink(f)
            except: pass
        # Output file is deleted after send_file streams it
        # (Flask reads the whole file before returning, so this is safe)
        try: os.unlink(output_tmp.name)
        except: pass

# Path to the built React app. Set by Docker; for local dev pointing at
# the sibling visual-song-react/dist folder.
REACT_BUILD_DIR = os.environ.get(
    "REACT_BUILD_DIR",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "visual-song-react", "dist")),
)

@app.route("/")
@app.route("/<path:path>")
def serve_react(path: str = ""):
    # Don't let the catch-all swallow API routes
    if path.startswith(('jobs', 'mux-video', 'api')):
        abort(404)
    """Serve the React SPA. Static files like /assets/foo.js get served
    directly; everything else returns index.html so React Router can
    handle client-side routing.
    """
    # If a built asset matches, serve it.
    candidate = os.path.join(REACT_BUILD_DIR, path)
    if path and os.path.isfile(candidate):
        return send_from_directory(REACT_BUILD_DIR, path)
    # Otherwise return the SPA shell.
    return send_from_directory(REACT_BUILD_DIR, "index.html")


@app.route('/sitemap.xml')
def sitemap():
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://visualsongproject.com/</loc></url>
  <url><loc>https://visualsongproject.com/images</loc></url>
  <url><loc>https://visualsongproject.com/live</loc></url>
  <url><loc>https://visualsongproject.com/notes</loc></url>
  <url><loc>https://visualsongproject.com/song</loc></url>
  <url><loc>https://visualsongproject.com/camera</loc></url>
  <url><loc>https://visualsongproject.com/video</loc></url>
  <url><loc>https://visualsongproject.com/about</loc></url>
</urlset>"""
    return Response(xml, mimetype='application/xml')


@app.route('/robots.txt')
def robots():
    content = """User-agent: *
Disallow:
Sitemap: https://visualsongproject.com/sitemap.xml"""
    return Response(content, mimetype='text/plain')


if __name__ == "__main__":
    # Threaded so status polls don't queue behind the worker thread.
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
