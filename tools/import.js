// Import parsed test JSONs (from the extraction pipeline) into data/tests,
// copying referenced images into public/assets/<id>/ and rewriting paths.
// Usage: node tools/import.js <parsedDir> <extractedDir>
const fs = require('fs');
const path = require('path');

const [parsedDir, extractedDir] = process.argv.slice(2);
if (!parsedDir || !extractedDir) {
  console.error('usage: node tools/import.js <parsedDir> <extractedDir>');
  process.exit(1);
}
const ROOT = path.join(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'data', 'tests');
const ASSETS_DIR = path.join(ROOT, 'public', 'assets');
fs.mkdirSync(TESTS_DIR, { recursive: true });

const VALID_TYPES = ['multiple_choice', 'short_answer', 'open_response'];
let okCount = 0;
const problems = [];

for (const file of fs.readdirSync(parsedDir).filter((f) => f.endsWith('.json')).sort()) {
  const id = path.basename(file, '.json');
  let t;
  try {
    t = JSON.parse(fs.readFileSync(path.join(parsedDir, file), 'utf8'));
  } catch (e) {
    problems.push(`${id}: INVALID JSON — ${e.message}`);
    continue;
  }
  const errs = [];
  if (t.id !== id) errs.push(`id mismatch (${t.id})`);
  if (!t.title) errs.push('missing title');
  if (!Array.isArray(t.sections) || !t.sections.length) errs.push('no sections');
  if (!Array.isArray(t.questions) || !t.questions.length) errs.push('no questions');
  if (errs.length) { problems.push(`${id}: ${errs.join('; ')}`); continue; }

  if (!t.durationMinutes || !isFinite(t.durationMinutes)) {
    problems.push(`${id}: no duration — defaulted to 60`);
    t.durationMinutes = 60;
  }
  const secIds = new Set(t.sections.map((s) => s.id));
  const qIds = new Set();
  const srcDir = path.join(extractedDir, id);

  const fixImage = (ref, where) => {
    if (!ref) return null;
    const clean = String(ref).replace(/^\.?\//, '');
    const src = path.join(srcDir, clean);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      problems.push(`${id}: ${where} image missing (${clean}) — dropped`);
      return null;
    }
    const dest = path.join(ASSETS_DIR, id, clean);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return `/assets/${id}/${clean}`;
  };

  // rewrite inline markdown image refs (media/... or figures/...) to served asset paths
  const fixInline = (text, where) => {
    if (!text) return text;
    return String(text).replace(/(!\[[^\]]*\]\()(\.?\/?)((?:media|figures)\/[^)\s]+)(\))/g, (m, a, _dot, rel, z) => {
      const served = fixImage(rel, where + ' inline');
      return served ? a + served + z : '';
    });
  };

  for (const s of t.sections) {
    s.image = fixImage(s.image, `section ${s.id}`);
    s.passage = fixInline(s.passage, `section ${s.id}`) || null;
    s.instructions = fixInline(s.instructions, `section ${s.id}`) || null;
  }
  t.instructions = fixInline(t.instructions, 'instructions') || null;
  for (const q of t.questions) {
    if (qIds.has(q.id)) problems.push(`${id}: duplicate question id ${q.id}`);
    qIds.add(q.id);
    if (!secIds.has(q.sectionId)) {
      problems.push(`${id}: q ${q.id} bad sectionId ${q.sectionId} — moved to first section`);
      q.sectionId = t.sections[0].id;
    }
    if (!VALID_TYPES.includes(q.type)) {
      problems.push(`${id}: q ${q.id} bad type ${q.type} — set open_response`);
      q.type = 'open_response';
    }
    if (typeof q.points !== 'number' || !isFinite(q.points) || q.points <= 0) {
      problems.push(`${id}: q ${q.id} bad points (${q.points}) — set 1`);
      q.points = 1;
    }
    q.image = fixImage(q.image, `q ${q.id}`);
    q.prompt = fixInline(q.prompt, `q ${q.id}`);
    if (q.type === 'multiple_choice') {
      if (!Array.isArray(q.choices) || q.choices.length < 2) {
        problems.push(`${id}: q ${q.id} MC without choices — set short_answer`);
        q.type = 'short_answer';
        q.choices = [];
      } else {
        for (const c of q.choices) {
          c.image = fixImage(c.image, `q ${q.id} choice ${c.id}`);
          c.text = fixInline(c.text, `q ${q.id} choice ${c.id}`);
        }
        if (q.correctChoiceId && !q.choices.find((c) => c.id === q.correctChoiceId)) {
          problems.push(`${id}: q ${q.id} correctChoiceId ${q.correctChoiceId} not in choices — cleared`);
          q.correctChoiceId = null;
        }
      }
    } else {
      q.choices = [];
      q.correctChoiceId = null;
    }
    q.answerKey = q.answerKey || null;
    q.criteria = q.criteria || null;
    q.paperOnly = !!q.paperOnly;
  }

  t.published = true;
  if (t.aiRules === undefined) t.aiRules = null;
  fs.writeFileSync(path.join(TESTS_DIR, id + '.json'), JSON.stringify(t, null, 2));
  okCount++;
  const pts = t.questions.reduce((s, q) => s + q.points, 0);
  console.log(`ok ${id}: ${t.questions.length} q, ${pts} pts — ${t.title}`);
}

console.log(`\nimported ${okCount} tests`);
if (problems.length) {
  console.log(`\n${problems.length} notes:`);
  for (const p of problems) console.log('  - ' + p);
}
