#!/usr/bin/env python3
"""Build the canonical 200px/cell browser assets from the v7 capture library."""

import argparse
import json
import shutil
import uuid
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT.parent.parent / "tile-capture-mod" / "output_tilelibrary_v7_200px"
DEFAULT_OUT = ROOT / "public" / "assets"
SOURCE_PX_PER_CELL = 200
DETAIL_TIERS = (50, 100, 200)
EXCAVATION_CHUNK_CELLS = 4
EXCAVATION_INTEGRATED_UIDS = {
    "ba31a522-7659-4ec5-b933-8b83960c57f2",
    "bf0ba240-416f-4f32-b87d-3a445919e72a",
    "1ec32974-d07c-4ad1-a16c-57dcf90ca342",
}
GENERATOR_CATALOGS = (
    "terrain-rules.json",
    "road-cliff-rules.json",
    "poi-catalog.json",
    "start-area.json",
    "excavation-world.json",
)
FALLBACK_SOURCES = (
    ROOT.parent.parent / "tile-capture-mod" / "output_tilelibrary_v6_200px",
    ROOT.parent.parent / "tile-capture-mod" / "output_tilelibrary_v4_200px_fixed",
    ROOT.parent.parent / "tile-capture-mod" / "output_tilelibrary_v3",
)


def is_uuid(stem):
    try:
        uuid.UUID(stem)
        return True
    except ValueError:
        return False


def encode_asset(src, relative, out, source_px_per_cell=SOURCE_PX_PER_CELL):
    with Image.open(src) as opened:
        image = opened.convert("RGB")
        for tier in DETAIL_TIERS:
            width = max(1, round(image.width * tier / source_px_per_cell))
            height = max(1, round(image.height * tier / source_px_per_cell))
            output = image if tier == source_px_per_cell else image.resize((width, height), Image.Resampling.LANCZOS)
            destination = out / "detail" / str(tier) / relative.with_suffix(".webp")
            destination.parent.mkdir(parents=True, exist_ok=True)
            output.save(destination, format="WEBP", quality=85, method=6)


def generator_tile_catalog():
    data_root = ROOT / "public" / "runtime" / "data"
    metadata = json.loads((data_root / "tile_metadata.json").read_text())
    paths = set()

    def collect(value):
        if isinstance(value, str) and value.endswith(".tile"):
            paths.add(value)
        elif isinstance(value, dict):
            for key, item in value.items():
                collect(key)
                collect(item)
        elif isinstance(value, list):
            for item in value:
                collect(item)

    for name in GENERATOR_CATALOGS:
        collect(json.loads((data_root / name).read_text()))
    missing_metadata = sorted(path for path in paths if path not in metadata)
    if missing_metadata:
        raise RuntimeError(f"Generator tile metadata is missing {len(missing_metadata)} paths")
    return {
        metadata[path]["uid"]: int(metadata[path].get("size", 1))
        for path in paths
    }


def fallback_capture(uid):
    for library in FALLBACK_SOURCES:
        for directory in (library / "tiles", library):
            for extension in (".jpg", ".jpeg", ".png", ".webp"):
                candidate = directory / f"{uid}{extension}"
                if candidate.is_file():
                    return candidate
    return None


def encode_excavation(src, out):
    with Image.open(src) as opened:
        source = opened.convert("RGB")
        for tier in DETAIL_TIERS:
            side = 32 * tier
            image = source if tier == SOURCE_PX_PER_CELL else source.resize(
                (side, side), Image.Resampling.LANCZOS
            )
            destination = out / "detail" / str(tier) / "excavation_island_special.webp"
            destination.parent.mkdir(parents=True, exist_ok=True)
            image.save(destination, format="WEBP", quality=85, method=6)
            chunk_px = EXCAVATION_CHUNK_CELLS * tier
            chunk_count = 32 // EXCAVATION_CHUNK_CELLS
            for row in range(chunk_count):
                for column in range(chunk_count):
                    chunk = image.crop((
                        column * chunk_px,
                        row * chunk_px,
                        (column + 1) * chunk_px,
                        (row + 1) * chunk_px,
                    ))
                    chunk_path = out / "detail" / str(tier) / "excavation" / f"{column}_{row}.webp"
                    chunk_path.parent.mkdir(parents=True, exist_ok=True)
                    chunk.save(chunk_path, format="WEBP", quality=85, method=6)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    if not (args.source / "tiles").is_dir():
        parser.error(f"200px capture library not found: {args.source}")

    detail = args.out / "detail"
    if detail.exists():
        shutil.rmtree(detail)

    required_tiles = generator_tile_catalog()
    encoded_uids = set()
    count = 0
    for source in sorted((args.source / "tiles").glob("*")):
        if source.is_file() and is_uuid(source.stem):
            encode_asset(source, Path("tiles") / source.name, args.out)
            encoded_uids.add(source.stem)
            count += 1
    for source in sorted(args.source.glob("*")):
        if (
            source.is_file()
            and is_uuid(source.stem)
            and source.stem not in EXCAVATION_INTEGRATED_UIDS
        ):
            encode_asset(source, Path(source.name), args.out)
            encoded_uids.add(source.stem)
            count += 1

    restored = []
    for uid, size in sorted(required_tiles.items()):
        if uid in encoded_uids or uid in EXCAVATION_INTEGRATED_UIDS:
            continue
        fallback = fallback_capture(uid)
        if fallback is None:
            raise RuntimeError(f"Required generator tile has no captured image: {uid}")
        with Image.open(fallback) as opened:
            source_px_per_cell = opened.width / max(1, size)
        relative = Path("tiles") / fallback.name if size == 1 else Path(fallback.name)
        encode_asset(fallback, relative, args.out, source_px_per_cell)
        encoded_uids.add(uid)
        restored.append(uid)
        count += 1

    special = args.source / "excavation_island_special.jpg"
    if special.is_file():
        encode_excavation(special, args.out)

    # Marker badges are rendered from original HTML/CSS; no game compass art is copied here.
    legacy_tiles = args.out / "tiles"
    if legacy_tiles.exists():
        shutil.rmtree(legacy_tiles)
    for legacy in args.out.glob("*.webp"):
        if is_uuid(legacy.stem) or legacy.name == "excavation_island_special.webp":
            legacy.unlink()

    print(f"Encoded {count} UID images into 50px, 100px, and 200px browser tiers -> {detail}")
    if restored:
        print(f"Restored {len(restored)} required tiles from earlier valid captures: {', '.join(restored)}")


if __name__ == "__main__":
    main()
