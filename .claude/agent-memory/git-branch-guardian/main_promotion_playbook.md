---
name: main-promotion-playbook
description: How work reaches `main` in Blackwood — branch model, the feat→main --no-ff promotion recipe, the merge-base tree conflict test, and the authorized direct-to-main exceptions
metadata:
  type: project
---

`main` = production (Vercel deploys the live URL from it). `dev` = staging. `feat/*` = feature work.

**Why:** Renzo tests on the live app, so "ship it" nearly always means landing on `main` and pushing. Getting the promotion shape wrong either fails to deploy or rewrites protected history.

**How to apply:** pick the path below that matches the task prompt, then run the gates in [[gates-and-shell-traps]].

## The dominant path: `feat/*` → `main` directly (bypassing `dev`)

Accepted live-deploy path **when the task prompt explicitly authorizes it** (first used 2026-07-27, `ca18c6d`). `dev` is not involved and does not need to be.

```
git checkout main && git pull --ff-only origin main
git merge --no-ff <feat> -m "chore: merge <feat> into main — <summary>"
git push origin main
git checkout <feat>            # restore the starting branch
```

Keep `--no-ff` even when a fast-forward would work — the merge commit is what marks a prod promotion.

### The conflict test: merge-base tree comparison

```
git diff --stat origin/main $(git merge-base origin/main <feat>)
```

**Empty output = main's tree equals the merge-base tree**, so the merge applies only the new commits and is structurally conflict-free. Held on 13 consecutive promotions (empty diff, merge exit 0, every time).

- Prefer this merge-base form over `<feat-tip>^` — it stays correct when the branch accumulated more than one commit since the last promotion (2026-07-30 Phase B had 2; 2026-08-04 had 2).
- **Do NOT use `git rev-list --left-right --count origin/main...<feat>` as the gate.** After each promotion `main` carries merge commits the feat branch lacks, so it reads `N M`, not `0 N`. `main` is no longer a strict ancestor and **that is EXPECTED, not divergence.** Don't stall on it.
- Post-merge, confirm `git diff --stat main <feat>` is ALSO empty — cheap proof the merge took everything — before pushing.
- Renzo explicitly asked (2026-08-03) for the tree diff *instead of* the ancestry commit list. Don't report the list; by the 13th promotion it is a dozen `chore: merge …` lines of pure noise.

**Stronger, fully non-destructive variant (added promotion 28):**

```
git merge-tree --write-tree --name-only main <feat>
```

**Clean = exit 0 and output is a BARE tree OID with no file list below it.** Conflicted = non-zero exit plus the conflicting paths. This actually performs the merge in memory rather than inferring safety from tree equality, so it catches a real content conflict the merge-base test would miss — and it touches neither the index nor the working tree, so it is safe to run *before* `git checkout main`. Use it as the gate; keep the merge-base diff as the cheap corroborator.

## `feat/gmail-oauth-sync-auth` — the long-lived promotion branch

21 promotions as of 2026-08-04 before the `feat/cenapro-deliveries-qol` split, latest `434eb7b`; earlier `c9c4f1a`, `0be5b4a`, `478b0c0`, `566d68a`, `8ff1c77`, `52178d9`, `db95d03`, `ca18c6d`, `70dfa60`, `3450d3c`, `96e825b`, `c3608d5`, `7ac5674`, `070e52e`, `437be13`, `65c21e3`, `a773826`, `ff776f8`, `e51045f`, `8be1fa3`.

The merge-base tree test has now held **22 consecutive promotions** (empty diff, merge clean, every time) — including `478b0c0` and `0be5b4a`, both promoted from a working tree a second Claude session was editing concurrently ([[concurrent-session-promotions]]).

### Branching a correctly-named `feat/*` off a mis-named one (2026-08-04, `c8ffc53`)

`feat/gmail-oauth-sync-auth` accumulates work whose name stopped describing it long ago. When a
brief's changeset has nothing to do with the branch name, **cut a new branch from the current
HEAD** (`git checkout -b feat/<slug>`) rather than piling on. It costs nothing here because after
each promotion HEAD is already an ancestor of `main` (`git merge-base --is-ancestor HEAD main`,
exit 0) and the trees are identical (`git diff --stat <HEAD> <main>` empty) — so the new branch's
merge-base with `main` IS `main`'s tree and the gate passes trivially. `main` being AHEAD of the
branch base by its own merge commits is the normal steady state, not divergence; the `--no-ff`
merge back preserves every one of them (`git merge-base --is-ancestor <old-main-tip> main` to
prove it in the report).

`feat/cenapro-deliveries-qol` (promotion `c8ffc53`) is the first branch cut this way. Same
promotion recipe, no `dev`, no PR. Latest promotion off it: `7a8bee6` (2026-08-06, #39).

### Cutting a NEW `feat/*` off `main` while carrying a dirty tree (2026-08-17, `feat/universal-table`)

A planning/research changeset that belongs to a *new* work line starts from `main`, not from
whatever branch the tree happens to sit on: `git fetch origin` → confirm `git rev-list
--left-right --count main...origin/main` is `0 0` → `git checkout -b feat/<slug> main`.
**The pre-check that makes a plain checkout safe with uncommitted work is one command:**
`git diff --name-only main..HEAD` — if none of those paths intersect the dirty set from
`git status -sb`, the checkout carries every modification and untracked file across
untouched and **no stash is needed**. (Measured here: the only path differing was
`.claude/agent-memory/git-branch-guardian/main_promotion_playbook.md`, the dirty set was
`.claude/agent-memory-local/**` + `.claude/agent-memory/perf-reviewer/MEMORY.md` — disjoint,
clean checkout.) Note the old branch's unmerged commits simply stay on it; that a memory
commit is left behind on the source branch is intended, never cherry-pick it across.
**Commit-only brief: do not merge, do not touch the source branch, push with
`git push -u origin feat/<slug>`.**

**Degenerate (and commonest) case: you are ALREADY standing on the base.** When `HEAD ==
main == origin/main`, `git checkout -b feat/<slug> main` cannot touch a single tracked file —
the diff between the two tips is empty *by construction*, so the stash question never arises.
Still prove it rather than asserting it: `git hash-object <dirty paths>` before and after the
checkout must match byte-for-byte (`git rev-parse main:<path>` vs `origin/main:<path>` covers
the tips). Git prints the carried ` M` paths on switch — expected, not damage. Verified
2026-08-21 cutting `feat/rc-in-out-v2-default` off `ebb06d2` with the three standing dirty
files; all three hashes identical across the switch, no stash created. Beware `git rev-parse
--short <a> <b> <c>` in one call — it errored `fatal: Needed a single revision` here while
each ref resolved fine alone; resolve refs one at a time.

**`feat/<screen>-v2-default` is a SERIES, one branch per screen — confirmed 2026-08-21.** The
table migration (v2 default flip + inline editing + Year/Month picker) is being rolled out
screen by screen, and Renzo's approved convention is a fresh branch per screen rather than one
long-lived branch accumulating them: `feat/rc-in-out-v2-default` (promoted), then
`feat/qc-ledger-v2-default` (Cenapro QC ledger, cut off `3328874`). So when the next screen's
v2 migration arrives, **cut a new branch off current `main` — never reopen or pile onto a
v2-default branch that already promoted.** Each cut is the degenerate case above (already
standing on `main`, three standing dirty files carried, no stash); it has now run clean twice.

**A follow-up fix on an already-promoted branch needs no new branch.** 2026-08-04 promotion
23 (`9ee70d5` → main): Renzo hit a bug in the live app an hour after `c8ffc53`, the fix
belonged to the same module, so it committed straight onto `feat/cenapro-deliveries-qol` and
re-promoted. The merge-base gate stays trivially clean because the previous promotion made
that branch's old tip an ancestor of `main` — so the merge-base IS the last promotion's tree.
Don't cut `feat/<slug>-fix`; the name still describes the work.

**This repeats — a "correct fix that missed the real cause" is normal, not a red flag.**
Promotion 24 (`18a4068` → `98805ff`, same day, ~20 min after 23) fixed the SAME reported
symptom again: 23 fixed page-level scrolling, 24 fixed the virtuoso index space actually
causing it. Same branch, same recipe, gate clean both times. When a brief says "the earlier
fix was correct but addressed a different mechanism," just promote — don't re-litigate the
previous promotion or reach for a revert.

**Promotion 25 (`04e9c5d` → `2d6e422`) is the THIRD consecutive fix to the same ledger's
keyboard layer** (Escape could not undo a Backspace-cleared cell). Pattern now confirmed:
Renzo shakes out one RC Deliveries grid interaction per promotion, minutes apart, same
branch, same recipe. A brief that says the shared platform hook
`lib/hooks/use-grid-keyboard-nav.ts` was deliberately NOT touched is stating a design
constraint you should VERIFY in the staged path list — its presence would contradict the
fix and is a stop condition.

**Promotion 26 (`921b8b3` + `37095dd` → `7aff668`) broke the one-grid-per-promotion pattern**:
first WIDE changeset on this branch — 20 files across platform `components/shared/grid/**` plus
five modules (rc-in, rc-out, three production grids, cenapro qc, cenapro deliveries). A brief
that enumerates a wide expected-path list is describing a real platform sweep, not scope creep;
diff the staged list against the brief's list and only stop on a genuine extra. The
`use-grid-keyboard-nav.ts` / `use-cell-selection.ts` stop condition from promotion 25 held —
neither appeared, and the brief's "audited, no change needed" claim was true.

**Promotion 27 (`47bd9db` → `a0a6bfb`) moved off RC Deliveries to the QC ledger** — same
branch, same recipe, first `feat(` (not `fix(`) subject on it, because the changeset added
capability (typable lab columns) rather than repairing one interaction. A brief that argues
"more feature than fix" and names the scope is making the call for you; don't downgrade it
to `fix(`. Also the first promotion here where the branch's PREVIOUS `chore(memory)` commit
rode along into `main` as part of the same merge — the brief authorized promoting a pending
`.claude/`-only commit with the feature, and the merge stat correctly showed
`main_promotion_playbook.md` among the files. Expect that: after `git checkout main` a
tracked memory file REVERTS to main's older copy (the memory commit is still only on the
branch) — that is the checkout doing its job, not a lost edit, and the merge restores it.
Write your own memory update AFTER returning to the feat branch, never while on `main`.

