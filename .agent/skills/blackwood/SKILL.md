# Blackwood Architecture Skill

## Core Concept
Blackwood is an industrial inventory system that uses "Separate Inputs" (RC IN/OUT) but a "Unified State" (Batches). The UI must feel like a high-performance spreadsheet (Excel).

## The Rules (Database & Logic)
1. **The Math is in the DB**: Never calculate weighted averages in JS/Typescript. Let the PostgreSQL Trigger `fn_update_blackwood_state` handle it.
2. **Text-Based Linking**: Link `deliveries` to `batches` via `batch_code` (Text).
3. **WHSE Formula**: "WHSE" is derived from "BLOCK LOC". 
   - Starts with "F" -> "FEED"
   - Starts with "A" -> "WHSE A" (etc).

## UI & Spreadsheet Standards
1. **Bulk Input Table**: Dynamic grid (add/remove rows).
2. **No Spinners**: CSS must hide up/down arrows on number inputs.
3. **Master Log**: Support inline editing and deletion (triggering DB recalcs).
4. **Column Order (Exact Match)**: 
   - DATE | WHSE | SUPPLIER | BLOCK | BLOCK LOC | TRK | SKS | WT 
   - MC | ASH | ASTM | JIS | GRIT | VM | FC (Lab Results)
   - PHP/KG | PHP TTL | REMARKS

## Git Workflow & Branch Hierarchy
1. **Production (`main`)**: 
   - The "Golden Copy". 
   - **RULE:** NEVER commit directly to `main`.
2. **Beta (`dev`)**: 
   - The integration branch. 
   - **RULE:** Merge features here for testing.
3. **Feature Branches (`feat/name`)**: 
   - **RULE:** ALWAYS create a new branch for every task (e.g., `git checkout -b feat/fix-columns`).
   - Work here -> Commit here -> Merge to `dev`.
   