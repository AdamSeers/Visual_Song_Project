#!/usr/bin/env bash
# Downloads only the two CSVs this project needs (~170 MB) from the NGA
# open-data repo into ./nga-data, using a blobless sparse checkout so the
# other ~120 MB of files are skipped.
set -euo pipefail

DEST="${1:-nga-data}"
REPO="https://github.com/NationalGalleryOfArt/opendata.git"
TMP="$(mktemp -d)"

echo "Cloning metadata only..."
git clone --depth 1 --filter=blob:none --no-checkout "$REPO" "$TMP" >/dev/null 2>&1

cd "$TMP"
git sparse-checkout init --no-cone >/dev/null
git sparse-checkout set "data/objects.csv" "data/published_images.csv" >/dev/null
echo "Fetching objects.csv and published_images.csv..."
git checkout HEAD >/dev/null 2>&1
cd - >/dev/null

mkdir -p "$DEST"
cp "$TMP/data/objects.csv" "$TMP/data/published_images.csv" "$DEST/"
rm -rf "$TMP"

echo "Done. CSVs are in: $DEST"
ls -lh "$DEST"
