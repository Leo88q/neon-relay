// Test-only driver. Disabled in ordinary builds. Supplies input and reads state;
// never assigns health, position, velocity, inventory, scores or round state.
#include <base/log.h>
#include <base/str.h>
#include <engine/server.h>
#include <engine/shared/config.h>
#include <game/server/entities/character.h>
#include <game/server/gamecontext.h>
#include <game/server/gamecontroller.h>
#include <game/server/player.h>

#include <cmath>
#include <cstdlib>

namespace
{
int s_Stage = 0, s_Ticks = 0, s_StageTick = 0, s_DeathTick = 0;
int s_aFire[MAX_CLIENTS]{};
bool s_Failed = false, s_Done = false;

bool Check(CGameContext *pGame, bool Condition, const char *pMessage)
{
	if(!Condition)
	{
		s_Failed = true;
		log_error("dm-probe", "FAIL stage=%d: %s", s_Stage, pMessage);
		pGame->Server()->SetErrorShutdown("DM server probe failed");
	}
	return Condition;
}

void Input(CGameContext *pGame, int Id, int Direction, int Weapon, bool Shoot, vec2 Aim)
{
	CNetObj_PlayerInput In{};
	In.m_Direction = Direction;
	In.m_TargetX = (int)Aim.x;
	In.m_TargetY = (int)Aim.y;
	if(!In.m_TargetX && !In.m_TargetY)
		In.m_TargetY = -1;
	In.m_WantedWeapon = Weapon + 1;
	In.m_PlayerFlags = PLAYERFLAG_PLAYING;
	if((s_aFire[Id] & 1) != (int)Shoot)
		s_aFire[Id] = (s_aFire[Id] + 1) & INPUT_STATE_MASK;
	In.m_Fire = s_aFire[Id];
	pGame->OnClientPredictedInput(Id, &In);
	pGame->OnClientPredictedEarlyInput(Id, &In);
}

void Next(CGameContext *pGame, const char *pMarker)
{
	log_info("dm-probe", "%s tick=%d", pMarker, pGame->Server()->Tick());
	++s_Stage;
	s_StageTick = pGame->Server()->Tick();
}
}

