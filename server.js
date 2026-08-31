// BGA entrance tests — local server
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { store, id } = require('./lib/store');
const { gradeAttempt, computeTotals } = require('./lib/grader');

const app = express();
const PORT = process.env.PORT || 4310;
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const teacherTokens = new Set();

function requireTeacher(req, res, next) {
  const token = req.headers['x-teacher-token'];
  if (!token || !teacherTokens.has(token)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function publicTestMeta(t) {
  return {
    id: t.id,
    title: t.title,
    titleKa: t.titleKa || null,
    division: t.division,
    track: t.track,
    grade: t.grade,
    subject: t.subject,
    language: t.language,
    durationMinutes: t.durationMinutes,
    questionCount: t.questions.length,
    totalPoints: t.questions.reduce((s, q) => s + (q.points || 0), 0),
    published: t.published !== false,
  };
}

// strip answer keys/criteria before sending a test to a student
function studentTest(t) {
  return {
    ...publicTestMeta(t),
    instructions: t.instructions,
    sections: t.sections,
    questions: t.questions.map((q) => ({
      id: q.id,
      sectionId: q.sectionId,
      number: q.number,
      type: q.type,
      prompt: q.prompt,
      image: q.image || null,
      choices: (q.choices || []).map((c) => ({ id: c.id, text: c.text, image: c.image || null })),
      points: q.points,
      paperOnly: !!q.paperOnly,
    })),
  };
}

function attemptForStudent(a) {
  const { grades, ...rest } = a;
  return rest; // students don't see grading while in progress
}

// ---------- student API ----------
app.get('/api/tests', (req, res) => {
  res.json(store.listTests().map(publicTestMeta).filter((t) => t.published));
});

app.get('/api/tests/:id/take', (req, res) => {
  const t = store.getTest(req.params.id);
  if (!t || t.published === false) return res.status(404).json({ error: 'not found' });
  res.json(studentTest(t));
});

app.post('/api/attempts', (req, res) => {
  const { testId, student } = req.body || {};
  const t = store.getTest(testId);
  if (!t || t.published === false) return res.status(404).json({ error: 'test not found' });
  const first = student && String(student.firstName || '').trim();
  const last = student && String(student.lastName || '').trim();
  if (!first || !last) return res.status(400).json({ error: 'name required' });
  const attempt = store.createAttempt(t, { firstName: first, lastName: last });
  res.json(attemptForStudent(attempt));
});

app.get('/api/attempts/:id', (req, res) => {
  const a = store.getAttempt(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(attemptForStudent(a));
});

app.put('/api/attempts/:id/answers', (req, res) => {
  const a = store.getAttempt(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (a.status !== 'in_progress') return res.status(409).json({ error: 'already submitted' });
  if (Date.now() > Date.parse(a.deadline) + 2 * 60000)
    return res.status(409).json({ error: 'time is up' });
  const answers = req.body && req.body.answers;
  if (answers && typeof answers === 'object') {
    for (const [qid, val] of Object.entries(answers)) {
      if (!/^[\w-]+$/.test(qid)) continue;
      a.answers[qid] = {
        choiceId: val && typeof val.choiceId === 'string' ? val.choiceId.slice(0, 8) : undefined,
        text: val && typeof val.text === 'string' ? val.text.slice(0, 20000) : undefined,
      };
    }
    store.saveAttempt(a);
  }
  res.json({ ok: true, savedAt: new Date().toISOString() });
});

app.post('/api/attempts/:id/submit', (req, res) => {
  const a = store.getAttempt(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (a.status !== 'in_progress') return res.status(409).json({ error: 'already submitted' });
  a.status = 'submitted';
  a.submittedAt = new Date().toISOString();
  store.saveAttempt(a);
  gradeAttempt(a.id); // async — runs in background
  res.json({ ok: true });
});

// ---------- teacher API ----------
app.post('/api/session/teacher', (req, res) => {
  const { password } = req.body || {};
  if (password !== store.settings().teacherPassword)
    return res.status(401).json({ error: 'wrong password' });
  const token = crypto.randomBytes(24).toString('base64url');
  teacherTokens.add(token);
  res.json({ token });
});

app.get('/api/teacher/overview', requireTeacher, (req, res) => {
  const tests = store.listTests();
  const attempts = store.listAttempts();
  res.json({
    tests: tests.map((t) => ({
      ...publicTestMeta(t),
      hasAiRules: !!t.aiRules,
      keysMissing: t.questions.filter(
        (q) =>
          (q.type === 'multiple_choice' && !q.correctChoiceId) ||
          (q.type === 'short_answer' && !q.answerKey)
      ).length,
    })),
    attempts: attempts.map((a) => ({
      id: a.id,
      testId: a.testId,
      testTitle: a.testTitle,
      student: a.student,
      status: a.status,
      startedAt: a.startedAt,
      submittedAt: a.submittedAt,
      totalScore: a.totalScore,
      maxScore: a.maxScore,
    })),
    settings: (({ teacherPassword, anthropicApiKey, ...s }) => ({
      ...s,
      hasApiKey: !!(anthropicApiKey || process.env.ANTHROPIC_API_KEY),
    }))(store.settings()),
  });
});

app.get('/api/teacher/tests/:id', requireTeacher, (req, res) => {
  const t = store.getTest(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(t);
});

app.put('/api/teacher/tests/:id', requireTeacher, (req, res) => {
  const t = store.getTest(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const next = req.body;
  if (!next || next.id !== t.id) return res.status(400).json({ error: 'id mismatch' });
  if (!Array.isArray(next.questions) || !Array.isArray(next.sections))
    return res.status(400).json({ error: 'invalid test' });
  store.saveTest(next);
  res.json({ ok: true });
});

app.get('/api/teacher/attempts/:id', requireTeacher, (req, res) => {
  const a = store.getAttempt(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const t = store.getTest(a.testId);
  res.json({ attempt: a, test: t });
});

app.put('/api/teacher/attempts/:id/grade', requireTeacher, (req, res) => {
  const a = store.getAttempt(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const { questionId, score, feedback } = req.body || {};
  const t = store.getTest(a.testId);
  const q = t && t.questions.find((x) => x.id === questionId);
  if (!q) return res.status(400).json({ error: 'unknown question' });
  let s = Math.round(Number(score) * 2) / 2;
  if (!isFinite(s)) return res.status(400).json({ error: 'invalid score' });
  s = Math.max(0, Math.min(q.points, s));
  a.grades[questionId] = {
    score: s,
    maxPoints: q.points,
    source: 'teacher',
    feedback: feedback == null ? (a.grades[questionId] || {}).feedback || null : feedback,
  };
  computeTotals(a);
  store.saveAttempt(a);
  res.json({ ok: true, totalScore: a.totalScore });
});

app.post('/api/teacher/attempts/:id/regrade', requireTeacher, (req, res) => {
  const a = store.getAttempt(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (a.status === 'in_progress') return res.status(409).json({ error: 'not submitted yet' });
  const mode = (req.body && req.body.mode) || 'missing'; // 'missing' | 'all'
  gradeAttempt(a.id, { aiOnlyMissing: mode !== 'all' });
  res.json({ ok: true });
});

app.put('/api/teacher/attempts/:id/status', requireTeacher, (req, res) => {
  const a = store.getAttempt(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const { status } = req.body || {};
  if (!['submitted', 'graded', 'needs_review', 'reviewed'].includes(status))
    return res.status(400).json({ error: 'invalid status' });
  a.status = status;
  store.saveAttempt(a);
  res.json({ ok: true });
});

app.put('/api/teacher/settings', requireTeacher, (req, res) => {
  const allowed = ['teacherPassword', 'aiModel', 'anthropicApiKey', 'globalRules'];
  const patch = {};
  for (const k of allowed) if (req.body && req.body[k] !== undefined) patch[k] = req.body[k];
  const s = store.saveSettings(patch);
  res.json({ ok: true, aiModel: s.aiModel });
});

app.listen(PORT, () => {
  console.log(`BGA entrance tests running at http://localhost:${PORT}`);
});
