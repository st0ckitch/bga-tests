// Attach digitization notes (from the parsing workflow journal) to each test JSON.
// Usage: node tools/attach-notes.js <journal.jsonl>
const fs = require('fs');
const path = require('path');
const TESTS_DIR = path.join(__dirname, '..', 'data', 'tests');

const journal = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n');
const parseIssues = {}; // id -> issues[] (last parse result wins)
const verifyInfo = {};  // id -> {fixes, remaining} (last verify result wins)

for (const line of journal) {
  let e; try { e = JSON.parse(line); } catch { continue; }
  if (e.type !== 'result' || !e.result || !e.result.id) continue;
  const r = e.result;
  if (Array.isArray(r.issues)) parseIssues[r.id] = r.issues;
  if (Array.isArray(r.remainingIssues)) verifyInfo[r.id] = { fixes: r.fixesApplied || [], remaining: r.remainingIssues, ok: r.ok };
}

let updated = 0;
for (const f of fs.readdirSync(TESTS_DIR).filter((x) => x.endsWith('.json'))) {
  const file = path.join(TESTS_DIR, f);
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  const notes = [];
  const seen = new Set();
  for (const n of [...(verifyInfo[t.id]?.remaining || []), ...(parseIssues[t.id] || [])]) {
    const key = n.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push(n);
  }
  t.importNotes = notes;
  t.verified = !!verifyInfo[t.id];
  fs.writeFileSync(file, JSON.stringify(t, null, 2));
  updated++;
}
console.log('attached notes to', updated, 'tests');