void NeonDmServerProbeTick(CGameContext *pGame)
{
	const char *pEnable = std::getenv("NEONRELAY_DM_PROBE");
	if(!pEnable || str_comp(pEnable, "1") || s_Failed || s_Done)
		return;
	if(!Check(pGame, !str_comp(g_Config.m_Bindaddr, "127.0.0.1") && !str_comp(g_Config.m_SvRegister, "0") &&
		pGame->m_pController->IsDeathmatch() && !g_Config.m_SvTestingCommands && !g_Config.m_SvNeonrelaySigning,
		"requires isolated cheat-free, reward-free Neon DM server"))
		return;
	int A = -1, B = -1;
	for(int Id = 0; Id < MAX_CLIENTS; ++Id)
	{
		if(!pGame->Server()->ClientIngame(Id))
			continue;
		if(!str_comp(pGame->Server()->ClientName(Id), "DmProbeA")) A = Id;
		else if(!str_comp(pGame->Server()->ClientName(Id), "DmProbeB")) B = Id;
		else if(!Check(pGame, false, "unexpected participant")) return;
	}
	if(A < 0 || B < 0)
		return;
	if(!Check(pGame, ++s_Ticks < 9000, "scenario timeout"))
		return;
	auto *pA = pGame->GetPlayerChar(A);
	auto *pB = pGame->GetPlayerChar(B);
	const int Now = pGame->Server()->Tick();
	const int Hz = pGame->Server()->TickSpeed();
	const auto Score = [&](int Id) { return pGame->m_pController->SnapPlayerScore(Id, pGame->m_apPlayers[Id]); };
	Input(pGame, A, 0, WEAPON_HAMMER, false, vec2(0, -1));
	Input(pGame, B, 0, WEAPON_HAMMER, false, vec2(0, -1));

	if(!str_comp(g_Config.m_SvMap, "Neon Relay Chrome DM Study"))
	{
		// Separate check on the actual big map, not a battle or route proof.
		if(pA && pB && s_Ticks > Hz * 3)
		{
			if(!Check(pGame, pA->GetHealth() == 10 && pB->GetHealth() == 10 && Score(A) == 0 && Score(B) == 0,
				"arena entry state")) return;
			log_info("dm-probe", "PASS: two native clients entered Chrome DM arena");
			s_Done = true;
		}
		return;
	}
	if(!Check(pGame, !str_comp(g_Config.m_SvMap, "Neon DM Fixture") && g_Config.m_SvNeonDmScoreLimit == 2, "fixture and frag limit required"))
		return;

	switch(s_Stage)
	{
	case 0:
		if(!pA || !pB || s_Ticks < Hz) return;
		if(!Check(pGame, pA->GetHealth() == 10 && pB->GetHealth() == 10 && !pA->GetArmor() && !pB->GetArmor() &&
			pA->GetWeaponAmmo(WEAPON_GUN) == 10 && pB->GetWeaponAmmo(WEAPON_GUN) == 10, "spawn loadout")) return;
		Next(pGame, "SPAWN");
		break;
	case 1:
		if(!pB)
		{
			if(!Check(pGame, pA && Score(A) == 1 && Score(B) == 0 && pA->GetWeaponAmmo(WEAPON_GUN) < 10, "gun kill and real ammo consumption")) return;
			s_DeathTick = pGame->m_apPlayers[B]->m_DieTick;
			Next(pGame, "GUN_KILL");
			break;
		}
		if(!Check(pGame, pA != nullptr, "shooter alive")) return;
		{
			vec2 Aim = pB->m_Pos - pA->m_Pos;
			Aim.y -= 0.000125f * Aim.x * Aim.x; // compensate default gun curvature
			Input(pGame, A, 0, WEAPON_GUN, ((Now - s_StageTick) / 8) % 2 == 0, Aim);
		}
		break;
	case 2:
		if(!pB) return;
		if(!Check(pGame, Now - s_DeathTick >= Hz / 2 && pB->GetHealth() == 10 && !pB->GetArmor() &&
			pB->GetWeaponAmmo(WEAPON_GUN) == 10 && Score(A) == 1, "timed respawn and preserved frag")) return;
		Next(pGame, "RESPAWN");
		break;
	case 3:
		if(!Check(pGame, pA && pB, "both actors before pickups")) return;
		if(pA->GetHealth() < 10)
		{
			Next(pGame, "RETURN_HIT");
			break;
		}
		Input(pGame, B, 0, WEAPON_GUN, (Now - s_StageTick) % Hz == 0, pA->m_Pos - pB->m_Pos);
		break;
	case 4:
		if(!Check(pGame, pA && pB, "both actors on pickup route")) return;
		Input(pGame, A, pA->m_Pos.x < 34.5f * 32 - 8 ? 1 : 0, WEAPON_HAMMER, false, vec2(0, -1));
		if(pA->m_Pos.x >= 34.5f * 32 - 8)
		{
			if(!Check(pGame, pA->GetHealth() == 10 && pA->GetArmor() == 1 &&
				pA->GetWeaponAmmo(WEAPON_SHOTGUN) == 10 && pA->GetWeaponAmmo(WEAPON_GRENADE) == 10 &&
				pA->GetWeaponAmmo(WEAPON_LASER) == 10, "health, armor and finite weapon pickups")) return;
			Next(pGame, "PICKUPS");
		}
		break;
	case 5:
		if(!Check(pGame, pA && pB, "both actors at shared pickups")) return;
		Input(pGame, B, pB->m_Pos.x < 32.5f * 32 - 8 ? 1 : 0, WEAPON_HAMMER, false, vec2(0, -1));
		if(pB->m_Pos.x >= 32.5f * 32 - 8)
		{
			if(!Check(pGame, !pB->GetWeaponGot(WEAPON_SHOTGUN), "pickup unavailable to second player before respawn")) return;
			Next(pGame, "SHARED_PICKUP_HIDDEN");
		}
		break;
	case 6:
		if(!Check(pGame, pA && pB, "actors waiting for pickup")) return;
		if(pB->GetWeaponGot(WEAPON_SHOTGUN))
		{
			if(!Check(pGame, Now - s_StageTick > Hz * 8 && pB->GetWeaponAmmo(WEAPON_SHOTGUN) == 10, "delayed shared pickup respawn")) return;
			Next(pGame, "PICKUP_RESPAWN");
		}
		break;
	case 7:
		if(!pB)
		{
			if(!Check(pGame, pA && Score(A) == 2 && pGame->m_pController->IsGamePaused() &&
				pA->GetWeaponAmmo(WEAPON_LASER) < 10, "laser frag and gameover at score limit")) return;
			Next(pGame, "LASER_KILL_GAMEOVER");
			break;
		}
		if(!Check(pGame, pA != nullptr, "laser shooter alive")) return;
		Input(pGame, A, 0, WEAPON_LASER, true, pB->m_Pos - pA->m_Pos);
		break;
	case 8:
		if(pGame->m_pController->IsGamePaused() || !pA || !pB || Score(A) || Score(B)) return;
		if(!Check(pGame, Now - s_StageTick >= Hz * 9 && pA->GetHealth() == 10 && pB->GetHealth() == 10 &&
			!pA->GetWeaponGot(WEAPON_LASER) && !pB->GetWeaponGot(WEAPON_SHOTGUN), "round reset clears scores and inventories")) return;
		log_info("dm-probe", "PASS: native gun and laser kills, frags, timed respawn, shared pickups, ammo and round restart");
		s_Done = true;
		break;
	}
}
