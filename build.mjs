// Lushi Meubles : convertit les meubles du dossier "sources" en fichiers GLB légers
// et écrit catalogue.json pour Lushi Plan. Aucune dépendance : Node.js 18 ou plus suffit.
//
// Rangement attendu :
//   sources/<Catégorie>/<dossier du meuble>/  ← le contenu du zip glTF 1K téléchargé sur polyhaven.com
//        ├─ xxx_1k.gltf  (ou un .glb)
//        ├─ xxx.bin
//        ├─ textures/...
//        ├─ nom.txt      (facultatif : le nom affiché, ex. « Canapé 3 places gris »)
//        └─ apercu.jpg   (facultatif : petite image affichée dans le catalogue)
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(ROOT, 'sources');
const OUT = path.join(ROOT, 'meubles');
fs.mkdirSync(OUT, { recursive: true });

const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const pretty = s => s.replace(/_?(1k|2k|4k)$/i, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
const pad4 = b => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);

function readGLB(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('GLB invalide');
  let p = 12, json = null, bin = null;
  while (p < buf.length) {
    const len = buf.readUInt32LE(p), type = buf.readUInt32LE(p + 4), chunk = buf.subarray(p + 8, p + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
    else if (type === 0x004e4942) bin = Buffer.from(chunk);
    p += 8 + len;
  }
  return { json, bin };
}

// matrices 4×4 (ordre colonnes, comme glTF)
const mul = (a, b) => { const o = new Array(16).fill(0); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
const trs = n => {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1], t = n.translation || [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0, t[0], t[1], t[2], 1];
};

function bounds(G) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const walk = (ni, P) => {
    const n = G.nodes[ni], M = mul(P, trs(n));
    if (n.mesh != null) for (const pr of G.meshes[n.mesh].primitives) {
      const A = G.accessors[pr.attributes.POSITION]; if (!A || !A.min || !A.max) continue;
      for (let i = 0; i < 8; i++) {
        const x = i & 1 ? A.max[0] : A.min[0], y = i & 2 ? A.max[1] : A.min[1], z = i & 4 ? A.max[2] : A.min[2];
        const v = [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]];
        for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], v[k]); b[k + 3] = Math.max(b[k + 3], v[k]); }
      }
    }
    (n.children || []).forEach(c => walk(c, M));
  };
  const roots = G.scenes && G.scenes[G.scene || 0] ? G.scenes[G.scene || 0].nodes : (G.nodes || []).map((_, i) => i);
  roots.forEach(i => walk(i, I));
  return b;
}

