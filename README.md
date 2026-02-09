# Blackwood

A comprehensive logistics and inventory management system built with Next.js and Supabase.

## Functionality Overview

### 1. RC IN Module (`/rc-in`)
The **RC IN** (Raw Coconut Inbound) module manages the delivery and quality control of incoming shipments.

**Key Features:**
*   **Bulk Delivery Input**:
    *   Efficient data entry table for logging deliveries.
    *   **Flat & Strict Data Structure**: Ensuring compatibility with CSV/Spreadsheet logic.
    *   **Dynamic Calculations**:
        *   `WHSE` (Warehouse) is auto-calculated based on `Block Loc`.
        *   `PHP TTL` (Total Price) calculated real-time (`Weight * Price`).
    *   **Fields**: State, Date, Supplier, Block, Truck, Weight, Sacks, and comprehensive Lab Results (MC, Ash, BD ASTM, BD JIS, Grit, VM, FC).
*   **Delivery Master Table**:
    *   Live view of all historical deliveries.
    *   Matches the strict column order of the input.
    *   Displays individual lab statistics.
    *   Supports **Edit** and **Delete** actions for data correction.

### 2. Data Management Scripts
Automation scripts for system administration and setup.

*   **RC IN Seeder** (`scripts/seed_rc_in.ts`):
    *   Robust seeding script compatible with legacy data CSVs (`260209_rc_in_samples.csv`).
    *   **Advanced Logic**:
        *   Automatically upserts **Batches** (Blocks) if they don't exist.
        *   Converts **Excel Serial Dates** to PostgreSQL timestamps.
        *   Safe parsing handling BOM and quoted CSV fields without external dependencies.

## Tech Stack
*   **Framework**: Next.js 16 (App Router)
*   **Database**: Supabase (PostgreSQL)
*   **Styling**: Tailwind CSS
*   **UI Components**: Shadcn UI (Radix Primitives)
*   **Language**: TypeScript

## Getting Started

First, run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.
