// Student app: name -> catalog -> runner -> done
const app = document.getElementById('app');
const LS = { student: 'bga_student', attempt: 'bga_attempt' };

let student = JSON.parse(localStorage.getItem(LS.student) || 'null');
let tests = [];
let filters = { division: 'all', track: 'all', subject: 'all' };

// runner state
let run = null; // { test, attempt, dirty:{}, saveTimer, tickTimer }

init();

async function init() {
  const saved = JSON.parse(localStorage.getItem(LS.attempt) || 'null');
  if (saved) {
    try {
      const attempt = await api('/api/attempts/' + saved.id);
      if (attempt.status === 'in_progress' && Date.now() < Date.parse(attempt.deadline)) {
        const test = await api('/api/tests/' + attempt.testId + '/take');
        return startRunner(test, attempt);
      }
    } catch (e) { /* stale */ }
    localStorage.removeItem(LS.attempt);
  }
  if (!student) return renderNameForm();
  renderCatalog();
}

/* ---------- name form ---------- */
function renderNameForm() {
  document.body.style.background = 'var(--canvas)';
  app.innerHTML = `
  <div class="landing">
    <form class="card landing-card" id="nameForm" style="text-align:left">
      <div class="brand-mark" style="margin:0 0 16px">BGA</div>
      <h1 style="font-size:21px">Welcome! Before we start…</h1>
      <p>Enter your name exactly as it appears in your application.<br>შეიყვანე შენი სახელი და გვარი.</p>
      <div class="field"><label>First name / სახელი</label>
        <input class="input" id="fn" required maxlength="60" placeholder="e.g. Giorgi"></div>
      <div class="field"><label>Last name / გვარი</label>
        <input class="input" id="ln" required maxlength="60" placeholder="e.g. Beridze"></div>
      <button class="btn btn-primary" style="width:100%;margin-top:8px">Continue</button>
    </form>
  </div>`;
  document.getElementById('nameForm').onsubmit = (e) => {
    e.preventDefault();
    const firstName = document.getElementById('fn').value.trim();
    const lastName = document.getElementById('ln').value.trim();
    if (!firstName || !lastName) return;
    student = { firstName, lastName };
    localStorage.setItem(LS.student, JSON.stringify(student));
    renderCatalog();
  };
}

/* ---------- catalog ---------- */
async function renderCatalog() {
  if (!tests.length) tests = await api('/api/tests');
  app.innerHTML = `
  <div class="shell">
    ${sidebar('catalog')}
    <div class="main">
      <div class="topbar">
        <div><h1>Choose your test</h1>
          <div class="sub">Pick the test your admissions letter asks you to take.</div></div>
        <div class="top-right">
          <div class="who"><div class="name">${esc(student.firstName)} ${esc(student.lastName)}</div>
            <div class="role">Applicant</div></div>
          <div class="avatar">${esc(initials(student))}</div>
        </div>
      </div>
      <div class="hero">
        <div class="eyebrow">BGA Entrance Tests</div>
        <h2>Good luck, ${esc(student.firstName)}! Read every question carefully.</h2>
        <p>The timer starts when you open a test. Your answers are saved automatically as you type — even if the page reloads.</p>
      </div>
      <div class="section-title" style="margin-top:22px">
        <span>Available tests</span>
        <span class="row" id="filters"></span>
      </div>
      <div class="test-grid" id="testGrid"></div>
    </div>
  </div>`;
  renderFilters();
  renderGrid();
}

function sidebar(active) {
  return `
  <aside class="sidebar">
    <div class="brand"><div class="brand-mark">BGA</div>
      <div><div class="brand-name">BGA</div><div class="brand-sub">entrance tests</div></div></div>
    <div class="nav-label">Overview</div>
    <button class="nav-item ${active === 'catalog' ? 'active' : ''}">${icoGrid()} Tests</button>
    <a class="nav-item" href="/">${icoHome()} Home</a>
    <div class="sidebar-foot">British-Georgian Academy<br>Entrance testing platform</div>
  </aside>`;
}

function renderFilters() {
  const wrap = document.getElementById('filters');
  wrap.innerHTML = '';
  const seg = (key, options) => {
    const s = el('<div class="seg"></div>');
    for (const [val, label] of options) {
      const b = el(`<button class="${filters[key] === val ? 'active' : ''}">${label}</button>`);
      b.onclick = () => { filters[key] = val; renderFilters(); renderGrid(); };
      s.appendChild(b);
    }
    return s;
  };
  wrap.appendChild(seg('division', [['all', 'All'], ['primary', 'Primary'], ['secondary', 'Secondary']]));
  wrap.appendChild(seg('track', [['all', 'All'], ['entrance', 'Entrance'], ['scholarship', 'Scholarship']]));
  wrap.appendChild(seg('subject', [['all', 'All subjects'], ['english', 'English'], ['math', 'Math'], ['georgian', 'ქართული'], ['science', 'Science']]));
}

