-- PROPOSAL, not supported by Zetaris today. Access control declared inside the USL definition, so that a rebuild
-- of the model re-creates it. Read by the mock: npm run usl:policy
-- Names are the ones this project uses (roles, users, the id_number column, the desk column).

CREATE ROLE role_evidence_agent DESCRIBE BY 'Evidence and reasoning agents, identifiers masked';
CREATE ROLE role_reviewer DESCRIBE BY 'Human reviewers, full values';
CREATE ROLE role_desk_emea DESCRIBE BY 'Reviewers who see the EMEA desk only';

-- Agent users with a scoped token: read only, limited to one role, expires.
CREATE USER agent_evidence ROLE role_evidence_agent TOKEN SCOPE READ_ONLY EXPIRES 90 DAYS;
CREATE USER agent_reviewer ROLE role_reviewer TOKEN SCOPE READ_ONLY EXPIRES 90 DAYS;

-- Table grants, declared once.
GRANT SELECT ON ALL TABLES TO ROLE role_evidence_agent;
GRANT SELECT ON ALL TABLES TO ROLE role_reviewer;
GRANT SELECT ON TABLE customer TO ROLE role_desk_emea;

-- Regex masking on a column: keep the last two characters, replace the rest.
ALTER TABLE customer_identifier MASK COLUMN id_number REGEX '.(?=.{2})' REPLACE '*' FOR ROLE role_evidence_agent;

-- Row filter: this role sees only matching rows, in SQL and in the API.
ALTER TABLE customer ROW FILTER FOR ROLE role_desk_emea WHERE desk = 'EMEA';