**Splitting platform from tenant is the natural cut on a wide changeset.** Two commits via
`git commit -F <msg> -- <pathspec>` (never per-file staging): `fix(grid):` took
`components/shared/grid` + `app/(app)/inventory` + `app/(app)/production` + `app/(app)/cenapro/qc`
+ `app/(app)/cenapro/CONTEXT.md`; `fix(cenapro):` took `app/(app)/cenapro/deliveries` +
`scripts/verify-*.ts`. Note `app/(app)/cenapro/CONTEXT.md` documents the **QC** ledger, so it
rides the PLATFORM commit, not the cenapro one — check which module a shared CONTEXT.md edit
actually describes before assigning it by path prefix.

**Promotion tempo on this branch is minutes, not hours.** Six promotions in one afternoon
(`c8ffc53`, `9ee70d5`, `98805ff`, `2d6e422`, `7aff668`, `a0a6bfb`). Renzo is blocked on the live app during each one, so
prefer the cheap gate set (`npx tsc --noEmit` + the repo's `scripts/verify-*.ts`, ~1 min
total) over a fresh 8-minute `npm run build` when the brief already reports the build green.

**Cheap pre-checkout check when the tree is dirty:** compare `git diff --name-only origin/main <feat>` against `git diff --name-only`. No overlap ⇒ `git checkout main` carries the dirty tracked files across without "local changes would be overwritten". Run it before the checkout, not after it fails.

**Never delete this branch after a promotion** — it keeps accumulating work and is re-merged.

A **docs-only promotion is still a full `--no-ff` promotion** (2026-08-04, `52178d9`, one `handoffs/YYYY-MM-DD-*.md` file): same recipe, same gate discipline, no shortcut to a FF. Session-handoff files are a standing CLAUDE.md convention (`handoffs/` at repo root, never deleted), so `docs(handoff): <date> <slug>` commits recur — scan them like any other file, but the build gate alone suffices when nothing under `workers/sync/` is touched.

**A brief may pre-run the build and waive the gate — honour it** (2026-08-04, `434eb7b`, 3 markdown files): "`npm run build` was run before this brief and exited 0, so skip it." Markdown-only changesets have no code impact; re-running an 8-minute build to prove a `CONTEXT.md` compiles is waste. Same waiver shape as `0be5b4a` in [[concurrent-session-promotions]] §1b.

**Concurrent-session mode can be OFF — verify, don't assume.** [[concurrent-session-promotions]] says to presume selective staging when `app/(app)/cenapro/deliveries/**` is in play. On `434eb7b` the brief said the same, but `git status --short` came back clean apart from the brief's own 3 paths + the standing `.claude/agent-memory*` dirt — no stray source files at all. The pre-staging `git status --short` is what decides; report it verbatim when the brief asks whether the other session is live.

**Promotion 28 (`9996f34` + `45ab29b` → `d4741ca`) was the first SPLIT promotion on this branch** —
a brief that explicitly asked for the DB migration to be reviewable alone, so the changeset became
two `feat(cenapro):` commits: migration + `types/supabase.ts` first, then all frontend. Both pushed,
then one `--no-ff` merge carried both plus the pending `chore(memory)` commit. When a brief names
the split axis ("so the schema change is reviewable alone"), honour it even though the house default
is ONE commit — and put the migration FIRST so `main` never has frontend calling an RPC signature
that does not exist yet. Executed with `git commit -- <pathspec>` twice off a single `git add .`
(see [[feedback-commit-splitting]]); no per-file staging.

Also confirmed here: a brief's "these paths must NOT appear" list is a real gate worth running as a
diff, not a glance — `git status --porcelain=v1 --untracked-files=all` before staging, compared
against the expected list, resolved it in one step. And when the brief supplies a rich rationale
(parity argument, blank-means-derive, DROP-not-overload), that rationale IS the commit body; verify
each claim against the diff (signature, grant lines, re-export) rather than paraphrasing it blind.

**Promotion 29 (`0ba1d57` → `c502b40`) — back to the one-file `fix(cenapro):` shape** after the
split. Two staged paths only (`deliveries-ledger.tsx` + its `CONTEXT.md`), pending
`chore(memory)` commit rode along again, `git merge-tree` gate clean, merge exit 0. Notable:
the brief listed a "STOP if you see these" set (`components/shared/grid/**`, `lib/hooks/**`,
`app/(app)/cenapro/qc/**`, `globals.css`, `workers/`, `supabase/`) and the pre-staging
`git status --porcelain` had NO stray source files — concurrent-session mode was OFF again,
second time running (cf. `434eb7b`). Presume-then-verify keeps paying; don't pre-emptively
switch to exact-path staging without the status proving it.

Also: `git status -sb` reports a bare `## main` (no `...origin/main`) on this repo — local
`main` has no upstream tracking configured. That is NOT an un-pushed state; push explicitly
with `git push origin main` and prove the result with `git rev-parse main origin/main`
(identical OIDs) plus `git ls-remote origin main`, not with the `-sb` ahead/behind marker.

**Promotion 30 (`44f452d` → `e5523f3`) — the tightest shape yet: ONE file, 5 lines, and the
first `style(cenapro):` subject.** A pure Tailwind class-token change (border opacity weights on
the RC Deliveries grid), immediate follow-up to promotion 29 on the same file. Confirms the
type vocabulary extends past the CLAUDE.md list when the brief names one: `style` is right for a
visual-weight-only change with zero behaviour delta, and the brief specified it.

Two habits paid again, both cheap: (1) the "STOP if you see these" path list was clean for the
THIRD consecutive promotion on this branch — concurrent-session mode really is the exception
here, so keep presuming `git add .` and verifying, per [[concurrent-session-promotions]];
(2) the bare-`## main` trap above fired exactly as written, and `git ls-remote` settled it in one
call. No CONTEXT.md update rode along this time — correct, since no files/actions/behaviours
changed, only class tokens; don't reflexively expect the CONTEXT.md sibling on style commits.

Gates were run by the ORCHESTRATOR before handoff (verify script 83 assertions, `tsc --noEmit` 0,
`npm run build` 0, lint at exact baseline) and the brief said so explicitly — when the brief
states gate results with numbers, take them and don't re-run a 2-minute build for a 5-line
class-token diff. Re-run only when the brief is silent or the diff touches logic.

**Promotion 31 (`be0dbc4` → `0d0a61d`) — FOURTH consecutive clean `git add .` on this branch**,
same 4-file shape as promotion 29 (ledger + `types.ts` + CONTEXT.md + the verify script). The
"STOP if you see these" list was clean again; `.claude/agent-memory-local/**` was the only
exclusion, as always. `feat(cenapro):` for a day-spacer row in the endless RC Deliveries view.

Two things worth carrying forward:
- **A pending `chore(memory):` commit can already be PUSHED and still need promoting.** `18f3ba8`
  sat on the branch tip at origin, so after committing, `git status -sb` read `ahead 1` — not
  `ahead 2`. Don't read the ahead-count as the promotion count; use
  `git log --oneline main..<branch>` to enumerate what the merge will actually carry (it carried
  2). Same trap family as the untracked-main-upstream one above: `-sb` markers answer a different
  question than the one being asked.
- **Checking out `main` with dirty `agent-memory-local` files is safe** — git prints the carried
  `M` paths on switch, which looks alarming mid-merge but is just the dirty tree following you.
  Switch back to the feature branch after pushing `main`; don't leave Renzo parked on `main`.

Gates again came from the orchestrator with numbers (verify 89 assertions, up from 83; formula 22;
qc-draw 36; `tsc` 0; build 0; lint at exact baseline) — took them, per promotion 30's rule. The
diff touched logic this time, but it was self-asserting: the feature's core claim (a spacer row
never enters `navRows`) is checked in-repo by comparing serialised `navRows` both ways, which is
exactly the kind of assertion that makes re-running a build redundant rather than prudent.

**Promotion 32 (`9799659` + `e121639` → `53b01e2`) — first TWO-commit promotion on this branch**,
and the FIFTH consecutive clean `git add .` (only `.claude/agent-memory-local/**` unstaged). Split
executed with `git commit -- <pathspec>` off one staged set, per [[feedback-commit-splitting]]:
`fix(cenapro):` for 5 code/doc files, then `docs(cenapro):` for a lone `.agents/prompts/*.md`
planning brief. A doc that is a *planning brief for future work* is its own change-line — do not
fold it into the fix commit even though it shipped in the same tree.

**The stop-list can be per-FILE inside a directory that is otherwise expected.** The brief named
`lib/hooks/use-grid-keyboard-nav.ts`, `use-grid-paste.ts`, `use-clipboard-copy.ts` as STOP-if-seen
while `lib/hooks/use-cell-selection.ts` was a REQUIRED path. Read the stop-list literally as file
paths; never generalise it to the parent directory, or you'll refuse the very change you were sent
to land. Verified the distinction by diffing the staged list against both lists before committing.

Gates came from the orchestrator with numbers again (verify 100 assertions, up from 89; qc-draw 36;
formula 22; `tsc` 0; build 0; lint 166/28 at exact baseline) — took them, per promotion 30's rule.
Pre-merge `git merge-tree $(git merge-base …)` conflict-marker count was 0, merge exit 0, and the
pending `chore(memory)` commit rode along for the fifth time.

**Promotion 33 (`2085a7d` → `32f1623`) — SIXTH consecutive clean `git add .`**, back to a single
`fix(cenapro):` over 3 files (ledger + CONTEXT.md + verify script). Per-file stop-list from
promotion 32 held again and was clean.

**Promotion 34 (`35374d9`+`1a5c41a`+`2a05e39`+`e5322d`… → `aff9bdb`) — SEVENTH consecutive clean
`git add .`, and the LARGEST split so far: 30 files → FOUR commits.** Brief prescribed the split and
the ordering; migration commit went FIRST so `main` never has a moment where the UI selects a column
that does not exist yet. Order-within-a-promotion is a real constraint when a changeset spans SQL +
its consumers — even though all four land in one merge, `main`'s per-commit history is what a
bisect/revert walks.

**Splitting 30 staged files four ways: use DIRECTORY pathspecs, not file lists.** `git commit -- <dir>`
(e.g. `'app/(app)/cenapro/production' 'app/(app)/production' components/digest`) covered the 3rd
commit's 9-file sweep in one line. Quote any path containing `(app)` — zsh globs the parens. Confirm
completeness with a final `git status --porcelain` showing only the known exclusions, rather than
counting files per commit.

**Brief-supplied NEGATIVE expectations are a real gate.** This one named `lib/hooks/**`,
`components/shared/grid/**` and `workers/` as paths that must NOT appear, with instructions to stop
if they did. Ran `git diff --staged --name-only | grep -E '^(…)'` right after staging — cheap, and
it converts "I think the changeset is what was described" into a verified claim.

