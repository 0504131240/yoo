// ⚠️ PORTED LOGIC — kept in sync with app.js by hand, on purpose.
// evShares/evCost/evAdjBalance/famWeight/itemShareFor below are copies of the
// same-named functions in app.js. If the calculation logic changes there (split
// methods, savings rounding, settled-entry matching, pot handling...),
// update these too or the weekly debt email will quietly report the wrong
// amount. (Same warning as the old functions/index.js this was ported from.)
const FAM_ADULTS = 2;

function hebrewToGregorian(hebYear, hebMonthName, hebDay) {
  if (!hebYear || !hebMonthName || !hebDay) return null;
  const dayFmt = new Intl.DateTimeFormat('he-IL-u-ca-hebrew-nu-latn', { day: 'numeric' });
  const monthFmt = new Intl.DateTimeFormat('he-IL-u-ca-hebrew', { month: 'long' });
  const yearFmt = new Intl.DateTimeFormat('he-IL-u-ca-hebrew-nu-latn', { year: 'numeric' });
  const gregYearGuess = hebYear - 3760;
  const cur = new Date(gregYearGuess, 0, 1);
  cur.setDate(cur.getDate() - 150);
  for (let i = 0; i < 400; i++) {
    if (parseInt(yearFmt.format(cur)) === hebYear && monthFmt.format(cur) === hebMonthName && parseInt(dayFmt.format(cur)) === hebDay) return new Date(cur);
    cur.setDate(cur.getDate() + 1);
  }
  return null;
}
function kidAge(k) {
  if (!k.hebYear || !k.hebMonth || !k.hebDay) return null;
  const bd = hebrewToGregorian(k.hebYear, k.hebMonth, k.hebDay);
  if (!bd) return null;
  const today = new Date();
  let age = today.getFullYear() - bd.getFullYear();
  const m = today.getMonth() - bd.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < bd.getDate())) age--;
  return age;
}
function famAge3PlusChildCount(f) {
  if (!f.kids || !f.kids.length) return f.children || 0;
  return f.kids.filter(k => { const age = kidAge(k); return age == null || age >= 3; }).length;
}

