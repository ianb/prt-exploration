// Minimal streaming CSV reader for the data scripts: handles quoted fields
// (with commas and doubled quotes), a UTF-8 BOM, and .gz files.
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';

export async function* csvRows(file) {
  let input = fs.createReadStream(file);
  if (String(file).endsWith('.gz')) input = input.pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let header = null;
  for await (let line of rl) {
    if (!header) line = line.replace(/^﻿/, '');
    const f = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = !q;
      } else if (ch === ',' && !q) {
        f.push(cur);
        cur = '';
      } else cur += ch;
    }
    f.push(cur);
    if (!header) {
      header = f;
      continue;
    }
    yield Object.fromEntries(header.map((h, i) => [h, f[i]]));
  }
}
