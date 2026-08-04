---
name: concurrent-session-promotions
description: Promoting to `main` while ANOTHER Claude session is editing the same working tree — the selective-staging override to Renzo's `git add .` rule, and the clean-worktree build gate that untracked files otherwise defeat
metadata:
  type: feedback
---

Sometimes a second Claude session is editing `/Users/renzosy/blackwood` **while** you promote.
Its work is in the tree, in progress, and often does not compile. Two standing habits break
in exactly this case.

**Why:** 2026-08-04 (promotion `478b0c0`). A prior promotion's `git add .` swept two of the
other session's files onto `main` and risked breaking the production build. The brief that
followed opened with "⚠ CRITICAL — DO NOT `git add .` THIS TIME" and listed five exact paths.

**How to apply:** whenever a brief names an exact staging list, or `git status` shows source
files nobody mentioned changing under your feet.

**This is now a STANDING mode, not a one-off** — three consecutive promotions (`478b0c0`,
`0be5b4a`, and the one between them) ran under it on 2026-08-04, each brief re-stating the
constraint. When `app/(app)/cenapro/deliveries/**` + the `20260804*` migrations are sitting
untracked, assume selective staging even before the brief says so, and confirm.

### Is the other session actually LIVE right now? Check mtimes, don't guess

`find /Users/renzosy/blackwood -newermt '-20 minutes' -type f -not -path '*/.git/*' -not -path
'*/node_modules/*' -not -path '*/.next/*'` — **empty output means no session is writing**, so the
dirty tree is inert leftovers and a plain `git add .` is safe. Verified 2026-08-04 on promotion
`c8ffc53`: the brief warned about the earlier collision, but nothing had been touched in 20
minutes and `git status` showed only the brief's own paths. `ls -lT` on the dirty dir corroborates
(newest guardian-memory mtime was 90 minutes old).

This is the cheap decider the [[main-promotion-playbook]]'s "concurrent-session mode can be OFF —
verify, don't assume" note was missing. Run it BEFORE choosing a staging strategy.

### Guardian memory left dirty by a PREVIOUS (finished) guardian session

`.claude/agent-memory/git-branch-guardian/*.md` can sit uncommitted for hours because the session
that wrote it promoted and exited without committing its own notes. Once the mtime check says
nobody is live, **commit it — but in its own `chore(memory):` commit**, never folded into the
brief's feature commit (that would make the `feat(...)` subject a lie). Pathspec recipe in
[[feedback-commit-splitting]]. Leaving it dirty is what makes the NEXT session waste a gate
deciding whether it is someone's in-flight work.

## 1. The `git add .` rule IS overridden — by an explicit path list

[[staging-exclusions]] says always `git add .`. **A brief that enumerates the exact paths to
stage overrides it**, and this is the one override to honour rather than fold back. It is not
the "incidental, include it" phrasing that must be resisted — it is a specific, reasoned
instruction with a named blast radius (production build breakage).

- Stage with `git add -A <path>...` — `-A` so a DELETION in the list stages as a deletion
  (`add-draw-panel.tsx` was one). Plain `git add <path>` on a deleted file is a no-op in
  older git.
- Then `git status --short` and read **column 1** (staged) vs column 2 (worktree). Confirm the
  staged set is byte-for-byte the brief's list before committing.
- A file carrying BOTH sessions' edits (`app/(app)/cenapro/CONTEXT.md`) stays uncommitted on
  purpose. Say so in the commit body so the missing doc update reads as deliberate, not lost.

## 1b. A single-markdown promotion needs NO build gate — and the brief may say so

2026-08-04 (`0be5b4a`, one `handoffs/*.md` file): the brief explicitly waived `npm run build`
— "it would fail on the other session's file anyway, and there is nothing here for it to
verify." Honour that. Don't spend a worktree build proving a handoff doc compiles. The
worktree recipe below is for promotions that actually carry code.

## 2. Untracked files FOLLOW the working tree — "build on main" is a lie without a worktree

`git checkout main` does **not** remove the other session's untracked files. They sit on disk
and Next.js compiles them, so an in-place `npm run build` on `main` tests a tree that does not
exist on `main` and will fail on code you must not fix. Never move or stash another live
session's files to work around this.

Build the **committed** tree instead — exactly what Vercel builds:

```
git worktree add "$SCRATCH/mainbuild" <merge-sha> --detach
cp -Rc /Users/renzosy/blackwood/node_modules "$SCRATCH/mainbuild/node_modules"
cp /Users/renzosy/blackwood/.env.local "$SCRATCH/mainbuild/.env.local"
npm --prefix "$SCRATCH/mainbuild" run build      # npm sets cwd to the prefix; no `cd` needed
git worktree remove --force "$SCRATCH/mainbuild"
```

- **`cp -Rc` is an APFS clone** — 653 packages in 12s, zero disk cost. `/private/tmp` and
  `/Users` are both on `/dev/disk3s5`, so clonefile works across them. Verify with `df` if unsure.
- **TURBOPACK TRAP: a symlinked `node_modules` PANICS.** `ln -s` gives
  `TurbopackInternalError: Symlink node_modules is invalid, it points out of the filesystem
  root` — a FATAL panic log, not a build error. It must be physically inside the project root.
  Don't misread this as a code failure; it says nothing about the commit.
- `.env.local` is untracked, so the worktree has none. Copy it or the build runs env-less.
- Proof the worktree is clean: `ls` the module dir and confirm the other session's directory
  is absent, and confirm the emitted route manifest has no route for it.

## 3. Prove you didn't touch their work — mtimes + `git log --all`

Checksum their files BEFORE (`shasum ... > before.sha`) and `shasum -c` after. Expect
**mismatches** — they are actively typing (three files changed and a new `page.tsx` appeared
within 2 minutes, mid-run). A mismatch is NOT evidence you clobbered anything. Prove innocence
positively, since git cannot modify untracked files during checkout/merge anyway:

- `git ls-files --error-unmatch <path>` → "Did you forget to 'git add'?" = still untracked.
- `git log --all --oneline -- <paths>` → **empty = never entered git history on any branch.**
- `ls -lT` mtimes landing inside your run window = an external writer, not you.

Report it as "still present, still untracked, never committed — and being edited live," not as
a clean checksum match you cannot honestly claim.
