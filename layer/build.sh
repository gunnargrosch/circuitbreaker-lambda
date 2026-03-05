#!/bin/bash
set -euo pipefail

# Determine build tool: cargo-zigbuild (no Docker) or cross (Docker/Finch)
if command -v cargo-zigbuild &> /dev/null; then
  BUILD_CMD="cargo zigbuild"
elif command -v cross &> /dev/null; then
  BUILD_CMD="cross build"
else
  echo "Error: neither 'cargo-zigbuild' nor 'cross' is installed."
  echo "Option 1: pip3 install ziglang && cargo install cargo-zigbuild"
  echo "Option 2: cargo install cross --git https://github.com/cross-rs/cross (requires Docker)"
  exit 1
fi

echo "Using build tool: $BUILD_CMD"

cd "$(dirname "$0")/extension"

$BUILD_CMD --release --target x86_64-unknown-linux-musl
$BUILD_CMD --release --target aarch64-unknown-linux-musl

cd ..

for arch in x86_64 aarch64; do
  target="${arch}-unknown-linux-musl"
  dir="dist/${arch}/extensions"
  mkdir -p "$dir"
  cp "extension/target/${target}/release/circuitbreaker-lambda-extension" "$dir/"
  chmod +x "$dir/circuitbreaker-lambda-extension"
  (cd "dist/${arch}" && zip -r "../circuitbreaker-lambda-layer-${arch}.zip" .)
done

echo "Layer zips created:"
ls -lh dist/circuitbreaker-lambda-layer-*.zip
