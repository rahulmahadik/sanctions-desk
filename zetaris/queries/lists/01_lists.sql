-- Source: public sanctions lists (OFAC and UN sample), file-store tables.
-- Read only. Run: npm run zetaris:queries -- lists

-- Question: how much does the list source hold, and who is on it?
-- @@ lists_entries_by_list
SELECT list_id, party_kind, COUNT(*) AS n FROM sanctions_lists.list_entry GROUP BY list_id, party_kind ORDER BY list_id, party_kind

-- Question: how many aliases does the most-aliased listed party have (why name matching alone is weak)?
-- @@ lists_most_aliases
SELECT e.entry_id, e.primary_name, COUNT(*) AS aliases FROM sanctions_lists.list_entry e JOIN sanctions_lists.list_alias a ON a.entry_id = e.entry_id GROUP BY e.entry_id, e.primary_name ORDER BY aliases DESC LIMIT 3

-- Question: which approved definitions are in force, and in which version?
-- @@ lists_definitions
SELECT definition_id, version, status FROM sanctions_lists.business_definition ORDER BY definition_id, version
