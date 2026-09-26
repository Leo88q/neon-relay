// Neon Relay — local progress model for the menu gamification layer.
//
// Everything here is deliberately client-side and cosmetic: experience, level, day streak and
// three daily quests computed from counters that the player generates by using the client
// (practice runs, characters tried on, sessions). It is NOT the reward ledger: no number here
// is a payment, a ticket or a claim, and the pages label it as local progress
// (docs/UI_POTATO_ARENA_REDESIGN_RU.md rule P9, docs/REWARD_SECURITY.md).
//
// Verified match results (kills, placements) stay on the server/backend side. The read-only
// endpoint now exists (GET /v1/rewards/verified, backend/src/routes.ts) and the switch itself
// lives in Counter() below: it is the single point where the daily-quest source flips from
// local counters to server-confirmed numbers (cl_neon_verified_source + SetVerifiedSource()).
#ifndef GAME_CLIENT_NEON_PROGRESS_H
#define GAME_CLIENT_NEON_PROGRESS_H

#include <engine/shared/config.h>
#include <game/client/neon_style.h>

#include <algorithm>
#include <cstdlib>
#include <ctime>

namespace NeonProgress
{
// Level curve: L -> L+1 costs 250 * L * (L + 1) / 2 experience, i.e. 250, 750, 1350 ... and it
// plateaus at MAX_LEVEL so a long-lived profile can never overflow the saved counter.
constexpr int MAX_LEVEL = 30;
constexpr int XP_PER_LEVEL_STEP = 250;
constexpr int QUEST_COUNT = 3;
constexpr int QUEST_POOL = 12;

inline int XpForLevel(int Level)
{
	if(Level <= 0)
		return 0;
	const int Clamped = std::min(Level, MAX_LEVEL);
	return XP_PER_LEVEL_STEP * Clamped * (Clamped + 1) / 2;
}

inline int LevelFromXp(int Xp)
{
	int Level = 0;
	while(Level < MAX_LEVEL && Xp >= XpForLevel(Level + 1))
		++Level;
	return Level;
}

// 0..1 towards the next level; 1.0 at the cap.
inline float LevelProgress(int Xp)
{
	const int Level = LevelFromXp(Xp);
	if(Level >= MAX_LEVEL)
		return 1.0f;
	const int From = XpForLevel(Level);
	const int To = XpForLevel(Level + 1);
	return std::clamp((Xp - From) / float(std::max(1, To - From)), 0.0f, 1.0f);
}

// Day number since the Unix epoch, in UTC. A deliberately boring choice: no <tm>, no
// platform-specific localtime, and the "day" only gates a cosmetic streak and the daily quest
// reroll, so a UTC boundary (03:00 for Moscow) is fine and can never crash a player's save.
inline int TodayStamp()
{
	const std::time_t Now = std::time(nullptr);
	if(Now == static_cast<std::time_t>(-1))
		return 0;
	return static_cast<int>(Now / 86400) + 1; // 0 is reserved for "never seen"
}

inline int DayDelta(int From, int To)
{
	if(From <= 0 || To <= 0 || To < From)
		return 0;
	return To - From;
}

// Called once per menu session; advances the streak and refreshes the daily quest set.
inline void TouchDay()
{
	const int Today = TodayStamp();
	if(g_Config.m_ClNeonStreakDay == Today)
		return;
	const int Delta = DayDelta(g_Config.m_ClNeonStreakDay, Today);
	g_Config.m_ClNeonStreak = (Delta == 1) ? g_Config.m_ClNeonStreak + 1 : 1;
	g_Config.m_ClNeonStreakDay = Today;
	if(g_Config.m_ClNeonQuestDay != Today)
	{
		g_Config.m_ClNeonQuestDay = Today;
		g_Config.m_ClNeonQuestDone = 0; // the new set starts untouched
		// Daily progress is measured from the counters as of the rollover, so yesterday's
		// grind cannot silently complete today's quests.
		g_Config.m_ClNeonBasePractices = g_Config.m_ClNeonPractices;
		g_Config.m_ClNeonBaseTries = g_Config.m_ClNeonTries;
		g_Config.m_ClNeonBaseSessions = g_Config.m_ClNeonMatches;
	}
}

inline void AddXp(int Amount)
{
	g_Config.m_ClNeonXp = std::min(g_Config.m_ClNeonXp + std::max(0, Amount), 1000000000);
}

// Event sinks the pages call. Each one both awards experience and feeds a quest counter.
inline void OnPracticeStarted()
{
	++g_Config.m_ClNeonPractices;
	AddXp(25);
}
inline void OnPracticeStopped()
{
	AddXp(40);
}
inline void OnCharacterTried()
{
	++g_Config.m_ClNeonTries;
	AddXp(10);
}
inline void OnSessionStarted()
{
	++g_Config.m_ClNeonMatches;
	AddXp(15);
}

// ---- daily quests -----------------------------------------------------------------------
//
// Deterministic: the same day always offers the same three quests on every machine, and the
// selection never depends on random state (a reroll would let a player farm the easy ones).
struct SQuest
{
	const char *m_pTitle;
	const char *m_pTitleRu;
	int m_Target;
	int m_Xp;
	int m_Icon;
	int m_Counter; // index into Counters()
};

enum ECounter
{
	COUNTER_PRACTICE = 0,
	COUNTER_TRIES,
	COUNTER_SESSIONS,
	COUNTER_STREAK,
	COUNTER_COUNT
};

// ---- verified source (server-confirmed numbers) ------------------------------------
//
// Filled by the fetch path from GET /v1/rewards/verified (the route is read-only and
// returns only the bearer session's own events). Until a fetch has landed for the current
// day, the source stays empty and the local counters below remain authoritative, so a
// failed or absent fetch can never zero a player's progress.
struct SVerifiedSource
{
	int m_PracticesToday = 0; // verified practice laps today
	int m_SessionsToday = 0; // verified match finishes today
	int m_FetchedDay = 0; // TodayStamp() at fetch time
};

inline SVerifiedSource &VerifiedSource()
{
	static SVerifiedSource s_Source;
	return s_Source;
}

// The fetch path calls this with the payload's per-day counts. Values are clamped to the
// same range as the local counters so a hostile reply cannot overflow the quest math.
inline void SetVerifiedSource(int PracticesToday, int SessionsToday, int FetchedDay)
{
	SVerifiedSource &S = VerifiedSource();
	S.m_PracticesToday = std::clamp(PracticesToday, 0, 1000000);
	S.m_SessionsToday = std::clamp(SessionsToday, 0, 1000000);
	S.m_FetchedDay = FetchedDay;
}

inline void ClearVerifiedSource()
{
	VerifiedSource() = SVerifiedSource();
}

// Usable only for the day it was fetched (daily quests count "today") and only when at
// least one number actually came back.
inline bool VerifiedSourceUsable()
{
	const SVerifiedSource &S = VerifiedSource();
	return g_Config.m_ClNeonVerifiedSource != 0 && S.m_FetchedDay == TodayStamp() &&
		(S.m_PracticesToday > 0 || S.m_SessionsToday > 0);
}

inline int Counter(int Which)
{
	// SINGLE SOURCE-SWITCH POINT (docs/UI_POTATO_ARENA_REDESIGN_RU.md §7.7): when a
	// same-day verified fetch is present and enabled, the counters the server can confirm
	// (practice laps, matches joined) read the server-verified numbers; the counters with
	// no server source yet (try-ons, streak) keep the local value. No other panel may
	// read the verified source directly.
	if(VerifiedSourceUsable())
	{
		switch(Which)
		{
		case COUNTER_PRACTICE: return VerifiedSource().m_PracticesToday;
		case COUNTER_SESSIONS: return VerifiedSource().m_SessionsToday;
		}
	}
	switch(Which)
	{
	case COUNTER_PRACTICE: return std::max(0, g_Config.m_ClNeonPractices - g_Config.m_ClNeonBasePractices);
	case COUNTER_TRIES: return std::max(0, g_Config.m_ClNeonTries - g_Config.m_ClNeonBaseTries);
	case COUNTER_SESSIONS: return std::max(0, g_Config.m_ClNeonMatches - g_Config.m_ClNeonBaseSessions);
	case COUNTER_STREAK: return g_Config.m_ClNeonStreak;
	default: return 0;
	}
}

// Daily progress = lifetime counter minus the baseline captured at the last rollover (see
// TouchDay). The verified-source switch above is the only place a panel's number changes
// origin; quest baselines keep meaning the same thing in both sources.
inline const SQuest *QuestDef(int PoolIndex)
{
	static const SQuest s_aQuests[QUEST_POOL] = {
		{"Run 2 practice laps", "2 разминки", 2, 60, NeonStyle::ICON_TIMER, COUNTER_PRACTICE},
		{"Run 5 practice laps", "5 разминок", 5, 150, NeonStyle::ICON_TIMER, COUNTER_PRACTICE},
		{"Try 2 characters", "Примерить 2 персонажей", 2, 45, NeonStyle::ICON_STAR, COUNTER_TRIES},
		{"Try 4 characters", "Примерить 4 персонажей", 4, 90, NeonStyle::ICON_STAR, COUNTER_TRIES},
		{"Join 1 match", "1 заход на сервер", 1, 40, NeonStyle::ICON_HOOK, COUNTER_SESSIONS},
		{"Join 3 matches", "3 захода на сервер", 3, 110, NeonStyle::ICON_HOOK, COUNTER_SESSIONS},
		{"Keep a 2-day streak", "Серия 2 дня", 2, 70, NeonStyle::ICON_STREAK_FLAME, COUNTER_STREAK},
		{"Keep a 4-day streak", "Серия 4 дня", 4, 160, NeonStyle::ICON_STREAK_FLAME, COUNTER_STREAK},
		{"Run a lap and try a skin", "Разминка + примерка", 1, 55, NeonStyle::ICON_POTATO, COUNTER_PRACTICE},
		{"3 practice laps today", "3 разминки сегодня", 3, 100, NeonStyle::ICON_TIMER, COUNTER_PRACTICE},
		{"Open the storefront", "Открыть витрину", 1, 20, NeonStyle::ICON_SHIELD, COUNTER_TRIES},
		{"Join 2 matches", "2 захода на сервер", 2, 75, NeonStyle::ICON_HOOK, COUNTER_SESSIONS},
	};
	return &s_aQuests[PoolIndex % QUEST_POOL];
}

inline int QuestPoolIndex(int Slot, int DayStamp)
{
	// LCG mixing of the day stamp; 3 distinct slots by open addressing in the pool.
	int Hash = DayStamp * 1103515245 + 12345;
	Hash ^= Hash >> 13;
	int Start = std::abs(Hash) % QUEST_POOL;
	return (Start + Slot * 5) % QUEST_POOL;
}

inline bool QuestClaimed(int Slot)
{
	return (g_Config.m_ClNeonQuestDone & (1 << Slot)) != 0;
}

inline void QuestClaim(int Slot)
{
	if(QuestClaimed(Slot))
		return;
	g_Config.m_ClNeonQuestDone |= 1 << Slot;
	AddXp(QuestDef(QuestPoolIndex(Slot, g_Config.m_ClNeonQuestDay))->m_Xp);
}

struct SQuestState
{
	const SQuest *m_pQuest;
	int m_Progress;
	bool m_Complete;
	bool m_Claimed;
};

inline SQuestState QuestState(int Slot)
{
	const SQuest *pQuest = QuestDef(QuestPoolIndex(Slot, g_Config.m_ClNeonQuestDay));
	const int Progress = std::min(Counter(pQuest->m_Counter), pQuest->m_Target);
	SQuestState State;
	State.m_pQuest = pQuest;
	State.m_Progress = Progress;
	State.m_Complete = Progress >= pQuest->m_Target;
	State.m_Claimed = QuestClaimed(Slot);
	return State;
}
} // namespace NeonProgress

#endif // GAME_CLIENT_NEON_PROGRESS_H
