-- SW-2026-AGI (threat 74): authenticate agent memory. Every watchtower_events
-- row is an agent-readable memory record; a direct DB write, a restored
-- backup or any out-of-band editor must be detectable by the exporter before
-- the record reaches a downstream LLM. `memory_mac` is an HMAC-SHA256 (hex)
-- over all stored columns, keyed by NEONRELAY_WATCHTOWER_MEMORY_KEY.
-- NULL = row written before this change (reported as `unsigned`, not
-- `tampered`, because absence of a MAC is not evidence of tampering).
ALTER TABLE watchtower_events ADD COLUMN memory_mac TEXT;
