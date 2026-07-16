-- Widen block_loc and location_ref CHECK constraints to accept PCA/PCB prefixes.
-- PCA/PCB are physical subdivisions of the A-row 15-17 area used for prepared charcoal sundrying.
-- New pattern: ^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$

-- batches.location_ref
ALTER TABLE batches
  DROP CONSTRAINT IF EXISTS chk_location_ref_format;

ALTER TABLE batches
  ADD CONSTRAINT chk_location_ref_format
  CHECK (
    location_ref = ''
    OR location_ref ~ '^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$'
  );

-- deliveries.block_loc
ALTER TABLE deliveries
  DROP CONSTRAINT IF EXISTS chk_block_loc_format;

ALTER TABLE deliveries
  ADD CONSTRAINT chk_block_loc_format
  CHECK (
    block_loc IS NULL
    OR block_loc ~ '^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$'
  );