function renderGrid() {
  const grid = document.getElementById('testGrid');
  const list = tests.filter((t) =>
    (filters.division === 'all' || t.division === filters.division) &&
    (filters.track === 'all' || t.track === filters.track) &&
    (filters.subject === 'all' || t.subject === filters.subject));
  grid.innerHTML = '';
  if (!list.length) { grid.innerHTML = '<div class="empty card">No tests match these filters.</div>'; return; }
  for (const t of list) {
    const s = SUBJECT_META[t.subject] || { icon: '📄', label: t.subject };
    const card = el(`
      <div class="card test-card">
        <div class="row" style="justify-content:space-between">
          <div class="subject-ico">${s.icon}</div>
          <span class="chip ${t.track === 'scholarship' ? 'warn' : 'accent'}">${t.track === 'scholarship' ? 'Scholarship' : 'Entrance'}</span>
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
          <button class="btn btn-primary btn-sm btn-pill">Start</button>
        </div>
      </div>`);
    card.querySelector('button').onclick = () => confirmStart(t);
    grid.appendChild(card);
  }
}

function confirmStart(t) {
  const bg = el(`
  <div class="modal-bg">
    <div class="modal">
      <h3>${esc(t.title)}</h3>
      <p class="muted" style="margin-bottom:14px">${esc(GRADE_LABEL(t.grade))} · ${t.questionCount} questions · ${t.totalPoints} points</p>
      <p style="font-size:14px">You will have <b>${t.durationMinutes} minutes</b>. The timer starts immediately and cannot be paused. When time runs out, the test submits automatically.</p>
      <p style="font-size:14px;margin-top:8px">დრო: <b>${t.durationMinutes} წუთი</b>. ტაიმერი დაუყოვნებლივ დაიწყება.</p>
      <div class="row" style="margin-top:20px;justify-content:flex-end">
        <button class="btn btn-ghost" data-x>Cancel</button>
        <button class="btn btn-primary" data-go>Start test</button>
      </div>
    </div>
  </div>`);
  bg.querySelector('[data-x]').onclick = () => bg.remove();
  bg.querySelector('[data-go]').onclick = async () => {
    bg.querySelector('[data-go]').disabled = true;
    try {
      const attempt = await api('/api/attempts', { method: 'POST', body: { testId: t.id, student } });
      localStorage.setItem(LS.attempt, JSON.stringify({ id: attempt.id }));
      const test = await api('/api/tests/' + t.id + '/take');
      bg.remove();
      startRunner(test, attempt);
    } catch (e) { toast(e.message); bg.remove(); }
  };
  document.body.appendChild(bg);
}

/* ---------- runner ---------- */
function startRunner(test, attempt) {
  run = { test, attempt, dirty: {}, answers: attempt.answers || {} };
  const secOf = {};
  test.sections.forEach((s) => (secOf[s.id] = s));

  let qIndex = 0;
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

  // --- question palette
  const nav = document.getElementById('qnav');
  qs.forEach((q, i) => {
    const c = el(`<button class="qnav-cell" title="Question ${esc(q.number)}">${esc(q.number)}</button>`);
    c.onclick = () => { document.getElementById('qc-' + q.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    nav.appendChild(c);
  });

  // --- sections + questions
  const qcol = document.getElementById('qcol');
  if (test.instructions) {
    qcol.appendChild(el(`<div class="card sec-head"><h2>Instructions</h2><div class="sec-instr">${md(test.instructions)}</div></div>`));
  }
  for (const sec of test.sections) {
    const sqs = qs.filter((q) => q.sectionId === sec.id);
    if (!sqs.length && !sec.passage) continue;
    const head = el(`<div class="card sec-head">
      <h2>${esc(sec.title || 'Section')}</h2>
      ${sec.instructions ? `<div class="sec-instr">${md(sec.instructions)}</div>` : ''}
      ${sec.image ? `<img class="qimg" src="${esc(sec.image)}" alt="">` : ''}
      ${sec.passage ? `<div class="passage">${md(sec.passage)}</div>` : ''}
    </div>`);
    qcol.appendChild(head);
    for (const q of sqs) qcol.appendChild(questionCard(q));
  }

  // --- events
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
  run.saveTimer = setInterval(flush, 2500);
  async function flush() {
    if (!Object.keys(run.dirty).length) return;
    const batch = run.dirty;
    run.dirty = {};
    try {
      await api(`/api/attempts/${run.attempt.id}/answers`, { method: 'PUT', body: { answers: batch } });
      if (!Object.keys(run.dirty).length)
        document.getElementById('savebar').textContent = 'All changes saved';
    } catch (e) {
      run.dirty = { ...batch, ...run.dirty };
      if (e.status === 409) forceSubmit();
      else document.getElementById('savebar').textContent = '⚠ Offline — retrying…';
    }
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
  window.onbeforeunload = null;
  try { await run.flush(); } catch (e) {}
  try {
    await api(`/api/attempts/${run.attempt.id}/submit`, { method: 'POST' });
  } catch (e) {
    if (e.status !== 409) { toast('Could not submit: ' + e.message); submitting = false; return; }
  }
  localStorage.removeItem(LS.attempt);
  renderDone(auto);
}

function renderDone(auto) {
  app.innerHTML = `
  <div class="landing">
    <div class="card landing-card">
      <div class="subject-ico" style="width:64px;height:64px;font-size:28px;margin:0 auto 18px;background:var(--good-bg)">✅</div>
      <h1>Test submitted${auto ? ' (time was up)' : ''}!</h1>
      <p>Thank you, ${esc(student.firstName)}. Your answers were received and will be marked by the admissions team.<br><br>
      გმადლობთ! თქვენი ნამუშევარი მიღებულია — შედეგებს სკოლა შეგატყობინებთ.</p>
      <a class="btn btn-primary" href="/student.html">Back to tests</a>
    </div>
  </div>`;
}

/* tiny inline icons */
function icoGrid() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>'; }
function icoHome() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>'; }
