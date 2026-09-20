#include "neon_dm.h"

#include "neon_dm_rules.h"

#include <base/log.h>
#include <engine/shared/config.h>
#include <game/mapitems.h>
#include <game/server/entities/character.h>
#include <game/server/gamecontext.h>
#include <game/server/player.h>

#include <limits>

CGameControllerNeonDm::CGameControllerNeonDm(CGameContext *pGameServer) :
	IGameController(pGameServer)
{
	m_pGameType = "NeonDM";
	m_GameFlags = 0;
	log_info("neon-dm", "combat controller selected; score_limit=%d time_limit=%d",
		Config()->m_SvNeonDmScoreLimit, Config()->m_SvNeonDmTimeLimit);
}

void CGameControllerNeonDm::OnCharacterSpawn(CCharacter *pChr)
{
	IGameController::OnCharacterSpawn(pChr);
	pChr->SetArmor(0);
	pChr->SetWeaponAmmo(WEAPON_GUN, NeonDm::MAX_AMMO);
}

int CGameControllerNeonDm::OnCharacterDeath(CCharacter *pVictim, CPlayer *pKiller, int Weapon)
{
	if(m_GameOverTick != -1 || m_Warmup || GameServer()->m_World.m_ResetRequested)
		return 0;
	const bool Self = pKiller == pVictim->GetPlayer();
	const int Delta = NeonDm::ScoreDelta(Weapon == WEAPON_GAME, pKiller != nullptr, Self);
	if(Delta)
	{
		const int Id = Delta < 0 ? pVictim->GetPlayer()->GetCid() : pKiller->GetCid();
		m_aScores[Id] += Delta;
		Server()->SetClientScore(Id, m_aScores[Id]);
	}
	return 0;
}

bool CGameControllerNeonDm::OnEntity(int Index, int x, int y, int Layer, int Flags, bool Initial, int Number)
{
	// No legacy ninja pickup or DDRace hazards in this initial combat mode.
	// The map's source entity is kept intact; it is deliberately not spawned.
	if((Index >= ENTITY_SPAWN && Index <= ENTITY_SPAWN_BLUE) ||
		Index == ENTITY_ARMOR_1 || Index == ENTITY_HEALTH_1 ||
		Index == ENTITY_WEAPON_SHOTGUN || Index == ENTITY_WEAPON_GRENADE || Index == ENTITY_WEAPON_LASER)
		return IGameController::OnEntity(Index, x, y, Layer, Flags, Initial, Number);
	return false;
}

void CGameControllerNeonDm::OnPlayerConnect(CPlayer *pPlayer)
{
	m_aScores[pPlayer->GetCid()] = 0; // a reused client slot must not inherit frags
	Server()->SetClientScore(pPlayer->GetCid(), 0);
	IGameController::OnPlayerConnect(pPlayer);
}

void CGameControllerNeonDm::OnPlayerDisconnect(CPlayer *pPlayer, const char *pReason)
{
	// A projectile must not credit the next connection that reuses this slot.
	GameServer()->m_World.RemoveEntitiesFromPlayer(pPlayer->GetCid());
	IGameController::OnPlayerDisconnect(pPlayer, pReason);
	m_aScores[pPlayer->GetCid()] = 0;
}

void CGameControllerNeonDm::OnReset()
{
	m_aScores.fill(0);
	for(auto *pPlayer : GameServer()->m_apPlayers)
		if(pPlayer)
			Server()->SetClientScore(pPlayer->GetCid(), 0);
	IGameController::OnReset();
}

int CGameControllerNeonDm::SnapPlayerScore(int SnappingClient, CPlayer *pPlayer)
{
	return m_aScores[pPlayer->GetCid()];
}

void CGameControllerNeonDm::Tick()
{
	IGameController::Tick();
	if(IsGamePaused() && m_GameOverTick == -1)
		++m_RoundStartTick;
	if(m_GameOverTick != -1 || m_Warmup || IsGamePaused() || GameServer()->m_World.m_ResetRequested)
		return;
	int Players = 0, Leaders = 0, Best = std::numeric_limits<int>::min();
	for(auto *pPlayer : GameServer()->m_apPlayers)
	{
		if(!pPlayer || !Server()->ClientIngame(pPlayer->GetCid()) || pPlayer->GetTeam() == TEAM_SPECTATORS)
			continue;
		++Players;
		const int Score = m_aScores[pPlayer->GetCid()];
		if(Score > Best)
		{
			Best = Score;
			Leaders = 1;
		}
		else if(Score == Best)
			++Leaders;
	}
	if(Players < 2)
	{
		// Do not consume the match timer while waiting for an opponent.
		++m_RoundStartTick;
		return;
	}
	const auto Result = NeonDm::RoundResult(Players, Best, Leaders, Server()->Tick() - m_RoundStartTick,
		Config()->m_SvNeonDmScoreLimit, Config()->m_SvNeonDmTimeLimit * 60 * Server()->TickSpeed(), m_SuddenDeath != 0);
	if(Result == NeonDm::ERoundResult::END)
		EndRound(); // base controller restarts after ten seconds
	else if(Result == NeonDm::ERoundResult::SUDDEN_DEATH)
		m_SuddenDeath = 1;
}
