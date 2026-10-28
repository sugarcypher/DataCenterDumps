#!/usr/bin/env python3
"""Turn raw Overpass dumps into the web app's datasets.

Inputs : data/raw/*.json (from fetch_osm.py), data/ne/*.geojson (Natural Earth)
Outputs: web/data/sites.geojson   one feature per site (footprint polygon or point)
         web/data/regions.json    land area per country / first-level region
         web/data/countries.geojson, web/data/admin1.geojson  simplified boundaries
         web/data/meta.json       build time, source timestamps, counts

Run:  python3 pipeline/build_sites.py
"""
import glob
import json
import math
import os
import sys
from datetime import datetime, timezone

from pyproj import Geod
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, mapping, shape
from shapely.ops import polygonize, unary_union
from shapely.strtree import STRtree

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
RAW = os.path.join(ROOT, "data", "raw")
NE = os.path.join(ROOT, "data", "ne")
OUT = os.path.join(ROOT, "web", "data")
GREEN_CACHE = os.path.join(ROOT, "data", "green_cache.json")
GEOD = Geod(ellps="WGS84")

# ---------------------------------------------------------------- status

FUTURE_PREFIXES = ("construction:", "proposed:", "planned:")
PAST_PREFIXES = ("disused:", "abandoned:", "was:", "removed:", "demolished:", "razed:")
DC_VALUES = {"data_center", "data_centre"}


def classify(tags):
    """Return (status, reason). status in operating|construction|planned|abandoned."""
    for k, v in tags.items():
        if v in DC_VALUES:
            if k.startswith("construction:") or k == "construction":
                return "construction", f"{k}={v}"
            if k.startswith(("proposed:", "planned:")):
                return "planned", f"{k}={v}"
            if k.startswith(PAST_PREFIXES):
                return "abandoned", f"{k}={v}"
    dc_tag = next((f"{k}={v}" for k, v in tags.items() if v in DC_VALUES), None)
    if tags.get("landuse") == "construction" or tags.get("building") == "construction":
        k = "landuse" if tags.get("landuse") == "construction" else "building"
        return "construction", f"{k}=construction + " + (dc_tag or "data-center name")
    if tags.get("disused") == "yes" or tags.get("abandoned") == "yes":
        return "abandoned", "disused/abandoned=yes"
    if tags.get("landuse") in ("brownfield", "greenfield"):
        return "planned", f"landuse={tags['landuse']} + data-center name"
    if tags.get("opening_date") and tags["opening_date"][:4].isdigit() and int(tags["opening_date"][:4]) > datetime.now().year:
        return "construction", "opening_date in the future"
    return "operating", next((f"{k}={v}" for k, v in tags.items() if v in DC_VALUES), "named data-center land use")


# ---------------------------------------------------------------- geometry

def geodesic_area(geom):
    if geom is None or geom.is_empty or geom.geom_type not in ("Polygon", "MultiPolygon"):
        return 0.0
    a, _ = GEOD.geometry_area_perimeter(geom)
    return abs(a)


def element_geometry(el):
    t = el["type"]
    if t == "node":
        return Point(el["lon"], el["lat"])
    if t == "way":
        pts = [(p["lon"], p["lat"]) for p in el.get("geometry", []) if p]
        if len(pts) >= 4 and pts[0] == pts[-1]:
            poly = Polygon(pts)
            return poly if poly.is_valid else poly.buffer(0)
        if len(pts) >= 2:
            return LineString(pts).centroid
        if "center" in el:
            return Point(el["center"]["lon"], el["center"]["lat"])
        return None
    if t == "relation":
        outers, inners = [], []
        for m in el.get("members", []):
            if m.get("type") != "way" or not m.get("geometry"):
                continue
            pts = [(p["lon"], p["lat"]) for p in m["geometry"] if p]
            if len(pts) < 2:
                continue
            (inners if m.get("role") == "inner" else outers).append(LineString(pts))
        if outers:
            polys = list(polygonize(unary_union(outers)))
            if polys:
                g = unary_union(polys)
                if inners:
                    holes = list(polygonize(unary_union(inners)))
                    if holes:
                        g = g.difference(unary_union(holes))
                return g if g.is_valid else g.buffer(0)
        b = el.get("bounds")
        if b:
            return Point((b["minlon"] + b["maxlon"]) / 2, (b["minlat"] + b["maxlat"]) / 2)
    return None


