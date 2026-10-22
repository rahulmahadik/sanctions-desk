-- Roles and table-level grants for the three runtime identities. Users are created in the Zetaris UI and
-- assigned to these roles afterwards (see the setup guide); the admin key is never used at runtime.

-- @@ create_role_evidence_agent
CREATE ROLE 'role_evidence_agent' DESCRIBE BY 'Evidence and reasoning agents, identifiers are masked'

-- @@ create_role_reviewer
CREATE ROLE 'role_reviewer' DESCRIBE BY 'Human reviewers, full values'

-- @@ create_role_eval
CREATE ROLE 'role_eval' DESCRIBE BY 'Evaluation runs, read-only'

-- @@ grant_role_evidence_agent_list_entry
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_entry TO ROLE 'role_evidence_agent'

-- @@ grant_role_evidence_agent_list_alias
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_alias TO ROLE 'role_evidence_agent'

-- @@ grant_role_evidence_agent_list_dob
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_dob TO ROLE 'role_evidence_agent'

-- @@ grant_role_evidence_agent_list_country
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_country TO ROLE 'role_evidence_agent'

-- @@ grant_role_evidence_agent_list_identifier
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_identifier TO ROLE 'role_evidence_agent'

-- @@ grant_role_evidence_agent_customer
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.customer TO ROLE 'role_evidence_agent'

-- @@ grant_role_evidence_agent_customer_identifier
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.customer_identifier TO ROLE 'role_evidence_agent'

-- @@ grant_role_evidence_agent_alert
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.alert TO ROLE 'role_evidence_agent'

-- @@ grant_role_reviewer_list_entry
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_entry TO ROLE 'role_reviewer'

-- @@ grant_role_reviewer_list_alias
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_alias TO ROLE 'role_reviewer'

-- @@ grant_role_reviewer_list_dob
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_dob TO ROLE 'role_reviewer'

-- @@ grant_role_reviewer_list_country
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_country TO ROLE 'role_reviewer'

-- @@ grant_role_reviewer_list_identifier
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_identifier TO ROLE 'role_reviewer'

-- @@ grant_role_reviewer_customer
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.customer TO ROLE 'role_reviewer'

-- @@ grant_role_reviewer_customer_identifier
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.customer_identifier TO ROLE 'role_reviewer'

-- @@ grant_role_reviewer_alert
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.alert TO ROLE 'role_reviewer'

-- @@ grant_role_eval_list_entry
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_entry TO ROLE 'role_eval'

-- @@ grant_role_eval_list_alias
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_alias TO ROLE 'role_eval'

-- @@ grant_role_eval_list_dob
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_dob TO ROLE 'role_eval'

-- @@ grant_role_eval_list_country
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_country TO ROLE 'role_eval'

-- @@ grant_role_eval_list_identifier
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_identifier TO ROLE 'role_eval'

-- @@ grant_role_eval_customer
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.customer TO ROLE 'role_eval'

-- @@ grant_role_eval_customer_identifier
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.customer_identifier TO ROLE 'role_eval'

-- @@ grant_role_eval_alert
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.alert TO ROLE 'role_eval'

-- @@ grant_role_evidence_agent_business_definition
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.business_definition TO ROLE 'role_evidence_agent'

-- @@ grant_role_reviewer_business_definition
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.business_definition TO ROLE 'role_reviewer'

-- @@ grant_role_eval_business_definition
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.business_definition TO ROLE 'role_eval'
