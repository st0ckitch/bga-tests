// JSON-file storage with atomic writes. One file per test and per attempt.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = path.join(__dirname, '..', 'data');
const TESTS_DIR = path.join(DATA, 'tests');
const ATTEMPTS_DIR = path.join(DATA, 'attempts');
const SETTINGS_FILE = path.join(DATA, 'settings.json');

for (const d of [DATA, TESTS_DIR, ATTEMPTS_DIR]) fs.mkdirSync(d, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

function writeJson(file, obj) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function id(prefix) {
  return prefix + '_' + crypto.randomBytes(9).toString('base64url');
}

const DEFAULT_SETTINGS = {
  teacherPassword: 'bga-admin',
  aiModel: 'claude-sonnet-5',
  anthropicApiKey: null,
  globalRules:
    'Be a fair but strict examiner. Award partial credit in 0.5 steps when part of the work is correct. ' +
    'Accept equivalent answers (e.g. 0.5 = 1/2, different but correct wording). ' +
    'Do not award points for restating the question. Give feedback in the language of the test.',
};

const store = {
  settings() {
    return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) };
  },
  saveSettings(patch) {
    const next = { ...this.settings(), ...patch };
    writeJson(SETTINGS_FILE, next);
    return next;
  },

  listTests() {
    return fs
      .readdirSync(TESTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(path.join(TESTS_DIR, f)))
      .sort((a, b) => {
        const g = (t) => (t.grade === 'DP' ? 99 : parseInt(t.grade, 10) || 0);
        return (
          a.division.localeCompare(b.division) || // primary first
          a.track.localeCompare(b.track) ||
          g(a) - g(b) ||
          a.subject.localeCompare(b.subject)
        );
      });
  },
  getTest(testId) {
    const file = path.join(TESTS_DIR, testId + '.json');
    if (!/^[\w-]+$/.test(testId) || !fs.existsSync(file)) return null;
    return readJson(file);
  },
  saveTest(test) {
    writeJson(path.join(TESTS_DIR, test.id + '.json'), test);
    return test;
  },

  createAttempt(test, student) {
    const now = new Date();
    const attempt = {
      id: id('a'),
      testId: test.id,
      testTitle: test.title,
      student,
      startedAt: now.toISOString(),
      deadline: new Date(now.getTime() + test.durationMinutes * 60000).toISOString(),
      submittedAt: null,
      status: 'in_progress', // in_progress | submitted | grading | graded | needs_review | reviewed
      answers: {},
      grades: {},
      totalScore: null,
      maxScore: test.questions.reduce((s, q) => s + (q.points || 0), 0),
    };
    writeJson(path.join(ATTEMPTS_DIR, attempt.id + '.json'), attempt);
    return attempt;
  },
  getAttempt(attemptId) {
    const file = path.join(ATTEMPTS_DIR, attemptId + '.json');
    if (!/^[\w-]+$/.test(attemptId) || !fs.existsSync(file)) return null;
    return readJson(file);
  },
  saveAttempt(attempt) {
    writeJson(path.join(ATTEMPTS_DIR, attempt.id + '.json'), attempt);
    return attempt;
  },
  listAttempts() {
    return fs
      .readdirSync(ATTEMPTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(path.join(ATTEMPTS_DIR, f)))
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  },
};

module.exports = { store, id };
