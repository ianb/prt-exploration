// Download Minneapolis parcel attributes (no shapes) from Hennepin County GIS:
// property type, owner, land and building value, area and centroid. Used to
// judge whether a station site is plausible. Output: data/raw/parcels.json
import fs from 'node:fs';
const URL_ = 'https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer/1/query';
const fields = 'OBJECTID,PR_TYP_NM1,OWNER_NM,PARCEL_AREA,LAND_MV1,BLDG_MV1,LAT,LON';
const out = [];
for (let offset = 0; ; offset += 2000) {
  const q = new URLSearchParams({ where: "MUNIC_NM='MINNEAPOLIS'", outFields: fields, returnGeometry: 'false', resultOffset: String(offset), resultRecordCount: '2000', orderByFields: 'OBJECTID', f: 'json' });
  let d;
  for (let tries = 0; tries < 4; tries++) {
    try {
      d = await (await fetch(`${URL_}?${q}`)).json();
      if (!d.error) break;
    } catch (e) {
      d = { error: String(e) };
    }
    await new Promise((r) => setTimeout(r, 2000 * (tries + 1)));
  }
  if (d.error) throw new Error(JSON.stringify(d.error));
  for (const f of d.features) {
    const a = f.attributes;
    out.push([a.PR_TYP_NM1, a.OWNER_NM, a.PARCEL_AREA, a.LAND_MV1, a.BLDG_MV1, a.LAT, a.LON]);
  }
  process.stdout.write(`\r${out.length}`);
  if (d.features.length < 2000) break;
}
fs.writeFileSync(new URL('../data/raw/parcels.json', import.meta.url), JSON.stringify({ fields: ['type', 'owner', 'area', 'landValue', 'buildingValue', 'lat', 'lon'], rows: out }));
console.log(`\nsaved ${out.length} parcels`);
