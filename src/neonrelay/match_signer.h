// Neon Relay match-event signer (stage 8).
//
// Produces the Ed25519 signatures that the reward backend verifies
// (docs/REWARD_SECURITY.md §2). The signed bytes are the canonical JSON of
// {match_id, player_id, event_type, amount_micro, occurred_at} - byte-identical
// to backend/src/rewards.ts canonicalEventBytes().
//
// Key handling: the seed (32 bytes) is read from a file whose path comes from
// sv_neonrelay_signing_key_file; it is never logged, never sent anywhere and
// never embedded in a binary. The module is inert unless explicitly enabled.
//
#ifndef NEONRELAY_MATCH_SIGNER_H
#define NEONRELAY_MATCH_SIGNER_H

#include <cstddef>
#include <cstdint>
#include <string>

namespace neonrelay {

std::string Base64UrlEncode(const unsigned char *data, size_t len);

/* Escaping with the semantics of JavaScript JSON.stringify (the backend
 * serializes with JSON.stringify, so both sides must agree). */
std::string JsonEscape(const std::string &value);

/* Canonical event payload: fixed key order, no insignificant whitespace. */
std::string CanonicalEventJson(const std::string &match_id, const std::string &player_id,
	const std::string &event_type, int64_t amount_micro, int64_t occurred_at);

class MatchSigner
{
public:
	bool LoadSeedHex(const std::string &hex64);
	bool LoadSeedFile(const std::string &path);
	bool Ready() const { return m_Ready; }
	std::string PublicKeyBase64Url() const;
	/* base64url(ed25519(message)) */
	std::string Sign(const std::string &message) const;
	std::string SignEvent(const std::string &match_id, const std::string &player_id,
		const std::string &event_type, int64_t amount_micro, int64_t occurred_at) const;

private:
	unsigned char m_aSeed[32] = {0};
	unsigned char m_aPublic[32] = {0};
	bool m_Ready = false;
};

} // namespace neonrelay

#endif // NEONRELAY_MATCH_SIGNER_H
