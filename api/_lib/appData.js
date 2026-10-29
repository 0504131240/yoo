// Reading and writing the site's shared data from the server.
//
// The data used to be one document (appData/familyPayments). It now lives in
// one document per field, appData/part_<field> (part_families,
// part_events...), each holding the field as a JSON string in `j`. A field
// too big for one document continues in part_<field>~1, ~2... (the head
// doc's `n` says how many; all chunks of one write share the same `ver`).
// Photos are cut out into appData/photo_<hash> and appear in the JSON as
// "fsphoto://<hash>" — the server never needs the images themselves.
// appData/part__meta marks that the move happened; before that (or if it
// never does) everything is still in appData/familyPayments, which always
// keeps adminPass. A first version used the appParts collection instead
// (ids without the prefix); that is still read until a device moves it.
// See app.js "Split storage" for the client side of the same format.
const admin = require('firebase-admin');
const MAIN = 'appData/familyPayments';
const PART_PRE = 'part_';
const PHOTO_PRE = 'photo_';
const CHUNK_CHARS = 300000;
const NEW = { col: 'appData', pre: PART_PRE };
const OLD = { col: 'appParts', pre: '' };

const partRef = (db, loc, id) => db.collection(loc.col).doc(loc.pre + id);
const prefixQuery = (db, pre) => db.collection('appData')
  .where(admin.firestore.FieldPath.documentId(), '>=', pre)
  .where(admin.firestore.FieldPath.documentId(), '<', pre.slice(0, -1) + '`');
const listParts = (db, loc) => loc.pre ? prefixQuery(db, loc.pre).get() : db.collection(loc.col).get();
const partId = (loc, docId) => docId.slice(loc.pre.length);

// Where the parts are: { loc, docs } — or null before the move.
async function findParts(db) {
  for (const loc of [NEW, OLD]) {
    const snap = await listParts(db, loc);
    if (snap.docs.some(d => partId(loc, d.id) === '_meta')) return { loc, docs: snap.docs };
  }
  return null;
}

function assemble(byId, field) {
  const head = byId[field];
  if (!head || typeof head.j !== 'string') return undefined;
  let j = head.j;
  for (let i = 1; i < (head.n || 1); i++) {
    const c = byId[field + '~' + i];
    if (!c || c.ver !== head.ver) throw new Error('appParts: incomplete field ' + field);
    j += c.j;
  }
  return JSON.parse(j);
}

function partsById(docs, loc) {
  const byId = {};
  docs.forEach(d => { byId[loc ? partId(loc, d.id) : d.id] = d.data(); });
  return byId;
}

function fieldsOf(byId) {
  return [...new Set(Object.keys(byId).filter(id => id !== '_meta').map(id => id.split('~')[0]))];
}

// Everything, in the old single-document shape: { families, events, ..., adminPass }.
async function loadAppData(db) {
  const [parts, main] = await Promise.all([findParts(db), db.doc(MAIN).get()]);
  const mainData = main.exists ? main.data() : null;
  if (!parts) return mainData;
  const byId = partsById(parts.docs, parts.loc);
  const data = {};
  fieldsOf(byId).forEach(f => { const v = assemble(byId, f); if (v !== undefined) data[f] = v; });
  data.adminPass = (mainData && mainData.adminPass) || '';
  return data;
}

function chunksOf(json) {
  const out = [];
  let i = 0;
  while (i < json.length || !out.length) {
    let end = Math.min(json.length, i + CHUNK_CHARS);
    if (end < json.length) { const c = json.charCodeAt(end - 1); if (c >= 0xD800 && c <= 0xDBFF) end--; }
    out.push(json.slice(i, end));
    i = end;
  }
  return out;
}

// Writes one field (in a transaction or batch). prevN = how many chunk docs
// it had, so leftovers get deleted.
function writeField(db, writer, field, value, prevN, loc = NEW) {
  const chunks = chunksOf(JSON.stringify(value === undefined ? null : value));
  const ver = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  writer.set(partRef(db, loc, field), { j: chunks[0], n: chunks.length, ver, at: Date.now() });
  for (let i = 1; i < chunks.length; i++) writer.set(partRef(db, loc, `${field}~${i}`), { j: chunks[i], ver });
  for (let i = chunks.length; i < (prevN || 0); i++) writer.delete(partRef(db, loc, `${field}~${i}`));
}

