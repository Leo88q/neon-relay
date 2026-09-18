#include "game_pairing_seal.h"
#include <array>
#if defined(CONF_OPENSSL)
#include <openssl/evp.h>
#include <openssl/kdf.h>
#include <openssl/crypto.h>
#endif
namespace neonrelay {
struct GamePairingSeal::Impl
{
	std::string Offer, Signature;
	int64_t Issued = 0, Expires = 0;
	unsigned Attempts = 0;
#if defined(CONF_OPENSSL)
	EVP_PKEY *Key = nullptr;
	~Impl() { EVP_PKEY_free(Key); }
#endif
};
GamePairingSeal::GamePairingSeal() : m_pImpl(std::make_unique<Impl>()) {}
GamePairingSeal::~GamePairingSeal() = default;
const std::string &GamePairingSeal::Offer() const { return m_pImpl->Offer; }
const std::string &GamePairingSeal::Signature() const { return m_pImpl->Signature; }
#if defined(CONF_OPENSSL)
namespace {
std::string Hex(const unsigned char *Data, size_t Size)
{
	std::string Out;
	for(size_t i = 0; i < Size; ++i) { Out += "0123456789abcdef"[Data[i] >> 4]; Out += "0123456789abcdef"[Data[i] & 15]; }
	return Out;
}
template<size_t N> bool Decode(const std::string &Hex, std::array<unsigned char, N> &Out)
{
	if(Hex.size() != N * 2 || Hex.find_first_not_of("0123456789abcdef") != std::string::npos) return false;
	const std::string Alphabet = "0123456789abcdef";
	for(size_t i = 0; i < N; ++i) Out[i] = (Alphabet.find(Hex[i * 2]) << 4) | Alphabet.find(Hex[i * 2 + 1]);
	return true;
}
struct Secret
{
	std::array<unsigned char, 32> Data{};
	~Secret() { OPENSSL_cleanse(Data.data(), Data.size()); }
};
}
#endif
bool GamePairingSeal::Begin(const MatchSigner &Signer, const std::string &Domain, const std::string &Nonce, int64_t Now)
{
	m_pImpl = std::make_unique<Impl>();
#if defined(CONF_OPENSSL)
	if(!Signer.Ready() || Domain.empty() || Domain.size() > 253 || Nonce.size() != 64 ||
		Nonce.find_first_not_of("0123456789abcdef") != std::string::npos || Now < 0 || Now > 9007199254620991LL) return false;
	for(unsigned char c : Domain) if(c < 32 || c == 127) return false;
	std::unique_ptr<EVP_PKEY_CTX, decltype(&EVP_PKEY_CTX_free)> Gen(EVP_PKEY_CTX_new_id(EVP_PKEY_X25519, nullptr), EVP_PKEY_CTX_free);
	if(!Gen || EVP_PKEY_keygen_init(Gen.get()) != 1 || EVP_PKEY_keygen(Gen.get(), &m_pImpl->Key) != 1) return false;
	std::array<unsigned char, 32> Public; size_t Length = Public.size();
	if(EVP_PKEY_get_raw_public_key(m_pImpl->Key, Public.data(), &Length) != 1 || Length != 32) return false;
	m_pImpl->Issued = Now; m_pImpl->Expires = Now + 120000;
	m_pImpl->Offer = "{\"v\":1,\"purpose\":\"neonrelay-game-pairing-seal\",\"domain\":\"" + JsonEscape(Domain) +
		"\",\"connection_nonce\":\"" + Nonce + "\",\"server_ephemeral_key\":\"" + Hex(Public.data(), Public.size()) +
		"\",\"issued_at\":" + std::to_string(Now) + ",\"expires_at\":" + std::to_string(Now + 120000) + "}";
	m_pImpl->Signature = Signer.Sign(m_pImpl->Offer);
	return !m_pImpl->Signature.empty();
#else
	(void)Signer; (void)Domain; (void)Nonce; (void)Now;
	return false;
#endif
}
std::string GamePairingSeal::Open(const std::string &SenderKey, const std::string &Iv,
	const std::string &Ciphertext, const std::string &Tag, int64_t Now)
{
#if defined(CONF_OPENSSL)
	auto &State = *m_pImpl;
	if(!State.Key) return {};
	if(Now < State.Issued || Now >= State.Expires || State.Attempts++ >= 8)
	{
		EVP_PKEY_free(State.Key); State.Key = nullptr; return {};
	}
	std::array<unsigned char, 32> PeerBytes;
	std::array<unsigned char, 12> Nonce;
	std::array<unsigned char, 43> Encrypted;
	std::array<unsigned char, 16> AuthTag;
	if(!Decode(SenderKey, PeerBytes) || !Decode(Iv, Nonce) || !Decode(Ciphertext, Encrypted) || !Decode(Tag, AuthTag)) return {};
	std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> Peer(EVP_PKEY_new_raw_public_key(EVP_PKEY_X25519, nullptr, PeerBytes.data(), 32), EVP_PKEY_free);
	std::unique_ptr<EVP_PKEY_CTX, decltype(&EVP_PKEY_CTX_free)> Dh(EVP_PKEY_CTX_new(State.Key, nullptr), EVP_PKEY_CTX_free);
	Secret Shared, Key;
	size_t Length = 32;
	if(!Peer || !Dh || EVP_PKEY_derive_init(Dh.get()) != 1 || EVP_PKEY_derive_set_peer(Dh.get(), Peer.get()) != 1 ||
		EVP_PKEY_derive(Dh.get(), Shared.Data.data(), &Length) != 1 || Length != 32) return {};
	std::array<unsigned char, 32> Salt; unsigned SaltSize = 0;
	if(EVP_Digest(State.Offer.data(), State.Offer.size(), Salt.data(), &SaltSize, EVP_sha256(), nullptr) != 1 || SaltSize != 32) return {};
	std::unique_ptr<EVP_PKEY_CTX, decltype(&EVP_PKEY_CTX_free)> Kdf(EVP_PKEY_CTX_new_id(EVP_PKEY_HKDF, nullptr), EVP_PKEY_CTX_free);
	const std::string Info = "neonrelay:game-pairing-seal:v1";
	Length = 32;
	if(!Kdf || EVP_PKEY_derive_init(Kdf.get()) != 1 || EVP_PKEY_CTX_set_hkdf_md(Kdf.get(), EVP_sha256()) != 1 ||
		EVP_PKEY_CTX_set1_hkdf_salt(Kdf.get(), Salt.data(), Salt.size()) != 1 ||
		EVP_PKEY_CTX_set1_hkdf_key(Kdf.get(), Shared.Data.data(), 32) != 1 ||
		EVP_PKEY_CTX_add1_hkdf_info(Kdf.get(), reinterpret_cast<const unsigned char *>(Info.data()), Info.size()) != 1 ||
		EVP_PKEY_derive(Kdf.get(), Key.Data.data(), &Length) != 1 || Length != 32) return {};
	std::unique_ptr<EVP_CIPHER_CTX, decltype(&EVP_CIPHER_CTX_free)> Cipher(EVP_CIPHER_CTX_new(), EVP_CIPHER_CTX_free);
	std::array<unsigned char, 64> Plain{};
	int Written = 0, Final = 0;
	bool Ok = Cipher && EVP_DecryptInit_ex(Cipher.get(), EVP_aes_256_gcm(), nullptr, Key.Data.data(), Nonce.data()) == 1 &&
		EVP_DecryptUpdate(Cipher.get(), nullptr, &Written, reinterpret_cast<const unsigned char *>(State.Offer.data()), State.Offer.size()) == 1 &&
		EVP_DecryptUpdate(Cipher.get(), Plain.data(), &Written, Encrypted.data(), Encrypted.size()) == 1 && Written == 43 &&
		EVP_CIPHER_CTX_ctrl(Cipher.get(), EVP_CTRL_GCM_SET_TAG, 16, AuthTag.data()) == 1 &&
		EVP_DecryptFinal_ex(Cipher.get(), Plain.data() + Written, &Final) == 1 && Final == 0;
	std::string Token;
	if(Ok) Token.assign(reinterpret_cast<char *>(Plain.data()), 43);
	OPENSSL_cleanse(Plain.data(), Plain.size());
	if(Ok) { EVP_PKEY_free(State.Key); State.Key = nullptr; }
	return Token;
#else
	(void)SenderKey; (void)Iv; (void)Ciphertext; (void)Tag; (void)Now;
	return {};
#endif
}
} // namespace neonrelay
