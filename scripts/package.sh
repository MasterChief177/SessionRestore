#!/bin/sh
# Build the zip that gets uploaded to the Chrome Web Store.
# Only the files the extension needs at runtime go in; tests, docs and tooling stay out.
set -eu

cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
out="dist/tab-snapshot-$version.zip"

mkdir -p dist
rm -f "$out"
zip -r -X -q "$out" manifest.json LICENSE src icons -x 'icons/*.svg'
echo "Wrote $out"
unzip -l "$out" | tail -n 1
