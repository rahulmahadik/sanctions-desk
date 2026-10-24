-- Rollback of 10_step_roles_create.sql: the step users first, then their roles. The three original identities stay.

-- @@ drop_agent_ownership
DROP USER 'agent_ownership@sanctions-desk.local'

-- @@ drop_agent_critic
DROP USER 'agent_critic@sanctions-desk.local'

-- @@ drop_agent_memory
DROP USER 'agent_memory@sanctions-desk.local'

-- @@ drop_agent_document
DROP USER 'agent_document@sanctions-desk.local'

-- @@ drop_agent_rescreen
DROP USER 'agent_rescreen@sanctions-desk.local'

-- @@ drop_role_ownership_agent
DROP ROLE 'role_ownership_agent'

-- @@ drop_role_critic_agent
DROP ROLE 'role_critic_agent'

-- @@ drop_role_memory_agent
DROP ROLE 'role_memory_agent'

-- @@ drop_role_document_agent
DROP ROLE 'role_document_agent'

-- @@ drop_role_rescreen_agent
DROP ROLE 'role_rescreen_agent'
