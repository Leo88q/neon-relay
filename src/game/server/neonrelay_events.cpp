#include "neonrelay_events.h"

#include <chrono>
#include <fstream>
#include <string>

#include <base/dbg.h>
#include <engine/map.h>
#include <engine/shared/config.h>
#include <engine/shared/uuid_manager.h>
#include <game/server/gamecontext.h>
#include <neonrelay/match_signer.h>

namespace neonrelay {

namespace {
MatchSigner s_Signer;
std::string s_LoadedKeyPath;
bool s_Warned = false;

int64_t NowMillis()
{
	return std::chrono::duration_cast<std::chrono::milliseconds>(
		std::chrono::system_clock::now().time_since_epoch())
		.count();
}
} // namespace

void EmitFinishEvent(CGameContext *pGameServer, int ClientId, int TimeTicks)
{
	if(!g_Config.m_SvNeonrelaySigning)
		return;
	const char *pOut = g_Config.m_SvNeonrelaySigningOutFile;
	const char *pKey = g_Config.m_SvNeonrelaySigningKeyFile;
	if(pOut[0] == '\0' || pKey[0] == '\0')
	{
		if(!s_Warned)
		{
			dbg_msg("neonrelay", "sv_neonrelay_signing is 1 but key/out file is not set; signing stays off");
			s_Warned = true;
		}
		return;
	}
	const std::string keyPath(pKey);
	if(!s_Signer.Ready() || s_LoadedKeyPath != keyPath)
	{
		if(!s_Signer.LoadSeedFile(keyPath))
		{
			if(!s_Warned)
			{
				dbg_msg("neonrelay", "cannot read signing seed from %s; signing stays off", keyPath.c_str());
				s_Warned = true;
			}
			return;
		}
		s_LoadedKeyPath = keyPath;
		dbg_msg("neonrelay", "reward signing enabled, public key %s", s_Signer.PublicKeyBase64Url().c_str());
	}

	char aUuid[64];
	FormatUuid(pGameServer->GameUuid(), aUuid, sizeof(aUuid));
	const std::string matchId = std::string(aUuid) + ":" + pGameServer->Map()->BaseName();
	const std::string playerId = pGameServer->Server()->ClientName(ClientId);
	const int64_t amount = g_Config.m_SvNeonrelayRewardPerMatchMicro;
	const int64_t occurredAt = NowMillis();

	const std::string canonical = CanonicalEventJson(matchId, playerId, "map_finish", amount, occurredAt);
	const std::string signature = s_Signer.Sign(canonical);
	if(signature.empty())
		return;

	std::ofstream out(pOut, std::ios::app);
	if(!out)
	{
		if(!s_Warned)
		{
			dbg_msg("neonrelay", "cannot open %s for appending signed events", pOut);
			s_Warned = true;
		}
		return;
	}
	out << "{\"match_id\":\"" << JsonEscape(matchId)
	    << "\",\"player_id\":\"" << JsonEscape(playerId)
	    << "\",\"event_type\":\"map_finish\""
	    << ",\"amount_micro\":" << amount
	    << ",\"occurred_at\":" << occurredAt
	    << ",\"time_ticks\":" << TimeTicks
	    << ",\"server_signature\":\"" << signature
	    << "\",\"public_key\":\"" << s_Signer.PublicKeyBase64Url() << "\"}\n";
}

} // namespace neonrelay
