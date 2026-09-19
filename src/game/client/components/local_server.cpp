#include "local_server.h"

#include <base/fs.h>
#include <base/hash_ctxt.h>
#include <base/io.h>
#include <base/log.h>
#include <base/net.h>
#include <base/mem.h>
#include <base/secure.h>
#include <base/str.h>

#include <engine/map.h>
#include <engine/storage.h>

#include <game/client/gameclient.h>
#include <game/client/practice_course.h>
#include <game/localization.h>

#if defined(CONF_PLATFORM_ANDROID)
#include <android/android_main.h>
#else
#include <base/process.h>
#endif

bool CLocalServer::RunServer(const std::vector<const char *> &vpArguments)
{
	secure_random_password(m_aRconPassword, sizeof(m_aRconPassword), 16);
	char aAuthCommand[64 + sizeof(m_aRconPassword)];
	str_format(aAuthCommand, sizeof(aAuthCommand), "auth_add %s admin %s", DEFAULT_SAVED_RCON_USER, m_aRconPassword);

	std::vector<const char *> vpArgumentsWithAuth = vpArguments;
	vpArgumentsWithAuth.push_back(aAuthCommand);

#if defined(CONF_PLATFORM_ANDROID)
	if(StartAndroidServer(vpArgumentsWithAuth.data(), vpArgumentsWithAuth.size()))
	{
		GameClient()->m_Menus.ForceRefreshLanPage();
		return true;
	}
	else
	{
		Client()->AddWarning(SWarning(Localize("Server could not be started. Make sure to grant the notification permission in the app settings so the server can run in the background.")));
		mem_zero(m_aRconPassword, sizeof(m_aRconPassword));
		return false;
	}
#else
	char aBuf[IO_MAX_PATH_LENGTH];
	Storage()->GetBinaryPath(PLAT_SERVER_EXEC, aBuf, sizeof(aBuf));
#if defined(CONF_PLATFORM_MACOS)
	if(!fs_is_file(aBuf) && fs_parent_dir(aBuf) == 0)
	{
		str_append(aBuf, "/../../../neonrelay-server.app/Contents/MacOS/");
		str_append(aBuf, PLAT_SERVER_EXEC);
	}
#endif
	// No / in binary path means to search in $PATH, so it is expected that the file can't be opened. Just try executing anyway.
	if(str_find(aBuf, "/") == nullptr || fs_is_file(aBuf))
	{
		m_Process = process_execute(aBuf, EShellExecuteWindowState::BACKGROUND, vpArgumentsWithAuth.data(), vpArgumentsWithAuth.size());
		if(m_Process != INVALID_PROCESS)
		{
			GameClient()->m_Menus.ForceRefreshLanPage();
			return true;
		}
		else
		{
			Client()->AddWarning(SWarning(Localize("Server could not be started")));
			mem_zero(m_aRconPassword, sizeof(m_aRconPassword));
			return false;
		}
	}
	else
	{
		Client()->AddWarning(SWarning(Localize("Server executable not found, can't run server")));
		mem_zero(m_aRconPassword, sizeof(m_aRconPassword));
		return false;
	}
#endif
}

void CLocalServer::KillServer()
{
	m_WarmupServer = false;
	m_WarmupPending = false;
#if defined(CONF_PLATFORM_ANDROID)
	ExecuteAndroidServerCommand("shutdown");
	GameClient()->m_Menus.ForceRefreshLanPage();
#else
	if(m_Process != INVALID_PROCESS && process_kill(m_Process))
	{
		m_Process = INVALID_PROCESS;
		GameClient()->m_Menus.ForceRefreshLanPage();
	}
#endif
	mem_zero(m_aRconPassword, sizeof(m_aRconPassword));
}

bool CLocalServer::IsServerRunning()
{
#if defined(CONF_PLATFORM_ANDROID)
	return IsAndroidServerRunning();
#else
	if(m_Process != INVALID_PROCESS && !process_is_alive(m_Process))
	{
		KillServer();
	}
	return m_Process != INVALID_PROCESS;
#endif
}

void CLocalServer::RconAuthIfPossible()
{
	if(!IsServerRunning() ||
		m_aRconPassword[0] == '\0' ||
		!net_addr_is_local(&Client()->ServerAddress()))
	{
		return;
	}
	Client()->RconAuth(DEFAULT_SAVED_RCON_USER, m_aRconPassword, g_Config.m_ClDummy);
}

