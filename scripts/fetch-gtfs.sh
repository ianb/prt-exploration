#!/bin/sh
# Metro Transit's published schedule (GTFS) into data/raw/gtfs.
set -e
D=$(dirname "$0")/../data/raw/gtfs
mkdir -p "$D"
cd "$D"
curl -sfL -o gtfs.zip https://svc.metrotransit.org/mtgtfs/gtfs.zip
unzip -oq gtfs.zip
ls
