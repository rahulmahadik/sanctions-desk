-- Puts each runtime user in its role. The users are created by `npm run zetaris:agents`.

-- @@ assign_agent_evidence
ASSIGN USER 'agent_evidence@sanctions-desk.local' TO ROLE 'role_evidence_agent'

-- @@ assign_agent_reviewer
ASSIGN USER 'agent_reviewer@sanctions-desk.local' TO ROLE 'role_reviewer'

-- @@ assign_agent_eval
ASSIGN USER 'agent_eval@sanctions-desk.local' TO ROLE 'role_eval'
