---
name: commit-message-fidelity
description: How much a supplied commit message may be changed — the three decided cases (excluded-path claim, internal inconsistency, over-budget subject) and the question that separates them
metadata:
  type: feedback
---

Briefs on this repo often supply the commit message. The rule is **fidelity by default**, and the
question that decides every case is: **"does the message MISDESCRIBE THE COMMIT'S CONTENTS?"**
If yes, fix the minimum and lead the report with it. If no, ship as given and flag anything odd.

**Why:** a commit body that lies is worse than a body that deviates from the brief — the message is
the permanent record and the brief is not. But silently "improving" a message the orchestrator wrote
deliberately destroys information it may have meant to convey.

**How to apply:** three cases are decided. All three are from `feat/universal-table`, 2026-08-17.

1. **A VERBATIM message that claims an EXCLUDED path → amend that ONE body line.** Never the
   subject, never the trailer, never the exclusion itself. (`22eaff5`) The supplied body said
   *"agent memory updates from the perf-reviewer and supabase-backend-engineer runs"*, but
   supabase-backend-engineer's memory lives in `.claude/agent-memory-local/` — see
   [[staging-exclusions]]. Committing it breaks the exclusion; shipping it makes the commit describe
   files it does not contain. Rewrite the bullet to name **only what shipped plus why the rest did
   not**. This is the *misdescribes-contents* case.

2. **An INTERNAL INCONSISTENCY in the supplied message ships VERBATIM and is FLAGGED.** (`b4620a5`)
   The subject said *"three dangerous grid defects"* while its own body said *"Four findings"* and
   enumerated BUG-022/023/024/025. Tempting one-word fix — and wrong: there is a coherent reading
   (three grid defects plus a fourth, authorization, defect), and nothing about the count was false
   *about what shipped*. Report it, let the orchestrator decide.

3. **A subject the brief SUGGESTED rather than dictated, over the 72-char budget → TRIM it.**
   (`058682d`) The brief said *"subject along the lines of `docs(table): hand off Stage 1D slices 1
   and 2, and the draw-identity decision`"* — 76 chars. **"Along the lines of" is latitude, not a
   verbatim message**, so the ≤72 rule wins; `slices 1-2` in place of `slices 1 and 2` landed it at
   exactly 72 with every content word intact. Trim the phrasing, never drop a subject's meaning, and
   no report flag is needed — this is not a deviation, it is the house style being applied. Contrast
   case 2: that subject was *supplied*, this one was *suggested*.

**Mechanics, always:** write the message to a scratchpad file and `git commit -F <file>` — the
backtick trap in [[gates-and-shell-traps]] mangles `-m` prose silently. Then verify the body
survived and that `git log -1 --format='%(trailers)'` prints the trailer.