// Garde la géométrie et la seule photo de couleur (baseColor) de chaque matériau, emballe tout dans un GLB.
function pack(file) {
  const dir = path.dirname(file);
  let G, bins = [];
  if (/\.glb$/i.test(file)) { const r = readGLB(fs.readFileSync(file)); G = r.json; bins = [r.bin]; }
  else {
    G = JSON.parse(fs.readFileSync(file, 'utf8'));
    bins = (G.buffers || []).map(b => b.uri && !b.uri.startsWith('data:') ? fs.readFileSync(path.join(dir, decodeURIComponent(b.uri))) : Buffer.from((b.uri || '').split(',')[1] || '', 'base64'));
  }
  if ((G.extensionsUsed || []).some(e => /draco|meshopt/i.test(e))) throw new Error('modèle compressé (Draco/meshopt) : télécharge la version glTF normale');
  // 1. ne garder que les textures de couleur
  const keepTex = new Set();
  for (const m of G.materials || []) {
    delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture;
    const pb = m.pbrMetallicRoughness || {}; delete pb.metallicRoughnessTexture;
    if (pb.baseColorTexture) keepTex.add(pb.baseColorTexture.index);
    if (m.extensions) { for (const k of Object.keys(m.extensions)) if (k !== 'KHR_materials_emissive_strength') delete m.extensions[k]; if (!Object.keys(m.extensions).length) delete m.extensions; }
  }
  const texMap = {}, newTex = [], imgMap = {}, newImg = [];
  [...keepTex].sort((a, b) => a - b).forEach(ti => {
    const t = G.textures[ti]; const si = t.source;
    if (!(si in imgMap)) { imgMap[si] = newImg.length; newImg.push(G.images[si]); }
    texMap[ti] = newTex.length; newTex.push({ source: imgMap[si], sampler: t.sampler });
  });
  for (const m of G.materials || []) { const pb = m.pbrMetallicRoughness; if (pb && pb.baseColorTexture) pb.baseColorTexture.index = texMap[pb.baseColorTexture.index]; }
  // 2. un seul tampon binaire : tous les anciens tampons à la suite, puis les images
  const offs = []; let total = 0; const parts = [];
  bins.forEach(b => { offs.push(total); const p = pad4(b); parts.push(p); total += p.length; });
  for (const bv of G.bufferViews || []) { bv.byteOffset = (bv.byteOffset || 0) + offs[bv.buffer || 0]; bv.buffer = 0; }
  G.images = newImg.map(im => {
    let data, mime = im.mimeType;
    if (im.bufferView != null) { const bv = G.bufferViews[im.bufferView]; data = Buffer.concat(parts).subarray(bv.byteOffset, bv.byteOffset + bv.byteLength); }
    else if (im.uri && im.uri.startsWith('data:')) { data = Buffer.from(im.uri.split(',')[1], 'base64'); mime = im.uri.slice(5, im.uri.indexOf(';')); }
    else { const f = path.join(dir, decodeURIComponent(im.uri)); data = fs.readFileSync(f); mime = /\.png$/i.test(f) ? 'image/png' : /\.webp$/i.test(f) ? 'image/webp' : 'image/jpeg'; }
    const p = pad4(Buffer.from(data)); G.bufferViews.push({ buffer: 0, byteOffset: total, byteLength: data.length }); parts.push(p); total += p.length;
    return { bufferView: G.bufferViews.length - 1, mimeType: mime || 'image/jpeg' };
  });
  G.textures = newTex; if (!newTex.length) { delete G.textures; delete G.images; }
  G.buffers = [{ byteLength: total }];
  if (G.extensionsRequired) G.extensionsRequired = G.extensionsRequired.filter(e => e === 'KHR_texture_transform' || e === 'KHR_materials_emissive_strength');
  if (G.extensionsUsed) G.extensionsUsed = G.extensionsUsed.filter(e => e === 'KHR_texture_transform' || e === 'KHR_materials_emissive_strength');
  // 3. écrire le GLB
  const bin = Buffer.concat(parts);
  let J = Buffer.from(JSON.stringify(G)); J = Buffer.concat([J, Buffer.alloc((4 - (J.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + J.length + 8 + bin.length, 8);
  const ch = (t, b) => { const h = Buffer.alloc(8); h.writeUInt32LE(b.length, 0); h.writeUInt32LE(t, 4); return Buffer.concat([h, b]); };
  return { glb: Buffer.concat([head, ch(0x4e4f534a, J), ch(0x004e4942, bin)]), G };
}

const items = [];
if (fs.existsSync(SRC)) for (const cat of fs.readdirSync(SRC).sort()) {
  const cd = path.join(SRC, cat); if (!fs.statSync(cd).isDirectory()) continue;
  for (const m of fs.readdirSync(cd).sort()) {
    const md = path.join(cd, m); if (!fs.statSync(md).isDirectory()) continue;
    const all = []; const scan = d => fs.readdirSync(d).forEach(f => { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) scan(p); else all.push(p); }); scan(md);
    const file = all.find(f => /\.glb$/i.test(f)) || all.find(f => /\.gltf$/i.test(f));
    if (!file) { console.warn('⚠ aucun .gltf/.glb dans', md); continue; }
    try {
      const { glb, G } = pack(file);
      const id = slug(cat + '_' + m);
      fs.writeFileSync(path.join(OUT, id + '.glb'), glb);
      const b = bounds(G), w = +(b[3] - b[0]).toFixed(2), h = +(b[4] - b[1]).toFixed(2), d = +(b[5] - b[2]).toFixed(2);
      const nomF = path.join(md, 'nom.txt'), n = fs.existsSync(nomF) ? fs.readFileSync(nomF, 'utf8').trim() : pretty(m);
      const it = { id, n, cat, glb: 'meubles/' + id + '.glb', w, d, h, mo: +(glb.length / 1048576).toFixed(1) };
      const ap = all.find(f => /apercu\.(jpe?g|png|webp)$/i.test(f));
      if (ap) { const ext = path.extname(ap).toLowerCase(); fs.copyFileSync(ap, path.join(OUT, id + ext)); it.img = 'meubles/' + id + ext; }
      items.push(it);
      console.log('✓', cat, '›', n, `(${w} × ${d} × ${h} m, ${it.mo} Mo)`);
    } catch (e) { console.warn('⚠', md, ':', e.message); }
  }
}
fs.writeFileSync(path.join(ROOT, 'catalogue.json'), JSON.stringify({
  version: 1, date: new Date().toISOString().slice(0, 10),
  credit: 'Meubles 3D : Poly Haven (polyhaven.com), licence CC0.',
  items
}, null, 1));
console.log(items.length, 'meuble(s) dans catalogue.json');
