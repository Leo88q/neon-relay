#ifndef NEONRELAY_GAME_IDENTITY_H
#define NEONRELAY_GAME_IDENTITY_H

#include "match_signer.h"

namespace neonrelay {

// Trusted server-side context, NOT a network DTO. An authenticated account
// adapter must populate this after wallet/session binding and explicit consent.
// ClientName, connection slot, IP, chat text and RCON claims are NOT identities.
struct AuthenticatedGameIdentity
{
	std::string Domain;
	std::string PlayerId;
	std::string Wallet;
	std::string SessionId;
	std::string WalletBindingId;
	int64_t AuthenticationExpiresAt = 0;
	bool ExplicitLinkConfirmed = false;
};

bool IsGameIdentityContextValid(const AuthenticatedGameIdentity &Identity, int64_t Now);

// Exact backend-issued JSON bytes are signed only if they equal the canonical
// challenge constructed from trusted context and bounded nonce/time inputs.
// Caller must use a dedicated identity key, not the match-event signing key.
// Empty output means reject. No network handler or account authentication here.
std::string SignGameIdentityChallenge(const MatchSigner &Signer,
	const AuthenticatedGameIdentity &Identity, const std::string &Nonce,
	int64_t IssuedAt, int64_t ExpiresAt, const std::string &ChallengeBytes, int64_t Now);

} // namespace neonrelay

#endif // NEONRELAY_GAME_IDENTITY_H