// Read-modify-write of some fields, atomically. fn(data) gets { field: value }
// for the requested fields, changes them in place, and returns
// { changed: [field names to write], ...anything else to hand back }.
async function updateFields(db, fields, fn) {
  return db.runTransaction(async tx => {
    let loc = null;
    for (const l of [NEW, OLD]) { if ((await tx.get(partRef(db, l, '_meta'))).exists) { loc = l; break; } }
    if (!loc) {
      const ref = db.doc(MAIN);
      const data = (await tx.get(ref)).data() || {};
      const r = (await fn(data)) || {};
      if (r.changed && r.changed.length) tx.update(ref, Object.fromEntries(r.changed.map(f => [f, data[f]])));
      return r;
    }
    const data = {}, prevN = {};
    for (const f of fields) {
      const head = await tx.get(partRef(db, loc, f));
      if (!head.exists) continue;
      const byId = { [f]: head.data() };
      for (let i = 1; i < (head.data().n || 1); i++) byId[`${f}~${i}`] = (await tx.get(partRef(db, loc, `${f}~${i}`))).data();
      data[f] = assemble(byId, f);
      prevN[f] = head.data().n || 1;
    }
    const r = (await fn(data)) || {};
    (r.changed || []).forEach(f => writeField(db, tx, f, data[f], prevN[f], loc));
    return r;
  });
}

// Every photo hash a JSON string mentions.
function photoRefs(text, into) {
  const re = /fsphoto:\/\/([0-9a-z]+)/g;
  let m;
  while ((m = re.exec(text))) into.add(m[1]);
  return into;
}

// Runs writes in batches small enough for Firestore (500 ops, 10MiB).
async function inBatches(db, ops) {
  let batch = db.batch(), count = 0, size = 0;
  for (const op of ops) {
    const sz = op.data ? JSON.stringify(op.data).length : 100;
    if (count && (count >= 400 || size + sz > 6000000)) { await batch.commit(); batch = db.batch(); count = 0; size = 0; }
    if (op.del) batch.delete(op.ref); else batch.set(op.ref, op.data);
    count++; size += sz;
  }
  if (count) await batch.commit();
}

// Daily backup in the appParts format: backups/<date> holds { format: 2,
// photos: [hashes it needs], ... } and backups/<date>/parts/* is a copy of
// every appParts doc. Returns null (nothing written) before the move — the
// caller then keeps writing the old single-doc backup.
async function backupParts(db, date, extra) {
  const parts = await findParts(db);
  if (!parts) return null;
  const ref = db.doc(`backups/${date}`);
  const old = await ref.collection('parts').get();
  const photos = new Set();
  parts.docs.forEach(d => { if (typeof d.data().j === 'string') photoRefs(d.data().j, photos); });
  // Stored without the prefix: backups/<date>/parts/<field>.
  await inBatches(db, [
    ...old.docs.map(d => ({ ref: d.ref, del: true })),
    ...parts.docs.map(d => ({ ref: ref.collection('parts').doc(partId(parts.loc, d.id)), data: d.data() })),
  ]);
  const byId = partsById(parts.docs, parts.loc);
  const count = f => { try { return (assemble(byId, f) || []).length; } catch (e) { return null; } };
  await ref.set({ format: 2, photos: [...photos], summary: { families: count('families'), events: count('events') }, ...extra });
  return { parts: parts.size, photos: photos.size };
}

// A backup's data in the old single-doc shape, whichever format it is.
async function loadBackup(snap) {
  const b = snap.data() || {};
  if (b.format !== 2) return b.data || {};
  const parts = await snap.ref.collection('parts').get();
  const byId = partsById(parts.docs);
  const data = {};
  fieldsOf(byId).forEach(f => { const v = assemble(byId, f); if (v !== undefined) data[f] = v; });
  return data;
}

async function deleteBackup(db, snap) {
  const parts = await snap.ref.collection('parts').get();
  await inBatches(db, [...parts.docs.map(d => ({ ref: d.ref, del: true })), { ref: snap.ref, del: true }]);
}

// Deletes photos nothing points to any more: not the live data, and not any
// kept backup. Only ones older than two days, so a photo a device has just
// written ahead of its data is never caught in between.
async function cleanupPhotos(db) {
  const keep = new Set();
  const parts = await findParts(db);
  if (!parts || parts.loc !== NEW) return { skipped: 'not moved yet' };
  parts.docs.forEach(d => { if (typeof d.data().j === 'string') photoRefs(d.data().j, keep); });
  const backups = await db.collection('backups').get();
  backups.docs.forEach(b => (b.data().photos || []).forEach(h => keep.add(h)));
  const photos = await prefixQuery(db, PHOTO_PRE).select('at').get();
  const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const dead = photos.docs.filter(d => !keep.has(d.id.slice(PHOTO_PRE.length)) && (d.data().at || 0) < cutoff);
  await inBatches(db, dead.map(d => ({ ref: d.ref, del: true })));
  return { photos: photos.size, deleted: dead.length };
}

module.exports = { MAIN, NEW, PART_PRE, PHOTO_PRE, partRef, findParts, partId, loadAppData, updateFields, writeField, partsById, fieldsOf, assemble, photoRefs,
  inBatches, backupParts, loadBackup, deleteBackup, cleanupPhotos };
