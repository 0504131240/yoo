// /api/kalpi — the 2026 election prediction poll (kalpi.html).
//   GET  ?voter=<id>  → {entries:[{nick, seats, updatedAt, mine}]}
//   POST {voterId, nick, seats} → saves (or replaces) this voter's prediction.
// Open to anyone with the link, no login. Each browser keeps a random
// voterId in localStorage; the Firestore doc id is a hash of it, so the raw
// id is never served and nobody can overwrite someone else's prediction.
// Goes through the Admin SDK, so Firestore security rules don't apply here.
const crypto = require('crypto');
const { getDb } = require('./_lib/firebaseAdmin');

const COLLECTION = 'kalpi2026';
const PARTY_IDS = ['yashar', 'likud', 'beyachad', 'dems', 'joint', 'ybeytenu', 'otzma', 'shas', 'utj', 'rz', 'raam', 'amcha', 'reserv', 'haredi'];
const TOTAL = 120;
const MIN_SEATS = 4; // 3.25% threshold
const VOTER_RE = /^[A-Za-z0-9_-]{16,64}$/;

const docId = voterId => crypto.createHash('sha256').update(voterId).digest('hex').slice(0, 32);

function cleanSeats(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  let sum = 0;
  for (const id of PARTY_IDS) {
    const v = raw[id] == null ? 0 : Number(raw[id]);
    if (!Number.isInteger(v) || v < 0 || v > TOTAL) return null;
    if (v > 0 && v < MIN_SEATS) return null;
    out[id] = v;
    sum += v;
  }
  return sum === TOTAL ? out : null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const db = getDb();
  const col = db.collection(COLLECTION);

  if (req.method === 'GET') {
    const voter = typeof req.query.voter === 'string' && VOTER_RE.test(req.query.voter) ? docId(req.query.voter) : null;
    const snap = await col.orderBy('updatedAt', 'desc').limit(2000).get();
    const entries = snap.docs.map(d => {
      const x = d.data();
      return { nick: x.nick || '', seats: x.seats, updatedAt: x.updatedAt || 0, mine: d.id === voter };
    });
    res.status(200).json({ entries });
    return;
  }

  if (req.method === 'POST') {
    const host = req.headers.host || '';
    const origin = req.headers.origin || '';
    if (origin && origin.replace(/^https?:\/\//, '') !== host) { res.status(403).json({ error: 'forbidden' }); return; }
    const { voterId, nick, seats } = req.body || {};
    if (typeof voterId !== 'string' || !VOTER_RE.test(voterId)) { res.status(400).json({ error: 'bad voter' }); return; }
    const clean = cleanSeats(seats);
    if (!clean) { res.status(400).json({ error: 'seats must add up to 120, each party 0 or at least 4' }); return; }
    const data = { seats: clean, nick: typeof nick === 'string' ? nick.trim().slice(0, 24) : '', updatedAt: Date.now() };
    await col.doc(docId(voterId)).set(data);
    res.status(200).json({ ok: true, updatedAt: data.updatedAt });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
