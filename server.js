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

// students see their answers but no grading information at all
function attemptForStudent(a) {
  const { grades, totalScore, gradedAt, ...rest } = a;
  return { ...rest, status: a.status === 'in_progress' ? 'in_progress' : 'submitted' };
}

const GRACE_MS = 2 * 60000;

// auto-finalize an in_progress attempt whose deadline (+grace) has passed,
// so autosaved answers still get graded and the attempt never strands
function finalizeIfExpired(a) {
  if (a && a.status === 'in_progress' && Date.now() > Date.parse(a.deadline) + GRACE_MS) {
    a.status = 'submitted';
    a.submittedAt = a.deadline;
    a.autoSubmitted = true;
    store.saveAttempt(a);
    gradeAttempt(a.id);
  }
  return a;
}

// per-attempt auth: the request must carry the owner's access code
function requireAttemptOwner(req, res) {
  const a = store.getAttempt(req.params.id);
  if (!a) { res.status(404).json({ error: 'not found' }); return null; }
  const code = req.headers['x-student-code'] || (req.body && req.body.code);
  const student = store.getStudentByCode(code);
  if (!student || student.id !== a.studentId) {
    res.status(401).json({ error: 'access code required' });
    return null;
  }
  return finalizeIfExpired(a);
}

// throttle code guessing: max 20 failed logins per IP per 10 minutes
const loginFails = new Map();
function throttled(ip) {
  const now = Date.now();
  const rec = (loginFails.get(ip) || []).filter((t) => now - t < 10 * 60000);
  loginFails.set(ip, rec);
  return rec.length >= 20;
}
function noteFail(ip) {
  loginFails.get(ip).push(Date.now());
}

// ---------- student API ----------
function attemptBrief(a) {
  return {
    id: a.id,
    testId: a.testId,
    status: a.status === 'in_progress' ? 'in_progress' : 'submitted',
    submittedAt: a.submittedAt,
  };
}

// student signs in with the access code the teacher gave them
app.post('/api/session/student', (req, res) => {
  if (throttled(req.ip)) return res.status(429).json({ error: 'Too many tries — wait a few minutes.' });
  const student = store.getStudentByCode(req.body && req.body.code);
  if (!student) {
    noteFail(req.ip);
    return res.status(401).json({ error: 'unknown code' });
  }
  const attempts = {};
  for (const a of store.listAttempts()) {
    if (a.studentId === student.id) attempts[a.testId] = attemptBrief(finalizeIfExpired(a));
  }
  // assigned tests, plus any test with a live attempt (so an unassign/unpublish
  // mid-exam never hides an attempt the student needs to finish)
  const visible = new Set(student.assignedTestIds || []);
  for (const [tid, att] of Object.entries(attempts)) if (att.status === 'in_progress') visible.add(tid);
  const tests = [...visible]
    .map((tid) => {
      const t = store.getTest(tid);
      if (!t) return null;
      const live = attempts[tid] && attempts[tid].status === 'in_progress';
      return t.published !== false || live ? publicTestMeta(t) : null;
    })
    .filter(Boolean);
  res.json({
    student: { id: student.id, firstName: student.firstName, lastName: student.lastName },
    tests,
    attempts,
  });
});

// full test content — only with a valid code that has this test assigned
app.post('/api/tests/:id/take', (req, res) => {
  const student = store.getStudentByCode(req.body && req.body.code);
  if (!student) return res.status(401).json({ error: 'unknown code' });
  const t = store.getTest(req.params.id);
  if (!t) return res.status(404).json({ error: 'test not available for you' });
  const existing = store.findAttempt(student.id, t.id);
  const live = existing && finalizeIfExpired(existing).status === 'in_progress';
  if (!live && (t.published === false || !(student.assignedTestIds || []).includes(t.id)))
    return res.status(404).json({ error: 'test not available for you' });
  res.json(studentTest(t));
});

