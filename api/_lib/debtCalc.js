// ⚠️ PORTED LOGIC — kept in sync with app.js by hand, on purpose.
// evShares/evCost/evAdjBalance/famWeight below are copies of the same-named
// functions in app.js. If the calculation logic changes there (split
// methods, savings rounding, settled-entry matching, pot handling...),
// update these too or the weekly debt email will quietly report the wrong
// amount. (Same warning as the old functions/index.js this was ported from.)
const FAM_ADULTS = 2;

function famWeight(f, method, childOverride, parentOverride) {
  if (!f) return 1;
  const ch = childOverride != null ? childOverride : (f.children || 0);
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
function evShares(ev, families) {
  const getFam = id => families.find(f => f.id === id);
  const method = ev.splitMethod || 'equal';
  const totalCost = evCost(ev);
  const partialItems = (ev.expenseItems || []).filter(it =>
    it.customSplit || (it.sharedWith && it.sharedWith.length > 0 && it.sharedWith.length < ev.participants.length)
  );
  const partialAmt = partialItems.reduce((s, it) => s + it.amt, 0);
  const globalCost = totalCost - partialAmt;
  let totalW = 0; const w = {};
  ev.participants.forEach(fid => { w[fid] = famWeight(getFam(fid), method, ev.childOverrides?.[fid], ev.parentOverrides?.[fid]); totalW += w[fid]; });
  if (!totalW) return Object.fromEntries(ev.participants.map(fid => [fid, 0]));
  const exact = {};
  ev.participants.forEach(fid => { exact[fid] = globalCost * (w[fid] / totalW); });
  partialItems.forEach(it => {
    if (it.customSplit) {
      Object.entries(it.customSplit).forEach(([fid, a]) => { const nfid = parseInt(fid); if (ev.participants.includes(nfid)) exact[nfid] = (exact[nfid] || 0) + a; });
    } else {
      const sw = it.sharedWith.filter(fid => ev.participants.includes(fid));
      if (!sw.length) return;
      sw.forEach(fid => { exact[fid] = (exact[fid] || 0) + it.amt / sw.length; });
    }
  });
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
    const fromFid = ev.participants.find(fid => { const f = getFam(fid); return f && f.name.replace('משפחת', '').trim() === s.from; });
    const toFid = ev.participants.find(fid => { const f = getFam(fid); return f && f.name.replace('משפחת', '').trim() === s.to; });
    if (fromFid != null) adjBal[fromFid] = (adjBal[fromFid] || 0) + s.amt;
    if (toFid != null) adjBal[toFid] = (adjBal[toFid] || 0) - s.amt;
  });
  (ev.potPayments || []).forEach(p => { adjBal[p.famId] = (adjBal[p.famId] || 0) + p.amt; });
  (ev.savingsPaid || []).forEach(p => { adjBal[p.famId] = (adjBal[p.famId] || 0) + p.amt; });
  return adjBal;
}

module.exports = { evAdjBalance };
