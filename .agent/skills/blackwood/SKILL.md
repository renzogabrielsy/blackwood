# Blackwood Architecture Skill

## Core Concept
Blackwood is an industrial inventory system that uses "Separate Inputs" (RC IN/OUT) but a "Unified State" (Batches). The UI must feel like a high-performance spreadsheet (Excel).

## The Rules (Database & Logic)
1. **The Math is in the DB**: Never calculate weighted averages in JS/Typescript. Let the PostgreSQL Trigger `fn_update_blackwood_state` handle it.
2. **Text-Based Linking**: Link `deliveries` to `batches` via `batch_code` (Text).
3. **WHSE Formula**: "WHSE" is derived from "BLOCK LOC". 
   - Starts with "F" -> "FEED"
   - Starts with "A" -> "WHSE A" (etc).
   - **Rule**: Do not change this parsing logic.

## RC OUT Schema (Inventory Depletion)
1. **Strict Column Order**:
   - DATE | BATCH | BLOCK | WT | PLANT/ETC
   - REMARKS | BLOCK LOC | AVG PRICE | AVG WTD VALUE
2. **Logic & Constraints**:
   - **BATCH**: Explicit input (e.g., "OCTOBER"). Required for future Production/Sundry tracking.
   - **PLANT/ETC**: Defines the workflow loop ("MAIN" vs "SUNDRY").
   - **AVG PRICE / VALUE**: Read-only columns. Calculated via Weighted Average from `RC IN`.

## The "State" Feedback Loop
The `RC IN` "Status" is no longer just manual; it is derived from `RC OUT` activity.
1. **STORED**: Default state upon entry in `RC IN`.
2. **IN-USE**: If `RC OUT` has a record for this Block with `Weight > 0`.
3. **CLOSED**: If `RC OUT` has a record with `REMARKS` containing "CLOSED".
4. **FEED**: Derived from Block Name containing "FEED".

## The "Sundry" Workflow (Circular Logic)
1. **MAIN**: Inventory leaves the system (Production/Exit).
2. **SUNDRY**: Inventory is removed for drying/re-packing.
   - **Architectural Rule**: Items marked "SUNDRY" in `RC OUT` physically leave the block but **must re-enter** `RC IN` as a new Block Entry (Recycled Inventory).

## The "Blocking" View (Inventory Snapshot)
1. **Purpose**: Aggregated view of "Current Stock".
2. **Formula**: `SUM(RC IN Weight) - SUM(RC OUT Weight)` per `BLOCK LOC`.
3. **Calculated Columns**:
   - BALANCE (Kg)
   - Weighted Avg: Price, MC, ASH, BD.

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
   