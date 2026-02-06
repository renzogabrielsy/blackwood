# Blackwood Architecture Skill

## Core Concept
Blackwood is an inventory system that uses "Separate Inputs" (RC IN/OUT) but a "Unified State" (Batches).

## The Rules
1. **The Math is in the DB**: Never calculate weighted averages in JS/Typescript. Just insert into `deliveries` and let the Trigger `fn_update_blackwood_state` handle it.
2. **The Snapshot is Automatic**: When inserting into `usage`, the DB will auto-fill `snapshot_price`. Do not send this from the client.
3. **Status Logic**:
   - `STORED`: New batch.
   - `IN-USE`: Usage has started.
   - `CLOSED`: Explicitly closed via "CLOSED" keyword in remarks.
   - `FEED`: Specialized feed stock.

## Git Workflow
- Always start a task with `git status`.
- Commit format: `feat(scope): message`.