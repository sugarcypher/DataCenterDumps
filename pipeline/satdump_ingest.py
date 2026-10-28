#!/usr/bin/env python3
"""Ingest SatDump GeoTIFFs as a regional vegetation layer.

SatDump (https://github.com/SatDump/SatDump) decodes weather / Earth-observation
satellite downlinks you receive with your own antenna and radio (NOAA and MetOp
AVHRR, Meteor MSU-MR, MODIS, and others). Its imagery is about 1 km per pixel:
too coarse to see a single data center, fine for the vegetation state of the
county or valley around one. That is the role it plays here: regional context
for the 10 m Sentinel-2 site measurements.

Workflow
  1. Copy satdump/dcd_linear_ndvi*.json into SatDump's
     resources/instrument_cfgs/common/ folder (restart SatDump).
  2. Process a pass, open the product, choose the composite
     "DataCenterDumps Linear NDVI", project it (equirectangular, UTM,
     stereographic or Web Mercator all write GeoTIFF tags) and save as .tif.
  3. python3 pipeline/satdump_ingest.py path/to/pass.tif [--date 2026-07-01] [--label "Meteor-M2-4"]

The composite stores (index + 1) / 2 as grey levels, so index = 2 * grey - 1.
Pure black (0) is treated as outside the swath. Clouds read near 0 and are not
separable with two channels: compare several clear passes.

Also accepts any single-band GeoTIFF already holding the index in -1..1
(--raw-ndvi), for example one exported from another tool.

Outputs into web/data/satdump/:
  <slug>.png        colour overlay in EPSG:4326 for the map
  <slug>.json       bounds, date, and the mean index within --radius-km of each site
  index.json        list of ingested passes (the web app reads this)
"""
import argparse
import json
import math
import os
import re
from datetime import datetime, timezone

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.warp import Resampling, calculate_default_transform, reproject

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SITES = os.path.join(ROOT, "web", "data", "sites.geojson")
OUTDIR = os.path.join(ROOT, "web", "data", "satdump")

# brown -> pale -> green ramp for -0.2 .. 0.9
RAMP = [(-0.2, (120, 85, 50)), (0.1, (215, 200, 160)), (0.3, (170, 200, 110)), (0.6, (60, 150, 60)), (0.9, (10, 80, 30))]


def colourize(ndvi):
    rgba = np.zeros(ndvi.shape + (4,), dtype=np.uint8)
    valid = np.isfinite(ndvi)
    v = np.clip(np.where(valid, ndvi, 0), RAMP[0][0], RAMP[-1][0])
    for c in range(3):
        xs = [r[0] for r in RAMP]
        ys = [r[1][c] for r in RAMP]
        rgba[..., c] = np.interp(v, xs, ys).astype(np.uint8)
    rgba[..., 3] = np.where(valid, 200, 0)
    return rgba


def read_ndvi(path, raw):
    with rasterio.open(path) as src:
        band = src.read(1).astype("float64")
        crs = src.crs or CRS.from_epsg(4326)  # SatDump equirectangular = geographic lon/lat
        transform = src.transform
        if raw:
            ndvi = band
            ndvi[(ndvi < -1) | (ndvi > 1)] = np.nan
        else:
            maxval = 65535.0 if src.dtypes[0] == "uint16" else 255.0
            ndvi = 2.0 * band / maxval - 1.0
            ndvi[band == 0] = np.nan  # outside the swath
        if src.nodata is not None:
            ndvi[band == src.nodata] = np.nan
    return ndvi, crs, transform


def to_wgs84(ndvi, crs, transform):
    if crs.to_epsg() == 4326:
        return ndvi, transform
    h, w = ndvi.shape
    left, top = transform * (0, 0)
    right, bottom = transform * (w, h)
    dst_tr, dw, dh = calculate_default_transform(crs, "EPSG:4326", w, h, left, bottom, right, top)
    out = np.full((dh, dw), np.nan)
    reproject(ndvi, out, src_transform=transform, src_crs=crs, dst_transform=dst_tr, dst_crs="EPSG:4326",
              resampling=Resampling.bilinear, src_nodata=np.nan, dst_nodata=np.nan)
    return out, dst_tr


