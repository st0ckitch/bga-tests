// Teacher portal: dashboard / attempt review / test editor / settings
const app = document.getElementById('app');
let token = sessionStorage.getItem('bga_teacher_token');
let overview = null; // { tests, attempts, settings }
let dashFilter = { testId: 'all', status: 'all' };

const STATUS_META = {
  in_progress:  { label: 'In progress',  cls: '' },
  submitted:    { label: 'Submitted',    cls: 'accent' },
  grading:      { label: 'AI grading…',  cls: 'accent' },
  graded:       { label: 'AI graded',    cls: 'good' },
  needs_review: { label: 'Needs review', cls: 'warn' },
  reviewed:     { label: 'Reviewed',     cls: 'good' },
};

async function tapi(path, opts = {}) {
  try {
    return await api(path, { ...opts, headers: { 'x-teacher-token': token, ...(opts.headers || {}) } });
  } catch (e) {
    if (e.status === 401) { token = null; sessionStorage.removeItem('bga_teacher_token'); route(); }
    throw e;
  }
}

window.addEventListener('hashchange', route);
route();

async function route() {
  if (!token) return renderLogin();
  const h = location.hash || '#/dashboard';
  const [, page, arg] = h.split('/');
  try {
    if (page === 'attempt' && arg) return await renderAttempt(arg);
    if (page === 'tests') return await renderTests();
    if (page === 'test' && arg) return await renderTestEditor(arg);
    if (page === 'settings') return await renderSettings();
    return await renderDashboard();
  } catch (e) { toast(e.message); }
}

/* ---------- login ---------- */
function renderLogin() {
  app.innerHTML = `
  <div class="landing">
    <form class="card landing-card" id="loginForm" style="text-align:left">
      <div class="brand-mark" style="margin:0 0 16px">BGA</div>
      <h1 style="font-size:21px">Teacher portal</h1>
      <p>Sign in to see results, review marking and edit tests.</p>
      <div class="field"><label>Password</label>
        <input class="input" type="password" id="pw" required autofocus></div>
      <button class="btn btn-primary" style="width:100%;margin-top:6px">Sign in</button>
      <p class="muted" style="margin-top:14px">Default password: <b>bga-admin</b> — change it in Settings.</p>
    </form>
  </div>`;
  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/session/teacher', { method: 'POST', body: { password: document.getElementById('pw').value } });
      token = r.token;
      sessionStorage.setItem('bga_teacher_token', token);
      route();
    } catch (err) { toast('Wrong password'); }
  };
}