**Third round on ONE reported symptom is not a red flag — read the brief's root-cause claim as the
commit body.** Renzo's "paste doesn't work" produced fixes in promotions 32 and this one; the first
two repaired real defects *downstream of a dead entry point* (`onPaste` on a non-editable div never
fired, because a clipboard event is dispatched at an element that can ACCEPT a paste, unlike a
keydown which goes to whatever holds focus). When a brief explains why the earlier correct fixes
did not resolve the symptom, that explanation is the most valuable part of the message — carry it
into the body verbatim in substance, and don't treat the repeat as scope creep or reach for a revert
(same lesson as promotions 23/24, now confirmed three deep).

**A brief may CORRECT its own earlier rationale — honour the correction in the message.** This one
noted the implementing agent had disproved a claim from the original brief (copy was never an
`onCopy` DOM event, so the "controlled experiment" was not real evidence; the input-vs-div split
was). Commit bodies must not repeat a rationale the brief has retracted — read the whole brief
before drafting, including its self-corrections near the end.

**Two divergence checks disagree — trust `merge-tree`, not `--is-ancestor`.** Here
`git merge-base --is-ancestor main <feat>` reported DIVERGED (main carried 2 prior promotion merge
commits), exactly the false alarm §"Do NOT use rev-list" warns about. `git log --oneline <feat>..main`
showed those two were merge commits with no unique content, and `git merge-tree --write-tree` came
back a bare tree OID (clean). Don't stall on ancestry; run the merge-tree gate.

Also re-confirmed: dirty `.claude/agent-memory-local/**` was identical on both branches
(`git diff main <feat> -- <path>` empty), so `git checkout main` carried it across without
complaint — the cheap pre-checkout check above, run as a branch-to-branch diff rather than a
name-overlap comparison.

### Promotion 35 (2026-08-05, `76f6570`) — the docs-only changeset with a STOP guard

First brief to hand me an **explicit expected-file manifest plus a STOP condition**: it named the
two docs files and said that if anything under `app/`, `lib/`, `components/`, `scripts/`,
`workers/`, `supabase/`, `types/supabase.ts`, or any migration appeared in the sweep, I must stop
and report, because the tree was clean after the last promotion and any source file would mean an
unexpected writer had touched it. **Treat that as the pattern for docs-only work:** after
`git add .`, diff the staged path list against the manifest *before* drafting the commit message —
the check is a tripwire for a concurrent session, not busywork. Here it passed (only
`.agents/prompts/liquidation-feature.md` + the new `handoffs/` file staged).

Also: the branch's pending `.claude/`-only commit `91c4e60` was already pushed to origin, so the
branch was only ahead by the new docs commit — check `git status -sb`'s ahead count rather than
assuming an unpushed predecessor still needs republishing.

### Promotion 36 (2026-08-05, `a86643a`) — the first NOTHING-TO-COMMIT promotion

Pure merge job: the three liquidation commits (`6a84e9a` audit trail, `edcfea1` subgroups +
payments, `96eb88b` agent memory) were **already committed AND pushed** by the implementing
session, so there was no `git add .` step at all — `git status --porcelain` held only the
standing `.claude/agent-memory-local/**` dirt. When a brief hands you named commit hashes to
verify rather than a changeset to stage, the job is gate → merge → push → prove; don't invent
a staging step. Verify each named hash landed with `git merge-base --is-ancestor <hash> main`.

Largest promotion on this branch: 30 files, +9,483/−88, including three
`supabase/migrations/2026080511*.sql` (~3,100 lines of SQL) and a new `app/(app)/cenapro/liquidation/`
route tree. **Migrations in the diff were NOT a schema-race risk here** — the brief stated all three
were already applied to the production Supabase project, making the deploy code-only. That claim is
the thing to repeat in the merge body; it is what makes shipping UI + migration in one merge safe.

Secret-scan discipline on a 635KB diff: capture `git diff <old-main>..HEAD` to the scratchpad, then
grep only `^+` lines for the pattern set (`service_role_key`, `eyJhbGciOi`, `sk-…`, private-key
headers, quoted `password=`/`api_key=`, `/Users/renzosy`). Clean here. Binary check via
`git diff --numstat … | grep -E '^-\s+-'` — the NUL-grep trap in [[gates-and-shell-traps]] stays
avoided by never grepping for `\x00` through argv.

Gates were all pre-run by the orchestrator with numbers (tsc clean; build green with
`/cenapro/liquidation`, `/banks`, `/subgroups` in the manifest; lint at the exact 166/28 baseline;
`verify-rc-deliveries-cells.ts` 116 assertions, up from 100; `verify-rc-formula.ts` 22) — taken, per
promotion 30's rule. Both gates clean again (`merge-tree` bare OID, merge-base tree diff empty):
that is now **24 consecutive clean promotions**.

### Promotion 37 (2026-08-05, `2311562` → `c8d8cdd`) — docs-only, EIGHTH consecutive clean `git add .`

The mirror of promotion 36: that one merged already-committed code with nothing to stage, this one
stages docs *describing* it. Same-day pair — when a feature lands on `main`, expect a follow-up
docs-only promotion (handoff + TIMELINE entry) minutes-to-hours later. It is a full `--no-ff`
promotion, not a shortcut to FF.

- **The STOP guard from promotion 35 fired again and is now the standing shape for docs work**:
  brief named the 2 expected files and said any `app/`/`lib/`/`components/`/`scripts/`/`workers/`/
  `supabase/`/`types/` path means an unexpected writer. Ran `git status --porcelain=v1
  --untracked-files=all` BEFORE staging — only the 2 files + the standing `.claude/agent-memory-local/**`.
  Clean for the eighth straight promotion; concurrent-session mode stays the exception here.
- **`sk-` in the secret-scan pattern false-positives on `task-chipped`** in TIMELINE.md (a
  pre-existing line, not in the diff). Scan the STAGED ADDED lines only —
  `git diff --staged | grep '^+' | grep -nE …` — not the whole file, or you re-triage the same
  benign prose every session. Tighten to `sk-(ant|proj|live)` to kill this class outright.
- **A TIMELINE correction to an EXISTING entry is normal and belongs in the commit body.** Here the
  older Step 1 entry closed with "no history UI", which stopped being true the same day; the diff
  is `1 insertion, 1 deletion` on that line plus the new entry. Read the `-` line to describe what
  the correction actually was — the stat alone (`3 +-`) hides that a claim was retracted.
- Build gate waived without the brief naming numbers: the staged set was verifiably 2 `.md` files,
  which is the same justification as `52178d9` / `434eb7b` above. Docs-only + verified-markdown
  staged list is sufficient on its own.

Gates clean again (`merge-tree` bare OID exit 0, merge-base tree diff empty, post-merge
`git diff --stat main <feat>` empty): **25 consecutive clean promotions.** The pending
`chore(memory)` commit `a420ce6` rode along for the eighth time — it was already pushed, so
`git status -sb` showed no ahead-count for it; `git log --oneline main..<branch>` is what
enumerates the real payload.

### Promotion 38 (2026-08-06, `4309336` → `67679c0`) — NINTH consecutive clean `git add .`

Supplier opening balances (cenapro liquidation Step 3b): 9 files, +3151/−89, one new migration +
one new dialog component. The same-day docs-only pair predicted by promotion 37 inverted here —
promotion 37's docs landed first, then this feature. Order isn't fixed; only the pairing is.

- **The mtime check decided the staging strategy in one command, again.**
  `find … -newermt '-20 minutes'` came back EMPTY and `git status --porcelain -uall` showed exactly
  the brief's 9 paths + the standing `.claude/agent-memory-local/**`. Plain `git add .` + one
  `git restore --staged .claude/agent-memory-local/`. Concurrent-session mode remains the exception
  on this branch — nine straight now.
- **A brief that pre-ran the gates WITH numbers is worth re-running the cheap subset against.**
  Per promotion 30's rule I took the pre-run `npm run build`, but independently re-ran
  `npx tsc --noEmit` (exit 0) + `verify-rc-deliveries-cells.ts` (116) + `verify-rc-formula.ts` (22)
  — all three matched the brief's stated figures exactly, in ~90s total vs ~8min for a build. That
  match is the evidence the brief describes THIS tree, which is the thing a build alone can't tell you.
- **`types/supabase.ts` regeneration is verifiable as additive in one line:**
  `git diff --staged -- types/supabase.ts | grep -cE '^-[^-]'` → `0` deletion lines, plus
  `grep -c graphql_public` on the file → `2`. Cheaper and stronger than eyeballing an 84-line diff,
  and it catches the real failure mode (a CLI regen that drops a schema).
- **Migration already applied to prod Supabase ⇒ the deploy is code-only.** Worth stating in the
  report: nothing about pushing `main` runs SQL, so a green Vercel deploy is the whole risk surface.

Gates clean again (merge-base tree diff empty, merge exit 0, post-merge `git diff --stat main
<feat>` empty, `git ls-remote` confirming both refs): **26 consecutive clean promotions.**

### Promotion 39 (2026-08-06, `7ee6bc2` → `7a8bee6`) — TENTH consecutive clean `git add .`

Liquidation Step 4 (cheque↔delivery allocations): 18 files, +6220/−140, one 2,386-line migration
+ two new components. Same-day sibling of promotion 38 — this branch now ships a numbered
liquidation step every few hours.

- **Ten straight clean sweeps.** `find -newermt '-20 minutes'` empty, `git status --porcelain -uall`
  exactly the brief's 20 paths (17 tracked + 3 untracked) plus the standing
  `.claude/agent-memory-local/**`. Concurrent-session mode is firmly the exception on this branch.
- **A brief's rich rationale IS the commit body — but verify each claim in the SQL first.** Four
  claims checked in ~4 greps before drafting: `unpriced` really is the FIRST `WHEN` in
  `view_rc_delivery_settlement`'s CASE (line ~855); `over_allocated` is a recorded state with a
  COMMENT saying "never an error"; the payment-side refusal is a DEFERRABLE constraint trigger
  (`tr_cenapro_rc_payment_allocations_fit`) that RAISEs; `advance_php` lands on both balance views.
  Cheap, and it means the body asserts what the diff does rather than what the brief hoped.
- **A single `-` line in a regenerated `types/supabase.ts` is usually a REFORMAT, not a loss.** The
  one deletion here was `Args: { p_expected_row_version; p_id }` collapsing into a multi-line
  object because `cenapro_delete_rc_delivery` gained `p_release_allocations boolean DEFAULT false`.
  Read the deletion's `+` neighbours before treating a non-zero count as a dropped schema; the
  promotion-38 one-liner (`grep -cE '^-[^-]'` → 0) is a green light, not a hard gate.
