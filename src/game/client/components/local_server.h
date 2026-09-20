#ifndef GAME_CLIENT_COMPONENTS_LOCAL_SERVER_H
#define GAME_CLIENT_COMPONENTS_LOCAL_SERVER_H

#include <base/types.h>

#include <engine/shared/config.h>

#include <game/client/component.h>

class CLocalServer : public CComponentInterfaces
{
public:
	bool RunServer(const std::vector<const char *> &vpArguments);
	void KillServer();
	bool StartWarmup();
	bool IsWarmupRunning();
	void StopWarmup();
	bool ValidateWarmupConnection();
	void CancelWarmupConnection() { m_WarmupPending = false; }
	bool IsServerRunning();
	void RconAuthIfPossible();

private:
	bool m_WarmupServer = false;
	bool m_WarmupPending = false;
	char m_aRconPassword[sizeof(g_Config.m_SvRconPassword)] = "";

#if !defined(CONF_PLATFORM_ANDROID)
	PROCESS m_Process = INVALID_PROCESS;
#endif
};

#endif
