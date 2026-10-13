// ⚠️ PORTED LOGIC — kept in sync with app.js by hand, on purpose.
// allOccasions below merges allBirthdays/allAnniversaries/allYahrzeits,
// copies of the same-named functions in app.js. If that logic changes
// there (new date fields, new occasion kinds...), update this too or the
// daily reminder will quietly go stale. (Same warning as debtCalc.js.)

function allBirthdays(families) {
  const kidBdays = families.flatMap(f => (f.kids || []).filter(k => k.hebDay && k.hebMonth).map(k => ({
    name: (k.name ? k.name : 'ילד/ה') + ' ' + f.name.replace('משפחת', '').trim(),
    hebDay: k.hebDay, hebMonth: k.hebMonth, hebYear: k.hebYear || null, gender: k.gender || '', famId: f.id,
  })));
  const parentBdays = families.flatMap(f => {
    const fam = f.name.replace('משפחת', '').trim();
    const arr = [];
    if (f.parent1Bday && f.parent1Bday.hebDay && f.parent1Bday.hebMonth) arr.push({ name: (f.emailName || 'הורה') + ' ' + fam, hebDay: f.parent1Bday.hebDay, hebMonth: f.parent1Bday.hebMonth, hebYear: f.parent1Bday.hebYear || null, famId: f.id });
    if (f.parent2Bday && f.parent2Bday.hebDay && f.parent2Bday.hebMonth) arr.push({ name: (f.emailName2 || 'הורה') + ' ' + fam, hebDay: f.parent2Bday.hebDay, hebMonth: f.parent2Bday.hebMonth, hebYear: f.parent2Bday.hebYear || null, famId: f.id });
    return arr;
  });
  return [...kidBdays, ...parentBdays];
}

function allAnniversaries(families) {
  return families.filter(f => f.anniversaryDay && f.anniversaryMonth).map(f => ({
    name: f.name.replace('משפחת', '').trim(),
    hebDay: f.anniversaryDay, hebMonth: f.anniversaryMonth, hebYear: f.anniversaryYear || null, famId: f.id,
  }));
}

function allYahrzeits(yahrzeits) {
  return (yahrzeits || []).filter(y => y.hebDay && y.hebMonth);
}

function allOccasions(families, yahrzeits) {
  return [
    ...allBirthdays(families).map(b => ({ ...b, kind: 'birthday' })),
    ...allAnniversaries(families).map(a => ({ ...a, kind: 'anniversary' })),
    ...allYahrzeits(yahrzeits).map(y => ({ ...y, kind: 'yahrzeit' })),
  ];
}

// " (בן 7)", " (12 שנים לנישואין)" — empty when the year isn't known.
function ageLabel(item, occHebYear) {
  if (!item.hebYear || !occHebYear) return '';
  const n = occHebYear - item.hebYear;
  if (n <= 0) return '';
  if (item.kind === 'anniversary') return ' (' + n + (n === 1 ? ' שנה' : ' שנים') + ' לנישואין)';
  if (item.kind === 'yahrzeit') return ' (' + n + (n === 1 ? ' שנה' : ' שנים') + ' מהפטירה)';
  if (item.gender === 'boy') return ' (בן ' + n + ')';
  if (item.gender === 'girl') return ' (בת ' + n + ')';
  return ' (' + n + ')';
}
function bmLabel(item, occHebYear) {
  if (item.kind !== 'birthday' || !item.hebYear || !occHebYear) return '';
  const n = occHebYear - item.hebYear;
  if (item.gender === 'boy' && n === 13) return 'בר מצווה';
  if (item.gender === 'girl' && n === 12) return 'בת מצווה';
  return '';
}

// ── Reminder text ──────────────────────────────────────────────────────────
// One day's occasions (i: 0 today, 1 tomorrow) as one title and one sentence,
// e.g. "מזל טוב ליוסי כהן ליום הולדתו ה-23 ולשרה לוי ליום הולדתה ה-7!".
const joinHe = a => a.length < 2 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' ו' + a[a.length - 1];
function _years(b, occHebYear) {
  if (!b.hebYear || !occHebYear) return 0;
  const n = occHebYear - b.hebYear;
  return n > 0 ? n : 0;
}
function occasionText(list, i, occHebYear) {
  const today = i === 0;
  const bms = [], bds = [], ans = [], yzs = [];
  list.forEach(b => {
    const n = _years(b, occHebYear);
    if (bmLabel(b, occHebYear)) bms.push({ b, bm: bmLabel(b, occHebYear) });
    else if (b.kind === 'anniversary') ans.push({ b, n });
    else if (b.kind === 'yahrzeit') yzs.push({ b, n });
    else bds.push({ b, n });
  });
  const lines = [];
  // ליום הולדתו ה-23 / ליום הולדתה ה-7 / ליום הולדת 23 (gender unknown)
  const bdToday = ({ b, n }) => 'ל' + b.name + ' ' + (n
    ? (b.gender === 'boy' ? 'ליום הולדתו ה-' + n : b.gender === 'girl' ? 'ליום הולדתה ה-' + n : 'ליום הולדת ' + n)
    : (b.gender === 'boy' ? 'ליום הולדתו' : b.gender === 'girl' ? 'ליום הולדתה' : 'ליום ההולדת'));
  const bdTomorrow = ({ b, n }) => 'יום ההולדת ' + (n ? 'ה-' + n + ' ' : '') + 'של ' + b.name;
  const anToday = ({ b, n }) => 'למשפחת ' + b.name + ' ' + (n === 1 ? 'לשנת הנישואין הראשונה' : n ? 'ל-' + n + ' שנות נישואין' : 'ליום הנישואין');
  const anTomorrow = ({ b, n }) => (n === 1 ? 'שנת הנישואין הראשונה' : n ? n + ' שנות נישואין' : 'יום הנישואין') + ' של משפחת ' + b.name;
  const yz = ({ b, n }) => 'היארצייט ' + (n ? 'ה-' + n + ' ' : '') + 'של ' + b.name;
  if (bms.length) lines.push(today ? 'מזל טוב ' + joinHe(bms.map(x => 'ל' + x.b.name + ' ל' + x.bm)) + '!' : 'מחר ' + joinHe(bms.map(x => 'ה' + x.bm + ' של ' + x.b.name)));
  if (bds.length) lines.push(today ? 'מזל טוב ' + joinHe(bds.map(bdToday)) + '!' : 'מחר ' + joinHe(bds.map(bdTomorrow)));
  if (ans.length) lines.push(today ? 'מזל טוב ' + joinHe(ans.map(anToday)) + '!' : 'מחר ' + joinHe(ans.map(anTomorrow)));
  if (yzs.length) lines.push((today ? 'היום ' : 'מחר ') + joinHe(yzs.map(yz)));
  const when = today ? 'היום' : 'מחר', bang = today ? '!' : '';
  const kinds = [bms, bds, ans, yzs].filter(a => a.length).length;
  const title = kinds > 1 ? '🎉 שמחות ' + when
    : bms.length ? '📜 ' + (bms.length > 1 ? 'שמחות' : bms[0].bm) + ' ' + when + bang
    : bds.length ? '🎂 ' + (bds.length > 1 ? 'ימי הולדת' : 'יום הולדת') + ' ' + when + bang
    : ans.length ? '💍 ' + (ans.length > 1 ? 'ימי נישואין' : 'יום נישואין') + ' ' + when + bang
    : '🕯️ יארצייט ' + when;
  return { title, body: lines.join(' · ') };
}

module.exports = { allOccasions, ageLabel, bmLabel, occasionText };
