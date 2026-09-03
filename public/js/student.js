// Student app: access code -> assigned tests -> runner -> done
const app = document.getElementById('app');
const LS = { code: 'bga_code', attempt: 'bga_attempt' };

let session = null; // { student, tests, attempts } from the server
let run = null;     // { test, attempt, dirty:{}, answers, pending, ... }

function codeHeaders() {
  const code = (session && session.code) || localStorage.getItem(LS.code) || '';
  return { 'x-student-code': code };
}

// the attempt was closed on the server (teacher deleted it / access changed / time up)
function endRun(title, message) {
  if (run) { clearInterval(run.tickTimer); clearInterval(run.saveTimer); }
  window.onbeforeunload = null;
  localStorage.removeItem(LS.attempt);
  app.innerHTML = `
  <div class="landing">
    <div class="card landing-card">
      <div class="subject-ico" style="width:64px;height:64px;font-size:28px;margin:0 auto 18px;background:var(--warn-bg)">ℹ️</div>
      <h1>${title}</h1>
      <p>${message}</p>
      <a class="btn btn-primary" href="/student.html">Back</a>
    </div>
  </div>`;
}

init();

async function init() {
  // resume an active attempt first (survives reloads)
  const saved = JSON.parse(localStorage.getItem(LS.attempt) || 'null');
  const code = localStorage.getItem(LS.code);
  if (saved && code) {
    try {
      const attempt = await api('/api/attempts/' + saved.id, { headers: codeHeaders() });
      if (attempt.status === 'in_progress' && Date.now() < Date.parse(attempt.deadline)) {
        const test = await api('/api/tests/' + attempt.testId + '/take', { method: 'POST', body: { code } });
        return startRunner(test, attempt);
      }
    } catch (e) { /* stale */ }
    localStorage.removeItem(LS.attempt);
  }
  if (code) {
    try { return await login(code); }
    catch (e) { localStorage.removeItem(LS.code); }
  }
  renderLogin();
}

async function login(code) {
  session = await api('/api/session/student', { method: 'POST', body: { code } });
  session.code = String(code).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  localStorage.setItem(LS.code, session.code);
  renderCatalog();
}

/* ---------- login ---------- */
function renderLogin() {
  app.innerHTML = `
  <div class="landing">
    <form class="card landing-card" id="codeForm" style="text-align:left">
      <div class="brand-mark" style="margin:0 0 16px">BGA</div>
      <h1 style="font-size:21px">Welcome!</h1>
      <p>Enter the access code your teacher gave you.<br>შეიყვანე მასწავლებლის მოცემული კოდი.</p>
      <div class="field"><label>Access code / კოდი</label>
        <input class="input" id="code" required maxlength="12" placeholder="e.g. K7M2QF" autocomplete="off"
               style="text-transform:uppercase;letter-spacing:.2em;font-weight:700;font-size:18px;text-align:center"></div>
      <button class="btn btn-primary" style="width:100%;margin-top:8px">Continue</button>
      <p class="muted" style="margin-top:14px">No code? Ask your teacher — codes are personal and case-insensitive.</p>
    </form>
  </div>`;
  document.getElementById('codeForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await login(document.getElementById('code').value); }
    catch (err) { toast(err.status === 401 ? 'Code not recognised — check it with your teacher.' : err.message); }
  };
}

/* ---------- catalog ---------- */
function renderCatalog() {
  const { student, tests, attempts } = session;
  app.innerHTML = `
  <div class="shell">
    ${sidebar()}
    <div class="main">
      <div class="topbar">
        <div><h1>Your tests</h1>
          <div class="sub">These are the tests assigned to you. The timer starts when you open one.</div></div>
        <div class="top-right">
          <div class="who"><div class="name">${esc(student.firstName)} ${esc(student.lastName)}</div>
            <div class="role">Applicant</div></div>
          <div class="avatar">${esc(initials(student))}</div>
        </div>
      </div>
      <div class="hero">
        <div class="eyebrow">BGA Entrance Tests</div>
        <h2>Good luck, ${esc(student.firstName)}! Read every question carefully.</h2>
        <p>Your answers are saved automatically as you type — even if the page reloads. Submit before the timer runs out.</p>
      </div>
      <div class="section-title" style="margin-top:22px"><span>Assigned to you (${tests.length})</span></div>
      <div class="test-grid" id="testGrid"></div>
    </div>
  </div>`;

  const grid = document.getElementById('testGrid');
  if (!tests.length) {
    grid.innerHTML = '<div class="empty card">No tests are assigned to you yet.<br>Ask your teacher to assign one to your code.</div>';
    return;
  }
  for (const t of tests) {
    const s = SUBJECT_META[t.subject] || { icon: '📄', label: t.subject };
    const att = attempts[t.id];
    const inProgress = att && att.status === 'in_progress';
    const done = att && att.status !== 'in_progress';
    const card = el(`
      <div class="card test-card">
        <div class="row" style="justify-content:space-between">
          <div class="subject-ico">${s.icon}</div>
          ${done ? '<span class="chip good"><span class="dot"></span>Completed</span>'
            : inProgress ? '<span class="chip warn"><span class="dot"></span>In progress</span>'
            : `<span class="chip ${t.track === 'scholarship' ? 'warn' : 'accent'}">${t.track === 'scholarship' ? 'Scholarship' : 'Entrance'}</span>`}
        </div>
        <h3>${esc(t.title)}</h3>
        ${t.titleKa ? `<div class="muted">${esc(t.titleKa)}</div>` : ''}
        <div class="test-meta">
          <span class="chip">${esc(GRADE_LABEL(t.grade))}</span>
          <span class="chip">${t.questionCount} questions</span>
          <span class="chip">${t.totalPoints} pts</span>
        </div>
        <div class="test-foot">
          <span>⏱ ${t.durationMinutes} min</span>
          ${done ? '<span class="muted">Submitted ✓</span>'
            : `<button class="btn btn-primary btn-sm btn-pill">${inProgress ? 'Continue' : 'Start'}</button>`}
        </div>
      </div>`);
    const btn = card.querySelector('button');
    if (btn) btn.onclick = () => (inProgress ? beginAttempt(t) : confirmStart(t));
    grid.appendChild(card);
  }
}

