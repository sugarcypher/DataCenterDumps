#!/usr/bin/env python3
"""Measure green space before and after at each data-center site with Sentinel-2.

Method (per site, per period):
  1. Search the public Earth Search catalogue (Element 84, AWS Open Data) for
     Sentinel-2 Level-2A scenes over the site in the growing season of the
     chosen year, least cloudy first.
  2. Read only the pixels under the site (Cloud Optimized GeoTIFF range reads):
     red (B04, 10 m), near infrared (B08, 10 m), scene classification (SCL, 20 m).
  3. Drop cloud, cloud shadow, cirrus, saturated and no-data pixels (SCL).
  4. Normalized Difference Vegetation Index = (NIR - red) / (NIR + red);
     per-pixel median across up to --scenes scenes.
  5. Green fraction = share of valid pixels with index >= --threshold (default 0.3).
     Green area = green fraction x site area.

Sites with only a point (no mapped footprint) are measured inside a circle of
--point-radius metres (default 150) and flagged "footprint_estimated".

Results are cached in data/green_cache.json and merged into the site dataset by
build_sites.py.

    python3 pipeline/green_space.py --top 200          # all non-operating + 200 largest operating
    python3 pipeline/green_space.py --ids way/123 way/456
"""
import argparse
import json
import math
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import rasterio
import requests
from pyproj import Transformer
from rasterio.features import geometry_mask
from rasterio.windows import from_bounds
from shapely.geometry import Point, shape
import shapely

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SITES = os.path.join(ROOT, "web", "data", "sites.geojson")
CACHE = os.path.join(ROOT, "data", "green_cache.json")
STAC = "https://earth-search.aws.element84.com/v1/search"
INVALID_SCL = {0, 1, 3, 8, 9, 10}  # no data, saturated, cloud shadow, cloud medium/high, cirrus

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "3")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")
if os.path.exists("/root/.ccr/ca-bundle.crt"):  # sandbox proxy; harmless elsewhere
    os.environ.setdefault("CURL_CA_BUNDLE", "/root/.ccr/ca-bundle.crt")

_lock = threading.Lock()
_now = time.gmtime()
LAST_SEASON = _now.tm_year if _now.tm_mon >= 10 else _now.tm_year - 1


def season(year, lat):
    """Growing-season window for the hemisphere; whole year near the equator."""
    if abs(lat) < 15:
        return f"{year}-01-01T00:00:00Z/{year}-12-31T23:59:59Z"
    if lat >= 0:
        return f"{year}-05-15T00:00:00Z/{year}-09-30T23:59:59Z"
    return f"{year - 1}-11-15T00:00:00Z/{year}-03-31T23:59:59Z"


def search(bbox, year, lat, n, session):
    body = {
        "collections": ["sentinel-2-l2a"],
        "bbox": bbox,
        "datetime": season(year, lat),
        "query": {"eo:cloud_cover": {"lt": 40}},
        "sortby": [{"field": "properties.eo:cloud_cover", "direction": "asc"}],
        "limit": max(n * 3, 6),
    }
    r = session.post(STAC, json=body, timeout=60)
    r.raise_for_status()
    feats = r.json().get("features", [])
    picked, days = [], set()
    for f in feats:
        day = f["properties"]["datetime"][:10]
        if day in days:
            continue
        if not all(k in f["assets"] and f["assets"][k]["href"].startswith("https://") for k in ("red", "nir", "scl")):
            continue  # some reprocessed items point at requester-pays JPEG 2000 on s3:// instead of public COGs
        days.add(day)
        picked.append(f)
        if len(picked) >= n:
            break
    return picked


def scale_offset(asset):
    rb = (asset.get("raster:bands") or [{}])[0]
    return rb.get("scale", 0.0001), rb.get("offset", 0.0)


def read_window(href, geom_in_crs, pad=20):
    minx, miny, maxx, maxy = geom_in_crs.bounds
    with rasterio.open(href) as src:
        win = from_bounds(minx - pad, miny - pad, maxx + pad, maxy + pad, src.transform)
        win = win.round_offsets().round_lengths()
        arr = src.read(1, window=win, boundless=True, fill_value=0)
        tr = src.window_transform(win)
    return arr, tr


