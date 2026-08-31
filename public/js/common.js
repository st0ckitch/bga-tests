// shared helpers
const SUBJECT_META = {
  english:  { label: 'English',  ka: 'ინგლისური', icon: '📘' },
  math:     { label: 'Mathematics', ka: 'მათემატიკა', icon: '🧮' },
  georgian: { label: 'Georgian', ka: 'ქართული', icon: '✍️' },
  science:  { label: 'Science',  ka: 'საბუნებისმეტყველო', icon: '🔬' },
};
const GRADE_LABEL = (g) => (g === 'DP' ? 'DP (IB)' : 'Grade ' + g);

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function md(s) {
  if (s == null || s === '') return '';
  try { return marked.parse(String(s), { breaks: true }); }
  catch (e) { return esc(s); }
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}
async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' +
         d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function initials(student) {
  return ((student.firstName || '?')[0] + (student.lastName || '?')[0]).toUpperCase();
}
