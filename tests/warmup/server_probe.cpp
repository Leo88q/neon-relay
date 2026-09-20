// Test-only input driver for the linked server. Never built by default.
// It does not set character positions, velocities, race state or timestamps.
#include <base/log.h>
#include <base/str.h>
#include <engine/server.h>
#include <engine/shared/config.h>
#include <game/collision.h>
#include <game/gamecore.h>
#include <game/mapitems.h>
#include <game/server/entities/character.h>
#include <game/server/gamecontext.h>
#include <game/server/player.h>
#include <game/server/score.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>

namespace
{
struct CProbe
{
	int m_Ticks = 0;
	int m_Target = 0;
	int m_Run = 0;
	int m_Returns = 0;
	int m_Start = -1;
	int m_FirstStart = -1;
	bool m_Respawning = false;
	bool m_Done = false;
	bool m_Failed = false;
	vec2 m_Previous = vec2(0, 0);
};
CProbe s_Probe;

bool Check(CGameContext *pGame, bool Valid, const char *pMessage)
{
	if(!Valid)
	{
		s_Probe.m_Failed = true;
		log_error("warmup-probe", "FAIL: %s", pMessage);
		pGame->Server()->SetErrorShutdown("warmup server probe failed");
	}
	return Valid;
}
}

void WarmupServerProbeTick(CGameContext *pGame)
{
	const char *pEnable = std::getenv("NEONRELAY_WARMUP_PROBE");
	if(!pEnable || str_comp(pEnable, "1") != 0 || s_Probe.m_Failed)
		return;
	if(!Check(pGame, str_comp(g_Config.m_Bindaddr, "127.0.0.1") == 0 &&
		str_comp(g_Config.m_SvRegister, "0") == 0 &&
		str_comp(g_Config.m_SvMap, "Neon Relay Warmup") == 0 &&
		!g_Config.m_SvTestingCommands, "requires private loopback Warmup server with cheats disabled"))
		return;
	if(!pGame->Server()->ClientIngame(0))
		return;
	if(!Check(pGame, str_comp(pGame->Server()->ClientName(0), "WarmupProbe") == 0, "unexpected client"))
		return;
	if(!Check(pGame, ++s_Probe.m_Ticks < 10000, "route timeout"))
		return;
	auto *pCharacter = pGame->GetPlayerChar(0);
	if(!pCharacter)
		return;
	auto Core = pCharacter->GetCore(); // read-only copy, never write back
	if(s_Probe.m_Done)
	{
		CNetObj_PlayerInput Stop{};
		Stop.m_TargetY = -1;
		pGame->OnClientPredictedInput(0, &Stop);
		return;
	}
	if(!Check(pGame, !Core.m_Super && !Core.m_EndlessHook && !Core.m_EndlessJump &&
		g_Config.m_SvSoloServer && float(Core.m_Tuning.m_PlayerCollision) == 0 &&
		float(Core.m_Tuning.m_PlayerHooking) == 0, "normal physics and map solo settings required"))
		return;
	if(s_Probe.m_Respawning)
	{
		if(!Check(pGame, pCharacter->m_DDRaceState == ERaceState::NONE, "respawn must clear race state"))
			return;
		s_Probe.m_Respawning = false;
	}
	if(pCharacter->m_DDRaceState == ERaceState::STARTED && s_Probe.m_Start == -1)
	{
		s_Probe.m_Start = pCharacter->m_StartTime;
		if(s_Probe.m_Run == 0)
			s_Probe.m_FirstStart = s_Probe.m_Start;
		else if(!Check(pGame, s_Probe.m_Start > s_Probe.m_FirstStart, "restart must start a fresh timer"))
			return;
		log_info("warmup-probe", "START run=%d tick=%d", s_Probe.m_Run + 1, s_Probe.m_Start);
	}

	static constexpr float s_aPits[] = {44.5f, 60.5f, 76.5f, 96.5f, 105.5f, 111.5f};
	static constexpr float s_aTargets[] = {28, 53, 69, 86, 117, 161};
	if(s_Probe.m_Run == 1 && s_Probe.m_Returns < 6)
	{
		const int Cp = s_Probe.m_Returns < 3 ? 1 : 2;
		const auto &Outs = pGame->Collision()->TeleCheckOuts(Cp - 1);
		if(s_Probe.m_Previous.y > 39 * 32 && Outs.size() == 1 && distance(Core.m_Pos, Outs[0]) < 32)
		{
			if(!Check(pGame, pCharacter->m_TeleCheckpoint == Cp &&
				pCharacter->m_DDRaceState == ERaceState::STARTED &&
				pCharacter->m_StartTime == s_Probe.m_Start && length(Core.m_Vel) < 3,
				"return must use last checkpoint, clear speed and preserve running timer"))
				return;
			log_info("warmup-probe", "RETURN pit=%d checkpoint=%d", s_Probe.m_Returns + 1, Cp);
			++s_Probe.m_Returns;
			s_Probe.m_Target = Cp == 1 ? 1 : 3;
		}
	}
	if(pCharacter->m_DDRaceState == ERaceState::FINISHED)
	{
		const auto Best = pGame->Score()->PlayerData(0)->m_BestTime;
		if(!Check(pGame, s_Probe.m_Start >= 0 && Best.has_value() && *Best > 0 &&
			(s_Probe.m_Run == 0 || s_Probe.m_Returns == 6), "finish must have time and all expected returns"))
			return;
		log_info("warmup-probe", "FINISH run=%d elapsed_ticks=%d", s_Probe.m_Run + 1, pGame->Server()->Tick() - s_Probe.m_Start);
		if(s_Probe.m_Run == 0)
		{
			s_Probe.m_Run = 1;
			s_Probe.m_Start = -1;
			s_Probe.m_Target = 0;
			s_Probe.m_Respawning = true;
			s_Probe.m_Previous = vec2(0, 0);
			pGame->m_apPlayers[0]->KillCharacter(WEAPON_SELF);
			pGame->m_apPlayers[0]->Respawn();
		}
		else
		{
			s_Probe.m_Done = true;
			log_info("warmup-probe", "PASS: two finishes, fresh timer, six server checkpoint returns");
		}
		return;
	}

	const bool Grounded = pGame->Collision()->IsOnGround(Core.m_Pos, Core.PhysicalSize());
	const float X = Core.m_Pos.x / 32;
	if(Grounded && std::abs(X - s_aTargets[s_Probe.m_Target]) < 1 && s_Probe.m_Target < 5)
		++s_Probe.m_Target;
	float Target = s_aTargets[s_Probe.m_Target];
	bool Falling = false;
	if(s_Probe.m_Run == 1 && s_Probe.m_Returns < 6)
	{
		const float Pit = s_aPits[s_Probe.m_Returns];
		Falling = X >= Pit - 4 && X <= Pit + 2;
		if(Falling)
			Target = Pit;
	}
	const float Desired = std::clamp((Target * 32 - Core.m_Pos.x) * .2f, -10.0f, 10.0f);
	CNetObj_PlayerInput Input{};
	Input.m_Direction = Desired > Core.m_Vel.x + .5f ? 1 : (Desired < Core.m_Vel.x - .5f ? -1 : 0);
	Input.m_Jump = !Falling && Grounded &&
		(pGame->Collision()->CheckPoint(Core.m_Pos.x + 36, Core.m_Pos.y) ||
			!pGame->Collision()->CheckPoint(Core.m_Pos.x + 48, Core.m_Pos.y + 20));
	Input.m_Hook = !Falling && X >= 91 && X < 113 && s_Probe.m_Ticks % 35 != 0;
	Input.m_TargetX = 96;
	Input.m_TargetY = -300;
	pGame->OnClientDirectInput(0, &Input);
	pGame->OnClientPredictedInput(0, &Input);
	s_Probe.m_Previous = Core.m_Pos;
}