def measure_scene(item, geom_ll):
    epsg = item["properties"].get("proj:epsg") or item["properties"].get("proj:code", "EPSG:0").split(":")[-1]
    to_utm = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True).transform
    g = shapely.transform(geom_ll, lambda c: np.column_stack(to_utm(c[:, 0], c[:, 1])))
    red_dn, tr = read_window(item["assets"]["red"]["href"], g)
    nir_dn, _ = read_window(item["assets"]["nir"]["href"], g)
    scl20, tr20 = read_window(item["assets"]["scl"]["href"], g)
    # Upsample SCL (20 m) onto the 10 m grid by nearest neighbour.
    h, w = red_dn.shape
    rows = np.clip(((np.arange(h) * tr.e + tr.f + tr.e / 2) - tr20.f) / tr20.e, 0, scl20.shape[0] - 1).astype(int)
    cols = np.clip(((np.arange(w) * tr.a + tr.c + tr.a / 2) - tr20.c) / tr20.a, 0, scl20.shape[1] - 1).astype(int)
    scl = scl20[np.ix_(rows, cols)]
    rs, ro = scale_offset(item["assets"]["red"])
    ns, no = scale_offset(item["assets"]["nir"])
    red = red_dn.astype("float32") * rs + ro
    nir = nir_dn.astype("float32") * ns + no
    inside = ~geometry_mask([g.__geo_interface__], out_shape=red.shape, transform=tr, all_touched=False)
    if inside.sum() == 0:  # tiny footprint: take the touched pixels
        inside = ~geometry_mask([g.__geo_interface__], out_shape=red.shape, transform=tr, all_touched=True)
    # After the processing-baseline 04.00 offset is removed, a few dark pixels go
    # slightly negative; drop them rather than let the ratio explode.
    valid = inside & ~np.isin(scl, list(INVALID_SCL)) & (red_dn > 0) & (nir_dn > 0) & (red > 0) & (nir > 0)
    with np.errstate(divide="ignore", invalid="ignore"):
        ndvi = (nir - red) / (nir + red)
    ndvi = np.clip(ndvi, -1, 1)
    ndvi[~valid] = np.nan
    return ndvi, int(inside.sum())


