#ifndef NEONRELAY_GAME_PAIRING_PROTOCOL_H
#define NEONRELAY_GAME_PAIRING_PROTOCOL_H
#include "game_identity.h"

namespace neonrelay {
struct PairingEnvelope
{
	std::string SenderKey, Iv, Ciphertext, Tag;
	int64_t ExpiresAt = 0;
};
// Fixed schema, canonical lowercase hex, at most 768 bytes and 8 KiB parser allocation.
bool ParsePairingEnvelope(const std::string &Json, PairingEnvelope &Envelope, int64_t Now);
bool IsPairingOrigin(const std::string &Origin);
std::string PairingRequestJson(const MatchSigner &Signer, const std::string &Domain,
	const std::string &ConnectionNonce, const std::string &Token);
bool ParsePairingResponse(const std::string &Json, AuthenticatedGameIdentity &Context, std::string &ConnectionNonce, int64_t Now);
} // namespace neonrelay
#endif // NEONRELAY_GAME_PAIRING_PROTOCOL_H