function famWeight(f, method, childOverride, parentOverride) {
  if (!f) return 1;
  const ch = childOverride != null ? childOverride : ((method === 'percapita' || method === 'weighted') ? famAge3PlusChildCount(f) : (f.children || 0));
  const adults = parentOverride != null ? parentOverride : FAM_ADULTS;
  if (method === 'percapita') return adults + ch;
  if (method === 'weighted') return adults + ch * 0.5;
  return 1;
}
function evPotExpTotal(ev) { return (ev.potExpItems || []).reduce((s, it) => s + it.amt, 0); }
function evCost(ev) {
  return (ev.totalCost != null ? ev.totalCost : ev.participants.reduce((s, fid) => s + (ev.expenses[fid] || 0), 0)) + evPotExpTotal(ev);
}
function evSavingsPerFam(ev) { return ev.savingsTotal ? Math.round(ev.savingsTotal / ((ev.participants || []).length || 1)) : 0; }
// Exact (unrounded) share of one expense item that a single family owes — respects
// the item's own splitMethod override, falling back to plain-equal for an explicit
// partial sharedWith subset, else the event's overall default method.
function itemShareFor(ev, families, it, fid) {
  const getFam = id => families.find(f => f.id === id);
  if (it.customSplit) return it.customSplit[String(fid)] || 0;
  const isPartialSubset = it.sharedWith && it.sharedWith.length > 0 && it.sharedWith.length < ev.participants.length;
  const sw = isPartialSubset ? it.sharedWith.filter(p => ev.participants.includes(p)) : ev.participants;
  if (!sw.includes(fid)) return 0;
  const method = it.splitMethod != null ? it.splitMethod : (isPartialSubset ? 'equal' : (ev.splitMethod || 'equal'));
  let itemW = 0; const iw = {};
  sw.forEach(p => {
    iw[p] = famWeight(getFam(p), method, ev.childOverrides?.[p], ev.parentOverrides?.[p]);
    itemW += iw[p];
  });
  return itemW ? it.amt * (iw[fid] / itemW) : 0;
}
function evShares(ev, families) {
  const getFam = id => families.find(f => f.id === id);
  const defMethod = ev.splitMethod || 'equal';
  const totalCost = evCost(ev);
  const items = ev.expenseItems || [];
  const exact = {};
  ev.participants.forEach(fid => { exact[fid] = 0; });
  let itemsTotal = 0;
  // Each item is split on its own — using its own splitMethod if it has one (the
  // per-expense override), else falling back to a subset-shared item's implicit
  // equal split, else the event's overall default method.
  items.forEach(it => {
    itemsTotal += it.amt;
    ev.participants.forEach(fid => {
      const s = itemShareFor(ev, families, it, fid);
      if (s) exact[fid] = (exact[fid] || 0) + s;
    });
  });
  // Cost not accounted for by any expense item (e.g. a flat totalCost, or pot-funded
  // expenses) falls back to the event's overall default method across everyone.
  const remainder0 = totalCost - itemsTotal;
  if (Math.abs(remainder0) > 0.0001) {
    let totalW = 0; const w = {};
    ev.participants.forEach(fid => { w[fid] = famWeight(getFam(fid), defMethod, ev.childOverrides?.[fid], ev.parentOverrides?.[fid]); totalW += w[fid]; });
    if (totalW) ev.participants.forEach(fid => { exact[fid] = (exact[fid] || 0) + remainder0 * (w[fid] / totalW); });
  }
  const floors = {};
  ev.participants.forEach(fid => { floors[fid] = Math.floor(exact[fid] || 0); });
  let remainder = Math.round(totalCost - ev.participants.reduce((s, fid) => s + floors[fid], 0));
  const sorted = [...ev.participants].sort((a, b) => ((exact[b] || 0) - floors[b]) - ((exact[a] || 0) - floors[a]));
  const hasSavings = !!ev.savingsTotal;
  const shares = { ...floors };
  if (hasSavings) {
    ev.participants.forEach(fid => { shares[fid] = Math.ceil(exact[fid] || 0); });
  } else {
    for (let i = 0; i < remainder && i < sorted.length; i++) shares[sorted[i]]++;
  }
  const savingsPerFam = evSavingsPerFam(ev);
  if (savingsPerFam > 0) ev.participants.forEach(fid => { shares[fid] = (shares[fid] || 0) + savingsPerFam; });
  return shares;
}
function evBalance(ev, families) {
  const shares = evShares(ev, families);
  const res = {};
  ev.participants.forEach(fid => { res[fid] = (ev.expenses[fid] || 0) - (shares[fid] || 0); });
  return res;
}
function evAdjBalance(ev, families) {
  const getFam = id => families.find(f => f.id === id);
  const adjBal = evBalance(ev, families);
  (ev.settled || []).forEach(s => {
    // Prefer the fromFid/toFid every settled entry already carries over
    // matching by name — name-only matching breaks silently the moment a
    // family is renamed, making an already-settled debt reappear as owed.
    const fromFid = s.fromFid != null ? s.fromFid : ev.participants.find(fid => { const f = getFam(fid); return f && f.name.replace('משפחת', '').trim() === s.from; });
    const toFid = s.toFid != null ? s.toFid : ev.participants.find(fid => { const f = getFam(fid); return f && f.name.replace('משפחת', '').trim() === s.to; });
    if (fromFid != null) adjBal[fromFid] = (adjBal[fromFid] || 0) + s.amt;
    if (toFid != null) adjBal[toFid] = (adjBal[toFid] || 0) - s.amt;
  });
  (ev.potPayments || []).forEach(p => { adjBal[p.famId] = (adjBal[p.famId] || 0) + p.amt; });
  (ev.savingsPaid || []).forEach(p => { adjBal[p.famId] = (adjBal[p.famId] || 0) + p.amt; });
  return adjBal;
}

module.exports = { evAdjBalance };