def to_webmercator(ndvi, tr, max_px):
    """Re-grid the lon/lat array to Web Mercator so a Leaflet image overlay lines up."""
    h, w = ndvi.shape
    west, north = tr.c, tr.f
    east, south = tr.c + tr.a * w, tr.f + tr.e * h
    south, north = max(south, -85.0), min(north, 85.0)
    dst_w = min(w, max_px)
    from rasterio.transform import from_bounds as tfb
    from pyproj import Transformer
    t = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    x0, y0 = t.transform(west, south)
    x1, y1 = t.transform(east, north)
    dst_h = max(1, int(round(dst_w * (y1 - y0) / (x1 - x0))))
    dst_tr = tfb(x0, y0, x1, y1, dst_w, dst_h)
    out = np.full((dst_h, dst_w), np.nan)
    reproject(ndvi, out, src_transform=tr, src_crs="EPSG:4326", dst_transform=dst_tr, dst_crs="EPSG:3857",
              resampling=Resampling.bilinear, src_nodata=np.nan, dst_nodata=np.nan)
    return out, [west, south, east, north]


def sample_sites(ndvi, tr, radius_km):
    feats = json.load(open(SITES))["features"] if os.path.exists(SITES) else []
    h, w = ndvi.shape
    res_x, res_y = abs(tr.a), abs(tr.e)
    out = {}
    for f in feats:
        p = f["properties"]
        if p.get("nested_in"):
            continue
        col, row = ~tr @ (p["lon"], p["lat"])
        if not (0 <= col < w and 0 <= row < h):
            continue
        rlat = radius_km / 111.32
        rlon = radius_km / (111.32 * max(math.cos(math.radians(p["lat"])), 0.01))
        r0, r1 = int(max(row - rlat / res_y, 0)), int(min(row + rlat / res_y + 1, h))
        c0, c1 = int(max(col - rlon / res_x, 0)), int(min(col + rlon / res_x + 1, w))
        win = ndvi[r0:r1, c0:c1]
        vals = win[np.isfinite(win)]
        if vals.size:
            out[p["id"]] = {"ndvi_mean": round(float(vals.mean()), 3), "pixels": int(vals.size)}
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tif", nargs="+")
    ap.add_argument("--date", help="acquisition date YYYY-MM-DD (default: guessed from file name)")
    ap.add_argument("--label", help="satellite / pass label shown in the app")
    ap.add_argument("--radius-km", type=float, default=5.0)
    ap.add_argument("--raw-ndvi", action="store_true", help="band already holds the index (-1..1)")
    ap.add_argument("--max-px", type=int, default=4096, help="downsample overlay PNG to this many pixels wide")
    args = ap.parse_args()
    os.makedirs(OUTDIR, exist_ok=True)
    idx_path = os.path.join(OUTDIR, "index.json")
    index = json.load(open(idx_path)) if os.path.exists(idx_path) else {"passes": []}

    for path in args.tif:
        ndvi, crs, tr = read_ndvi(path, args.raw_ndvi)
        ndvi, tr = to_wgs84(ndvi, crs, tr)
        h, w = ndvi.shape
        date = args.date
        if not date:
            m = re.search(r"(20\d\d)[-_]?(\d\d)[-_]?(\d\d)", os.path.basename(path))
            date = f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None
        slug = re.sub(r"[^a-z0-9]+", "-", os.path.splitext(os.path.basename(path))[0].lower()).strip("-")
        merc, bounds = to_webmercator(ndvi, tr, args.max_px)  # bounds: west, south, east, north
        rgba = colourize(merc)
        from PIL import Image
        Image.fromarray(rgba, "RGBA").save(os.path.join(OUTDIR, slug + ".png"), optimize=True)
        sites = sample_sites(ndvi, tr, args.radius_km)
        vals = ndvi[np.isfinite(ndvi)]
        rec = {
            "slug": slug, "source_file": os.path.basename(path), "label": args.label or slug, "date": date,
            "bounds": [round(b, 5) for b in bounds], "pixel_deg": [abs(tr.a), abs(tr.e)],
            "radius_km": args.radius_km, "scene_ndvi_mean": round(float(vals.mean()), 3) if vals.size else None,
            "ingested_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "sites": sites,
        }
        json.dump(rec, open(os.path.join(OUTDIR, slug + ".json"), "w"), separators=(",", ":"))
        index["passes"] = [p for p in index["passes"] if p["slug"] != slug]
        index["passes"].append({k: rec[k] for k in ("slug", "label", "date", "bounds", "scene_ndvi_mean", "source_file")} | {"site_count": len(sites)})
        print(f"{path}: {w}x{h} px, {len(sites)} sites sampled -> {slug}.png/.json")
    index["passes"].sort(key=lambda p: p.get("date") or "")
    json.dump(index, open(idx_path, "w"), indent=1)


if __name__ == "__main__":
    main()
