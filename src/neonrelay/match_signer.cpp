#include "match_signer.h"

#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>

#include <engine/external/ed25519/ed25519.h>

/* The vendored ed25519-donna is built with ED25519_CUSTOMRANDOM, whose custom
 * header is deliberately empty: Neon Relay never asks the library for random
 * bytes (no key generation here, seeds come from an operator-provided file).
 * The symbol is only referenced by ed25519_sign_open_batch(), which we do not
 * use; provide a deterministic zero filler so the link succeeds. If batch
 * verification is ever added, replace this with a CSPRNG. */
extern "C" void ed25519_randombytes_unsafe(void *out, size_t count)
{
	std::memset(out, 0, count);
}

namespace neonrelay {

static const char BASE64URL_ALPHABET[] =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

std::string Base64UrlEncode(const unsigned char *data, size_t len)
{
	std::string out;
	out.reserve((len + 2) / 3 * 4);
	size_t i = 0;
	while(i + 2 < len)
	{
		unsigned int v = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
		out += BASE64URL_ALPHABET[(v >> 18) & 63];
		out += BASE64URL_ALPHABET[(v >> 12) & 63];
		out += BASE64URL_ALPHABET[(v >> 6) & 63];
		out += BASE64URL_ALPHABET[v & 63];
		i += 3;
	}
	if(i + 1 == len)
	{
		unsigned int v = data[i] << 16;
		out += BASE64URL_ALPHABET[(v >> 18) & 63];
		out += BASE64URL_ALPHABET[(v >> 12) & 63];
	}
	else if(i + 2 == len)
	{
		unsigned int v = (data[i] << 16) | (data[i + 1] << 8);
		out += BASE64URL_ALPHABET[(v >> 18) & 63];
		out += BASE64URL_ALPHABET[(v >> 12) & 63];
		out += BASE64URL_ALPHABET[(v >> 6) & 63];
	}
	return out;
}

std::string JsonEscape(const std::string &value)
{
	std::string out;
	out.reserve(value.size() + 8);
	for(unsigned char c : value)
	{
		switch(c)
		{
		case '"': out += "\\\""; break;
		case '\\': out += "\\\\"; break;
		case '\b': out += "\\b"; break;
		case '\f': out += "\\f"; break;
		case '\n': out += "\\n"; break;
		case '\r': out += "\\r"; break;
		case '\t': out += "\\t"; break;
		default:
			if(c < 0x20)
			{
				char buf[8];
				std::snprintf(buf, sizeof(buf), "\\u%04x", c);
				out += buf;
			}
			else
			{
				out += static_cast<char>(c);
			}
		}
	}
	return out;
}

std::string CanonicalEventJson(const std::string &match_id, const std::string &player_id,
	const std::string &event_type, int64_t amount_micro, int64_t occurred_at)
{
	std::ostringstream os;
	os << "{\"match_id\":\"" << JsonEscape(match_id)
	   << "\",\"player_id\":\"" << JsonEscape(player_id)
	   << "\",\"event_type\":\"" << JsonEscape(event_type)
	   << "\",\"amount_micro\":" << amount_micro
	   << ",\"occurred_at\":" << occurred_at << "}";
	return os.str();
}

static int HexValue(char c)
{
	if(c >= '0' && c <= '9')
		return c - '0';
	if(c >= 'a' && c <= 'f')
		return c - 'a' + 10;
	if(c >= 'A' && c <= 'F')
		return c - 'A' + 10;
	return -1;
}

bool MatchSigner::LoadSeedHex(const std::string &hex64)
{
	if(hex64.size() != 64)
		return false;
	unsigned char seed[32];
	for(int i = 0; i < 32; ++i)
	{
		int hi = HexValue(hex64[2 * i]);
		int lo = HexValue(hex64[2 * i + 1]);
		if(hi < 0 || lo < 0)
			return false;
		seed[i] = static_cast<unsigned char>((hi << 4) | lo);
	}
	std::memcpy(m_aSeed, seed, sizeof(m_aSeed));
	ed25519_publickey(m_aSeed, m_aPublic);
	m_Ready = true;
	return true;
}

bool MatchSigner::LoadSeedFile(const std::string &path)
{
	std::ifstream in(path.c_str(), std::ios::binary);
	if(!in)
		return false;
	std::ostringstream os;
	os << in.rdbuf();
	std::string content = os.str();
	// tolerate a trailing newline / whitespace
	size_t end = content.find_last_not_of(" \t\r\n");
	if(end == std::string::npos)
		return false;
	content = content.substr(0, end + 1);
	return LoadSeedHex(content);
}

std::string MatchSigner::PublicKeyBase64Url() const
{
	if(!m_Ready)
		return std::string();
	return Base64UrlEncode(m_aPublic, sizeof(m_aPublic));
}

std::string MatchSigner::Sign(const std::string &message) const
{
	if(!m_Ready)
		return std::string();
	unsigned char signature[64];
	ed25519_sign(reinterpret_cast<const unsigned char *>(message.data()), message.size(),
		m_aSeed, m_aPublic, signature);
	return Base64UrlEncode(signature, sizeof(signature));
}

std::string MatchSigner::SignEvent(const std::string &match_id, const std::string &player_id,
	const std::string &event_type, int64_t amount_micro, int64_t occurred_at) const
{
	return Sign(CanonicalEventJson(match_id, player_id, event_type, amount_micro, occurred_at));
}

} // namespace neonrelay
