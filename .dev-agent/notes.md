# Dev Agent Notes

- 2026-09-09T00:38:47Z — Fixed social relay inbox structural mismatch by wrapping sanitized relay messages in colony_message_v1 customer_request envelopes; collectResults now enforces task/goal/assigned sender and assigned-running status. Focused tests added; native better-sqlite3 prevented runtime test execution in this checkout. Artifact: output/fix-critical-social-orchestration.zip
