#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Compare images fetched from Jimdo (via jimdo_fetch.py) against existing images
in ./images using perceptual hashing, and copy only-new images into a target
folder in the order of the Jimdo manifest. Generates a JSON report.

Usage examples:

  # Basic compare + copy with default threshold=10 into images/追加分3
  python Crawler/jimdo_compare_and_merge.py \
      --manifest Crawler/jimdo_fetched.json \
      --temp-dir images/_temp_jimdo \
      --dest-dir "images/追加分3"

  # Dry-run to inspect matches without copying
  python Crawler/jimdo_compare_and_merge.py --dry-run

  # Adjust threshold and workers
  python Crawler/jimdo_compare_and_merge.py --threshold 8 --workers 8

Optional: update article.json with placeholder titles

  python Crawler/jimdo_compare_and_merge.py --update-article \
      --article-key "追加分3" --title-prefix "Jimdo"
"""

import argparse
import concurrent.futures
import json
import os
import re
import shutil
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from PIL import Image


IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


def is_image_file(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in IMG_EXTS


def list_images(root: str, exclude_dirs: List[str]) -> List[str]:
    out: List[str] = []
    excl_norm = [os.path.abspath(d) for d in exclude_dirs]
    root_abs = os.path.abspath(root)
    for base, dirs, files in os.walk(root_abs):
        # Skip excluded dirs
        ab = os.path.abspath(base)
        if any(ab.startswith(ed) for ed in excl_norm):
            continue
        for fn in files:
            p = os.path.join(base, fn)
            if is_image_file(p):
                out.append(p)
    return out


def img_to_gray(img: Image.Image) -> Image.Image:
    if img.mode != "L":
        return img.convert("L")
    return img


def dhash(image: Image.Image, hash_size: int = 8) -> int:
    """Compute 64-bit dHash (horizontal)."""
    # Resize to (hash_size + 1, hash_size) so we can compute differences
    img = img_to_gray(image).resize((hash_size + 1, hash_size), Image.Resampling.LANCZOS)
    pixels = list(img.getdata())
    # Compute row-wise differences
    diff_bits = []
    for row in range(hash_size):
        row_start = row * (hash_size + 1)
        for col in range(hash_size):
            left = pixels[row_start + col]
            right = pixels[row_start + col + 1]
            diff_bits.append(1 if left > right else 0)
    # Pack bits into integer
    val = 0
    for b in diff_bits:
        val = (val << 1) | b
    return val


def ahash(image: Image.Image, hash_size: int = 8) -> int:
    """Compute average hash 64-bit."""
    img = img_to_gray(image).resize((hash_size, hash_size), Image.Resampling.LANCZOS)
    pixels = list(img.getdata())
    avg = sum(pixels) / len(pixels)
    bits = [1 if p > avg else 0 for p in pixels]
    val = 0
    for b in bits:
        val = (val << 1) | b
    return val


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()


@dataclass
class MatchResult:
    existing_path: Optional[str]
    distance: Optional[int]
    is_new: bool


def safe_open_image(path: str) -> Optional[Image.Image]:
    try:
        with Image.open(path) as im:
            return im.copy()
    except Exception:
        return None


def compute_hash(path: str, method: str = "dhash") -> Optional[int]:
    img = safe_open_image(path)
    if img is None:
        return None
    try:
        if method == "ahash":
            return ahash(img)
        else:
            return dhash(img)
    finally:
        img.close()


def build_existing_hash_index(
    roots: List[str], exclude_dirs: List[str], method: str, workers: int
) -> Dict[str, int]:
    paths: List[str] = []
    for r in roots:
        if not os.path.isdir(r):
            continue
        paths.extend(list_images(r, exclude_dirs))

    index: Dict[str, int] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(compute_hash, p, method): p for p in paths}
        for fut in concurrent.futures.as_completed(futs):
            p = futs[fut]
            val = fut.result()
            if val is not None:
                index[p] = val
    return index


def best_match(
    new_hash: int, existing_index: Dict[str, int]
) -> Tuple[Optional[str], Optional[int]]:
    best_path: Optional[str] = None
    best_dist: Optional[int] = None
    for p, h in existing_index.items():
        d = hamming(new_hash, h)
        if best_dist is None or d < best_dist:
            best_dist = d
            best_path = p
    return best_path, best_dist


def next_seq_index(dest_dir: str) -> int:
    if not os.path.isdir(dest_dir):
        return 1
    max_idx = 0
    for fn in os.listdir(dest_dir):
        m = re.match(r"^(\d{4})\b", fn)
        if m:
            try:
                max_idx = max(max_idx, int(m.group(1)))
            except ValueError:
                pass
    return max_idx + 1


def copy_preserve_ext(src: str, dest_dir: str, seq: int) -> str:
    ext = os.path.splitext(src)[1].lower()
    if ext not in IMG_EXTS:
        ext = ".jpg"
    out_name = f"{seq:04d}{ext}"
    out_path = os.path.join(dest_dir, out_name)
    shutil.copy2(src, out_path)
    return out_name


def load_manifest(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: str, data) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def update_article_json(
    article_path: str,
    article_key: str,
    title_prefix: str,
    new_items: List[Tuple[str, str]],  # (title, relative_path)
) -> None:
    data = {}
    if os.path.isfile(article_path):
        with open(article_path, "r", encoding="utf-8") as f:
            try:
                data = json.load(f)
            except Exception:
                data = {}
    sect = data.get(article_key, {})
    # Normalize existing entries to ensure they start with images/
    to_fix = []
    for k, v in list(sect.items()):
        norm = str(v).replace("\\", "/")
        if not norm.startswith("images/"):
            norm = f"images/{norm}"
        if sect[k] != norm:
            to_fix.append((k, norm))
    for k, v in to_fix:
        sect[k] = v
    # Append items preserving order
    for title, rel in new_items:
        norm = rel.replace("\\", "/")
        if not norm.startswith("images/"):
            norm = f"images/{norm}"
        sect[title] = norm
    data[article_key] = sect
    with open(article_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def main():
    parser = argparse.ArgumentParser(description="Compare Jimdo-fetched images with existing, copy only-new in order")
    parser.add_argument("--manifest", default=os.path.join("Crawler", "jimdo_fetched.json"))
    parser.add_argument("--temp-dir", default=os.path.join("images", "_temp_jimdo"))
    parser.add_argument("--dest-dir", default=os.path.join("images", "追加分3"))
    parser.add_argument("--threshold", type=int, default=10, help="Hamming distance threshold (<= is considered same)")
    parser.add_argument("--method", choices=["dhash", "ahash"], default="dhash")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--exclude-dirs", nargs="*", default=[os.path.join("images", "_temp_jimdo")])
    parser.add_argument("--update-article", action="store_true")
    parser.add_argument("--article-json", default="article.json")
    parser.add_argument("--article-key", default="追加分3")
    parser.add_argument("--title-prefix", default="Jimdo")
    args = parser.parse_args()

    if not os.path.isfile(args.manifest):
        raise SystemExit(f"Manifest not found: {args.manifest}")
    manifest = load_manifest(args.manifest)
    items = manifest.get("items", [])
    temp_dir = manifest.get("temp_dir", args.temp_dir)
    if not os.path.isdir(temp_dir):
        temp_dir = args.temp_dir

    # Build existing index
    # Important: do NOT exclude dest_dir, so reruns remain idempotent.
    exclude_dirs = list(set([os.path.abspath(d) for d in (args.exclude_dirs)]))
    print("Indexing existing images (this may take a moment)...")
    existing_index = build_existing_hash_index(["images"], exclude_dirs, args.method, args.workers)
    print(f"Indexed {len(existing_index)} existing images.")

    # Compute next sequence for destination
    if not args.dry_run:
        os.makedirs(args.dest_dir, exist_ok=True)
    seq = next_seq_index(args.dest_dir)

    report_items = []
    new_only_titles: List[Tuple[str, str]] = []  # (title, relative_path)
    new_count = 0

    # Process in Jimdo order
    items_sorted = sorted(items, key=lambda x: x.get("seq", 0))
    for it in items_sorted:
        seq_id = it.get("seq")
        url = it.get("url")
        filename = it.get("filename")
        src_path = os.path.join(temp_dir, filename)
        if not os.path.isfile(src_path):
            report_items.append(
                {
                    "seq": seq_id,
                    "url": url,
                    "temp_filename": filename,
                    "status": "missing_temp",
                }
            )
            continue

        h = compute_hash(src_path, args.method)
        if h is None:
            report_items.append(
                {
                    "seq": seq_id,
                    "url": url,
                    "temp_filename": filename,
                    "status": "unreadable",
                }
            )
            continue

        best_path, best_dist = best_match(h, existing_index)
        is_new = best_dist is None or best_dist > args.threshold

        out_name = None
        rel_save_path = None
        if is_new:
            new_count += 1
            if not args.dry_run:
                out_name = copy_preserve_ext(src_path, args.dest_dir, seq)
                rel_save_path = os.path.join(os.path.basename(args.dest_dir), out_name).replace("\\", "/")
                title = f"{args.title_prefix} {seq:04d}"
                new_only_titles.append((title, rel_save_path))
                seq += 1

        report_items.append(
            {
                "seq": seq_id,
                "url": url,
                "temp_filename": filename,
                "best_match": best_path,
                "distance": best_dist,
                "is_new": is_new,
                "saved_as": out_name,
            }
        )

    print(f"New-only images: {new_count}")

    # Report
    report = {
        "threshold": args.threshold,
        "method": args.method,
        "dest_dir": args.dest_dir,
        "new_only_count": new_count,
        "items": report_items,
    }
    report_path = os.path.join("Crawler", "jimdo_new_report.json")
    save_json(report_path, report)
    print(f"Report written to {report_path}")

    # Optionally update article.json
    if args.update_article and not args.dry_run and new_only_titles:
        update_article_json(args.article_json, args.article_key, args.title_prefix, new_only_titles)
        print(f"Updated {args.article_json} section '{args.article_key}' with {len(new_only_titles)} items.")


if __name__ == "__main__":
    main()