- **Cheap gate subset re-run and matched the brief's numbers exactly** (`tsc --noEmit` 0,
  `verify-rc-deliveries-cells.ts` 116, `verify-rc-formula.ts` 22, ~2 min total). Build taken from
  the brief per promotion 30's rule. Migration already applied to prod ⇒ deploy is code-only.

Gates clean again (merge-tree bare OID `d156396`, merge-base tree diff empty, merge exit 0,
`git ls-files --unmerged` empty, post-merge `git diff --stat main <feat>` empty):
**27 consecutive clean promotions.** The pending `chore(memory)` commit (`26d2fb2`) rode along for
the ninth time — already pushed, so `-sb` read `ahead 1` while the merge carried 2.

### Promotion 40 (2026-08-07, `2fadbf9` → `baa269c`) — ELEVENTH consecutive clean `git add .`

First promotion on this branch that is **not** cenapro: an ICTC sync fix (Czarina price
enrichment silently dead since August). 22 files, +3867/−112, one migration + 4 new files.
Branch name has drifted from its contents again — that is fine mid-flight, per the
"branching off a mis-named branch" note above; cut a new one only when a *fresh* work line starts.

- **A brief may under-describe its own migration — read the DDL before drafting the body.**
  The brief said the migration "narrows `batches.avg_cost`". It also added
  `view_digest_unpriced_deliveries` (+ rewired `view_digest_unpriced_recent`) and a
  `delivery_source_aliases` table + `fn_record_delivery_source_alias` RPC with full RLS/grants.
  One `grep -nE '^(CREATE|ALTER|DROP|COMMENT ON|GRANT|REVOKE|INSERT)' <migration>` catches the
  whole object list in seconds. Not scope creep — the brief described outcomes, not objects.
- **Verify brief claims by grepping for the named identifier, not by trusting the prose.** Four
  claims confirmed in ~4 greps: `resolveCzarinaTab` really returns an `ambiguous` variant carrying
  `candidates` + the full `available` tab list; the migration's `avg_cost` gained `AND cost_basis > 0`
  with a COMMENT preserving the BUG-018 definition; `MAX_DATE_DRIFT_DAYS = 7` exists and is enforced;
  `db.ts::applyOneFilter` now honours `is.true`/`is.false` instead of hardcoding `is(col, null)`.
- **`workers/sync/**` in the diff ⇒ run the WORKER gates, they are cheap and they are the point.**
  `npm test` (708 passed / 47 files, ~9s) and `npm run parity` (12 cases, exit 0) both matched the
  brief's stated numbers exactly, as did `npx tsc --noEmit` (0). ~2 min total for three independent
  confirmations that the brief describes THIS tree — took the 8-min build from the brief per
  promotion 30's rule. New worker-test baseline: **708 / 47 files** (was 674).
- **A machine-local absolute path in a TEST fixture constant is a FLAG, not a block.**
  `workers/sync/test/reports/deliveries-price-enrichment.test.ts:57` hardcodes
  `/Users/renzosy/blackwood/.sync-flags/2026-08-07/…xlsx`. It is `existsSync`-guarded and the file's
  own header documents skip-on-absence — but unlike the FIXED form in [[staging-exclusions]] there is
  **no in-repo fallback fixture**, so the workbook-dependent blocks silently skip everywhere else.
  Editing source is not the operator's call; commit and flag. Tightening the scan to
  `sk-(ant|proj|live)` (promotion 37) kept this the ONLY hit in a 238KB diff.

Gates clean again (merge-tree bare OID `b78b121` exit 0, merge-base tree diff empty, merge exit 0,
`git ls-files --unmerged` empty, post-merge `git diff --stat main <feat>` empty, `git ls-remote`
confirming both refs): **28 consecutive clean promotions.** The pending `chore(memory)` commit
(`882b62d`) rode along for the tenth time — already pushed, so `-sb` read no ahead-count while
`git log --oneline main..<branch>` correctly enumerated 2.

### Promotion 41 (2026-08-07, `5910877` → `a549afd`) — TWELFTH consecutive clean `git add .`

A **DATA-REMOVAL** promotion, the first of its kind here: 9 duplicate ICTC deliveries (161,926 kg
of phantom intake) archived + deleted in prod, shipped as 4 files / +525/−0 (one 352-line migration,
CLAUDE.md, the sync-ictc L-040 ledger entry, regenerated types). Same-day sibling of promotion 40,
same ICTC-sync work line on a cenapro-named branch.

- **The mtime check that decides staging strategy was silently BROKEN — see the new `-newermt`
  trap in [[gates-and-shell-traps]].** It returned empty (reads as "no concurrent session") and
  also returned empty for `-7 days` in a tree edited minutes earlier. Fell back to `stat` on each
  dirty file + `git status --porcelain -uall` vs the brief's path list. **Never let a single
  empty-output check decide the staging mode.**
- **A data-removal commit body is the RECORD, so it earns its length.** Nine paragraphs answering
  what a future reader will actually ask: why one truck became two rows, why the survivor was the
  right copy (`rc_out` consumption hangs off `batch_id`, so only one copy of a pair is connected to
  what was burned — zero `rc_out` rows on all seven shorthand batches), that the price moved onto
  the survivor BEFORE the delete so none was lost, and that one call reverts everything. Don't trim
  this to a one-liner because the stat is small; +525/−0 hides that 161,926 kg left the books.
- **A revealed pre-existing deficit is NOT new damage — say so explicitly.** `FEB-26-BLK5` went to
  −9,017 kg because the duplicate had been masking a real shortfall; 76 batches are already negative
  for the same history-boundary reason (51 with no deliveries at all). A brief that pre-frames this
  is handing you the exact sentence that stops it being read as breakage.
- **Verify the brief's reversibility claim in the DDL, don't take it on faith** — it is the whole
  safety story. Four greps: `row_snapshot` is `to_jsonb(deliveries.*)` with a CHECK tying
  `row_snapshot->>'id'` to `delivery_id`; the restore does
  `INSERT … SELECT * FROM jsonb_populate_record(NULL::public.deliveries, row_snapshot)` so the
  **original id and `created_at`** come back; an already-live id returns `already_present` instead of
  double-inserting; all four functions are `REVOKE … FROM PUBLIC`+`anon` / `GRANT … service_role`.
- **A BRIEF/DOCS date discrepancy is worth flagging, not silently resolving.** The brief said the
  untouched wet-sack split rows were `2025-04-03`; the committed CLAUDE.md and L-040 both say
  `2026-04-03` (batch `MARCH-25-BLK9`). Unverifiable from the sandbox (no Postgres reachable), so the
  commit body cites the rows **without a date** and the report flagged the conflict. Don't pick a
  side you cannot check, and don't bake an unverified figure into permanent history.
- Gate subset: `npx tsc --noEmit` exit 0, empty log (matched the brief). Worker gates correctly
  SKIPPED — nothing under `workers/sync/**` in the diff. `types/supabase.ts` additive one-liner held
  (`grep -cE '^-[^-]'` → 0, sentinel 2) and named all 5 new objects. Secret scan 0 hits.
- **Migration already applied to prod ⇒ deploy is code-only** (third promotion running with this
  shape). Nothing about pushing `main` runs SQL; the DB change already happened.

Gates clean again (merge-tree bare OID `df7ffe8` exit 0, merge-base tree diff empty, merge exit 0,
`git ls-files --unmerged` empty, post-merge `git diff --stat main <feat>` empty, old main tip
`baa269c` still an ancestor, `git ls-remote` confirming both refs): **29 consecutive clean
promotions.** The pending `chore(memory)` commit (`83e53cf`) rode along for the eleventh time.

### Promotion 42 (2026-08-07, `fd101ae` → `0656e69`) — THIRTEENTH consecutive clean `git add .`

An **observability** promotion, the biggest single-commit changeset on this branch: 23 files /
+3506/−5 adding an Excel report generated after every sync run (11 sheets, private `sync-reports`
Storage bucket, download by short-lived signed URL). Third same-day promotion (40, 41, 42).

- **A brief that names 2 untracked dirs may have 2 more untracked SIBLINGS that clearly belong.**
  Beyond the enumerated `src/reports/excel/{4 files}`, status showed `?? workers/sync/scripts/gen-run-report.ts`
  and `?? workers/sync/test/reports/excel/workbook.test.ts`. Both are the SAME work line (the brief's
  own "720 tests pass" and "workbook confirmed to contain all 11 sheets" claims are literally produced
  by them), so they fold into the one commit — unlike the [[staging-exclusions]] case where the strays
  were a *different* work line and earned their own commit. The test is "does this file produce the
  brief's evidence", not "was it listed".
- **A "small hand correction" in the brief can be worth verifying line-by-line.** The wet-sack date
  fix was a single character (`2026-04-03` → `2025-04-03`) in one CLAUDE.md bullet + one ledger line —
  and it **resolves the exact discrepancy promotion 41 flagged and refused to guess at**. `git diff -U0`
  + `grep -E '^[-+]- \*\*`<anchor>`'` on the replaced bullet proved nothing else moved inside it. Not
  splittable: CLAUDE.md carries both concerns, so the file stays whole per the multi-concern rule and
  the body names the correction.
- **`grep -nE '^[+-][^+-]'` on a staged diff SILENTLY DROPS removed markdown bullets** — a deleted
  `- **foo**` line starts with `--` and is excluded by that pattern. Cost a false "no removals in
  CLAUDE.md" reading against a numstat that said `16 1`. When numstat and your changed-line grep
  disagree, the grep is wrong: fall back to `git diff --staged -U1 | grep -nE '^(@@|-)'`.
- Gate subset (worker touched ⇒ worker gates are the point): root `tsc --noEmit` 0 / empty log,
  worker `tsc -p workers/sync/tsconfig.json` 0, `npm test` **720 passed / 48 files** (new baseline,
  was 708/47), `npm run parity` clean 12 cases. All four matched the brief's numbers; 8-min root
  build taken from the brief per promotion 30's rule.
- **cwd quirk confirmed:** this session's Bash cwd was already `workers/sync`, so a bare `npm test`
  ran the WORKER suite. Read the vitest header (`RUN v2.1.9 /Users/renzosy/blackwood/workers/sync`)
  to confirm which suite ran instead of assuming the repo root.
- Secret scan: 2 hits in a 3.5k-line diff, both the literal role name in `grant … to service_role`
  lines of the migration. Zero machine-local paths — the promotion-41 flag
  (`test/reports/deliveries-price-enrichment.test.ts` hardcoding `/Users/renzosy/…`) did NOT recur in
  the new test file.

