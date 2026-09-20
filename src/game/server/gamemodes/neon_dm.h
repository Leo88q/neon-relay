#ifndef GAME_SERVER_GAMEMODES_NEON_DM_H
#define GAME_SERVER_GAMEMODES_NEON_DM_H

#include <game/server/gamecontroller.h>

#include <array>

// Explicit opt-in combat mode. Never selected by the default ddnet config.
class CGameControllerNeonDm : public IGameController
{
	std::array<int, MAX_CLIENTS> m_aScores{};

public:
	explicit CGameControllerNeonDm(CGameContext *pGameServer);
	bool IsDeathmatch() const override { return true; }
	void OnCharacterSpawn(CCharacter *pChr) override;
	int OnCharacterDeath(CCharacter *pVictim, CPlayer *pKiller, int Weapon) override;
	bool OnEntity(int Index, int x, int y, int Layer, int Flags, bool Initial, int Number = 0) override;
	void OnPlayerConnect(CPlayer *pPlayer) override;
	void OnPlayerDisconnect(CPlayer *pPlayer, const char *pReason) override;
	void OnReset() override;
	void Tick() override;
	int SnapPlayerScore(int SnappingClient, CPlayer *pPlayer) override;
};

#endif // GAME_SERVER_GAMEMODES_NEON_DM_H
