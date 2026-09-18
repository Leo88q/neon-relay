#ifndef NEONRELAY_GAME_PAIRING_PROTOCOL_H
#define NEONRELAY_GAME_PAIRING_PROTOCOL_H
#include "game_identity.h"

namespace neonrelay {
bool IsPairingOrigin(const std::string &Origin);
std::string PairingRequestJson(const MatchSigner &Signer, const std::string &Domain,
	const std::string &ConnectionNonce, const std::string &Token);
bool ParsePairingResponse(const std::string &Json, AuthenticatedGameIdentity &Context, std::string &ConnectionNonce, int64_t Now);
} // namespace neonrelay
#endif // NEONRELAY_GAME_PAIRING_PROTOCOL_H