Gates clean again (merge-tree bare OID `b1ee329` exit 0 re-run AFTER committing, merge-base tree diff
empty, merge exit 0, `git ls-files --unmerged` empty, post-merge `git diff --stat main <feat>` empty,
old main tip `a549afd` still an ancestor, `git ls-remote` confirming both refs): **30 consecutive
clean promotions.** The pending `chore(memory)` commit (`7927b16`) rode along for the twelfth time.
**Re-run `merge-tree` after the commit, not just before** — the pre-commit run gates the wrong tip.

### Promotion 43 (2026-08-07, `c984fbf` → `9f877c7`) — FOURTEENTH consecutive clean `git add .`

ACTUAL FED ₱/kg in RC Movement (a closed block cost more per kg than it arrived at, because it
dried out while the money stayed spent): 5 files / +1125/−6, one 362-line migration + 3 new
`security_invoker` views. FOURTH same-day promotion (40, 41, 42, 43) — this branch is shipping
one work line every couple of hours and the branch name has drifted from its contents for four
promotions running. Still fine per the "mis-named branch" note; ICTC work continues on it.

- **Fourteen straight clean sweeps.** `git status --porcelain -uall` was exactly the brief's 4
  tracked paths + 1 untracked migration + the standing `.claude/agent-memory-local/**`. Skipped
  `find -newermt` entirely (broken here, see [[gates-and-shell-traps]]) — the status-vs-brief
  path comparison alone decided it, which is the signal that actually works.
- **A "strictly additive migration" claim is verifiable in ONE grep and worth it.**
  `grep -nE '^(CREATE|ALTER|DROP|COMMENT ON|GRANT|REVOKE|INSERT)' <migration>` showed three
  `CREATE OR REPLACE VIEW` on NEW names only, zero `ALTER`/`DROP`, grants to
  `authenticated, service_role`, `REVOKE ALL … FROM anon`. That list IS the additive proof —
  no existing view appears in it.
- **"Not queried at all when `!canViewPrices()`" needs the GUARD checked, not the call site.**
  `grep -n showPrices actions.ts` then reading the enclosing block: two views sit inside a real
  `if (showPrices) { … }` and the third is a `showPrices && batchIds.length ? fetchAll(…) :
  Promise.resolve([])` ternary. A `canViewPrices` import plus a nulling map would NOT have been
  the same claim; the point is the query never issues.
- **The brief's headline figures were all corroborated in the committed docs** (CONTEXT.md L61/64/69,
  CLAUDE.md L187/190) — ₱50.6110, ₱46.9580, ₱47.2747, and the 101-exact / 23-over split behind the
  "~27% zero-or-negative uplift" line. When a brief hands you measured numbers, grep the staged docs
  for them before putting them in permanent history; here they matched, so the body states them.
- Gate subset: `npx tsc --noEmit` exit 0, empty log (matched the brief). No `workers/sync/**` in the
  diff ⇒ worker gates correctly skipped. Build + lint baseline taken from the brief per promotion 30's
  rule. Secret scan on added lines only: **0 hits** in a 1,376-line diff; all 5 files text (numstat
  all-numeric). 6 removed lines, all benign (CONTEXT.md row rewrites, one destructure + one import
  expansion) — enumerated with `awk '/^-/ && !/^---/'` rather than the bullet-dropping `^[+-][^+-]`
  grep from promotion 42.
- **Migration already applied to prod ⇒ deploy is code-only** (fourth promotion running with this
  shape; it is now the norm on this branch, not the exception). Nothing about pushing `main` runs SQL.

Gates clean again (merge-tree bare OID `89e76d9` exit 0 run AFTER committing per promotion 42,
merge-base tree diff empty, merge exit 0, `git ls-files --unmerged` empty, post-merge
`git diff --stat main <feat>` empty, old main tip `0656e69` still an ancestor, `git ls-remote`
confirming both refs): **31 consecutive clean promotions.** The pending `chore(memory)` commit
(`606c3d5`) rode along for the thirteenth time — already pushed, so `-sb` showed no ahead-count
while `git log --oneline main..<branch>` correctly enumerated 2.

## `dev` → `main` promotion: LOCAL merge commit, no PR

Precedents `d323257`, `bacbe12`, `0e4ae9c` — all `git checkout main && git merge --no-ff dev -m "..."` then `git push origin main`. Never a GitHub PR. `main` has diverged history from `dev`, so `git merge --ff-only` always fails with "Diverging branches" — go straight to `--no-ff`. Trigger is an explicit request to sync the Vercel *production* target (a build/config or perf fix), not routine feature landing.

## `feat/*` → `dev`: GitHub PR **merge commits**

`gh pr merge <n> --merge` — NOT squash, NOT rebase. dev's history is a chain of "Merge pull request #N from …" commits (#3–#19). Match it.

- GitHub's repo *default* branch is `main`, so **always pass `--base dev` explicitly** when opening a feat→dev PR.
- Neither `dev` nor `main` has branch protection (gh api → 404 "Branch not protected"), but still confirm `mergeStateStatus: CLEAN` when a PR is used.
- **EXCEPTION:** when the task prompt itself says "ff expected" AND `dev` is a strict ancestor of the feat tip (`git merge-base --is-ancestor origin/dev <feat>`, exit 0), a plain `git merge --ff-only` with no PR is correct — that's what was asked for, not a shortcut. Done 2026-07-17 for `feat/mobile-pwa`.
- **`gh pr view --json merged` is INVALID in this gh version** — use `state` (=="MERGED"), `mergedAt`, `mergedBy`, `mergeCommit.oid`. A bad `--json` field exits 1 and silently skips any `&&`-chained git command after it; run gh JSON queries standalone.

## Direct commits to `dev` and `main`

- **`dev`: direct conventional commits ARE the norm** for session work (verified 2026-07-07: `014fff4`→`4ccd9ae`). Reserve `feat/*` + PR merges for large multi-session feature lines. Do NOT refuse or stall on an explicit direct-to-dev instruction.
- **`main`: direct commit only on an explicit, unambiguous instruction naming `main` + the live-deploy motivation.** Two authorized instances, both 2026-07-23: `529687e` (Shipments/Trello export feature) and `b2949b7` (a "trigger redeploy" commit whose entire purpose was forcing a fresh Vercel build so dashboard-added env vars get picked up — Vercel only reads new env vars on the next build). Plain `git push origin main`, no PR.
- If a branch is already **ahead of its remote before you start**, your push republishes those older local commits too — call that out in the report (happened 2026-07-23 with `9878caf` + `a871b5a`).

## Misc

- **Merged `feat/*` branches are KEPT, not deleted** — every historical feature branch (local + origin) survives. Default to keeping unless told otherwise.
- Branch naming shifted from `feat/<UI|backend>/<name>` (early) to flat `feat/<kebab-name>` (recent).

### Promotion 44 (2026-08-08, `534d879` → `50eced1`) — FIFTEENTH consecutive clean `git add .`

The root-cause fix for duplicate ICTC deliveries: the sync's natural key omitted the truck plate and
contained three human-correctable facts, so any correction filed a second row. 24 files / +2598/−211,
one new shared `workers/sync/src/lib/deliveryIdentity.ts` + a 538-line test file, Python oracle moved
in lockstep. **No migration, no schema change** — classification logic only, so nothing about pushing
`main` runs SQL (fifth promotion running with a code-only deploy shape).

- **First promotion on this branch that is worker-only** — zero files under `app/`, `lib/`,
  `components/`. So root `npm run build` / root `tsc --noEmit` gate NOTHING here: root `tsc` does not
  cover `workers/sync/tsconfig.json`. The honest gate subset was worker `tsc -p` (exit 0, empty log),
  `npm test` **745 passed / 49 files** (new baseline, was 720/48), `npm run parity` clean 12 cases
  (deliveries 2 / flecon 3 / gsheet 2 / production 2 / rc_movement_audit 1 / rc_out 2, +2 expected
  deviations on `production_downtime_ge60`). All three matched the brief. Say in the report WHY the
  root build was skipped — "no app-layer file in the diff" is the reason, not "the brief said so".
- **A TRACKED source file can already be BINARY to git, and its diff then reads `Bin N -> M bytes`.**
  `workers/sync/test/reports/gsheet-idempotency.test.ts` showed `Bin 14618 -> 15014` and `- -` in
  `--numstat`. Not a real binary and not an alarm: the **HEAD blob** carries exactly one stray NUL
  byte (inside a `String(row[c] ?? "…")` placeholder literal), and git marks the diff binary if
  EITHER side is. The new worktree copy has **no** NUL (replaced with a space), so from this commit
  forward the file diffs as text again. Diagnose with `git show HEAD:<path> | perl -0777 -ne 'exit(1)
  if /\x00/'` — check BOTH sides before concluding, and read the diff via `git diff -a -- <path> |
  tr -d '\000'`. Remember `tr -d` shifts columns, so do not read a one-character delta off that
  output; grep the worktree file for the real bytes.
- The `-  -` numstat row means the binary file contributes 0 to the insertion/deletion totals — the
  `24 files / +2598/−211` figures exclude it. State that rather than implying the file was unchanged.
- Secret scan: 3 hits in a 2.8k-line diff, all in the new dry-run script and all `process.env` reads
  (`SUPABASE_SERVICE_ROLE_KEY`, `Bearer ${key}`). **Zero hardcoded credentials, zero machine-local
  paths** — the promotion-41 `/Users/renzosy/…` flag did not recur in either new script. A new
  `.gitignore` line (`workers/sync/.dryrun-identity/`) kept the dry-run's scratch output untracked, so
  `git add .` swept nothing extra.
- The brief's measured figures were all corroborated in the committed docs before going into permanent
  history (`grep -oE '1,545|1,688|224|183|18,827'` on the staged diff): 1,545 plated+sacked rows,
  1,688 total, 224 raw plate spellings → 183 trucks, the 18,827 kg wet-sack split. They matched.

Gates clean again (merge-tree bare OID `aa7228a` exit 0 run AFTER committing, merge-base tree diff
empty, merge exit 0, `git ls-files --unmerged` empty, post-merge `git diff --stat main <feat>` empty,
old main tip `9f877c7` still an ancestor, `git ls-remote` confirming both refs): **32 consecutive
clean promotions.** The pending `chore(memory)` commit (`acac35c`) rode along for the fourteenth time
— which is why the merge stat said 25 files / +2640 against the commit's own 24 / +2598. Reconcile
that gap out loud; an unexplained extra file in a `main` merge stat is exactly what a mistake looks
like.

