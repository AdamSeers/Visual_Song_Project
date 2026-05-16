"""Flask app: upload an audio file, get back a visualization MP4."""

from __future__ import annotations

import os
import threading
import time
import uuid
from typing import Dict
import atexit
import subprocess
import shutil

from flask import Flask, jsonify, render_template, request, send_from_directory
from werkzeug.utils import secure_filename

from visualizer.pipeline import process_audio_to_video


UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "outputs")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

ALLOWED_EXTENSIONS = {"mp3", "wav", "flac", "ogg", "m4a", "aac", "opus"}
MAX_UPLOAD_BYTES = 75 * 1024 * 1024   # 75 MB

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


@app.route("/")
def index():
    return render_template("index.html")

@app.route("/about")
def about():
    return render_template("about.html")

@app.route("/live")
def live():
    return render_template("live.html")


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

@app.route("/images")
def images_page():
    return render_template("images.html")


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
        "images_per_beat": _get_float("images_per_beat", 4.0, 0.1, 16.0),
        "audio_offset": _get_float("audio_offset", 0.0, 0.0, 1.0),
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

COLOR_API_DIR = os.path.join(os.path.dirname(__file__), "color-api")


def _start_color_api():
    """Launch the .NET color-match service in the background.

    Silently does nothing if the project folder doesn't exist yet, so this
    is safe to run before the .NET side is set up.
    """
    if not os.path.isdir(COLOR_API_DIR):
        print("[color-api] folder not found, skipping launch")
        return None
    if not shutil.which("dotnet"):
        print("[color-api] dotnet CLI not on PATH, skipping launch")
        return None
    print("[color-api] starting on http://localhost:5050")
    proc = subprocess.Popen(
        # retirer --no-build eventuellement
        ["dotnet", "run", "--no-build", "--project", COLOR_API_DIR,
         "--urls", "http://localhost:5050"],
        cwd=COLOR_API_DIR,
    )
    # Make sure it dies when this Flask process dies
    atexit.register(lambda: proc.terminate())
    return proc


if __name__ == "__main__":
    _start_color_api()
    # Threaded so status polls don't queue behind the worker thread.
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
