// AI grading: Anthropic API when a key is configured, otherwise the local `claude` CLI.
const { execFile } = require('child_process');
const { store } = require('./store');

function normalize(s) {
  return String(s == null ? '' : s)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/, '')
    .replace(/,/g, '.'); // decimal comma -> point
}

// Deterministic marking for questions that have a key. Returns a grade or null.
function autoGrade(question, answer) {
  if (question.type === 'multiple_choice' && question.correctChoiceId) {
    const chosen = answer && answer.choiceId;
    if (!chosen) return { score: 0, source: 'auto', feedback: null };
    return {
      score: chosen === question.correctChoiceId ? question.points : 0,
      source: 'auto',
      feedback: null,
    };
  }
  if (question.type === 'short_answer' && question.answerKey) {
    const given = normalize(answer && answer.text);
    if (!given) return { score: 0, source: 'auto', feedback: null };
    const keys = String(question.answerKey)
      .split(/\s*\|\s*/) // teacher can list alternatives: "1/2 | 0.5"
      .map(normalize);
    if (keys.includes(given)) return { score: question.points, source: 'auto', feedback: null };
    return null; // near-miss -> AI decides
  }
  return null;
}

function buildPrompt(test, questions, answers) {
  const settings = store.settings();
  const lines = [];
  lines.push(
    'You are marking answers from a school entrance test. Grade strictly by the criteria below.'
  );
  lines.push(`Test: ${test.title} (subject: ${test.subject}, grade applied for: ${test.grade}, language: ${test.language === 'ka' ? 'Georgian' : 'English'})`);
  lines.push('\nGeneral marking rules set by the school:\n' + (settings.globalRules || ''));
  if (test.aiRules) lines.push('\nTest-specific rules set by the teacher:\n' + test.aiRules);
  lines.push('\n--- QUESTIONS TO MARK ---');
  for (const q of questions) {
    const a = answers[q.id];
    lines.push(`\n[Question ${q.id}] (max ${q.points} points)`);
    if (q.sectionPassage) lines.push('Context passage (excerpt):\n' + q.sectionPassage.slice(0, 4000));
    lines.push('Question:\n' + q.prompt);
    if (q.type === 'multiple_choice') {
      lines.push('Choices:\n' + q.choices.map((c) => `${c.id}. ${c.text}`).join('\n'));
      lines.push('Student chose: ' + ((a && a.choiceId) || '(no answer)'));
    } else {
      if (q.answerKey) lines.push('Expected answer (key): ' + q.answerKey);
      if (q.criteria) lines.push('Marking criteria:\n' + q.criteria);
      lines.push('Student answer:\n' + ((a && a.text) || '(no answer)'));
    }
  }
  lines.push(
    '\n--- OUTPUT ---\n' +
      'Respond with ONLY a JSON array, no markdown fences, one object per question:\n' +
      '[{"questionId":"q1","score":<number, 0 to max, 0.5 steps>,"feedback":"<1-3 sentences for the teacher/student, in the language of the test>","confidence":"high|medium|low"}]'
  );
  return lines.join('\n');
}

function parseModelJson(text) {
  const m = String(text).match(/\[[\s\S]*\]/);
  if (!m) throw new Error('no JSON array in model output');
  return JSON.parse(m[0]);
}

async function callAnthropic(prompt, model, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error('Anthropic API ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  return data.content.map((b) => b.text || '').join('');
}

const fs = require('fs');
const path = require('path');

function findClaudeCli() {
  const home = process.env.HOME || '';
  const candidates = [
    'claude',
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
  ];
  for (const c of candidates) {
    if (c === 'claude') continue; // tried via PATH below
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (e) {}
  }
  return 'claude';
}

function callClaudeCli(prompt, model) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      findClaudeCli(),
      ['-p', '--output-format', 'json', '--model', model],
      {
        timeout: 300000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, PATH: ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(':') },
      },
      (err, stdout) => {
        if (err) return reject(new Error('claude CLI failed: ' + err.message));
        try {
          const envelope = JSON.parse(stdout);
          resolve(envelope.result || '');
        } catch (e) {
          reject(new Error('claude CLI output not JSON'));
        }
      }
    );
    child.stdin.end(prompt);
  });
}

