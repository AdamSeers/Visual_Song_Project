# ---- stage 1: build the React app ----
FROM node:20-slim AS react-build
WORKDIR /react

# Copy package files first for layer caching
COPY ../visual-song-react/package*.json ./
RUN npm ci

# Copy the rest and build
COPY ../visual-song-react/ .
RUN npm run build

# ---- stage 2: Python + Flask app ----
FROM python:3.12-slim

# System deps for the audio/video pipeline
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps
COPY visual-song-flask/requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Copy the Flask app
COPY visual-song-flask/ .

# Copy the React build from the first stage
COPY --from=react-build /react/dist /app/react-dist

# Tell Flask where the React build lives inside the container
ENV REACT_BUILD_DIR=/app/react-dist

RUN mkdir -p /app/uploads /app/outputs

EXPOSE 5000

CMD ["python", "app.py"]