#include "game_pairing_protocol.h"
#include <base/hash_ctxt.h>
#include <engine/external/json-parser/json.h>
#include <memory>

namespace neonrelay {
namespace {
bool HexNonce(const std::string &Value)
{
	return Value.size() == 64 && Value.find_first_not_of("0123456789abcdef") == std::string::npos;
}
const json_value *Field(const json_value *pRoot, const char *pName)
{
	const json_value *pResult = nullptr;
	for(unsigned i = 0; i < pRoot->u.object.length; ++i)
	{
		const auto &Entry = pRoot->u.object.values[i];
		if(std::string(Entry.name, Entry.name_length) == pName)
		{
			if(pResult) return nullptr;
			pResult = Entry.value;
		}
	}
	return pResult;
}
bool Text(const json_value *pRoot, const char *pName, std::string &Result)
{
	const auto *p = Field(pRoot, pName);
	if(!p || p->type != json_string || p->u.string.length > 512) return false;
	Result.assign(p->u.string.ptr, p->u.string.length);
	return true;
}
} // namespace
bool IsPairingOrigin(const std::string &Origin)
{
	if(Origin.size() > 220 || Origin.compare(0, 8, "https://") != 0) return false;
	const auto Authority = Origin.substr(8);
	const auto Colon = Authority.find(':');
	const auto Host = Authority.substr(0, Colon);
	if(Host.empty() || Host.front() == '.' || Host.back() == '.' || Host.find("..") != std::string::npos ||
		Host.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-") != std::string::npos) return false;
	if(Colon != std::string::npos)
	{
		const auto Port = Authority.substr(Colon + 1);
		if(Port.empty() || Port.size() > 5 || Port.find_first_not_of("0123456789") != std::string::npos) return false;
		const int Number = std::stoi(Port);
		if(Number < 1 || Number > 65535) return false;
	}
	return true;
}
std::string PairingRequestJson(const MatchSigner &Signer, const std::string &Domain,
	const std::string &ConnectionNonce, const std::string &Token)
{
	const std::string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	if(!Signer.Ready() || Domain.empty() || Domain.size() > 253 || !HexNonce(ConnectionNonce) || Token.size() != 43 ||
		Token.find_first_not_of(Alphabet) != std::string::npos || Alphabet.find(Token.back()) % 4 != 0) return {};
	SHA256_CTX Hash;
	sha256_init(&Hash);
	sha256_update(&Hash, Token.data(), Token.size());
	const auto Digest = sha256_finish(&Hash);
	std::string Hex;
	for(unsigned char Byte : Digest.data)
	{
		Hex += "0123456789abcdef"[Byte >> 4];
		Hex += "0123456789abcdef"[Byte & 15];
	}
	const std::string Payload = "{\"v\":1,\"purpose\":\"neonrelay-game-pairing\",\"domain\":\"" + JsonEscape(Domain) +
		"\",\"token_hash\":\"" + Hex + "\",\"connection_nonce\":\"" + ConnectionNonce + "\"}";
	return "{\"pairing_token\":\"" + Token + "\",\"connection_nonce\":\"" + ConnectionNonce +
		"\",\"signature\":\"" + Signer.Sign(Payload) + "\"}";
}
bool ParsePairingResponse(const std::string &Json, AuthenticatedGameIdentity &Context, std::string &ConnectionNonce, int64_t Now)
{
	Context = {}; ConnectionNonce.clear();
	if(Json.empty() || Json.size() > 4096) return false;
	json_settings Settings{}; Settings.max_memory = 16384;
	std::unique_ptr<json_value, decltype(&json_value_free)> Root(json_parse_ex(&Settings, Json.data(), Json.size(), nullptr), json_value_free);
	if(!Root || Root->type != json_object || Root->u.object.length != 9) return false;
	AuthenticatedGameIdentity Parsed;
	std::string Nonce;
	if(!Text(Root.get(), "domain", Parsed.Domain) || !Text(Root.get(), "player_id", Parsed.PlayerId) ||
		!Text(Root.get(), "wallet", Parsed.Wallet) || !Text(Root.get(), "session_id", Parsed.SessionId) ||
		!Text(Root.get(), "wallet_binding_id", Parsed.WalletBindingId) || !Text(Root.get(), "connection_nonce", Nonce) || !HexNonce(Nonce)) return false;
	const auto *pExpiry = Field(Root.get(), "authentication_expires_at");
	const auto *pConsent = Field(Root.get(), "explicit_link_confirmed");
	const auto *pAdmission = Field(Root.get(), "admissionEnabled");
	if(!pExpiry || pExpiry->type != json_integer || !pConsent || pConsent->type != json_boolean || !pConsent->u.boolean ||
		!pAdmission || pAdmission->type != json_boolean || pAdmission->u.boolean) return false;
	Parsed.AuthenticationExpiresAt = pExpiry->u.integer;
	Parsed.ExplicitLinkConfirmed = true;
	if(!IsGameIdentityContextValid(Parsed, Now)) return false;
	Context = Parsed; ConnectionNonce = Nonce;
	return true;
}
} // namespace neonrelay