### Promotion 45 (2026-08-08, `5c5fb80` → `7a127b3`) — SIXTEENTH consecutive clean `git add .`

The human-edit latch for `public.deliveries` (the same protection the six production fact tables got
2026-08-03). 17 files / +2058/−50, one 566-line migration **already applied to production**, so the
`main` push is a **code-only deploy** (sixth promotion of that shape — say so explicitly, it changes
the risk story). Touches both `app/`+`lib/` AND `workers/sync/`, so unlike promotion 44 the root
`tsc` gate was meaningful and was run alongside the worker one.

- **A grep hit is not a caller.** The brief claimed "no in-app release door yet — nothing in `app/`
  calls `fn_release_delivery_rows`". `grep -rn` over `app/ lib/ components/` returned 2 hits in
  `app/(app)/sync/types.ts` — **both inside doc comments**. Reading them confirmed the brief instead
  of contradicting it. When a brief states a deliberate gap and you verify it, verify by reading the
  matches; a bare hit count would have produced a false "the brief is wrong" flag in a `main` report.
- **Gate subset used, and why:** worker `npm test` **764 passed / 50 files** (new baseline, was
  745/49 at promotion 44) + `npm run parity` clean 12 cases + `tsc --noEmit` root AND
  `-p workers/sync/tsconfig.json` (both exit 0, both logs 0 lines) + scoped `npx eslint` on the 3
  touched app-side files (exit 0). Root `npm run build` waived per the playbook — the brief pre-ran
  it and the four cheaper gates cover exactly what changed. All figures matched the brief exactly.
- Secret scan on the staged diff: **zero hits** for the full pattern in 2,058 added lines, and
  `--numstat` all-numeric (no binary side this time — promotion 44's stray-NUL file diffs as text
  again from `534d879` forward, exactly as predicted).
- The pending `chore(memory)` commit (`ddc329c`) rode along for the fifteenth time, so the merge stat
  read 19 files / +2126 against the commit's own 17 / +2058 (the 2 extra = this file +
  `gates_and_shell_traps.md`). Reconcile the gap out loud.

Gates clean again (merge-base tree diff empty, `git pull --ff-only` "Already up to date", merge exit 0
via the `ort` strategy with no conflict lines, post-push `git ls-remote` confirming
`main=7a127b3` / `feat=5c5fb80`): **33 consecutive clean promotions.**

### Promotion 46 (2026-08-08, `e9aa32e` → `e58c7d2`) — SEVENTEENTH consecutive clean `git add .`

The sync worker's **container build** was broken, so `fly deploy` had been failing and none of
the day's sync fixes were actually running. 9 files / +634/−15 — Dockerfile, a NEW root
`.dockerignore`, `fly.toml`, `package.json`, `esbuild.config.mjs`, a NEW 350-line
`verify-container-build.mjs`, plus `DEPLOY.md` / `RUNBOOK.md` / root `CLAUDE.md`.

- **The headline fact is now its own memory: [[deploy-targets]] — pushing `main` deploys Vercel
  ONLY.** This promotion's whole subject is that gap. A worker-only changeset landing on `main`
  changes nothing in production until `cd workers/sync && npm run deploy`. Never let a report
  imply otherwise.
- **Gate subset, and why:** the diff contains **zero** app-layer files — root `CLAUDE.md` is a doc
  and root `.dockerignore` is read by Docker only (not by Vercel, not by git), so root
  `npm run build`/`tsc` gate literally nothing and were skipped on that basis. What was run:
  worker `npx tsc --noEmit -p tsconfig.json` (exit 0, log 0 lines), `npm test` **764 passed /
  50 files** (baseline held from promotion 45), `npm run parity` clean 12 cases (+2 expected
  deviations on `production_downtime_ge60`), and the changeset's **own new gate**
  `npm run verify:container-build` → OK, reproducing **89 files / 1450 KB / 568 KB bundle**,
  which matched the brief's measured figures.
- **The Bash cwd was already `workers/sync`**, so a bare `npx tsc -p tsconfig.json` and
  `npm run verify:container-build` ran the WORKER ones with no `cd`. Confirmed by vitest's
  `RUN … /workers/sync` header and by `pwd`. Same trap [[gates-and-shell-traps]] flags — verify
  which package you actually gated.
- **The deployed image predates the commit, and that is fine.** Renzo's brief reported the Fly
  machine already on version 14 with startup banner `build 71a01b8` — the PARENT commit — because
  the deploy was built from the then-uncommitted working tree. Report it as expected, and say why
  the bytes are still provably the committed ones (tree unchanged between deploy and commit).
- Secret scan: **zero hits** across 634 added lines for the full pattern; `--numstat` all-numeric
  (no binary side). No machine-local path leaked into the new `.mjs` script.
- Merge stat read **10 files / +663** against the commit's own 9 / +634. The extra is
  `.claude/agent-memory/git-branch-guardian/main_promotion_playbook.md` (+29) from the pre-existing
  `71a01b8` `chore(memory)` commit riding along for the **sixteenth** time. Reconcile that gap out
  loud, every time.

Gates clean again (merge-base tree diff empty, `git merge-tree --write-tree` exit 0 with a bare OID
`039bff5`, `git pull --ff-only` "Already up to date", merge exit 0, `git ls-files --unmerged` empty,
post-merge `git diff --stat main <feat>` empty, old main tip `7a127b3` still an ancestor,
`git ls-remote` confirming `main=e58c7d2` / `feat=e9aa32e`): **34 consecutive clean promotions.**

### Promotion 47 (2026-08-12, `a116127` → `26a75e1`) — EIGHTEENTH consecutive clean `git add .`

The blocking cross-check's grand-total finding stopped crying wolf: it now states a RESIDUAL
(`delta − Σ signed per-block gaps`) and drops from `high` to `attention` when the flagged blocks
fully account for the gap. 9 files / +511/−16, no migration, no new files — pure logic + docs, so
the `main` push is a **code-only deploy** (seventh promotion of that shape).

- **Touches BOTH `workers/sync/**` and `app/`+`lib/`, so both type-checks were meaningful** and
  both were run: root `npx tsc --noEmit` (exit 0, log 0 lines) and worker
  `npx tsc --noEmit -p tsconfig.json` (exit 0, 0 lines). Worker `npm test` **772 passed / 50 files**
  (new baseline, was 764/50 at promotions 45–46), `npm run parity` clean 12 cases (+2 expected
  deviations on `production_downtime_ge60`). All matched the brief's numbers exactly. Root
  `npm run build` waived per promotion 30's rule (brief pre-ran it and stated the lint baseline).
- **A brief that says "+N test cases" is checkable in ONE grep and worth it.** The brief claimed
  +3 severity checks in `scripts/verify-findings.ts`; `git show HEAD:<path> | grep -cE '^\s*check\('`
  vs the same on the worktree gave **19 → 22**, and running the script printed
  "All 22 findings checks passed." Two independent confirmations that the brief describes THIS tree,
  in ~20 seconds. Do this whenever a brief quantifies its own test delta.
- **The brief's headline BUG claim was verified in the diff, not taken on faith** — and it is the
  most valuable line in the message. Summing the diffs' `delta` would have been wrong because
  presence-shaped diffs carry `delta: null`; the committed helper is
  `(sheet_kg ?? 0) − (computed_kg ?? 0)` with a JSDoc naming the measured wrong answer
  (Σ`delta` = 9,909 ⇒ "26,239 kg unexplained" on a run where nothing is unexplained). Read the
  helper before drafting; a body that states the trap must state the *committed* form of the fix.
- **Fail-closed severity reads are worth naming explicitly in the body.** `fully_accounted` is read
  as `=== true`, so a grand_total stored before this change (no such field) stays `high`. That is
  the difference between "we quieted an alarm" and "we quieted an alarm we can prove is redundant" —
  the distinction a reader of `main`'s history will care about.
- Secret scan on added lines only: **zero hits** across 511 added lines; `--numstat` all-numeric
  (no binary side). No machine-local paths.