function sidebar() {
  return `
  <aside class="sidebar">
    <div class="brand"><div class="brand-mark">BGA</div>
      <div><div class="brand-name">BGA</div><div class="brand-sub">entrance tests</div></div></div>
    <div class="nav-label">Overview</div>
    <button class="nav-item active">${icoGrid()} My tests</button>
    <button class="nav-item" id="signOut">${icoHome()} Sign out</button>
    <div class="sidebar-foot">British-Georgian Academy<br>Entrance testing platform</div>
  </aside>`;
}

function confirmStart(t) {
  const bg = el(`
  <div class="modal-bg">
    <div class="modal">
      <h3>${esc(t.title)}</h3>
      <p class="muted" style="margin-bottom:14px">${esc(GRADE_LABEL(t.grade))} · ${t.questionCount} questions · ${t.totalPoints} points</p>
      <p style="font-size:14px">You will have <b>${t.durationMinutes} minutes</b>. The timer starts immediately and cannot be paused. When time runs out, the test submits automatically. You can take this test only once.</p>
      <p style="font-size:14px;margin-top:8px">დრო: <b>${t.durationMinutes} წუთი</b>. ტესტის დაწერა შესაძლებელია მხოლოდ ერთხელ.</p>
      <div class="row" style="margin-top:20px;justify-content:flex-end">
        <button class="btn btn-ghost" data-x>Cancel</button>
        <button class="btn btn-primary" data-go>Start test</button>
      </div>
    </div>
  </div>`);
  bg.querySelector('[data-x]').onclick = () => bg.remove();
  bg.querySelector('[data-go]').onclick = async () => {
    bg.querySelector('[data-go]').disabled = true;
    await beginAttempt(t);
    bg.remove();
  };
  document.body.appendChild(bg);
}

async function beginAttempt(t) {
  try {
    const attempt = await api('/api/attempts', { method: 'POST', body: { testId: t.id, code: session.code } });
    localStorage.setItem(LS.attempt, JSON.stringify({ id: attempt.id }));
    const test = await api('/api/tests/' + t.id + '/take', { method: 'POST', body: { code: session.code } });
    startRunner(test, attempt);
  } catch (e) {
    if (e.status === 401) {
      localStorage.removeItem(LS.code);
      toast('Your access code changed — sign in with the new code from your teacher.');
      return renderLogin();
    }
    toast(e.message);
    if (e.status === 409) login(session.code).catch(() => renderLogin());
  }
}

