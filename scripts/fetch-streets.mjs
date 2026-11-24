// Download Minneapolis street centerlines from
// Hennepin County's public GIS service. These are the candidate rights-of-way
// for an elevated guideway. Output: data/raw/streets.json (GeoJSON-ish).
//
// Ramps, alleys and private roads are left out.

import fs from 'node:fs';

const URL_ = 'https://gis.hennepin.us/arcgis/rest/services/HennepinData/TRANSPORTATION/MapServer/0/query';
// All public streets and freeways except ramps, HOV lanes, alleys, private and non-traffic ways.
// Local streets are included: an elevated guideway over a street like 32nd St
// is plausible. The network builder keeps only long, continuous ones.
const where =
  "(CTU_NAME_L='Minneapolis' OR CTU_NAME_R='Minneapolis') AND ROUTE_SYS NOT IN ('22','21','30','34','41','42','43','70')";
const fields = 'OBJECTID,ST_CONCAT,FUNCTIONAL,ROUTE_SYS,ONEWAY,ELEV_FROM,ELEV_TO,SPEEDLIMIT';

const out = [];
for (let offset = 0; ; offset += 1000) {
  const q = new URLSearchParams({ where, outFields: fields, returnGeometry: 'true', outSR: '4326', resultOffset: String(offset), resultRecordCount: '1000', orderByFields: 'OBJECTID', f: 'json' });
  const res = await fetch(`${URL_}?${q}`);
  const d = await res.json();
  if (d.error) throw new Error(JSON.stringify(d.error));
  for (const f of d.features) out.push({ ...f.attributes, paths: f.geometry?.paths || [] });
  process.stdout.write(`\r${out.length}`);
  if (!d.exceededTransferLimit && d.features.length < 1000) break;
}
fs.mkdirSync(new URL('../data/raw/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../data/raw/streets.json', import.meta.url), JSON.stringify(out));
console.log(`\nsaved ${out.length} segments`);
