"""Pipeline tests: status rules, geometry, nesting, region assignment, SatDump ingest."""
import json
import os
import shutil
import subprocess
import sys

import numpy as np
import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "pipeline"))
import build_sites  # noqa: E402


@pytest.mark.parametrize("tags,status", [
    ({"telecom": "data_center"}, "operating"),
    ({"building": "data_center"}, "operating"),
    ({"construction:telecom": "data_center"}, "construction"),
    ({"construction": "data_center", "building": "construction"}, "construction"),
    ({"landuse": "construction", "name": "X Data Center"}, "construction"),
    ({"proposed:telecom": "data_center"}, "planned"),
    ({"disused:telecom": "data_center"}, "abandoned"),
    ({"abandoned:building": "data_center"}, "abandoned"),
    ({"was:telecom": "data_center"}, "abandoned"),
    ({"telecom": "data_center", "opening_date": "2099-01"}, "construction"),
])
def test_classify(tags, status):
    assert build_sites.classify(tags)[0] == status


def test_area_square_km():
    # 0.01 deg lon x 0.009 deg lat at 39N ~ 864 m x 999 m ~ 0.863 km2
    el = {"type": "way", "geometry": [{"lat": 39.0, "lon": -77.5}, {"lat": 39.0, "lon": -77.49}, {"lat": 39.009, "lon": -77.49},
                                      {"lat": 39.009, "lon": -77.5}, {"lat": 39.0, "lon": -77.5}]}
    a = build_sites.geodesic_area(build_sites.element_geometry(el))
    assert 0.85e6 < a < 0.88e6


@pytest.fixture()
def built(tmp_path, monkeypatch):
    raw = tmp_path / "raw"
    raw.mkdir()
    shutil.copy(os.path.join(ROOT, "tests", "fixtures", "raw_sample.json"), raw / "a.json")
    out = tmp_path / "web"
    monkeypatch.setattr(build_sites, "RAW", str(raw))
    monkeypatch.setattr(build_sites, "OUT", str(out))
    monkeypatch.setattr(build_sites, "GREEN_CACHE", str(tmp_path / "none.json"))
    build_sites.main([])
    sites = {f["properties"]["id"]: f["properties"] for f in json.load(open(out / "sites.geojson"))["features"]}
    return sites, json.load(open(out / "regions.json")), json.load(open(out / "meta.json"))


def test_build(built):
    sites, regions, meta = built
    assert meta["sites"] == 6
    assert sites["way/2"]["nested_in"] == "way/1"           # building inside campus counted once
    assert "nested_in" not in sites["way/1"]
    assert sites["way/1"]["country"] == "USA"
    assert sites["way/1"]["admin1_name"] == "Virginia"
    assert sites["node/3"]["status"] == "construction"
    assert sites["node/4"]["status"] == "abandoned" and sites["node/4"]["country"] == "GBR"
    assert sites["way/5"]["status"] == "construction" and sites["way/5"]["area_m2"] > 0
    assert sites["node/6"]["status"] == "planned" and sites["node/6"]["name"] == "Unnamed data center"
    assert 140e6 < regions["world_land_km2"] < 150e6       # Natural Earth land incl. Antarctica
    assert 9.0e6 < regions["countries"]["USA"]["area_km2"] < 9.9e6


def test_satdump_ingest(tmp_path, monkeypatch, built):
    """A GeoTIFF laid out like SatDump's equirectangular writer (tiepoint + pixel scale, lon/lat)."""
    import rasterio
    from rasterio.transform import from_origin
    import satdump_ingest
    tif = tmp_path / "meteor_20260701.tif"
    h, w = 200, 300
    grey = np.full((h, w), int((0.6 + 1) / 2 * 255), dtype=np.uint8)  # index 0.6
    grey[:, :20] = 0  # outside the swath
    with rasterio.open(tif, "w", driver="GTiff", width=w, height=h, count=1, dtype="uint8",
                       crs="EPSG:4326", transform=from_origin(-80.0, 41.0, 0.01, 0.01)) as dst:
        dst.write(grey, 1)
    sites_path = tmp_path / "web" / "sites.geojson"
    outdir = tmp_path / "sd"
    monkeypatch.setattr(satdump_ingest, "SITES", str(sites_path))
    monkeypatch.setattr(satdump_ingest, "OUTDIR", str(outdir))
    monkeypatch.setattr(sys, "argv", ["satdump_ingest.py", str(tif), "--label", "Meteor test"])
    satdump_ingest.main()
    idx = json.load(open(outdir / "index.json"))
    assert idx["passes"][0]["date"] == "2026-07-01"
    rec = json.load(open(outdir / (idx["passes"][0]["slug"] + ".json")))
    assert abs(rec["sites"]["way/1"]["ndvi_mean"] - 0.6) < 0.01   # campus at -77.5, 39.0 is inside
    assert "node/4" not in rec["sites"]                           # London is outside the pass
    assert (outdir / (idx["passes"][0]["slug"] + ".png")).exists()