def round_coords(geom, nd=6):
    def r(c):
        if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
            return [round(c[0], nd), round(c[1], nd)]
        return [r(x) for x in c]
    m = mapping(geom)
    return {"type": m["type"], "coordinates": r(m["coordinates"])}


# ---------------------------------------------------------------- regions

def load_regions():
    countries = json.load(open(os.path.join(NE, "ne_50m_admin_0_countries.geojson")))
    admin1 = json.load(open(os.path.join(NE, "ne_50m_admin_1_states_provinces.geojson")))
    c_geoms, c_props, a_geoms, a_props = [], [], [], []
    for f in countries["features"]:
        p = f["properties"]
        code = p.get("ADM0_A3") or p.get("ISO_A3")
        g = shape(f["geometry"])
        c_geoms.append(g)
        c_props.append({"code": code, "name": p.get("NAME_LONG") or p.get("NAME"), "continent": p.get("CONTINENT")})
    for f in admin1["features"]:
        p = f["properties"]
        g = shape(f["geometry"])
        a_geoms.append(g)
        a_props.append({"code": p.get("adm1_code"), "name": p.get("name"), "country": p.get("adm0_a3"), "postal": p.get("postal")})
    return (c_geoms, c_props, STRtree(c_geoms)), (a_geoms, a_props, STRtree(a_geoms)), countries, admin1


def locate(pt, region):
    geoms, props, tree = region
    for i in tree.query(pt):
        if geoms[i].contains(pt):
            return props[i]
    # coastal sites can fall a few hundred metres outside 1:50m coastlines
    i = tree.nearest(pt)
    if i is not None and geoms[i].distance(pt) < 0.1:
        return props[i]
    return None


def simplified_fc(fc, props_fn, tol):
    feats = []
    for f in fc["features"]:
        g = shape(f["geometry"]).simplify(tol, preserve_topology=True)
        feats.append({"type": "Feature", "properties": props_fn(f["properties"]), "geometry": round_coords(g, 3)})
    return {"type": "FeatureCollection", "features": feats}


# ---------------------------------------------------------------- main

