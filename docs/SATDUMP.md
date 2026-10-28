# Feeding DataCenterDumps from your own satellite receiver (SatDump)

[SatDump](https://github.com/SatDump/SatDump) (GPL-3.0) records and decodes
downlinks from weather and Earth-observation satellites: NOAA and MetOp
(AVHRR), Meteor-M (MSU-MR), Terra/Aqua (MODIS), Sentinel-3 (OLCI/SLSTR) and
others. With a small dish or a V-dipole and a software-defined radio you get
calibrated multispectral imagery straight from orbit, with no account,
download portal or intermediary.

## What it can and cannot tell you here

| | SatDump passes | Sentinel-2 (built in) |
|---|---|---|
| Pixel size | ~1 km (AVHRR, MSU-MR), 250 m–1 km (MODIS) | 10 m |
| Sees one data center | No (a 50-hectare campus is under one pixel) | Yes |
| Sees the surrounding valley / county | Yes | Yes |
| Independence | You received it | Copernicus via AWS |
| Revisit | Several passes a day | ~5 days, cloud permitting |

So SatDump supplies **regional vegetation context** around each site: whether
the landscape a campus sits in is greening or drying on the day of your pass.
The site-level before/after numbers come from Sentinel-2.

## Steps

1. **Install the preset.** Copy both files from `satdump/` into SatDump's
   `resources/instrument_cfgs/common/` folder and restart SatDump:
   - `dcd_linear_ndvi.json` — AVHRR-3, MODIS, OLCI, SLSTR
   - `dcd_linear_ndvi_msumr.json` — Meteor MSU-MR

   They add a composite called **DataCenterDumps Linear NDVI**. It uses the same
   calibrated red (~0.67 µm) and near-infrared (~0.86 µm) channels as SatDump's
   own NDVI preset but writes the index as plain grey levels,
   `grey = (index + 1) / 2`, instead of a colour lookup table, so the value can
   be read back.

2. **Process a pass** as usual (live or from a baseband recording).

3. **Make the GeoTIFF.** Open the product, choose the composite, project it
   (equirectangular is simplest; UTM, stereographic and Web Mercator also carry
   GeoTIFF tags in SatDump's writer) and save with a `.tif` extension. Put the
   date in the file name (`meteor_2026-07-01.tif`) or pass `--date`.

4. **Ingest.**

   ```sh
   python3 pipeline/satdump_ingest.py meteor_2026-07-01.tif --label "Meteor-M2-4"
   ```

   This writes `web/data/satdump/<name>.png` (colour overlay, re-gridded to Web
   Mercator), `<name>.json` (mean index within 5 km of every site in the swath)
   and updates `index.json`. Reload the site: the pass appears in the layer menu,
   in the Overview tab, and on each covered site's detail page.

## Caveats

- Two channels cannot separate cloud from bare ground; both read near zero.
  Use clear passes, or compare several.
- Pure black (0) is treated as outside the swath.
- Sun-angle compensation is SatDump's; very low sun (winter, high latitude)
  makes the index noisy.
- Checked against SatDump source at commit `9fee079` (22 Oct 2026):
  `src-core/image/geotiff/geotiff_write.cpp` writes ModelTiepoint and
  ModelPixelScale tags with a geographic model for equirectangular output,
  which `rasterio` reads directly. The ingest test builds a GeoTIFF with the same
  layout; it has not yet been run on a live pass from your receiver.
