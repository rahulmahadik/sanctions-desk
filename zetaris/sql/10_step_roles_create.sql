-- Optional: one role per review step that reads Zetaris, granted only that step's tables. The users are created
-- and assigned by `npm run zetaris:agents -- --steps --apply`; the existing three identities are not touched.

-- @@ create_role_ownership_agent
CREATE ROLE 'role_ownership_agent' DESCRIBE BY 'Ownership step: the ownership register only'

-- @@ grant_role_ownership_agent_beneficial_owner
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.beneficial_owner TO ROLE 'role_ownership_agent'

-- @@ create_role_critic_agent
CREATE ROLE 'role_critic_agent' DESCRIBE BY 'Critic fact re-read: no identifier tables'

-- @@ grant_role_critic_agent_business_definition
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.business_definition TO ROLE 'role_critic_agent'

-- @@ grant_role_critic_agent_list_entry
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_entry TO ROLE 'role_critic_agent'

-- @@ grant_role_critic_agent_list_alias
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_alias TO ROLE 'role_critic_agent'

-- @@ grant_role_critic_agent_list_dob
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_dob TO ROLE 'role_critic_agent'

-- @@ grant_role_critic_agent_list_country
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_country TO ROLE 'role_critic_agent'

-- @@ grant_role_critic_agent_customer
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.customer TO ROLE 'role_critic_agent'

-- @@ grant_role_critic_agent_beneficial_owner
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.beneficial_owner TO ROLE 'role_critic_agent'

-- @@ grant_role_critic_agent_payment
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.payment TO ROLE 'role_critic_agent'

-- @@ grant_role_critic_agent_alert
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.alert TO ROLE 'role_critic_agent'

-- @@ create_role_memory_agent
CREATE ROLE 'role_memory_agent' DESCRIBE BY 'Memory step: earlier decisions (pointers) only'

-- @@ grant_role_memory_agent_disposition
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.disposition TO ROLE 'role_memory_agent'

-- @@ create_role_document_agent
CREATE ROLE 'role_document_agent' DESCRIBE BY 'Document on record check: customer identifiers only'

-- @@ grant_role_document_agent_customer_identifier
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.customer_identifier TO ROLE 'role_document_agent'

-- @@ create_role_rescreen_agent
CREATE ROLE 'role_rescreen_agent' DESCRIBE BY 'List-change re-check: earlier decisions, list entries, open alerts, pending payments'

-- @@ grant_role_rescreen_agent_disposition
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.disposition TO ROLE 'role_rescreen_agent'

-- @@ grant_role_rescreen_agent_list_entry
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.list_entry TO ROLE 'role_rescreen_agent'

-- @@ grant_role_rescreen_agent_alert
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.alert TO ROLE 'role_rescreen_agent'

-- @@ grant_role_rescreen_agent_payment
GRANT SELECT ON USL TABLE lightning.metastore.sanctions.screening_usl.payment TO ROLE 'role_rescreen_agent'
