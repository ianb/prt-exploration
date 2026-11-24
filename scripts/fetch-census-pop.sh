#!/bin/sh
# 2020 Census population and housing units by block, Hennepin County, from the
# public PL 94-171 redistricting file (no API key needed).
set -e
D=$(dirname "$0")/../data/raw/pl2020
mkdir -p "$D"
cd "$D"
curl -sfO https://www2.census.gov/programs-surveys/decennial/2020/data/01-Redistricting_File--PL_94-171/Minnesota/mn2020.pl.zip
unzip -oq mn2020.pl.zip mngeo2020.pl
# geo header: field 3 summary level (750 = block), 10 block id, 91 population, 92 housing units
iconv -f latin1 -t utf-8 mngeo2020.pl | awk -F'|' 'BEGIN{print "block,pop,housing"} $3=="750" && substr($10,1,5)=="27053"{print $10","$91","$92}' > hennepin_block_pop.csv
rm -f mngeo2020.pl
wc -l hennepin_block_pop.csv
