# Python 3.12 slim base — small, current, plenty of wheels available
FROM python:3.12-slim

# System deps: ffmpeg (required by the pipeline), libsndfile (librosa runtime),
# and build tools in case any pip package needs to compile
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first (better Docker layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Then copy the rest of the app
COPY . .

# Where uploads/outputs land (we'll volume-mount these from compose)
RUN mkdir -p /app/uploads /app/outputs

EXPOSE 5000

# Use the Flask app entry point you already have
CMD ["python", "app.py"]