namespace
{
bool IsWarmupDigest(SHA256_DIGEST Digest)
{
	SHA256_DIGEST Expected{};
	return sha256_from_str(&Expected, WARMUP_MAP_SHA256) == 0 && Digest == Expected;
}
}

bool CLocalServer::IsWarmupRunning()
{
	return IsServerRunning() && m_WarmupServer;
}

bool CLocalServer::StartWarmup()
{
	if(Client()->State() != IClient::STATE_OFFLINE || IsServerRunning())
	{
		Client()->AddWarning(SWarning(Localize("Disconnect and stop the existing local server before starting Warmup.")));
		return false;
	}
	IOHANDLE File = Storage()->OpenFile(WARMUP_MAP_PATH, IOFLAG_READ, IStorage::TYPE_ALL);
	bool MapValid = false;
	if(File)
	{
		SHA256_CTX Hash;
		sha256_init(&Hash);
		unsigned char aBuffer[4096];
		unsigned Read;
		while((Read = io_read(File, aBuffer, sizeof(aBuffer))) != 0)
			sha256_update(&Hash, aBuffer, Read);
		MapValid = !io_error(File) && IsWarmupDigest(sha256_finish(&Hash));
		io_close(File);
	}
	if(!MapValid)
	{
		Client()->AddWarning(SWarning(Localize("Warmup map is missing or outdated. Update the game data.")));
		return false;
	}
	// Do not accidentally join an unrelated server already using this port.
	NETADDR Address{};
	Address.type = NETTYPE_IPV4;
	Address.ip[0] = 127;
	Address.ip[3] = 1;
	Address.port = WARMUP_PORT;
	NETSOCKET Probe = net_udp_create(Address);
	if(!Probe)
	{
		Client()->AddWarning(SWarning(Localize("Warmup port 8305 is busy. Stop that server or use the server browser.")));
		return false;
	}
	net_udp_close(Probe);
	char aMap[192], aPort[32], aAddress[64], aPassword[32], aPasswordCommand[64];
	str_format(aMap, sizeof(aMap), "sv_map \"%s\"", WARMUP_MAP_NAME);
	str_format(aPort, sizeof(aPort), "sv_port %d", WARMUP_PORT);
	str_format(aAddress, sizeof(aAddress), "127.0.0.1:%d", WARMUP_PORT);
	secure_random_password(aPassword, sizeof(aPassword), 16);
	str_format(aPasswordCommand, sizeof(aPasswordCommand), "password %s", aPassword);
	const bool Started = RunServer({"bindaddr 127.0.0.1", aPort, "sv_register 0",
		"sv_sixup 0", "sv_dnsbl 0", "sv_test_cmds 0", "sv_practice_by_default 0",
		"sv_neonrelay_signing 0", "sv_neonrelay_reward_per_match_micro 0",
		"sv_use_sql 0", "sv_sqlite_file warmup-practice.sqlite", aPasswordCommand,
		"sv_name \"Neon Relay - Warmup practice\"", aMap});
	if(Started)
	{
		m_WarmupServer = true;
		Client()->Connect(aAddress, aPassword);
		// Connect first clears the previous connection and its pending state.
		m_WarmupPending = true;
	}
	mem_zero(aPassword, sizeof(aPassword));
	mem_zero(aPasswordCommand, sizeof(aPasswordCommand));
	return Started;
}

void CLocalServer::StopWarmup()
{
	if(Client()->State() != IClient::STATE_OFFLINE)
	{
		Client()->AddWarning(SWarning(Localize("Disconnect before stopping the practice server.")));
		return;
	}
	if(IsWarmupRunning())
		KillServer();
}

bool CLocalServer::ValidateWarmupConnection()
{
	if(!m_WarmupPending)
		return true;
	m_WarmupPending = false;
	if(!IsWarmupRunning() || str_comp(GameClient()->Map()->BaseName(), WARMUP_MAP_NAME) != 0 ||
		!IsWarmupDigest(GameClient()->Map()->Sha256()))
	{
		Client()->Disconnect();
		if(IsWarmupRunning())
			KillServer();
		Client()->AddWarning(SWarning(Localize("Practice connection rejected: the expected Warmup map was not loaded.")));
		return false;
	}
	log_info("practice", "verified course=%s map=%s", WARMUP_COURSE_ID, WARMUP_MAP_NAME);
	return true;
}
