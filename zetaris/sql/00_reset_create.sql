-- Removes only the objects created by these scripts, so the setup can be rebuilt from scratch: the screening
-- model, the sanctions_* databases and the bank database registration. Nothing else is touched.

-- @@ uncache_payments
UNCACHE TABLE sanctions_payments.payments_raw

-- @@ drop_role_evidence_agent
DROP ROLE 'role_evidence_agent'

-- @@ drop_role_reviewer
DROP ROLE 'role_reviewer'

-- @@ drop_role_eval
DROP ROLE 'role_eval'

-- @@ remove_model
REMOVE USL screening_usl NAMESPACE lightning.metastore.sanctions

-- @@ drop_lists
DROP LIGHTNING DATABASE sanctions_lists

-- @@ drop_bank_files
DROP LIGHTNING DATABASE sanctions_bank_files

-- @@ drop_payments
DROP LIGHTNING DATABASE sanctions_payments

-- @@ drop_bankdb
DROP DATASOURCE sanctions_bankdb
