---
name: gates-and-shell-traps
description: Pre-push verification gates for anything landing on `main` (build, worker tests, parity, lint) plus the zsh/git traps that make a gate silently lie
metadata:
  type: feedback
---

Run the gates BEFORE merging to `main`, and never trust a gate whose exit code you didn't actually capture.

**Why:** `main` deploys straight to the live Vercel URL that Renzo tests on. A broken build there is a production outage, and a gate that *looks* green because the shell swallowed its exit code is worse than no gate.

**How to apply:** every promotion to `main`; run build + tests backgrounded in parallel while preparing the commit.

## The gates

- **`npm run build` from the repo root** — always. **Exit code 0 is the gate.**
- **`cd workers/sync && npm test`** — baseline grew 540 → 586 → 612 → 636 → 647 → 674 → **708 passing / 47 files, ~9s** (2026-08-07). Take the expected count from the task prompt; it is usually stated. Skip when nothing under `workers/sync/` is touched and the prompt scopes it out.
- **When `workers/sync/**` IS touched, `npm test` + `npm run parity` are the RIGHT cheap subset** — ~2 min for both, and they exercise exactly the code that changed. Prefer them over a fresh 8-min root `npm run build` when the brief already reports the build green (promotion 40: both matched the brief's numbers exactly, alongside `tsc --noEmit` 0).
- **`cd workers/sync && npm run parity`** when the sync worker is touched — expect "parity clean", 12 cases (deliveries 2 / flecon 3 / gsheet 2 / production 2 / rc_movement_audit 1 / rc_out 2).
- **Scoped lint:** `npx eslint <touched files>` exits **0 on warnings-only, 1 on any error**, so the plain exit code IS the "0 errors" gate — no `--max-warnings` needed. Still read the log to report the warning count (2026-08-03: 9 cenapro ledger files, exit 0, 7 warnings all pre-existing in `production-ledger-grid.tsx`).

- **`npm run build` in the repo root is the WRONG gate when another session shares the tree** — its untracked files follow every `git checkout` and get compiled. Build a detached `git worktree` of the merge commit instead; full recipe (incl. the Turbopack symlinked-`node_modules` panic) in [[concurrent-session-promotions]].
- **A red build is not automatically yours.** Judge by "no errors outside <the other session's dir>". 2026-08-04 `npx tsc --noEmit` exited 2 with exactly one error, in `app/(app)/cenapro/deliveries/actions.ts:140` — not ours, not to be fixed, not a blocker. **That error is GONE as of promotion 23** (same day, `tsc --noEmit` exit 0) — the other session finished and shipped it. Don't carry the expectation forward; a red tsc on that file now IS worth a second look.
- **`npx tsc --noEmit` is the cheap stand-in when a brief pre-ran the build.** ~1 min vs ~8, and it catches the class of error a type-heavy TSX changeset actually risks. Used on promotion 23 (`9ee70d5`): brief reported `npm run build` exit 0, so the build was waived per [[main-promotion-playbook]] but tsc was re-run independently. Same for the repo's `scripts/verify-*.ts` — seconds each, and they re-confirm the brief's assertion counts firsthand.

**The "Compiled successfully" string is unreliable in BOTH directions.** Some runs print it (2026-07-30 "✓ Compiled successfully in 17.0s"; 2026-08-04 "✓ Compiled successfully in 7.4s"), some don't. Verify via **exit code 0 + the emitted route manifest**, never the string.

## SHELL TRAP — `${PIPESTATUS[0]}` is silently EMPTY in zsh

Bit me twice in one run (2026-07-30): `VERIFY_EXIT=` and `ESLINT_EXIT=` both came back blank, which *reads* like a pass but proves nothing. zsh's array is `$pipestatus` (lowercase, **1-indexed**); `${PIPESTATUS[0]}` is a bash-ism.

**An empty `EXIT=` is a FAILED verification, not a green one — re-run it.**

- **Preferred fix — don't pipe a gate at all.** Redirect, capture plain `$?`, then read the log:
  `cmd > /path/log 2>&1; echo "EXIT=$?"` then read the log separately.
- When you must keep the pipe, `${pipestatus[1]}` IS reliable (confirmed 2026-08-03 and 2026-08-04 on `git push … | tail -5`).
- The background-task output file only holds the echoed exit code, **not** the command's stdout — always capture builds to your own log file if you need to grep them.

## GIT TRAP — `git rev-parse --short` takes ONE revision, and fails like a broken repo

2026-08-06 (promotion 38): `git rev-parse --short HEAD main origin/main origin/<feat>` — the
obvious way to prove every ref agrees after a promotion — exits **128** with
`fatal: Needed a single revision`. Reproduced at 2 refs and 3 refs. **`--short` is
single-revision only**; every ref was perfectly healthy.

The danger is the wording: "Needed a single revision" reads like a missing/corrupt branch at
exactly the moment you are verifying a production push, and invites a false alarm in the report.

- **Loop instead:** `for r in HEAD main origin/main origin/<feat>; do printf '%-40s ' "$r"; git rev-parse --short "$r"; done`
- **Best final proof is the remote itself:** `git ls-remote origin main refs/heads/<feat>` — full
  SHAs straight from origin, no local ref cache involved. Compare the first 7 chars to your commits.

## SHELL TRAP — you cannot grep for a NUL byte via an argv pattern

2026-08-05: `grep -qU $'\x00' "$f"` flagged **all 20 staged files** as containing NUL. It is a false positive with no exceptions — NUL terminates a C string, so the pattern reaches grep as the EMPTY string, which matches every line of every file. A scan that flags 100% of its inputs is broken, not alarming.

- **Cheapest real check: git already did it.** `git diff --staged --numstat` prints `-` in the add/del columns for a binary (NUL-containing) file. All-numeric columns = all text. One command, no extra tooling.
- **Direct check when you need per-file certainty:** `perl -0777 -ne 'exit(1) if /\x00/' "$f"` — slurps the whole file, exit 1 = NUL found.
- General rule: **any scan whose hit-rate is ~100% is a bug in the scan.** Re-derive before reporting it as a finding.

## Route-table gate for route-group moves

A move like `app/(app)/x/` → `app/(app)/x/(group)/` is supposed to leave URLs unchanged, and a silently-swallowed route still compiles. Grep the build log's emitted route manifest for the specific entries (2026-07-30 confirmed `ƒ /production` + `ƒ /production/schedule`; 2026-08-04 confirmed `ƒ /cenapro/qc` + `ƒ /cenapro/qc/breakdown`). A green build alone is not the gate.

## Rename detection is a DISPLAY-time heuristic

Git does not store renames — never promise "git recorded it as a rename" without checking `git diff --cached --stat`. A moved file that is ALSO edited can fall below the 50% similarity floor and show as add+delete; that is cosmetic, content is identical either way. Tiny files are the trap: a 5-line `page.tsx` with a changed import + new comment header scored under 30% and never paired, while its 3 lightly-edited siblings paired at 100%/65%. Test with `git diff --cached --stat -M30%` before reporting.

## "Files were deleted" often means UNTRACKED scratch that never entered git

2026-08-01 a brief said five files were "deleted" and asked me to confirm they staged as deletions; they had only ever existed as `??` untracked files in the same session, so `git diff --staged --diff-filter=D --name-only` was correctly empty. Nothing was wrong — but "no deletions staged" looks like a `git add` failure if you don't check. Two cheap proofs: `git log --all --oneline -- <path>` (empty = never tracked) and `git ls-tree -r HEAD --name-only | grep <path>`. Report it as "never tracked, nothing removed from history," not as a staging miss.
