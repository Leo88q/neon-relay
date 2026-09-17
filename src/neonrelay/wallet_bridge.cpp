#include "wallet_bridge.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <mutex>

#include <base/detect.h>

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
		s_info.requesting = 0;
		listener = s_listener;
		user = s_listener_user;
	}
	if(listener)
		listener(event_type, &s_info, user);
}

#if !defined(CONF_PLATFORM_ANDROID)
/* Non-Android stub: wallets are only wired up in the Solana Mobile build
 * (android/app/.../wallet/). Report it as a user-safe error event so the
 * in-game Wallet page can explain the situation instead of hanging. */
void neonrelay_wallet_platform_request(int connect)
{
	(void)connect;
	neonrelay_wallet_push_event(NEONRELAY_WALLET_EVENT_ERROR,
		"{\"connected\": false, \"error_message\": \"Wallet connection is only available in the Neon Relay Android build.\"}");
}

void neonrelay_wallet_platform_economy(const char *json)
{
	(void)json;
	neonrelay_wallet_push_event(NEONRELAY_WALLET_EVENT_ECONOMY,
		"{\"connected\": false, \"error_message\": \"SKR entry payments and prize claims run in the Neon Relay Android build (Mobile Wallet Adapter); see docs/PLAY_ECONOMY.md.\"}");
}
#endif

static void RequestWallet(int connect)
{
	{
		std::lock_guard<std::mutex> lock(s_mutex);
		s_info.requesting = 1;
		s_info.error_message[0] = '\0';
	}
	neonrelay_wallet_platform_request(connect);
}

void neonrelay_wallet_request_connect(void)
{
	RequestWallet(1);
}

void neonrelay_wallet_request_disconnect(void)
{
	RequestWallet(0);
}

void neonrelay_wallet_request_economy(const char *json)
{
	neonrelay_wallet_platform_economy(json ? json : "{}");
}

} // extern "C"