app.post('/api/attempts', (req, res) => {
  const { testId, code } = req.body || {};
  const student = store.getStudentByCode(code);
  if (!student) return res.status(401).json({ error: 'unknown code' });
  const t = store.getTest(testId);
  if (!t) return res.status(404).json({ error: 'test not available for you' });
  const existing = store.findAttempt(student.id, t.id);
  if (existing) {
    finalizeIfExpired(existing);
    if (existing.status === 'in_progress')
      return res.json(attemptForStudent(existing)); // resume (even if unassigned meanwhile)
    return res.status(409).json({ error: 'You have already completed this test.' });
  }
  if (t.published === false || !(student.assignedTestIds || []).includes(t.id))
    return res.status(404).json({ error: 'test not available for you' });
  const attempt = store.createAttempt(t, {
    id: student.id,
    firstName: student.firstName,
    lastName: student.lastName,
  });
  res.json(attemptForStudent(attempt));
});

app.get('/api/attempts/:id', (req, res) => {
  const a = requireAttemptOwner(req, res);
  if (!a) return;
  res.json(attemptForStudent(a));
});

app.put('/api/attempts/:id/answers', (req, res) => {
  const a = requireAttemptOwner(req, res);
  if (!a) return;
  if (a.status !== 'in_progress') return res.status(409).json({ error: 'already submitted' });
  if (Date.now() > Date.parse(a.deadline) + GRACE_MS)
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
  const a = requireAttemptOwner(req, res);
  if (!a) return;
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
  const attempts = store.listAttempts().map(finalizeIfExpired);
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
  finalizeIfExpired(a);
  const t = store.getTest(a.testId);
  const roster = a.studentId ? store.getStudent(a.studentId) : null;
  res.json({ attempt: a, test: t, studentCode: roster ? roster.code : null });
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

// ---------- teacher: students ----------
app.get('/api/teacher/students', requireTeacher, (req, res) => {
  const attempts = store.listAttempts();
  res.json(
    store.listStudents().map((st) => ({
      ...st,
      attempts: attempts
        .filter((a) => a.studentId === st.id)
        .map((a) => ({ id: a.id, testId: a.testId, status: a.status, totalScore: a.totalScore, maxScore: a.maxScore })),
    }))
  );
});

app.post('/api/teacher/students', requireTeacher, (req, res) => {
  const firstName = String((req.body && req.body.firstName) || '').trim();
  const lastName = String((req.body && req.body.lastName) || '').trim();
  if (!firstName || !lastName) return res.status(400).json({ error: 'name required' });
  res.json(store.createStudent({ firstName, lastName }));
});

app.put('/api/teacher/students/:id', requireTeacher, (req, res) => {
  const st = store.getStudent(req.params.id);
  if (!st) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (b.firstName !== undefined) st.firstName = String(b.firstName).trim() || st.firstName;
  if (b.lastName !== undefined) st.lastName = String(b.lastName).trim() || st.lastName;
  if (Array.isArray(b.assignedTestIds))
    st.assignedTestIds = b.assignedTestIds.filter((tid) => typeof tid === 'string' && store.getTest(tid));
  store.saveStudent(st);
  res.json(st);
});

app.post('/api/teacher/students/:id/regenerate-code', requireTeacher, (req, res) => {
  const st = store.getStudent(req.params.id);
  if (!st) return res.status(404).json({ error: 'not found' });
  st.code = store.accessCode();
  store.saveStudent(st);
  res.json(st);
});

app.delete('/api/teacher/students/:id', requireTeacher, (req, res) => {
  const st = store.getStudent(req.params.id);
  if (!st) return res.status(404).json({ error: 'not found' });
  store.deleteStudent(st.id);
  res.json({ ok: true });
});

// delete an attempt (lets the student retake the test)
app.delete('/api/teacher/attempts/:id', requireTeacher, (req, res) => {
  const a = store.getAttempt(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  store.deleteAttempt(a.id);
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
