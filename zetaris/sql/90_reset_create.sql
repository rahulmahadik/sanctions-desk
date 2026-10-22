-- Removes only the objects created by the sanctions desk scripts, so the setup can be rebuilt from scratch:
-- the screening model, and the two sanctions_* file-store databases. Nothing else is touched.
-- Rebuild order: zetaris:load-files, 90_reset, 01_sources, 02_usl, 03_access.

-- @@ remove_model
REMOVE USL screening_usl NAMESPACE lightning.metastore.sanctions

-- @@ drop_lists
DROP LIGHTNING DATABASE sanctions_lists

-- @@ drop_bank
DROP LIGHTNING DATABASE sanctions_bank_files
