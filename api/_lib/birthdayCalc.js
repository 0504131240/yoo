// ⚠️ PORTED LOGIC — kept in sync with app.js by hand, on purpose.
// allOccasions below merges allBirthdays/allAnniversaries/allYahrzeits,
// copies of the same-named functions in app.js. If that logic changes
// there (new date fields, new occasion kinds...), update this too or the
// daily reminder will quietly go stale. (Same warning as debtCalc.js.)

function allBirthdays(families) {
  const kidBdays = families.flatMap(f => (f.kids || []).filter(k => k.hebDay && k.hebMonth).map(k => ({
    name: (k.name ? k.name : 'ילד/ה') + ' (' + f.name.replace('משפחת', '').trim() + ')',
    hebDay: k.hebDay, hebMonth: k.hebMonth, famId: f.id,
  })));
  const parentBdays = families.flatMap(f => {
    const fam = f.name.replace('משפחת', '').trim();
    const arr = [];
    if (f.parent1Bday && f.parent1Bday.hebDay && f.parent1Bday.hebMonth) arr.push({ name: (f.emailName || 'הורה') + ' (' + fam + ')', hebDay: f.parent1Bday.hebDay, hebMonth: f.parent1Bday.hebMonth, famId: f.id });
    if (f.parent2Bday && f.parent2Bday.hebDay && f.parent2Bday.hebMonth) arr.push({ name: (f.emailName2 || 'הורה') + ' (' + fam + ')', hebDay: f.parent2Bday.hebDay, hebMonth: f.parent2Bday.hebMonth, famId: f.id });
    return arr;
  });
  return [...kidBdays, ...parentBdays];
}

function allAnniversaries(families) {
  return families.filter(f => f.anniversaryDay && f.anniversaryMonth).map(f => ({
    name: f.name.replace('משפחת', '').trim(),
    hebDay: f.anniversaryDay, hebMonth: f.anniversaryMonth, famId: f.id,
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

module.exports = { allOccasions };
