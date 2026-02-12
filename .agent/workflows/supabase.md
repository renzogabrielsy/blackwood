---
description: How to use Supabase CLI for database operations (migrations, type generation, schema inspection)
---

## Prerequisites
- Supabase CLI installed (`brew install supabase/tap/supabase`)
- Logged in (`supabase login`)
- Project linked (`supabase link --project-ref taadqhgdsmxvkhhniwgm`)

## Generate TypeScript Types
Regenerate after any schema change:
// turbo
```bash
supabase gen types typescript --linked > types/supabase.ts
```
**Never hand-edit `types/supabase.ts`** — always regenerate.

## Create a Migration
```bash
supabase migration new <migration_name>
```
This creates `supabase/migrations/<timestamp>_<migration_name>.sql`. Write your SQL in that file.

## Push Migrations to Remote
```bash
supabase db push
```
Applies all pending local migrations to the remote Supabase project.

## Pull Remote Schema
```bash
supabase db pull
```
Pulls the current remote schema into a local migration file. Useful for syncing after dashboard changes.

## Diff Schema Changes
```bash
supabase db diff
```
Shows SQL diff between local migrations and remote schema.

## Inspect Database
```bash
supabase inspect db table-sizes --linked
supabase inspect db index-usage --linked
supabase inspect db unused-indexes --linked
```

## List Migrations
// turbo
```bash
supabase migration list --linked
```
