#!/usr/bin/env python3
"""Fetch every data-center feature in OpenStreetMap through the Overpass API.

Standard library only, so it runs on any machine with Python 3.8+.
Writes one raw Overpass JSON file per query group into data/raw/.

    python3 pipeline/fetch_osm.py                         # whole planet, tiled
    python3 pipeline/fetch_osm.py --bbox 24,-125,50,-66   # one box: south,west,north,east

Exact data-center tags are fetched planet-wide in one request (cheap thanks to
the tag index). Land use whose name says "data center" needs a regular
expression, so that part runs tile by tile; a tile that times out is split into
quadrants. Finished files are skipped on re-run, so an interrupted fetch
resumes where it stopped.

Data (c) OpenStreetMap contributors, Open Database License.
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
USER_AGENT = "DataCenterDumps/1.0 (+https://github.com/sugarcypher/DataCenterDumps)"

NAME_RX = "data ?cent(er|re)|datacent(er|re)|rechenzentrum|centre de donn|centro de datos|data campus|hyperscale"

# Each group is a list of Overpass statements (without bbox; bbox is injected).
GROUPS = {
    "telecom": ['nwr["telecom"="data_center"]', 'nwr["telecom"="data_centre"]'],
    "building": ['nwr["building"="data_center"]', 'nwr["building"="data_centre"]'],
    "industrial": ['nwr["industrial"~"^data_cent(er|re)$"]'],
    "lifecycle_future": [
        'nwr["construction"="data_center"]',
        'nwr["construction:telecom"="data_center"]',
        'nwr["construction:building"="data_center"]',
        'nwr["proposed:telecom"="data_center"]',
        'nwr["planned:telecom"="data_center"]',
        'nwr["proposed:building"="data_center"]',
    ],
    "lifecycle_past": [
        'nwr["disused:telecom"="data_center"]',
        'nwr["abandoned:telecom"="data_center"]',
        'nwr["was:telecom"="data_center"]',
        'nwr["removed:telecom"="data_center"]',
        'nwr["disused:building"="data_center"]',
        'nwr["abandoned:building"="data_center"]',
        'nwr["demolished:building"="data_center"]',
        'nwr["razed:building"="data_center"]',
    ],
    "named_construction": [
        f'nwr["landuse"="construction"]["name"~"{NAME_RX}",i]',
        f'nwr["building"="construction"]["name"~"{NAME_RX}",i]',
    ],
    "named_industrial": [
        f'nwr["landuse"="industrial"]["name"~"{NAME_RX}",i]',
        f'nwr["landuse"="brownfield"]["name"~"{NAME_RX}",i]',
        f'nwr["landuse"="greenfield"]["name"~"{NAME_RX}",i]',
    ],
}


def build_query(statements, bbox=None, timeout=300):
    suffix = f"({bbox})" if bbox else ""
    body = "\n".join(f"  {s}{suffix};" for s in statements)
    return f"[out:json][timeout:{timeout}][maxsize:1073741824];\n(\n{body}\n);\nout body geom qt;"


def post(endpoint, query, timeout):
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(endpoint, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def run_group(name, statements, outdir, bbox=None, retries=3):
    query = build_query(statements, bbox)
    last = None
    for attempt in range(retries):
        for ep in ENDPOINTS:
            try:
                t0 = time.time()
                print(f"[{name}] {ep} (attempt {attempt + 1})", flush=True)
                data = post(ep, query, timeout=330)
                if "remark" in data and "error" in data.get("remark", "").lower():
                    raise RuntimeError(data["remark"])
                path = os.path.join(outdir, f"{name}.json")
                with open(path, "w") as f:
                    json.dump(data, f)
                print(f"[{name}] {len(data.get('elements', []))} elements in {time.time() - t0:.0f}s -> {path}", flush=True)
                return True
            except Exception as e:  # network / server-side timeout; try next mirror
                last = e
                print(f"[{name}] failed: {e}", flush=True)
                time.sleep(5)
        time.sleep(30 * (attempt + 1))
    print(f"[{name}] giving up: {last}", file=sys.stderr)
    return False


def tiles(step_lat=20, step_lon=30):
    for s in range(-60, 80, step_lat):
        for w in range(-180, 180, step_lon):
            yield s, w, min(s + step_lat, 84), w + step_lon


def fetch_box(name, statements, outdir, box, min_size, force):
    """Fetch one box; on failure split it into quadrants (down to min_size degrees)."""
    path = os.path.join(outdir, name + ".json")
    if not force and os.path.exists(path):
        return []
    s, w, n, e = box
    if run_group(name, statements, outdir, f"{s},{w},{n},{e}", retries=1):
        return []
    if (n - s) <= min_size:
        return [name]
    ms, mw = (s + n) / 2, (w + e) / 2
    failed = []
    for i, q in enumerate([(s, w, ms, mw), (s, mw, ms, e), (ms, w, n, mw), (ms, mw, n, e)]):
        failed += fetch_box(f"{name}_{i}", statements, outdir, q, min_size, force)
    return failed


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "raw"))
    ap.add_argument("--bbox", help="south,west,north,east (default: whole planet)")
    ap.add_argument("--skip-named", action="store_true", help="skip the slow name-pattern search (land use named 'data center')")
    ap.add_argument("--force", action="store_true", help="re-download files already on disk")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    exact = [x for g, v in GROUPS.items() if not g.startswith("named") for x in v]
    named = [x for g, v in GROUPS.items() if g.startswith("named") for x in v]
    failed = []
    boxes = [tuple(float(x) for x in args.bbox.split(","))] if args.bbox else None

    # 1. Exact data-center tags: the tag index makes these cheap even planet-wide.
    if boxes:
        failed += fetch_box("exact_bbox", exact, args.out, boxes[0], 2, args.force)
    else:
        if args.force or not os.path.exists(os.path.join(args.out, "exact_planet.json")):
            if not run_group("exact_planet", exact, args.out, None, retries=2):
                for (s, w, n, e) in tiles(60, 90):  # fall back to 8 big boxes
                    failed += fetch_box(f"exact_{s:+04.0f}_{w:+05.0f}", exact, args.out, (s, w, n, e), 5, args.force)
    # 2. Land use / construction sites whose *name* says data center: regex search, tiled.
    if not args.skip_named:
        for (s, w, n, e) in (boxes or list(tiles())):
            failed += fetch_box(f"named_{s:+04.0f}_{w:+05.0f}", named, args.out, (s, w, n, e), 5, args.force)
            time.sleep(2)  # be polite to the public Overpass servers
    if failed:
        print("failed boxes (re-run to retry):", " ".join(failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
