#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Fetch all images from the new Jimdo galleries into a temporary folder,
preserving the order displayed on the pages and writing a manifest for later
verification/merge.

Usage examples:

  # Quick run with defaults (temp dir images/_temp_jimdo)
  python Crawler/jimdo_fetch.py

  # Custom temp directory and worker count
  python Crawler/jimdo_fetch.py --temp-dir images/_temp_jimdo --workers 12

Notes:
- This script only downloads into a temp folder and creates a manifest
  (Crawler/jimdo_fetched.json). No changes to the main images/ content.
- The follow-up script (jimdo_compare_and_merge.py) will validate and copy
  only-new images into the final destination in Jimdo order.
"""

import argparse
import concurrent.futures
import json
import os
import re
import sys
import time
from datetime import datetime
from typing import List, Optional, Tuple

import requests
import cloudscraper  # type: ignore
from bs4 import BeautifulSoup

try:
    # Keep compatibility with requests vendored urllib3 (as seen in existing crawler)
    from requests.packages.urllib3.util.retry import Retry  # type: ignore
except Exception:  # pragma: no cover
    from urllib3.util.retry import Retry  # type: ignore

import requests.adapters
from urllib.parse import urljoin, urlparse


DEFAULT_URLS = [
    # 0001-0500
    "https://suzumorihrs.jimdofree.com/%E7%B5%B5-1/0001-0500/",
    # 0501-...
    "https://suzumorihrs.jimdofree.com/%E7%B5%B5-1/0501/",
]


def setup_requests_session() -> requests.Session:
    session = requests.Session()
    retry_strategy = Retry(
        total=3,
        backoff_factor=0.5,
        status_forcelist=[500, 502, 503, 504],
    )
    adapter = requests.adapters.HTTPAdapter(
        max_retries=retry_strategy, pool_connections=50, pool_maxsize=50
    )
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    # Friendly UA
    session.headers.update(
        {
            # Use a common desktop UA
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            "Accept-Language": "ja,en;q=0.9,zh;q=0.8",
        }
    )
    return session


def setup_scraper_session() -> requests.Session:
    """Create a cloudscraper session to bypass some anti-bot protections."""
    scraper = cloudscraper.create_scraper(
        browser={
            'browser': 'chrome',
            'platform': 'windows',
            'desktop': True
        }
    )
    scraper.headers.update(
        {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            "Accept-Language": "ja,en;q=0.9,zh;q=0.8",
        }
    )
    return scraper


def is_image_url(url: str) -> bool:
    path = urlparse(url).path.lower()
    return any(path.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif"))


def parse_srcset(srcset: str) -> Optional[str]:
    """Pick the largest candidate from srcset string.
    Returns URL string or None.
    """
    if not srcset:
        return None
    candidates: List[Tuple[str, int]] = []
    for part in srcset.split(","):
        part = part.strip()
        if not part:
            continue
        pieces = part.split()
        url = pieces[0]
        width = 0
        if len(pieces) > 1 and pieces[1].endswith("w"):
            try:
                width = int(pieces[1][:-1])
            except ValueError:
                width = 0
        candidates.append((url, width))
    if not candidates:
        return None
    # Pick the max width; if widths missing, fall back to last
    candidates.sort(key=lambda x: x[1])
    return candidates[-1][0]


def best_img_url(img, base_url: str) -> Optional[str]:
    """Heuristically pick the best image URL from an <img> element, preferring
    the largest srcset candidate, falling back to data-src/src. If parent <a>
    links to an image URL, prefer that.
    """
    # Prefer linked full-size if available
    parent = img.parent
    if parent and getattr(parent, "name", None) == "a":
        # Jimdo often uses data-href to store full-size image
        data_href = parent.get("data-href")
        if data_href and is_image_url(data_href):
            return urljoin(base_url, data_href)
        href = parent.get("href")
        if href and is_image_url(href):
            return urljoin(base_url, href)

    # srcset variants
    for attr in ("srcset", "data-srcset"):
        val = img.get(attr)
        if val:
            url = parse_srcset(val)
            if url:
                return urljoin(base_url, url)

    # data-src or src
    for attr in ("data-src", "data-original", "src"):
        val = img.get(attr)
        if val:
            return urljoin(base_url, val)

    return None


def get_soup(session: requests.Session, url: str) -> Optional[BeautifulSoup]:
    try:
        parsed = urlparse(url)
        origin = f"{parsed.scheme}://{parsed.netloc}/"
        resp = session.get(
            url,
            timeout=30,
            headers={
                "Referer": origin,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            },
        )
        if resp.status_code == 200:
            return BeautifulSoup(resp.text, "html.parser")
        print(f"[WARN] {url} -> HTTP {resp.status_code}")
        # Retry once with cloudscraper if forbidden
        if resp.status_code in (403, 503):
            try:
                scraper = setup_scraper_session()
                resp2 = scraper.get(
                    url,
                    timeout=30,
                    headers={
                        "Referer": origin,
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
                    },
                )
                if resp2.status_code == 200:
                    return BeautifulSoup(resp2.text, "html.parser")
                print(f"[WARN] cloudscraper {url} -> HTTP {resp2.status_code}")
            except Exception as e:
                print(f"[WARN] cloudscraper failed: {e}")
    except Exception as e:  # pragma: no cover (network)
        print(f"[ERROR] get {url} failed: {e}")
    return None


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def filename_for_index(idx: int, ext: str) -> str:
    ext = ext.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
        ext = ".jpg"
    return f"{idx:04d}{ext}"


def collect_image_urls(session: requests.Session, url: str) -> List[str]:
    soup = get_soup(session, url)
    if not soup:
        return []

    # Jimdo pages usually have the content under a main/article container,
    # but we keep it simple and allow all <img> in content area.
    # Try common content containers first, then fall back to all img.
    selectors = [
        "main img",
        "article img",
        ".cc-m-gallery img",
        ".gallery img",
        "img",
    ]
    imgs = []
    for sel in selectors:
        imgs = soup.select(sel)
        if imgs:
            break

    urls: List[str] = []
    seen = set()
    for img in imgs:
        url_candidate = best_img_url(img, url)
        if not url_candidate:
            continue
        # Normalize by stripping whitespace; keep query to preserve largest choice
        url_candidate = url_candidate.strip()
        # Basic heuristic: skip tiny icons/pixels by attribute hints
        try:
            w = int(img.get("width") or 0)
            h = int(img.get("height") or 0)
            if 0 < w <= 32 and 0 < h <= 32:
                continue
        except Exception:
            pass

        if url_candidate not in seen:
            seen.add(url_candidate)
            urls.append(url_candidate)

    return urls


def download_one(args) -> Optional[Tuple[int, str, str]]:
    idx, url, temp_dir, session, timeout = args
    try:
        r = session.get(url, timeout=timeout)
        if r.status_code != 200:
            print(f"[WARN] {idx:04d} HTTP {r.status_code}: {url}")
            return None
        # Derive extension from URL path
        path = urlparse(url).path
        ext = os.path.splitext(path)[1] or ".jpg"
        filename = filename_for_index(idx, ext)
        out_path = os.path.join(temp_dir, filename)
        with open(out_path, "wb") as f:
            f.write(r.content)
        return (idx, url, filename)
    except Exception as e:  # pragma: no cover (network)
        print(f"[ERROR] download {idx:04d} failed: {e} :: {url}")
        return None


def main():
    parser = argparse.ArgumentParser(description="Fetch images from Jimdo galleries into a temp folder")
    parser.add_argument(
        "--urls",
        nargs="*",
        default=DEFAULT_URLS,
        help="Jimdo gallery URLs in order",
    )
    parser.add_argument(
        "--temp-dir",
        default=os.path.join("images", "_temp_jimdo"),
        help="Temporary output directory for fetched images",
    )
    parser.add_argument("--workers", type=int, default=8, help="Max concurrent downloads")
    parser.add_argument("--timeout", type=int, default=30, help="Per-request timeout seconds")
    parser.add_argument("--max-count", type=int, default=0, help="Limit number of images per run (0=no limit)")
    args = parser.parse_args()

    session = setup_requests_session()

    # 1) Collect URLs in order across pages
    all_urls: List[str] = []
    seen = set()
    for page in args.urls:
        print(f"Collecting from: {page}")
        urls = collect_image_urls(session, page)
        print(f"  found {len(urls)} candidates")
        for u in urls:
            if u not in seen:
                seen.add(u)
                all_urls.append(u)

    if args.max_count and args.max_count > 0:
        all_urls = all_urls[: args.max_count]

    if not all_urls:
        print("No images found. Exiting.")
        sys.exit(1)

    # 2) Ensure temp dir and download
    ensure_dir(args.temp_dir)
    print(f"Downloading {len(all_urls)} images to {args.temp_dir} ...")

    jobs = [
        (i + 1, url, args.temp_dir, session, args.timeout) for i, url in enumerate(all_urls)
    ]

    results: List[Tuple[int, str, str]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = [ex.submit(download_one, j) for j in jobs]
        for fut in concurrent.futures.as_completed(futs):
            res = fut.result()
            if res:
                results.append(res)
                idx, url, fn = res
                print(f"  saved {idx:04d}: {fn}")

    results.sort(key=lambda x: x[0])
    saved = [r for r in results if r]
    print(f"Done. Saved {len(saved)}/{len(all_urls)} images.")

    # 3) Write manifest for later comparison
    manifest = {
        "source_pages": args.urls,
        "fetched_at": datetime.utcnow().isoformat() + "Z",
        "temp_dir": args.temp_dir,
        "count": len(saved),
        "items": [
            {"seq": idx, "url": url, "filename": fn} for idx, url, fn in results
        ],
    }
    manifest_path = os.path.join("Crawler", "jimdo_fetched.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"Manifest written to {manifest_path}")


if __name__ == "__main__":
    main()
