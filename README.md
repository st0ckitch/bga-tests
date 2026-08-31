# BGA entrance tests

Digital platform for the school's entrance and scholarship tests (primary II–V, secondary 6–10 and DP).

## Run

```bash
cd ~/Desktop/bga-entrance-tests
npm start
```

Open http://localhost:4310

- **Students** → `/student.html` — enter name, pick the test, timed attempt, autosave, submit.
- **Teachers** → `/teacher.html` — default password `bga-admin` (change it in Settings).

## What the teacher portal does

- **Dashboard** — every attempt with status, score, score-distribution chart, review queue.
- **Attempt review** — per-question view of the student's answer, the key/criteria, the AI's mark
  and feedback; override any score, add feedback, mark the attempt reviewed.
- **Tests** — all 47 imported tests. Edit prompts, points, question type, **assign the correct
  choice** for multiple-choice, set the expected answer for short answers, and write **AI marking
  criteria** per question plus **AI rules** per test (and global rules in Settings).
- **Settings** — AI model, optional Anthropic API key, global marking rules, teacher password.

## How marking works

1. Multiple-choice and exact short answers are marked instantly against the teacher's keys.
2. Everything else (essays, workings, near-miss short answers) is queued for the AI checker,
   which applies: global rules → test rules → per-question criteria, and returns a score
   (0.5 steps) + feedback with a confidence level.
3. The teacher reviews and can override every mark; teacher marks are never overwritten.
   "Re-run AI" is available per attempt.

The AI checker uses the Anthropic API when a key is set (Settings → Anthropic API key, or the
`ANTHROPIC_API_KEY` env var) — get a key at https://console.anthropic.com. Without a key it
tries the `claude` CLI if one is installed and logged in (`npm i -g @anthropic-ai/claude-code`).
If neither is available, attempts are simply flagged **Needs review** and the teacher marks
those answers manually in the portal — everything else still auto-marks.

## Data

Everything is plain JSON on disk — no database needed:

- `data/tests/*.json` — the tests (editable in the portal)
- `data/attempts/*.json` — student attempts, answers, grades
- `data/settings.json` — password, model, rules
- `public/assets/<test>/…` — figures extracted from the original papers

## Re-importing tests

Tests were parsed from the original .docx/.pdf papers by an AI pipeline. To re-import:

```bash
node tools/import.js <parsedDir> <extractedDir>
```