/* ---------- shell ---------- */
function shell(active, contentHtml, title, sub) {
  app.innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">BGA</div>
        <div><div class="brand-name">BGA</div><div class="brand-sub">teacher portal</div></div></div>
      <div class="nav-label">Overview</div>
      <a class="nav-item ${active === 'dashboard' ? 'active' : ''}" href="#/dashboard">${ico('dash')} Dashboard</a>
      <a class="nav-item ${active === 'tests' ? 'active' : ''}" href="#/tests">${ico('doc')} Tests</a>
      <div class="nav-label">System</div>
      <a class="nav-item ${active === 'settings' ? 'active' : ''}" href="#/settings">${ico('cog')} Settings</a>
      <a class="nav-item" href="/">${ico('home')} Exit portal</a>
      <div class="sidebar-foot">British-Georgian Academy<br>Entrance testing platform</div>
    </aside>
    <div class="main">
      <div class="topbar">
        <div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
        <div class="top-right"><div class="who"><div class="name">Admissions</div><div class="role">Teacher</div></div>
          <div class="avatar">T</div></div>
      </div>
      <div id="content">${contentHtml}</div>
    </div>
  </div>`;
}

/* ---------- dashboard ---------- */
async function renderDashboard() {
  overview = await tapi('/api/teacher/overview');
  const { attempts, tests } = overview;
  const submitted = attempts.filter((a) => a.status !== 'in_progress');
  const pending = attempts.filter((a) => ['submitted', 'grading', 'needs_review', 'graded'].includes(a.status));
  const reviewed = attempts.filter((a) => a.status === 'reviewed');
  const avg = (() => {
    const done = submitted.filter((a) => a.totalScore != null && a.maxScore);
    if (!done.length) return '—';
    return Math.round(done.reduce((s, a) => s + (a.totalScore / a.maxScore) * 100, 0) / done.length) + '%';
  })();

  shell('dashboard', `
    <div class="tiles">
      <div class="card tile"><div class="t-label">Attempts total</div><div class="t-value">${attempts.length}</div>
        <div class="t-foot">${submitted.length} submitted</div></div>
      <div class="card tile"><div class="t-label">Awaiting teacher review</div><div class="t-value">${pending.length}</div>
        <div class="t-foot">${attempts.filter((a) => a.status === 'needs_review').length} flagged by AI</div></div>
      <div class="card tile"><div class="t-label">Reviewed &amp; final</div><div class="t-value">${reviewed.length}</div>
        <div class="t-foot">of ${submitted.length} submitted</div></div>
      <div class="card tile"><div class="t-label">Average score</div><div class="t-value">${avg}</div>
        <div class="t-foot">across submitted attempts</div></div>
    </div>

    <div class="section-title"><span>Score distribution</span></div>
    <div class="card chart-wrap">
      <div class="chart-head">
        <div class="chart-title" id="chartTitle">All tests — submitted attempts by score band</div>
        <select class="input" id="chartTest" style="width:auto"></select>
      </div>
      <div class="bars" id="bars"></div>
    </div>

    <div class="section-title"><span>Attempts</span><span class="row" id="attFilters"></span></div>
    <div class="card" style="overflow-x:auto"><table class="tbl" id="attTbl"></table></div>
  `, 'Dashboard', 'Results, marking status and review queue.');

  // chart test selector
  const sel = document.getElementById('chartTest');
  sel.innerHTML = '<option value="all">All tests</option>' +
    tests.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('');
  sel.value = dashFilter.testId;
  sel.onchange = () => { dashFilter.testId = sel.value; drawChart(); drawTable(); };

  // status filter
  const f = document.getElementById('attFilters');
  const seg = el('<div class="seg"></div>');
  for (const [val, label] of [['all', 'All'], ['pending', 'To review'], ['reviewed', 'Reviewed']]) {
    const b = el(`<button class="${dashFilter.status === val ? 'active' : ''}">${label}</button>`);
    b.onclick = () => { dashFilter.status = val; renderDashboard(); };
    seg.appendChild(b);
  }
  f.appendChild(seg);

  drawChart();
  drawTable();

  function drawChart() {
    const pool = submitted.filter((a) => (dashFilter.testId === 'all' || a.testId === dashFilter.testId) && a.totalScore != null && a.maxScore);
    document.getElementById('chartTitle').textContent =
      (dashFilter.testId === 'all' ? 'All tests' : (tests.find((t) => t.id === dashFilter.testId) || {}).title) +
      ' — submitted attempts by score band';
    const buckets = Array(10).fill(0);
    for (const a of pool) {
      const pct = (a.totalScore / a.maxScore) * 100;
      buckets[Math.min(9, Math.floor(pct / 10))]++;
    }
    const max = Math.max(1, ...buckets);
    const bars = document.getElementById('bars');
    bars.innerHTML = buckets.map((n, i) => `
      <div class="bar-col">
        <div class="tip">${n} attempt${n === 1 ? '' : 's'} · ${i * 10}–${i * 10 + 10}%</div>
        <div class="bar" style="height:${(n / max) * 100}%; ${n ? '' : 'background:var(--line)'}"></div>
        <div class="bar-x">${i * 10}–${i * 10 + 10}</div>
      </div>`).join('');
    if (!pool.length) bars.innerHTML = '<div class="empty" style="width:100%">No submitted attempts yet.</div>';
  }

  function drawTable() {
    const rows = attempts.filter((a) =>
      (dashFilter.testId === 'all' || a.testId === dashFilter.testId) &&
      (dashFilter.status === 'all' ||
        (dashFilter.status === 'pending' && ['submitted', 'grading', 'graded', 'needs_review'].includes(a.status)) ||
        (dashFilter.status === 'reviewed' && a.status === 'reviewed')));
    const tbl = document.getElementById('attTbl');
    if (!rows.length) { tbl.innerHTML = '<tr><td class="empty">No attempts yet — share the student link to begin.</td></tr>'; return; }
    tbl.innerHTML = `
      <tr><th>Student</th><th>Test</th><th>Status</th><th>Score</th><th>Submitted</th><th></th></tr>` +
      rows.map((a) => {
        const s = STATUS_META[a.status] || { label: a.status, cls: '' };
        const score = a.totalScore != null ? `<b>${a.totalScore}</b> / ${a.maxScore}` : '—';
        return `<tr class="rowlink" data-id="${a.id}">
          <td><b>${esc(a.student.firstName)} ${esc(a.student.lastName)}</b></td>
          <td>${esc(a.testTitle)}</td>
          <td><span class="chip ${s.cls}"><span class="dot"></span>${s.label}</span></td>
          <td>${score}</td>
          <td class="muted">${fmtDate(a.submittedAt || a.startedAt)}</td>
          <td><span class="btn btn-soft btn-sm">Open</span></td></tr>`;
      }).join('');
    tbl.querySelectorAll('tr.rowlink').forEach((tr) => (tr.onclick = () => (location.hash = '#/attempt/' + tr.dataset.id)));
  }
}

/* ---------- attempt review ---------- */
async function renderAttempt(attemptId) {
  const { attempt, test } = await tapi('/api/teacher/attempts/' + attemptId);
  const s = STATUS_META[attempt.status] || { label: attempt.status, cls: '' };
  const passages = {};
  (test.sections || []).forEach((x) => (passages[x.id] = x));

  shell('dashboard', `
    <div class="row" style="margin-bottom:18px">
      <a class="btn btn-ghost btn-sm" href="#/dashboard">← Back</a>
      <span class="chip ${s.cls}"><span class="dot"></span>${s.label}</span>
      <span class="spacer"></span>
      <button class="btn btn-soft btn-sm" id="regradeMissing">Run AI on unmarked</button>
      <button class="btn btn-soft btn-sm" id="regradeAll">Re-run AI (all)</button>
      <button class="btn btn-primary btn-sm" id="markReviewed">${attempt.status === 'reviewed' ? '✓ Reviewed' : 'Mark as reviewed'}</button>
    </div>
    <div class="card card-pad" style="margin-bottom:18px">
      <div class="row" style="justify-content:space-between">
        <div>
          <h2 style="font-size:19px">${esc(attempt.student.firstName)} ${esc(attempt.student.lastName)}</h2>
          <div class="muted">${esc(test.title)} · ${esc(GRADE_LABEL(test.grade))} · started ${fmtDate(attempt.startedAt)}${attempt.submittedAt ? ' · submitted ' + fmtDate(attempt.submittedAt) : ''}</div>
        </div>
        <div style="text-align:right">
          <div class="t-label" style="font-size:12px;color:var(--ink-3);font-weight:600">TOTAL SCORE</div>
          <div style="font-size:30px;font-weight:700" id="totalScore">${attempt.totalScore != null ? attempt.totalScore : '—'}<span style="font-size:16px;color:var(--ink-3)"> / ${attempt.maxScore}</span></div>
        </div>
      </div>
    </div>
    <div class="grid" id="qlist"></div>
  `, 'Attempt review', 'Check every answer; adjust AI marks where needed.');

  const qlist = document.getElementById('qlist');
  for (const q of test.questions) {
    const a = attempt.answers[q.id];
    const g = attempt.grades[q.id];
    const sec = passages[q.sectionId];
    const answerHtml = q.type === 'multiple_choice'
      ? (a && a.choiceId
          ? `<div class="ans-block">Chose <b>${esc(a.choiceId)}</b> — ${esc((q.choices.find((c) => c.id === a.choiceId) || {}).text || '')}</div>`
          : '<div class="ans-block muted">No answer</div>')
      : (a && a.text && a.text.trim()
          ? `<div class="ans-block">${esc(a.text)}</div>`
          : '<div class="ans-block muted">No answer</div>');
    const keyHtml = q.type === 'multiple_choice'
      ? (q.correctChoiceId ? `<div class="key-block">Correct: <b>${esc(q.correctChoiceId)}</b> — ${esc((q.choices.find((c) => c.id === q.correctChoiceId) || {}).text || '')}</div>` : '<div class="muted">No key set — assign it in the test editor.</div>')
      : (q.answerKey ? `<div class="key-block">Key: ${esc(q.answerKey)}</div>` : (q.criteria ? `<div class="key-block" style="white-space:pre-wrap">Criteria: ${esc(q.criteria)}</div>` : '<div class="muted">No key/criteria set.</div>'));
    const srcChip = g ? ({ auto: '<span class="chip">Auto-marked</span>', ai: '<span class="chip accent">AI-marked' + (g.aiConfidence ? ' · ' + esc(g.aiConfidence) : '') + '</span>', teacher: '<span class="chip good">Teacher</span>' })[g.source] || '' : '<span class="chip warn">Unmarked</span>';

    const card = el(`<div class="card qcard">
      <div class="qhead">
        <span class="qnum">${esc(q.number)}</span>
        <span class="muted">${sec && sec.title ? esc(sec.title) : ''}</span>
        <span class="qpoints">${q.points} pts</span>
      </div>
      <div class="qprompt">${md(q.prompt)}</div>
      ${q.image ? `<img class="qimg" src="${esc(q.image)}" alt="">` : ''}
      <div class="ans-label">Student answer</div>${answerHtml}
      <div class="ans-label">Key / criteria</div>${keyHtml}
      ${g && g.feedback ? `<div class="ans-label">AI feedback</div><div class="ai-fb">${esc(g.feedback)}</div>` : ''}
      <div class="grade-row">
        ${srcChip}
        <span class="spacer"></span>
        <label class="muted">Score</label>
        <input class="input score-input" type="number" min="0" max="${q.points}" step="0.5" value="${g && g.score != null ? g.score : ''}">
        <span class="muted">/ ${q.points}</span>
        <button class="btn btn-primary btn-sm">Save</button>
      </div>
      <textarea class="input" placeholder="Feedback (optional, shown to admissions team)" style="margin-top:10px" rows="2">${esc((g && g.feedback) || '')}</textarea>
    </div>`);
    const [scoreInput] = [card.querySelector('.score-input')];
    const fbInput = card.querySelector('textarea');
    card.querySelector('.btn-primary').onclick = async () => {
      const r = await tapi(`/api/teacher/attempts/${attempt.id}/grade`, {
        method: 'PUT',
        body: { questionId: q.id, score: Number(scoreInput.value), feedback: fbInput.value },
      });
      document.getElementById('totalScore').innerHTML =
        `${r.totalScore}<span style="font-size:16px;color:var(--ink-3)"> / ${attempt.maxScore}</span>`;
      toast(`Question ${q.number} saved`);
    };
    qlist.appendChild(card);
  }

  document.getElementById('regradeMissing').onclick = () => regrade('missing');
  document.getElementById('regradeAll').onclick = () => regrade('all');
  async function regrade(mode) {
    await tapi(`/api/teacher/attempts/${attempt.id}/regrade`, { method: 'POST', body: { mode } });
    toast('AI grading started — refresh in a moment');
    setTimeout(() => renderAttempt(attemptId), 6000);
  }
  document.getElementById('markReviewed').onclick = async () => {
    await tapi(`/api/teacher/attempts/${attempt.id}/status`, { method: 'PUT', body: { status: 'reviewed' } });
    toast('Marked as reviewed');
    renderAttempt(attemptId);
  };
}

/* ---------- tests manager ---------- */
async function renderTests() {
  overview = await tapi('/api/teacher/overview');
  const groups = [
    ['Primary — Entrance', (t) => t.division === 'primary'],
    ['Secondary — Entrance', (t) => t.division === 'secondary' && t.track === 'entrance'],
    ['Secondary — Scholarship', (t) => t.division === 'secondary' && t.track === 'scholarship'],
  ];
  shell('tests', groups.map(([label, fn]) => {
    const list = overview.tests.filter(fn);
    if (!list.length) return '';
    return `<div class="section-title"><span>${label}</span></div>
    <div class="card" style="overflow-x:auto"><table class="tbl">
      <tr><th>Test</th><th>Grade</th><th>Subject</th><th>Questions</th><th>Points</th><th>Keys missing</th><th>Visible</th><th></th></tr>
      ${list.map((t) => `
        <tr class="rowlink" data-id="${t.id}">
          <td><b>${esc(t.title)}</b>${t.titleKa ? `<div class="muted">${esc(t.titleKa)}</div>` : ''}</td>
          <td>${esc(GRADE_LABEL(t.grade))}</td>
          <td>${(SUBJECT_META[t.subject] || {}).icon || ''} ${(SUBJECT_META[t.subject] || {}).label || t.subject}</td>
          <td>${t.questionCount}</td>
          <td>${t.totalPoints}</td>
          <td>${t.keysMissing ? `<span class="chip warn">${t.keysMissing}</span>` : '<span class="chip good">0</span>'}</td>
          <td>${t.published ? '<span class="chip good"><span class="dot"></span>Published</span>' : '<span class="chip">Hidden</span>'}</td>
          <td><span class="btn btn-soft btn-sm">Edit</span></td>
        </tr>`).join('')}
    </table></div>`;
  }).join(''), 'Tests', `${overview.tests.length} tests imported. Click one to edit questions, keys and AI marking rules.`);

  document.querySelectorAll('tr.rowlink').forEach((tr) => (tr.onclick = () => (location.hash = '#/test/' + tr.dataset.id)));
}

/* ---------- test editor ---------- */
async function renderTestEditor(testId) {
  const test = await tapi('/api/teacher/tests/' + testId);
  shell('tests', `
    <div class="row" style="margin-bottom:18px">
      <a class="btn btn-ghost btn-sm" href="#/tests">← All tests</a>
      <span class="spacer"></span>
      <label class="row" style="gap:8px;font-weight:600;font-size:14px">
        <input type="checkbox" id="pub" ${test.published !== false ? 'checked' : ''} style="width:17px;height:17px;accent-color:var(--accent)"> Published (visible to students)
      </label>
      <button class="btn btn-primary" id="saveTest">Save changes</button>
    </div>
    <div class="card card-pad" style="margin-bottom:18px">
      <div class="grid" style="grid-template-columns:2fr 1fr 1fr">
        <div class="field"><label>Title</label><input class="input" id="tTitle" value="${esc(test.title)}"></div>
        <div class="field"><label>Georgian title</label><input class="input" id="tTitleKa" value="${esc(test.titleKa || '')}"></div>
        <div class="field"><label>Duration (minutes)</label><input class="input" id="tDur" type="number" min="5" value="${test.durationMinutes}"></div>
      </div>
      <div class="field"><label>Instructions shown to the student (markdown)</label>
        <textarea class="input" id="tInstr" rows="3">${esc(test.instructions || '')}</textarea></div>
      <div class="field" style="margin-bottom:0"><label>AI marking rules for this test — criteria, conditions, style of feedback (used by the AI checker)</label>
        <textarea class="input" id="tRules" rows="4" placeholder="e.g. Spelling mistakes lose 0.5 pt only in Section B. Accept answers in Georgian or English. Award method marks even if the final answer is wrong.">${esc(test.aiRules || '')}</textarea></div>
    </div>
    ${(test.importNotes && test.importNotes.length) ? `
    <details class="card card-pad" style="margin-bottom:18px">
      <summary style="cursor:pointer;font-weight:700;font-size:15px">📋 Digitization notes (${test.importNotes.length}) — things the AI import flagged for teacher review</summary>
      <ul style="margin:12px 0 0 18px;font-size:13.5px;color:var(--ink-2);display:grid;gap:6px">
        ${test.importNotes.map((n) => `<li>${esc(n)}</li>`).join("")}
      </ul>
    </details>` : ""}
    <div class="section-title"><span>Questions (${test.questions.length})</span></div>
    <div class="grid" id="qeds"></div>
  `, esc(test.title), `${esc(GRADE_LABEL(test.grade))} · ${test.questions.length} questions · edit prompts, points, correct answers and criteria.`);

  const qeds = document.getElementById('qeds');
  const secTitle = {};
  (test.sections || []).forEach((s) => (secTitle[s.id] = s.title));

  test.questions.forEach((q, qi) => {
    const card = el(`<div class="card qcard" data-qi="${qi}">
      <div class="qhead">
        <span class="qnum">${esc(q.number)}</span>
        <span class="muted">${esc(secTitle[q.sectionId] || '')}</span>
        <span class="spacer"></span>
        <select class="input" data-f="type" style="width:auto">
          <option value="multiple_choice" ${q.type === 'multiple_choice' ? 'selected' : ''}>Multiple choice</option>
          <option value="short_answer" ${q.type === 'short_answer' ? 'selected' : ''}>Short answer</option>
          <option value="open_response" ${q.type === 'open_response' ? 'selected' : ''}>Open response</option>
        </select>
        <label class="muted">pts</label>
        <input class="input score-input" data-f="points" type="number" min="0" step="0.5" value="${q.points}">
      </div>
      <div class="field"><label>Prompt (markdown)</label>
        <textarea class="input" data-f="prompt" rows="${Math.min(8, Math.max(2, Math.ceil((q.prompt || '').length / 90)))}">${esc(q.prompt)}</textarea></div>
      ${q.image ? `<img class="qimg" src="${esc(q.image)}" alt="" style="max-height:200px">` : ''}
      <div class="q-editor" data-zone></div>
    </div>`);
    const zone = card.querySelector('[data-zone]');
    const typeSel = card.querySelector('[data-f="type"]');
    const renderZone = () => {
      const type = typeSel.value;
      zone.innerHTML = '';
      if (type === 'multiple_choice') {
        zone.appendChild(el('<div class="ans-label" style="margin-top:0">Choices — select the correct one</div>'));
        (q.choices || []).forEach((c) => {
          const row = el(`<div class="choice-edit">
            <input type="radio" name="key-${q.id}" ${q.correctChoiceId === c.id ? 'checked' : ''} title="Mark as correct">
            <span class="cid" style="font-weight:700;color:var(--accent)">${esc(c.id)}</span>
            <input class="input" value="${esc(c.text)}" style="flex:1">
          </div>`);
          row.querySelector('input[type=radio]').onchange = () => (q.correctChoiceId = c.id);
          row.querySelector('input.input').oninput = (e) => (c.text = e.target.value);
          zone.appendChild(row);
        });
        const clearBtn = el('<button class="btn btn-ghost btn-sm" style="margin-top:6px">No correct answer (send to AI/manual)</button>');
        clearBtn.onclick = () => { q.correctChoiceId = null; renderZone(); };
        zone.appendChild(clearBtn);
      } else if (type === 'short_answer') {
        const f = el(`<div class="field" style="margin:0"><label>Answer key — exact expected answer(s), separate alternatives with “|”</label>
          <input class="input" value="${esc(q.answerKey || '')}" placeholder="e.g. 42 | forty-two"></div>`);
        f.querySelector('input').oninput = (e) => (q.answerKey = e.target.value || null);
        zone.appendChild(f);
      }
      if (type !== 'multiple_choice') {
        const f = el(`<div class="field" style="margin:10px 0 0"><label>AI marking criteria for this question</label>
          <textarea class="input" rows="3" placeholder="What earns each point? e.g. 1 pt correct method, 1 pt correct final answer.">${esc(q.criteria || '')}</textarea></div>`);
        f.querySelector('textarea').oninput = (e) => (q.criteria = e.target.value || null);
        zone.appendChild(f);
      }
    };
    typeSel.onchange = () => { q.type = typeSel.value; renderZone(); };
    card.querySelector('[data-f="points"]').oninput = (e) => (q.points = Number(e.target.value) || 0);
    card.querySelector('[data-f="prompt"]').oninput = (e) => (q.prompt = e.target.value);
    renderZone();
    qeds.appendChild(card);
  });

  document.getElementById('saveTest').onclick = async () => {
    test.title = document.getElementById('tTitle').value.trim() || test.title;
    test.titleKa = document.getElementById('tTitleKa').value.trim() || null;
    test.durationMinutes = Number(document.getElementById('tDur').value) || test.durationMinutes;
    test.instructions = document.getElementById('tInstr').value.trim() || null;
    test.aiRules = document.getElementById('tRules').value.trim() || null;
    test.published = document.getElementById('pub').checked;
    await tapi('/api/teacher/tests/' + test.id, { method: 'PUT', body: test });
    toast('Test saved');
  };
}

/* ---------- settings ---------- */
async function renderSettings() {
  overview = await tapi('/api/teacher/overview');
  const s = overview.settings;
  shell('settings', `
    <div class="card card-pad" style="max-width:680px">
      <h2 style="font-size:17px;margin-bottom:14px">AI marking</h2>
      <div class="field"><label>Model</label>
        <select class="input" id="sModel">
          ${['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'].map((m) => `<option ${s.aiModel === m ? 'selected' : ''}>${m}</option>`).join('')}
        </select></div>
      <div class="field"><label>Anthropic API key ${s.hasApiKey ? '<span class="chip good">configured</span>' : '<span class="chip warn">not set — AI marking is off; answers without keys are flagged for manual review</span>'}</label>
        <input class="input" id="sKey" type="password" placeholder="sk-ant-… (leave empty to keep using the local Claude CLI)"></div>
      <div class="field"><label>Global marking rules (apply to every test; per-test rules are in each test's editor)</label>
        <textarea class="input" id="sRules" rows="5">${esc(s.globalRules || '')}</textarea></div>
      <h2 style="font-size:17px;margin:22px 0 14px">Access</h2>
      <div class="field"><label>Teacher password</label>
        <input class="input" id="sPw" type="text" placeholder="leave empty to keep current"></div>
      <button class="btn btn-primary" id="saveSettings">Save settings</button>
    </div>
  `, 'Settings', 'AI checker configuration and portal access.');

  document.getElementById('saveSettings').onclick = async () => {
    const body = {
      aiModel: document.getElementById('sModel').value,
      globalRules: document.getElementById('sRules').value,
    };
    const key = document.getElementById('sKey').value.trim();
    if (key) body.anthropicApiKey = key;
    const pw = document.getElementById('sPw').value.trim();
    if (pw) body.teacherPassword = pw;
    await tapi('/api/teacher/settings', { method: 'PUT', body });
    toast('Settings saved');
  };
}

/* ---------- icons ---------- */
function ico(name) {
  const m = {
    dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/></svg>',
    cog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3.2"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  };
  return m[name] || '';
}
