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