def measure_period(geom_ll, lat, year, n_scenes, threshold, session):
    bbox = list(geom_ll.bounds)
    items = search(bbox, year, lat, n_scenes, session)
    if not items:
        return {"year": year, "error": "no clear Sentinel-2 scene found"}
    stack, dates, pix = [], [], 0
    pix_max = 0
    for it in items:
        try:
            nd, pix = measure_scene(it, geom_ll)
            pix_max = max(pix_max, pix)
            stack.append(nd)
            dates.append(it["properties"]["datetime"][:10])
        except Exception as e:  # one bad read should not sink the period
            print(f"    scene {it['id']} failed: {e}", file=sys.stderr)
    if not stack:
        return {"year": year, "error": "all scene reads failed"}
    shapes = {a.shape for a in stack}
    if len(shapes) > 1:  # scenes from different tiles: keep the largest-coverage one
        stack = [max(stack, key=lambda a: np.isfinite(a).sum())]
    import warnings
    with np.errstate(all="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(np.stack(stack), axis=0)
    vals = med[np.isfinite(med)]
    if vals.size == 0:
        return {"year": year, "error": "no cloud-free pixels", "dates": dates}
    return {
        "year": year,
        "dates": dates,
        "ndvi_mean": round(float(vals.mean()), 3),
        "green_frac": round(float((vals >= threshold).mean()), 3),
        "valid_frac": round(min(1.0, vals.size / max(pix_max, 1)), 3),
        "pixels": int(vals.size),
    }


def site_geometry(feat, point_radius):
    p = feat["properties"]
    if p.get("area_m2", 0) > 0:
        return shape(feat["geometry"]), p["area_m2"], False
    lat, lon = p["lat"], p["lon"]
    # Circle of point_radius metres in degrees (fine at these scales).
    dlat = point_radius / 111_320
    dlon = point_radius / (111_320 * max(math.cos(math.radians(lat)), 0.01))
    circle = Point(0, 0).buffer(1, 32)
    from shapely.affinity import scale, translate
    g = translate(scale(circle, dlon, dlat, origin=(0, 0)), lon, lat)
    return g, math.pi * point_radius ** 2, True


def measure_site(feat, args, session):
    g, area, est = site_geometry(feat, args.point_radius)
    lat = feat["properties"]["lat"]
    # Level-2A coverage for 2017 is patchy outside Europe / North America: step forward up to two years.
    for y in range(args.before, args.before + 3):
        before = measure_period(g, lat, y, args.scenes, args.threshold, session)
        if "error" not in before or y >= args.after - 1:
            break
    after = measure_period(g, lat, args.after, args.scenes, args.threshold, session)
    out = {"threshold": args.threshold, "area_m2": round(area, 1), "footprint_estimated": est,
           "before": before, "after": after, "measured_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if "green_frac" in before:
        before["green_m2"] = round(before["green_frac"] * area, 1)
    if "green_frac" in after:
        after["green_m2"] = round(after["green_frac"] * area, 1)
    if "green_m2" in before and "green_m2" in after:
        out["change_m2"] = round(after["green_m2"] - before["green_m2"], 1)
    return out


def select(features, args):
    if args.ids:
        want = set(args.ids)
        return [f for f in features if f["properties"]["id"] in want]
    top_level = [f for f in features if not f["properties"].get("nested_in")]
    chosen = [f for f in top_level if f["properties"]["status"] != "operating"]
    ops = sorted((f for f in top_level if f["properties"]["status"] == "operating"),
                 key=lambda f: -f["properties"].get("area_m2", 0))
    chosen += ops[: args.top]
    return chosen


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--before", type=int, default=2017)
    ap.add_argument("--after", type=int, default=LAST_SEASON, help="default: latest completed growing season")
    ap.add_argument("--threshold", type=float, default=0.3)
    ap.add_argument("--scenes", type=int, default=2)
    ap.add_argument("--point-radius", type=float, default=150)
    ap.add_argument("--top", type=int, default=200, help="largest operating sites to include")
    ap.add_argument("--ids", nargs="*")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--refresh", action="store_true", help="re-measure cached sites")
    ap.add_argument("--retry-errors", action="store_true", help="re-measure cached sites where a period failed")
    ap.add_argument("--limit", type=int, default=0, help="stop after N sites (testing)")
    args = ap.parse_args()

    feats = json.load(open(SITES))["features"]
    cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
    def needs(sid):
        if args.refresh or sid not in cache:
            return True
        c = cache[sid]
        return args.retry_errors and ("error" in c["before"] or "error" in c["after"])
    todo = [f for f in select(feats, args) if needs(f["properties"]["id"])]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(todo)} sites to measure ({len(cache)} cached)")
    session = requests.Session()
    session.headers["User-Agent"] = "DataCenterDumps/1.0"
    done = 0
    with ThreadPoolExecutor(args.workers) as ex:
        futs = {ex.submit(measure_site, f, args, session): f["properties"]["id"] for f in todo}
        for fut in as_completed(futs):
            sid = futs[fut]
            try:
                res = fut.result()
            except Exception as e:
                print(f"  {sid}: FAILED {e}")
                continue
            with _lock:
                cache[sid] = res
                done += 1
                if done % 10 == 0:
                    json.dump(cache, open(CACHE, "w"))
            b, a = res["before"], res["after"]
            print(f"  [{done}/{len(todo)}] {sid}: green {b.get('green_frac', '–')} -> {a.get('green_frac', '–')}")
    json.dump(cache, open(CACHE, "w"))
    print(f"cache now holds {len(cache)} sites -> {CACHE}. Re-run build_sites.py to merge.")


if __name__ == "__main__":
    main()