async function gradeWithAI(test, questions, answers) {
  const settings = store.settings();
  const prompt = buildPrompt(test, questions, answers);
  const apiKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  const raw = apiKey
    ? await callAnthropic(prompt, settings.aiModel, apiKey)
    : await callClaudeCli(prompt, settings.aiModel);
  const items = parseModelJson(raw);
  const byId = {};
  for (const item of items) {
    const q = questions.find((x) => x.id === item.questionId);
    if (!q) continue;
    let score = Math.round(Number(item.score) * 2) / 2;
    if (!isFinite(score)) score = 0;
    score = Math.max(0, Math.min(q.points, score));
    byId[q.id] = {
      score,
      source: 'ai',
      feedback: item.feedback || null,
      aiConfidence: item.confidence || 'medium',
    };
  }
  return byId;
}

// --- grading queue (serialized, in-process) ---
let chain = Promise.resolve();

function computeTotals(attempt) {
  let total = 0;
  let graded = 0;
  const n = Object.keys(attempt.grades).length;
  for (const g of Object.values(attempt.grades)) {
    if (typeof g.score === 'number') {
      total += g.score;
      graded++;
    }
  }
  attempt.totalScore = Math.round(total * 2) / 2;
  return { graded, of: n };
}

function gradeAttempt(attemptId, { aiOnlyMissing = true } = {}) {
  chain = chain.then(() => doGrade(attemptId, aiOnlyMissing)).catch((e) => {
    console.error('[grader]', attemptId, e.message);
  });
  return chain;
}

async function doGrade(attemptId, aiOnlyMissing) {
  let attempt = store.getAttempt(attemptId);
  if (!attempt) return;
  const test = store.getTest(attempt.testId);
  if (!test) return;

  attempt.status = 'grading';
  store.saveAttempt(attempt);

  const passages = {};
  for (const s of test.sections || []) passages[s.id] = s.passage || null;

  const needsAI = [];
  for (const q of test.questions) {
    const existing = attempt.grades[q.id];
    if (existing && existing.source === 'teacher') continue; // never clobber a manual mark
    if (existing && aiOnlyMissing && existing.source === 'ai') continue;
    const answer = attempt.answers[q.id];
    const auto = autoGrade(q, answer);
    if (auto) {
      attempt.grades[q.id] = { ...auto, maxPoints: q.points };
    } else if (!answer || (answer.text != null && !String(answer.text).trim() && !answer.choiceId)) {
      attempt.grades[q.id] = { score: 0, source: 'auto', feedback: null, maxPoints: q.points };
    } else {
      needsAI.push({ ...q, sectionPassage: passages[q.sectionId] });
    }
  }
  store.saveAttempt(attempt);

  let aiFailed = false;
  // grade in batches of 8 questions per model call
  for (let i = 0; i < needsAI.length; i += 8) {
    const batch = needsAI.slice(i, i + 8);
    try {
      const grades = await gradeWithAI(test, batch, attempt.answers);
      attempt = store.getAttempt(attemptId); // re-read in case teacher edited meanwhile
      for (const q of batch) {
        const existing = attempt.grades[q.id];
        if (existing && existing.source === 'teacher') continue;
        if (grades[q.id]) attempt.grades[q.id] = { ...grades[q.id], maxPoints: q.points };
      }
      store.saveAttempt(attempt);
    } catch (e) {
      console.error('[grader] AI batch failed:', e.message);
      aiFailed = true;
    }
  }

  attempt = store.getAttempt(attemptId);
  computeTotals(attempt);
  const ungraded = test.questions.filter((q) => !attempt.grades[q.id]);
  attempt.status = aiFailed || ungraded.length ? 'needs_review' : 'graded';
  attempt.gradedAt = new Date().toISOString();
  store.saveAttempt(attempt);
}

module.exports = { gradeAttempt, autoGrade, computeTotals };
