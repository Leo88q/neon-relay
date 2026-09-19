#include <game/server/gamemodes/neon_dm_rules.h>

#include <cassert>
#include <iostream>

using namespace NeonDm;

int main()
{
	// These are the very functions called by CCharacter::TakeDamage and the
	// live DM controller, not a Python reimplementation of their rules.
	auto Hit = Damage(10, 0, 1, false);
	assert(Hit.m_Health == 9 && Hit.m_Armor == 0 && !Hit.m_Killed);
	Hit = Damage(10, 10, 1, false);
	assert(Hit.m_Health == 10 && Hit.m_Armor == 9);
	Hit = Damage(10, 10, 5, false);
	assert(Hit.m_Health == 9 && Hit.m_Armor == 6);
	Hit = Damage(10, 2, 5, false);
	assert(Hit.m_Health == 7 && Hit.m_Armor == 0);
	Hit = Damage(10, 0, 6, true);
	assert(Hit.m_Health == 7);
	Hit = Damage(10, 0, 1, true);
	assert(Hit.m_Health == 9);
	Hit = Damage(1, 10, 2, false);
	assert(Hit.m_Killed && Hit.m_Health == 0);
	Hit = Damage(10, 0, 100, false);
	assert(Hit.m_Killed && Hit.m_Health == 0);
	Hit = Damage(10, 10, 0, true);
	assert(Hit.m_Health == 10 && Hit.m_Armor == 10 && !Hit.m_Killed);
	Hit = Damage(0, 5, 5, false);
	assert(!Hit.m_Killed); // dead characters must not award a second frag

	int Health = 10;
	for(int Shot = 0; Shot < 10; ++Shot)
	{
		Hit = Damage(Health, 0, 1, false);
		Health = Hit.m_Health;
		assert(Hit.m_Killed == (Shot == 9));
	}
	std::cout << "PASS: gun lethality, armor, spill, self-damage, zero/dead damage\n";

	int Cases = 0;
	for(int Hp = 1; Hp <= MAX_HEALTH; ++Hp)
		for(int Armor = 0; Armor <= MAX_ARMOR; ++Armor)
			for(int Amount = -1; Amount <= 100; ++Amount)
				for(bool Self : {false, true})
				{
					const auto Result = Damage(Hp, Armor, Amount, Self);
					assert(Result.m_Health >= 0 && Result.m_Health <= Hp);
					assert(Result.m_Armor >= 0 && Result.m_Armor <= Armor);
					assert(Result.m_Killed == (Result.m_Health == 0));
					++Cases;
				}
	std::cout << "PASS: " << Cases << " bounded damage cases\n";

	assert(ScoreDelta(false, true, false) == 1);
	assert(ScoreDelta(false, true, true) == -1);
	assert(ScoreDelta(false, false, false) == -1);
	assert(ScoreDelta(true, true, true) == 0);
	assert(ScoreDelta(true, false, false) == 0);
	std::cout << "PASS: frag, suicide, environment and administrative scoring\n";

	assert(RoundResult(2, 19, 1, 100, 20, 1000, false) == ERoundResult::CONTINUE);
	assert(RoundResult(2, 20, 1, 100, 20, 1000, false) == ERoundResult::END);
	assert(RoundResult(2, 20, 2, 100, 20, 1000, false) == ERoundResult::SUDDEN_DEATH);
	assert(RoundResult(2, 0, 2, 1000, 20, 1000, false) == ERoundResult::SUDDEN_DEATH);
	assert(RoundResult(2, -1, 1, 1000, 20, 1000, false) == ERoundResult::END);
	assert(RoundResult(2, 100, 1, 100000, 0, 0, false) == ERoundResult::CONTINUE);
	assert(RoundResult(1, 100, 1, 100000, 20, 1000, false) == ERoundResult::CONTINUE);
	assert(RoundResult(2, 5, 1, 100, 20, 1000, true) == ERoundResult::END);
	assert(RoundResult(2, 5, 2, 100, 20, 1000, true) == ERoundResult::SUDDEN_DEATH);
	std::cout << "PASS: frag/time limits, disabled limits, ties, sudden death and waiting\n";
}
