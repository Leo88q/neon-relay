#ifndef GAME_SERVER_GAMEMODES_NEON_DM_RULES_H
#define GAME_SERVER_GAMEMODES_NEON_DM_RULES_H

#include <algorithm>

// Shared by the live controller/character and the standalone regression tests.
// No server state, protocol IDs or race behavior are changed here.
namespace NeonDm
{
constexpr int MAX_HEALTH = 10;
constexpr int MAX_ARMOR = 10;
constexpr int MAX_AMMO = 10;
constexpr int PICKUP_RESPAWN_SECONDS = 15;
constexpr int RESPAWN_MILLISECONDS = 500;

struct CDamageResult
{
	int m_Health;
	int m_Armor;
	bool m_Killed;
};

inline CDamageResult Damage(int Health, int Armor, int Amount, bool Self)
{
	if(Amount <= 0 || Health <= 0)
		return {Health, Armor, false};
	if(Self)
		Amount = std::max(1, Amount / 2);
	// Standard combat armor: one health point leaks through multi-point hits.
	if(Armor > 0 && Amount > 1)
	{
		--Health;
		--Amount;
	}
	const int Absorbed = std::min(Armor, Amount);
	Armor -= Absorbed;
	Health = std::max(0, Health - (Amount - Absorbed));
	return {Health, Armor, Health == 0};
}

inline int ScoreDelta(bool Administrative, bool HasKiller, bool Self)
{
	return Administrative ? 0 : (!HasKiller || Self ? -1 : 1);
}

enum class ERoundResult
{
	CONTINUE,
	SUDDEN_DEATH,
	END
};

inline ERoundResult RoundResult(int Players, int BestScore, int Leaders, int ElapsedTicks,
	int ScoreLimit, int TimeLimitTicks, bool SuddenDeath)
{
	if(Players < 2)
		return ERoundResult::CONTINUE;
	const bool Limit = (ScoreLimit > 0 && BestScore >= ScoreLimit) ||
		(TimeLimitTicks > 0 && ElapsedTicks >= TimeLimitTicks);
	if(!Limit && !SuddenDeath)
		return ERoundResult::CONTINUE;
	return Leaders == 1 ? ERoundResult::END : ERoundResult::SUDDEN_DEATH;
}
} // namespace NeonDm

#endif // GAME_SERVER_GAMEMODES_NEON_DM_RULES_H