/* ---------- runner ---------- */
function startRunner(test, attempt) {
  run = { test, attempt, dirty: {}, answers: attempt.answers || {} };
  const qs = test.questions;

  app.innerHTML = `
  <div>
    <div class="runner-top">
      <div class="brand-mark" style="width:34px;height:34px;border-radius:10px;font-size:12px">BGA</div>
      <div><div class="title">${esc(test.title)}</div>
        <div class="meta">${esc(GRADE_LABEL(test.grade))} · ${qs.length} questions · ${test.totalPoints} points</div></div>
      <div class="timer" id="timer">--:--</div>
      <button class="btn btn-primary" id="submitBtn">Submit test</button>
    </div>
    <div class="runner-body">
      <div class="qnav card">
        <div class="qnav-grid" id="qnav"></div>
        <div style="padding:0 14px 14px" class="muted" id="navProgress"></div>
      </div>
      <div class="qcol" id="qcol"></div>
    </div>
    <div class="savebar" id="savebar">All changes saved</div>
  </div>`;

  const nav = document.getElementById('qnav');
  qs.forEach((q) => {
    const c = el(`<button class="qnav-cell" title="Question ${esc(q.number)}">${esc(q.number)}</button>`);
    c.onclick = () => { document.getElementById('qc-' + q.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    nav.appendChild(c);
  });

  const qcol = document.getElementById('qcol');
  if (test.instructions) {
    qcol.appendChild(el(`<div class="card sec-head"><h2>Instructions</h2><div class="sec-instr">${md(test.instructions)}</div></div>`));
  }
  for (const sec of test.sections) {
    const sqs = qs.filter((q) => q.sectionId === sec.id);
    if (!sqs.length && !sec.passage) continue;
    qcol.appendChild(el(`<div class="card sec-head">
      <h2>${esc(sec.title || 'Section')}</h2>
      ${sec.instructions ? `<div class="sec-instr">${md(sec.instructions)}</div>` : ''}
      ${sec.image ? `<img class="qimg" src="${esc(sec.image)}" alt="">` : ''}
      ${sec.passage ? `<div class="passage">${md(sec.passage)}</div>` : ''}
    </div>`));
    for (const q of sqs) qcol.appendChild(questionCard(q));
  }

  document.getElementById('submitBtn').onclick = () => confirmSubmit(false);
  refreshNav();
  startTimer();
  startAutosave();
  window.onbeforeunload = () => (Object.keys(run.dirty).length ? true : undefined);
}

function questionCard(q) {
  const a = run.answers[q.id] || {};
  const card = el(`<div class="card qcard" id="qc-${q.id}">
    <div class="qhead">
      <span class="qnum">${esc(q.number)}</span>
      <span class="qpoints">${q.points} ${q.points === 1 ? 'point' : 'points'}</span>
    </div>
    <div class="qprompt">${md(q.prompt)}</div>
    ${q.image ? `<img class="qimg" src="${esc(q.image)}" alt="figure">` : ''}
    ${q.paperOnly ? `<div class="paper-note">✏️ This task is designed for paper. If you can, describe your answer in words below.</div>` : ''}
  </div>`);

  if (q.type === 'multiple_choice') {
    const box = el('<div class="choices"></div>');
    for (const c of q.choices) {
      const row = el(`<label class="choice ${a.choiceId === c.id ? 'sel' : ''}">
        <input type="radio" name="q-${q.id}" ${a.choiceId === c.id ? 'checked' : ''}>
        <span class="cid">${esc(c.id)}.</span>
        <span>${md(c.text).replace(/^<p>|<\/p>\s*$/g, '')}${c.image ? `<img class="qimg" src="${esc(c.image)}" alt="">` : ''}</span>
      </label>`);
      row.querySelector('input').onchange = () => {
        setAnswer(q.id, { choiceId: c.id });
        box.querySelectorAll('.choice').forEach((x) => x.classList.remove('sel'));
        row.classList.add('sel');
      };
      box.appendChild(row);
    }
    card.appendChild(box);
  } else {
    const isLong = q.type === 'open_response';
    const input = isLong
      ? el(`<textarea class="input" rows="${Math.min(14, Math.max(4, Math.ceil(q.points * 1.5)))}" placeholder="Type your answer…">${esc(a.text || '')}</textarea>`)
      : el(`<input class="input" placeholder="Your answer…" value="${esc(a.text || '')}">`);
    input.style.marginTop = '14px';
    input.oninput = () => setAnswer(q.id, { text: input.value });
    card.appendChild(input);
  }
  return card;
}

function setAnswer(qid, val) {
  run.answers[qid] = val;
  run.dirty[qid] = val;
  document.getElementById('savebar').textContent = 'Saving…';
  refreshNav();
}

function refreshNav() {
  const cells = document.querySelectorAll('.qnav-cell');
  let answered = 0;
  run.test.questions.forEach((q, i) => {
    const a = run.answers[q.id];
    const has = a && (a.choiceId || (a.text && a.text.trim()));
    if (has) answered++;
    cells[i].classList.toggle('answered', !!has);
  });
  document.getElementById('navProgress').textContent = `${answered} / ${run.test.questions.length} answered`;
}

function startAutosave() {
  run.pending = Promise.resolve();
  run.saveTimer = setInterval(() => flush(), 2500);
  function flush() {
    if (Object.keys(run.dirty).length) {
      const batch = run.dirty;
      run.dirty = {};
      // chain PUTs so they can never overtake each other or a submit
      run.pending = run.pending.then(async () => {
        try {
          await api(`/api/attempts/${run.attempt.id}/answers`, {
            method: 'PUT', body: { answers: batch }, headers: codeHeaders(),
          });
          const bar = document.getElementById('savebar');
          if (bar && !Object.keys(run.dirty).length) bar.textContent = 'All changes saved';
        } catch (e) {
          if (e.status === 409) { run.timeUp = true; forceSubmit(); }
          else if (e.status === 401) endRun('Access changed', 'Your access code is no longer valid. Please ask your teacher for the current code and sign in again.');
          else if (e.status === 404) endRun('Attempt closed', 'This attempt was closed by your teacher. Sign in again to see your tests.');
          else {
            run.dirty = { ...batch, ...run.dirty };
            const bar = document.getElementById('savebar');
            if (bar) bar.textContent = '⚠ Offline — retrying…';
          }
        }
      });
    }
    return run.pending;
  }
  run.flush = flush;
}

function startTimer() {
  const elT = document.getElementById('timer');
  run.tickTimer = setInterval(tick, 1000);
  tick();
  function tick() {
    const left = Date.parse(run.attempt.deadline) - Date.now();
    if (left <= 0) { clearInterval(run.tickTimer); elT.textContent = '00:00'; return forceSubmit(); }
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    elT.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    elT.classList.toggle('low', left < 5 * 60000);
  }
}

function confirmSubmit(auto) {
  const unanswered = run.test.questions.filter((q) => {
    const a = run.answers[q.id];
    return !(a && (a.choiceId || (a.text && a.text.trim())));
  }).length;
  const bg = el(`
  <div class="modal-bg"><div class="modal">
    <h3>Submit test?</h3>
    <p style="font-size:14px;margin:10px 0">${unanswered
      ? `You still have <b>${unanswered} unanswered question${unanswered > 1 ? 's' : ''}</b>. Unanswered questions receive 0 points.`
      : 'All questions answered. Once submitted, you cannot change your answers.'}</p>
    <div class="row" style="justify-content:flex-end;margin-top:16px">
      <button class="btn btn-ghost" data-x>Keep working</button>
      <button class="btn btn-primary" data-go>Submit now</button>
    </div>
  </div></div>`);
  bg.querySelector('[data-x]').onclick = () => bg.remove();
  bg.querySelector('[data-go]').onclick = () => { bg.remove(); doSubmit(); };
  document.body.appendChild(bg);
}

async function forceSubmit() { await doSubmit(true); }

let submitting = false;
async function doSubmit(auto) {
  if (submitting) return;
  submitting = true;
  clearInterval(run.tickTimer); clearInterval(run.saveTimer);
  try { await run.flush(); await run.pending; } catch (e) {}
  if (Object.keys(run.dirty).length && !auto && !run.timeUp) {
    // saves are failing (offline) — don't silently drop answers
    toast('Some answers are not saved yet — check the connection and try again.');
    run.saveTimer = setInterval(() => run.flush(), 2500);
    submitting = false;
    return;
  }
  window.onbeforeunload = null;
  try {
    await api(`/api/attempts/${run.attempt.id}/submit`, { method: 'POST', headers: codeHeaders() });
  } catch (e) {
    if (e.status === 401) { submitting = false; return endRun('Access changed', 'Your access code is no longer valid. Ask your teacher for the current code.'); }
    if (e.status === 404) { submitting = false; return endRun('Attempt closed', 'This attempt was closed by your teacher.'); }
    if (e.status !== 409) { toast('Could not submit: ' + e.message); submitting = false; return; }
  }
  localStorage.removeItem(LS.attempt);
  submitting = false;
  renderDone(auto);
}

function renderDone(auto) {
  const name = session ? session.student.firstName : '';
  app.innerHTML = `
  <div class="landing">
    <div class="card landing-card">
      <div class="subject-ico" style="width:64px;height:64px;font-size:28px;margin:0 auto 18px;background:var(--good-bg)">✅</div>
      <h1>Test submitted${auto ? ' (time was up)' : ''}!</h1>
      <p>Thank you${name ? ', ' + esc(name) : ''}. Your answers were received and will be marked by the admissions team.<br><br>
      გმადლობთ! თქვენი ნამუშევარი მიღებულია — შედეგებს სკოლა შეგატყობინებთ.</p>
      <div class="row" style="justify-content:center">
        <a class="btn btn-primary" href="/student.html">Back to my tests</a>
        <button class="btn btn-ghost" id="doneSignOut">Sign out</button>
      </div>
    </div>
  </div>`;
}

/* wire sign-out (delegated, sidebar re-renders) */
document.addEventListener('click', (e) => {
  if (e.target.closest && (e.target.closest('#signOut') || e.target.closest('#doneSignOut'))) {
    localStorage.removeItem(LS.code);
    localStorage.removeItem(LS.attempt);
    session = null;
    renderLogin();
  }
});

/* tiny inline icons */
function icoGrid() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>'; }
function icoHome() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>'; }