KEEP_TAGS = ["name", "operator", "owner", "brand", "website", "start_date", "opening_date", "construction:start_date",
             "power", "capacity", "data_center:power", "building:levels", "addr:city", "addr:state", "addr:country",
             "description", "note", "wikidata", "wikipedia", "end_date", "disused:operator"]


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="Build web datasets from raw Overpass dumps.")
    ap.add_argument("--allow-shrink", action="store_true",
                    help="write even if the new dataset has <90%% of the previous site count (guards against partial fetches)")
    args = ap.parse_args(argv)
    files = sorted(glob.glob(os.path.join(RAW, "*.json")))
    if not files:
        sys.exit("No raw Overpass files in data/raw — run pipeline/fetch_osm.py first.")
    elements, osm_base = {}, None
    for fp in files:
        d = json.load(open(fp))
        osm_base = d.get("osm3s", {}).get("timestamp_osm_base", osm_base)
        for el in d.get("elements", []):
            elements[(el["type"], el["id"])] = el
    print(f"{len(elements)} unique OSM elements from {len(files)} files")

    countries_r, admin1_r, countries_fc, admin1_fc = load_regions()
    green = json.load(open(GREEN_CACHE)) if os.path.exists(GREEN_CACHE) else {}

    sites = []
    for (t, i), el in elements.items():
        tags = el.get("tags", {})
        geom = element_geometry(el)
        if geom is None or geom.is_empty:
            continue
        status, reason = classify(tags)
        area = geodesic_area(geom)
        rp = geom.representative_point() if area else geom
        c = locate(rp, countries_r)
        a = locate(rp, admin1_r)
        sid = f"{t}/{i}"
        props = {
            "id": sid,
            "name": tags.get("name") or tags.get("operator") or tags.get("brand") or "Unnamed data center",
            "status": status,
            "status_reason": reason,
            "area_m2": round(area, 1),
            "lat": round(rp.y, 6),
            "lon": round(rp.x, 6),
            "country": c["code"] if c else None,
            "country_name": c["name"] if c else None,
            "admin1": a["code"] if a else None,
            "admin1_name": a["name"] if a else None,
            "tags": {k: tags[k] for k in KEEP_TAGS if k in tags},
        }
        if sid in green:
            props["green"] = green[sid]
        sites.append((geom, props))

    # Nesting: a building inside a mapped campus must not be counted twice.
    polys = [(g, p) for g, p in sites if p["area_m2"] > 0]
    polys.sort(key=lambda x: -x[1]["area_m2"])
    pgeoms = [g for g, _ in polys]
    tree = STRtree(pgeoms) if pgeoms else None
    for g, p in sites:
        if tree is None:
            break
        rp = Point(p["lon"], p["lat"])
        for j in tree.query(rp):
            outer_g, outer_p = polys[j]
            if outer_p["id"] == p["id"] or outer_p["area_m2"] <= p["area_m2"]:
                continue
            if outer_g.contains(rp):
                p["nested_in"] = outer_p["id"]
                break

    prev_meta = os.path.join(OUT, "meta.json")
    if not args.allow_shrink and os.path.exists(prev_meta):
        prev = json.load(open(prev_meta)).get("sites", 0)
        if prev and len(sites) < 0.9 * prev:
            sys.exit(f"Refusing to write: {len(sites)} sites vs {prev} last build (partial fetch?). Use --allow-shrink to override.")

    features = []
    for g, p in sites:
        geom_out = round_coords(g.simplify(0.00001, preserve_topology=True) if p["area_m2"] else g)
        features.append({"type": "Feature", "properties": p, "geometry": geom_out})
    features.sort(key=lambda f: f["properties"]["id"])

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "sites.geojson"), "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f, separators=(",", ":"))

    # Region land areas (geodesic area of Natural Earth 1:50m polygons).
    regions = {"countries": {}, "admin1": {}}
    for g, p in zip(countries_r[0], countries_r[1]):
        b = g.bounds
        regions["countries"][p["code"]] = {"name": p["name"], "continent": p["continent"],
                                           "area_km2": round(geodesic_area(g) / 1e6, 1), "bbox": [round(x, 3) for x in b]}
    for g, p in zip(admin1_r[0], admin1_r[1]):
        b = g.bounds
        regions["admin1"][p["code"]] = {"name": p["name"], "country": p["country"],
                                        "area_km2": round(geodesic_area(g) / 1e6, 1), "bbox": [round(x, 3) for x in b]}
    world_land = sum(v["area_km2"] for v in regions["countries"].values())
    regions["world_land_km2"] = round(world_land, 1)
    with open(os.path.join(OUT, "regions.json"), "w") as f:
        json.dump(regions, f, separators=(",", ":"))

    with open(os.path.join(OUT, "countries.geojson"), "w") as f:
        json.dump(simplified_fc(countries_fc, lambda p: {"code": p.get("ADM0_A3"), "name": p.get("NAME")}, 0.02), f, separators=(",", ":"))
    with open(os.path.join(OUT, "admin1.geojson"), "w") as f:
        json.dump(simplified_fc(admin1_fc, lambda p: {"code": p.get("adm1_code"), "name": p.get("name"), "country": p.get("adm0_a3")}, 0.02), f, separators=(",", ":"))

    counts = {}
    for _, p in sites:
        counts[p["status"]] = counts.get(p["status"], 0) + 1
    meta = {
        "built_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "osm_base_utc": osm_base,
        "sites": len(sites),
        "by_status": counts,
        "with_footprint": sum(1 for _, p in sites if p["area_m2"] > 0),
        "nested": sum(1 for _, p in sites if p.get("nested_in")),
        "with_green": sum(1 for _, p in sites if "green" in p),
    }
    with open(os.path.join(OUT, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main()
