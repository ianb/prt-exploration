#!/bin/sh
# Download Census LEHD LODES commute data for Minnesota into data/raw/lodes.
# LODES = where people live and where they work, by census block.
# https://lehd.ces.census.gov/data/  (public domain, US Census Bureau)
set -e
YEAR=${1:-2022}
B=https://lehd.ces.census.gov/data/lodes/LODES8/mn
D=$(dirname "$0")/../data/raw/lodes
mkdir -p "$D"
cd "$D"
curl -sfO "$B/mn_xwalk.csv.gz"
curl -sfO "$B/od/mn_od_main_JT00_$YEAR.csv.gz"
curl -sfO "$B/od/mn_od_aux_JT00_$YEAR.csv.gz" || true
curl -sfO "$B/wac/mn_wac_S000_JT00_$YEAR.csv.gz"
curl -sfO "$B/rac/mn_rac_S000_JT00_$YEAR.csv.gz"
ls -la
