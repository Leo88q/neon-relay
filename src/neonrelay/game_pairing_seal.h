#ifndef NEONRELAY_GAME_PAIRING_SEAL_H
#define NEONRELAY_GAME_PAIRING_SEAL_H
#include "match_signer.h"
#include <memory>
namespace neonrelay {
// One ephemeral X25519 key per offer. Own alongside the original connection;
// destroy on disconnect. No plaintext fallback when OpenSSL is unavailable.
class GamePairingSeal
{
public:
	GamePairingSeal();
	~GamePairingSeal();
	GamePairingSeal(const GamePairingSeal &) = delete;
	GamePairingSeal &operator=(const GamePairingSeal &) = delete;
	bool Begin(const MatchSigner &Signer, const std::string &Domain, const std::string &Nonce, int64_t Now);
	const std::string &Offer() const;
	const std::string &Signature() const;
	// Empty on tampering, expiry or replay. Successful decryption destroys key.
	std::string OpenEnvelope(const std::string &Json, int64_t Now);
private:
	std::string Decrypt(const std::string &SenderKey, const std::string &Iv,
		const std::string &Ciphertext, const std::string &Tag);
	struct Impl;
	std::unique_ptr<Impl> m_pImpl;
};
} // namespace neonrelay
#endif // NEONRELAY_GAME_PAIRING_SEAL_H