- **The brief explicitly reserved the Fly deploy for Renzo** ("do the merge and push only, I am
  handling the deploy") and asked for the outstanding deploy to be stated on the record. Honour
  that literally — do NOT run `npm run deploy` — and put the outstanding worker deploy in the
  report anyway, per [[deploy-targets]]. A worker changeset on `main` is inert until it ships.
- Merge stat read **13 files / +622** against the commit's own 9 / +511. The 4 extra files
  (+111 = 2 + 45 + 25 + 39) are all `.claude/agent-memory/git-branch-guardian/**` from the
  pre-existing `4481b69` `chore(memory)` commit riding along for the **seventeenth** time.
  Reconcile that gap out loud, every time — it adds up exactly or something is wrong.

Gates clean again (merge-base tree diff empty, `git merge-tree --write-tree` bare OID `0d4cd6e`
exit 0 **re-run after committing** per promotion 42, `git pull --ff-only` "Already up to date",
merge exit 0 via `ort`, `git ls-files --unmerged` empty, post-merge `git diff --stat main <feat>`
empty, old main tip `e58c7d2` still an ancestor, `git ls-remote` confirming `main=26a75e1` /
`feat=a116127`): **35 consecutive clean promotions.**

### Promotion 48 (2026-08-12, `730166f` → `43a66f8`) — NINETEENTH consecutive clean `git add .`

Promotion 47's follow-up the same day: the blocking grand-total finding's reassurance became a
**BADGE** (`POSSIBLE MISMATCH DUE TO LAG`, Renzo's wording verbatim) instead of the closing clause of
a paragraph, plus a real fix to `FindingDetailCards.tsx`, which styled from `kind` and ignored
severity. 6 files / +346/−33, **zero files under `workers/sync/**`** — so unlike 47 this is a
Vercel-only deploy and no Fly deploy is outstanding. Confirm that with
`git diff --name-only <old-main> <new-main> -- workers/sync/ | wc -l` = 0 and say so in the report;
the brief asked for the confirmation explicitly.

- **THE LESSON OF THIS PROMOTION IS A SHELL TRAP THAT NEARLY MERGED A STALE `main`** — the piped
  `git pull --ff-only` inside an `&&` chain, its 75-second connection timeout swallowed by `tail`.
  Full write-up + the `merge-base --is-ancestor` recovery in [[gates-and-shell-traps]]. Outcome here
  was clean (`origin/main` 26a75e1 WAS already an ancestor, from the earlier successful fetch, and a
  fresh re-fetch showed the remote unmoved), but that was luck, not the gate working. Network to
  github was flaky mid-session: the branch push succeeded, the pull 30 seconds later timed out, the
  next fetch and the `main` push both succeeded.
- Gates: root `npx tsc --noEmit` exit 0 (checked with `${PIPESTATUS[1]}`), `npx tsx
  scripts/verify-findings.ts` printing **"All 25 findings checks passed"** — the brief's claimed
  22 → 25 delta, confirmed by running it, per promotion 47's grep rule. No worker type-check or
  `npm test` needed *because* nothing under `workers/sync/` changed; state that reasoning rather
  than silently skipping them. Root `npm run build` waived per promotion 30 (brief pre-ran it and
  stated the 166/28 lint baseline).
- Secret scan on the staged diff: zero hits across 346 added lines. Note this changeset is
  Tailwind-class-heavy (`dark:bg-amber-400/10` etc.), which produces no scan noise at all.
- Merge stat read **8 files / +392** against the commit's own 6 / +346: the 2 extra
  (+47 = 2 + 45) are `.claude/agent-memory/git-branch-guardian/**` from the pre-existing `66eb894`
  `chore(memory)` commit riding along for the **eighteenth** time. Reconciled exactly.
- `git status -sb` on `main` prints a bare `## main` with **no `...origin/main`** — local `main` has
  no upstream configured in this repo, which is why the playbook's recipe says `git pull --ff-only
  origin main` and `git push origin main` with explicit remote+branch. A missing tracking line on
  `main` is normal here, not evidence of a failed push; prove the push from its own
  `26a75e1..43a66f8` output.

### Promotion 49 (2026-08-13, `5369fa6` → `d6c69da`) — TWENTIETH consecutive clean `git add .`

`fix(sync): understand the operator's FEEDING # N shorthand` — the `FEEDING_AREA_RE` widening,
a new `lib/batchCodeAlias.ts` so the widening did not trade a held case for a spurious one, and a
new soft `awaiting_batch_assignment` class. 21 files / +1633/−19, **12 of them under
`workers/sync/**`** ⇒ Fly deploy outstanding (see [[deploy-targets]]).

- **The piped-pull trap from 48 was avoided by construction:** every network call ran as its own
  UNPIPED Bash invocation with `> log 2>&1; echo "EXIT=$?"` — `fetch` (twice), `checkout`, `pull
  --ff-only`, `merge`, both pushes. Six separate calls instead of one `&&` chain is the cost of the
  gate actually working; pay it. First fetch and the pre-merge `pull --ff-only` both exit 0,
  `origin/main` read `43a66f8` before AND after, so nothing was stale.
- Gates all re-run firsthand, none taken on faith: root `npx tsc --noEmit` **0**, worker `npx tsc
  --noEmit -p workers/sync/tsconfig.json` **0**, `npm test` **789 passed / 51 files** (the brief's
  772 → 789 delta, confirmed), `npm run parity` **clean / 12 cases**, `npm run verify:container-build`
  **OK** (bundle 579 KB — note it drifts run to run, 568 KB at promotion 46; the OK line is the gate,
  not the byte count), `npx tsx scripts/verify-awaiting-batch-assignment-fold.ts` **"All 8 … passed"**.
  Root `npm run build` waived per promotion 30.
- **A brief claiming a file is "byte-unchanged" is checkable in one command** — here
  `workers/sync/test/parity/expected-deviations.json`. `git status --porcelain -- <path>` printing
  nothing IS the proof, but only once you have found the REAL path (`find … -name` first; my two
  guessed paths also printed nothing, which proves nothing). Same family as the empty-`$PIPESTATUS`
  silent green.
- Merge stat read **23 files / +1669** against the commit's own 21 / +1633: the 2 extra
  (+36 = 2 + 34) are `.claude/agent-memory/git-branch-guardian/**` from the pre-existing `f08f16a`
  `chore(memory)` commit riding along for the **nineteenth** time. 1633 + 36 = 1669 exactly.
- Gates clean (merge-base tree diff empty, `merge-tree --write-tree` bare OID `89ec1a7` exit 0 run
  after committing, merge exit 0 via `ort`, `git ls-files --unmerged` empty, post-merge `git diff
  --stat main <feat>` empty, old main tip `43a66f8` still an ancestor, `git ls-remote` confirming
  `main=d6c69da` / `feat=5369fa6`): **36 consecutive clean promotions.**

### Promotion 50 (2026-08-13, `b76def7` → `5f24f23`) — TWENTY-FIRST consecutive clean `git add .`

`feat(shipments): download just the customer send-out set` — `planSendOutSet()` /
`sendOutZipBaseName()` in `lib/shipments/requirements.ts`, a `?set=sendout` param on the EXISTING
ZIP route, a set-download button + `SET` row pill, and `scripts/verify-sendout-set.ts`. 5 files /
+660/−21. **Zero files under `workers/sync/**` ⇒ Vercel alone ships it, no Fly deploy** — the first
promotion in a while where the brief's "no deploy needed" claim was checkable in one command:
`git diff --name-only <oldmain>..<newmain> | grep -c "^workers/sync/"` → `0`. Use that, not the
commit's file list, since the promotion range includes any riding-along commits.
- Network calls unpiped in their own invocations again (`push feat`, `fetch main`, `checkout`,
  `pull --ff-only`, `merge`, `push main`), each with `echo "EXIT=$?"`. All 0. `origin/main` read
  `d6c69da` before the merge and the pull said "Already up to date", so nothing was stale.
- **A brief saying "verified independently just now" is still re-run firsthand** — root
  `npx tsc --noEmit` **0**, `npx tsx scripts/verify-sendout-set.ts` **"14 checks passed."**,
  `git diff --quiet main -- middleware.ts` **0**, no bypass/`SKIP_AUTH` token in `middleware.ts`.
  Root `npm run build` and `npm run lint` waived per promotion 30 (lint baseline unchanged claim
  taken as-is; it is a baseline, not a gate).
- Merge stat read **7 files / +693** against the commit's own 5 / +660: the 2 extra (+34, −1) are
  `.claude/agent-memory/git-branch-guardian/**` from the pre-existing `2ccbae4` `chore(memory)`
  commit riding along for the **twentieth** time. Expect this every promotion.
- Gates clean (merge-base tree diff empty, merge exit 0 via `ort`, post-push `main` == `origin/main`
  at `5f24f23`, feature branch restored): **37 consecutive clean promotions.**

**Promotion 50 (`d1ef776` + `c10680d` → `49dfd70`) — first promotion off
`feat/sync-rc-in-recovery`, a NEW branch cut off `main` for a live production defect**
(RC IN stopped flowing; four truckloads at ₱0). Branch sat exactly AT `main` with zero
commits and the entire changeset uncommitted in the tree — so the merge-base gate and the
`merge-tree` gate were both trivially clean, and the merge was a normal `--no-ff` (`ort`,
25 files, +2706/−105). Confirms the "cut a new `feat/*` off `main` for a new work line"
shape from the 2026-08-17 note, now with a same-day promotion attached.

Two things worth carrying forward:

- **The `chore(memory)` + feature SPLIT is the right default when the tree holds a guardian
  memory edit.** A `fix(sync):` body enumerating three production faults cannot honestly
  describe a git-guardian process note. Mechanics per [[feedback-commit-splitting]]:
  `git commit -F <msg> -- <the one memory path>` FIRST, then a bare `git commit -F <msg>`
  for the rest of the index — that ordering leaves the substantive commit as the branch TIP,
  which is what you want in `git log` and in the merge stat. No per-file staging.
- **A brief that states gate numbers is worth spot-checking on a production-defect
  promotion, and it is cheap.** Ran worker `npm test` (52 files / **816** tests) + `parity`
  (12 cases, 2 expected deviations, 0 fail) + root `tsc` in parallel background calls while
  writing the commit message: ~2 min of wall clock, all three matched the brief exactly,
  including its prediction of the one stale `.next` tsc error. Matching numbers is real
  corroboration that the brief's author actually ran them; take the 8-minute root build
  from the brief, re-run the 2-minute subset yourself.
### Promotion 52 (2026-08-17, `c5ad702` → `ff8b583`) — first promotion of `feat/universal-table`

`Merge: universal table module — plan, research pack, and Phase 0 (four defects fixed)`. 23 files /
+2947/−35: the plan of record (`.agents/prompts/universal-table-module.md`), 5 evidence docs under
`docs/universal-table/`, and Phase 0 fixes for BUG-022/023/024/025. **Zero files under
`workers/sync/**` and zero migrations ⇒ Vercel alone ships it** (checked with
`git diff --name-only <oldmain>..<newmain> -- 'workers/**' | wc -l` → 0, same for
`supabase/migrations/**`; use the promotion RANGE, not the commit list, per promotion 50).

**The numbering gap in this file is real, not an error.** Promotion 51's note (`7662056`) is
stranded on `feat/cenapro-deliveries-qol` and never reached `main`, so this branch — cut fresh off
`main` — carries a playbook whose last entry was 50. `git merge-base --is-ancestor <memory-commit>
main` settles "did that note ship" in one call. Expect this whenever two feature branches are alive
at once; do NOT cherry-pick the stranded commit across.

- **On a branch cut from `main` that has NEVER been promoted, `git merge-base --is-ancestor main
  <feat>` (exit 0) is the STRONGEST clean-merge proof available** — main is a strict ancestor, so
  `--no-ff` is guaranteed conflict-free and `merge-tree` adds nothing. This does not contradict
  promotion 34's "don't trust `--is-ancestor`": that warning is about LONG-LIVED branches where main
  has accumulated its own merge commits and the check false-alarms DIVERGED. Ancestor-true is always
  conclusive; ancestor-false is the reading that means nothing on its own.
- **New step: a brief may ask you to LEVEL the branch, not merely return to it.** Steps 6–7 here were
  `git checkout <feat>` → `git merge main` (fast-forwards, since main's tip has the feat tip as
  parent #2) → `git push origin <feat>`, leaving all four refs at the SAME OID for Phase 1 work. The
  usual recipe only restores the branch and leaves it behind main. Prove it with
  `git rev-list --left-right --count <feat>...main` → `0 0`.
- Gates: `npx tsc --noEmit` exit 0, run ON `main` AFTER the merge and BEFORE the push, exactly as the
  brief ordered. Secret scan on the promotion range found 2 `/Users/renzosy/…` hits, both markdown
  PROSE in docs (an approved-plan pointer and a scope note) — benign, unlike promotion 40's hardcoded
  fixture path in executable test code. Judge a home-path hit by whether code READS it.
- The two `.claude/agent-memory-local/**` files were **identical on both branches**
  (`git diff <feat> main -- <paths>` empty), so `git checkout main` carried them across untouched —
  the branch-to-branch form of the pre-checkout check, per promotion 34. They stayed unstaged
  throughout, as always.
- No `chore(memory)` commit rode along this time (the branch's memory commit `c8b4b93` was already
  in the promoted range), so the merge stat matched the branch diff exactly — 23 files both ways.
  **38 consecutive clean promotions.**

### A DEV-ONLY ROUTE on a feature branch is a promotion-time question, not a commit-time one

2026-08-17, `9f5bb71` on `feat/universal-table` (commit-only brief, no merge). Stage 1C added
**`app/dev/table-playground/`** — a public, unauthenticated page so Playwright can drive the shared
grid with no login and no Supabase — plus the first `middleware.ts` change this branch has carried.
Committing it is safe; **promoting it is the moment to re-check it**, because merging this branch to
`main` ships that route to the live Vercel app.

- **Its safety is two INDEPENDENT locks, and either alone suffices.** The page calls `notFound()`
  when `NODE_ENV === 'production' && !process.env.TABLE_PLAYGROUND`; middleware only pushes
  `/dev/table-playground` onto `PUBLIC_PATHS` under the negation of the same condition. So the env
  var `TABLE_PLAYGROUND` must be **absent from Vercel production** for the route to stay dark —
  that is the one external fact a promotion of this branch should state, since it lives in the Vercel
  dashboard and nothing in the repo can prove it.
- **How to verify an auth-boundary diff is additive, in one command:** `git diff --numstat -- middleware.ts`
  → `15 0 middleware.ts`. A zero in the deletions column is the proof that no existing guard was
  removed; reading the hunk alone can miss a guard silently relocated. Do this on ANY changeset
  touching `middleware.ts`, `lib/auth.ts`, or an RLS migration, and quote the numstat in the report.
- The brief asked for exactly this check. Treat "confirm the diff only ADDS X and removes no guard"
  as a standing instruction for auth-boundary files even when a brief does not spell it out.

### Promotion 52 — the FIRST non-empty merge-base tree test, and it was still safe

2026-08-19, `feat/universal-table` (`1bd8426`, 20 commits) → `main` (`49dfd70`) = **`8bf43ac`**.
The universal-table v2 grids, 83 files, +21,110/−667.

**The merge-base tree diff was NOT empty** — 25 files / 2,706 lines, because `main` had moved on
(the RC IN price-outage promotion) while the branch sat unmerged. Twenty-two promotions of an
empty result had made that test feel like a safety property; it is not. **It only ever proved
"`main` has not advanced", which is a different claim from "the merge is clean."**

- **The test that actually answers the question is the FILE-SET INTERSECTION**, and it costs one
  command: `comm -12 <(git diff --name-only $MB origin/main | sort) <(git diff --name-only $MB <feat> | sort)`.
  Here it printed exactly one path, and `git merge-tree --write-tree --name-only main <feat>`
  (exit 1) then named that same single path as the only conflict. Two independent instruments
  agreeing on the same one file is what makes a non-empty merge-base diff safe to proceed on.
- **When `main` has advanced, the merged tree is a combination NEITHER SIDE EVER GATED.** Both
  branches ran their own green gates on their own trees; the union is novel. So re-run a gate on the
  merge result — and the free moment to do it is **while the merge is still conflicted and
  uncommitted**, because the working tree already holds the fully merged content. Green → `git
  commit`; red → `git merge --abort` leaves no trace. Here: `tsc --noEmit` exit 0 plus
  `verify-table-core` 44 / `verify-rc-deliveries-cells` 129 / `verify-qc-draw-cells` 36, matching the
  brief's branch-tip numbers exactly.
- **`git add .` IS WRONG INSIDE A MERGE.** Renzo's blanket-staging rule governs *composing a
  changeset*; a conflict resolution stages the resolved path and nothing else. A bare `git add .`
  here would have swept the standing `.claude/agent-memory-local/` exclusion into a **production**
  merge commit. Stage the resolved file by name, then prove the negative:
  `git diff --staged --name-only HEAD | grep -E 'agent-memory-local|supabase/.temp|test-results'`
  must return nothing.

### A "union" resolution does NOT mean re-inlining prose that MOVED to another file

The one conflict was this agent's own `staging_exclusions.md`, and the brief ordered a union so no
lesson would be lost. `main` still carried two long bullets inline; the branch had **consolidated
them into `commit_message_fidelity.md`** (`fb8c75b`) and replaced them with a `[[…]]` pointer.
Re-inlining them would have duplicated the prose and silently reverted a deliberate refactor.

**Take the pointer form — but PROVE the lesson survived before you do.** Audit distinctive phrases
across *both* files, not by eyeballing the hunk: grep each side's commit hashes (`22eaff5`,
`b4620a5`), its governing question (`MISDESCRIBE THE COMMIT'S CONTENTS`) and its principle
(`a commit body that lies is worse`) and require every one to resolve somewhere in the **merged
tree**. Then union the genuinely branch-exclusive bullet (`main`'s `test-results/` one) back in.
Net: 3 + 3 conflicting bullets → 4 kept, zero lessons dropped, refactor preserved.

Generalises: **a union is over LESSONS, not over LINES.** When one side moved content into a new
file that arrives with the same merge, the merged tree is the unit to audit — never the hunk.

### Proving "no force-push" from the push output itself

`git push` prints the ref update in a notation that already answers it:
`49dfd70..8bf43ac  main -> main` — **two dots and no leading `+` is a fast-forward.** A forced
update prints `+ 49dfd70...8bf43ac (forced update)`, three dots and a `+`. Quote that line in the
report and corroborate with `git merge-base --is-ancestor <old-main-tip> <new-main-tip>`.

**`git status -sb` prints a bare `## main` on this repo** — local `main` has **no upstream tracking
configured** (`git config --get branch.main.merge` is empty), so the usual `## main...origin/main`
"no ahead/behind" proof is simply unavailable. It is pre-existing, not damage. Prove remote sync
with `git ls-remote origin refs/heads/main` instead — full SHA straight from origin, no local ref
cache in the way.

### `TABLE_PLAYGROUND` — verified live at promotion time, not taken on the brief's word

`vercel env ls production` (CLI is installed and authenticated here) listed **nine** production
variables — `TRELLO_BOARD_ID`, `TRELLO_TOKEN`, `TRELLO_API_KEY`, `SYNC_WORKER_URL`,
`SYNC_KICK_SECRET`, `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`NEXT_PUBLIC_SUPABASE_URL` — and **no `TABLE_PLAYGROUND`**, so `/dev/table-playground` is dark on the
live site under both locks. The "nothing in the repo can prove it" caveat above is now obsolete:
**one command proves it.** Re-run it on any promotion that ships a env-gated route.

### The TRIVIAL promotion shape, and the one command that proves it up front

When the brief says *"branch was fast-forwarded to `main` before the work, so expect trivial"*,
**verify it in one line instead of trusting it**: `git merge-base main <branch>` equal to
`git rev-parse main` means the branch tip's only ancestor-gap is its own new commits, so the
`--no-ff` merge cannot conflict. Corroborate with `git merge-tree --write-tree main <branch>`
(exit 0 = clean) BEFORE `git checkout main` — it is a pure index-level test, touches no working
tree, and needs no stash. Confirmed 2026-08-21 (`ccbff91` → merge `36bc677`, the shared Year +
Month period filter): merge-base == `main` tip == `74db0d5`, merge-tree exit 0, merge produced
zero conflicts exactly as predicted.

Two things worth re-confirming on that same promotion, both already documented above and both
still true: the dirty standing-exclusion paths (`.claude/agent-memory-local/**`,
`supabase/.temp/cli-latest`) had **identical blobs at both tips** (`git diff --stat main <branch>
-- <paths>` empty), so `git checkout main` carried the uncommitted edits across untouched —
`shasum -a 256 -c` passed on all three afterwards and `git stash list` stayed empty. And a brief
that supplies exact gate NUMBERS (`verify-table-core` 78, `verify-rc-in-grid` 33) is worth re-running
on the MERGED tree specifically: matching counts prove the merge added nothing and dropped nothing.

### Promotion 56 (2026-08-25, `2e99253` → merge `7edd55b`) — BUG-027, and the gate numbers earned their keep

`feat/sync-rc-in-recovery` → `main` directly, `--no-ff`, no `dev`, no PR. The TRIVIAL shape again
and predicted by the brief: `git rev-list --left-right --count main...HEAD` read `0 0` before the
commit (branch tip WAS `main` at `d63fdbb`, which also equalled `origin/main`), merge-base tree
diff empty, `git merge-tree --write-tree --name-only main <branch>` a bare OID at exit 0. Merge
clean, post-merge `git diff --stat main <branch>` empty.

- **Standing exclusions held for the twenty-somethingth time**: `.claude/agent-memory-local/`
  (2 files, unstage the DIRECTORY) + `supabase/.temp/cli-latest`. Identical blobs at both tips,
  so `git checkout main` and back carried them untouched — `shasum -a 256` matched afterwards,
  `git stash list` empty. The brief said "standing exclusions" without naming them, which is now
  the normal phrasing; no argument, one report bullet.
- **A brief supplying gate COUNTS is a real check, not decoration.** This one said `verify-findings`
  **54** (was 51). Re-run on the MERGED tree it printed exactly `All 54 findings checks passed`,
  and three of the new lines were visibly the BUG-027 ones (`batch_location_conflict:` headline /
  raw refusal in data / fingerprint IS the durable case fingerprint). Matching counts prove the
  merge added nothing and dropped nothing — cheaper and stronger than reading a diff. Worker
  `npm run typecheck` exit 0 on the same tree.
- **`workers/sync/**` was in the promoted range — 15 files** (`git diff --name-only <old-main>..<merge>
  -- 'workers/sync/**'`). Report that as a POSITIVE fact when the brief says a Fly deploy follows;
  see [[deploy-targets]]. Pushing `main` shipped the app half only.
- **zsh trap, again:** `npm run typecheck 2>&1 | tail` then `${PIPESTATUS[0]}` printed EMPTY here.
  Use `cmd > /tmp/x.log 2>&1; echo $?` when the exit code is the thing you are reporting.
- **cwd quirk confirmed:** this session launched from `workers/sync`, so a bare `npm run typecheck`
  IS the worker's. Anything root-level (`npx tsx scripts/verify-findings.ts`) needs an explicit
  `cd /Users/renzosy/blackwood` in the same command — Bash-tool cwd resets between calls.
