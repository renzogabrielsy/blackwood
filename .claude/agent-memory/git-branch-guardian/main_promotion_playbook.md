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
promotion recipe, no `dev`, no PR. Latest promotion off it: `a86643a` (2026-08-05, #36).

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
