#include "wallet_bridge.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <mutex>

namespace {

std::mutex s_mutex;
NeonRelayWalletInfo s_info = {};
NeonRelayWalletListener s_listener = nullptr;
void *s_listener_user = nullptr;

/* Extract a JSON string field ("key": "value") without pulling a parser into
 * the hot path. Returns false when the key is absent. Escapes other than \"
 * and \\ are not produced by the Kotlin side. */
bool JsonString(const char *json, const char *key, char *dst, size_t dst_size)
{
	if(!json || !key || !dst || dst_size == 0)
		return false;
	char needle[64];
	if(std::strlen(key) + 4 > sizeof(needle))
		return false;
	std::snprintf(needle, sizeof(needle), "\"%s\"", key);
	const char *at = std::strstr(json, needle);
	if(!at)
		return false;
	at = std::strchr(at + std::strlen(needle), ':');
	if(!at)
		return false;
	at = std::strchr(at, '"');
	if(!at)
		return false;
	++at;
	size_t i = 0;
	for(; at[i] != '\0' && at[i] != '"'; ++i)
	{
		char c = at[i];
		if(c == '\\' && at[i + 1])
		{
			++i;
			c = at[i] == 'n' ? '\n' : at[i];
		}
		if(i >= dst_size - 1)
			break;
		dst[i] = c;
	}
	if(i > dst_size - 1)
		i = dst_size - 1;
	dst[i] = '\0';
	return true;
}

bool JsonBool(const char *json, const char *key, bool fallback)
{
	if(!json || !key)
		return fallback;
	char needle[64];
	if(std::strlen(key) + 4 > sizeof(needle))
		return fallback;
	std::snprintf(needle, sizeof(needle), "\"%s\"", key);
	const char *at = std::strstr(json, needle);
	if(!at)
		return fallback;
	at = std::strchr(at + std::strlen(needle), ':');
	if(!at)
		return fallback;
	while(*at && (*at == ':' || *at == ' '))
		++at;
	return std::strncmp(at, "true", 4) == 0;
}

} // namespace

extern "C" {

void neonrelay_wallet_set_listener(NeonRelayWalletListener listener, void *user)
{
	std::lock_guard<std::mutex> lock(s_mutex);
	s_listener = listener;
	s_listener_user = user;
}

const NeonRelayWalletInfo *neonrelay_wallet_info(void)
{
	return &s_info;
}

void neonrelay_wallet_push_event(int event_type, const char *json)
{
	NeonRelayWalletListener listener = nullptr;
	void *user = nullptr;
	{
		std::lock_guard<std::mutex> lock(s_mutex);
		s_info.account_label[0] = '\0';
		s_info.public_key_base64[0] = '\0';
		s_info.error_message[0] = '\0';
		s_info.connected = 0;
		if(json)
		{
			JsonString(json, "account_label", s_info.account_label, sizeof(s_info.account_label));
			JsonString(json, "public_key_base64", s_info.public_key_base64, sizeof(s_info.public_key_base64));
			JsonString(json, "error_message", s_info.error_message, sizeof(s_info.error_message));
			s_info.connected = JsonBool(json, "connected", false) ? 1 : 0;
		}
		listener = s_listener;
		user = s_listener_user;
	}
	if(listener)
		listener(event_type, &s_info, user);
}

} // extern "C"
