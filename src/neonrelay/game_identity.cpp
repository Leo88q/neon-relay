#include "game_identity.h"

namespace neonrelay {
namespace {
bool SafeText(const std::string &Text, size_t Max)
{
	if(Text.empty() || Text.size() > Max)
		return false;
	for(unsigned char c : Text)
		if(c < 32 || c == 127)
			return false;
	return true;
}
bool Canonical32(const std::string &Text)
{
	const std::string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	if(Text.size() != 43)
		return false;
	for(char c : Text)
		if(Alphabet.find(c) == std::string::npos)
			return false;
	return Alphabet.find(Text.back()) % 4 == 0;
}
bool Uuid(const std::string &Text)
{
	if(Text.size() != 36)
		return false;
	for(size_t i = 0; i < Text.size(); ++i)
	{
		if(i == 8 || i == 13 || i == 18 || i == 23)
		{
			if(Text[i] != '-')
				return false;
		}
		else if(!((Text[i] >= '0' && Text[i] <= '9') || (Text[i] >= 'a' && Text[i] <= 'f')))
			return false;
	}
	return true;
}
} // namespace

bool IsGameIdentityContextValid(const AuthenticatedGameIdentity &Identity, int64_t Now)
{
	return Now >= 0 && Now <= 9007199254740991LL && Identity.ExplicitLinkConfirmed &&
		Identity.AuthenticationExpiresAt > Now && Identity.AuthenticationExpiresAt <= 9007199254740991LL &&
		SafeText(Identity.Domain, 253) && SafeText(Identity.PlayerId, 512) &&
		Canonical32(Identity.Wallet) && Uuid(Identity.SessionId) && Uuid(Identity.WalletBindingId);
}

std::string SignGameIdentityChallenge(const MatchSigner &Signer,
	const AuthenticatedGameIdentity &Identity, const std::string &Nonce,
	int64_t IssuedAt, int64_t ExpiresAt, const std::string &ChallengeBytes, int64_t Now)
{
	constexpr int64_t MaxSafeInteger = 9007199254740991LL;
	if(!Signer.Ready() || !IsGameIdentityContextValid(Identity, Now) ||
		Now < 0 || Now > MaxSafeInteger || IssuedAt < 0 || IssuedAt > Now ||
		ExpiresAt <= Now || ExpiresAt > MaxSafeInteger || ExpiresAt - IssuedAt > 120000 ||
		Identity.AuthenticationExpiresAt <= Now || Identity.AuthenticationExpiresAt > MaxSafeInteger ||
		!SafeText(Identity.Domain, 253) || !SafeText(Identity.PlayerId, 512) ||
		!Canonical32(Identity.Wallet) || !Canonical32(Nonce) ||
		!Uuid(Identity.SessionId) || !Uuid(Identity.WalletBindingId) || ChallengeBytes.size() > 4096)
		return {};
	const std::string Expected = "{\"v\":1,\"purpose\":\"neonrelay-game-identity\",\"domain\":\"" + JsonEscape(Identity.Domain) +
		"\",\"nonce\":\"" + Nonce + "\",\"session_id\":\"" + Identity.SessionId +
		"\",\"wallet_binding_id\":\"" + Identity.WalletBindingId + "\",\"wallet\":\"" + Identity.Wallet +
		"\",\"player_id\":\"" + JsonEscape(Identity.PlayerId) + "\",\"signer\":\"" + Signer.PublicKeyBase64Url() +
		"\",\"issued_at\":" + std::to_string(IssuedAt) + ",\"expires_at\":" + std::to_string(ExpiresAt) + "}";
	if(ChallengeBytes != Expected)
		return {};
	return Signer.Sign(ChallengeBytes);
}
} // namespace neonrelay
