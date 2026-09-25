//
// Static data for the Arsenal and Maps pages. Every number here is copied from the code that
// implements it (see the comments), and scripts/test_map_catalog.py + check_menu_syntax.sh fail if
// the tables drift: the blurbs and grid statistics are re-derived from scripts/build_neon_maps.py,
// the weapon numbers from datasrc/content.py.
//
#ifndef GAME_CLIENT_NEON_ARSENAL_H
#define GAME_CLIENT_NEON_ARSENAL_H

#include <cstddef>

namespace NeonArsenal
{
// One armoury card. m_Icon indexes NeonStyle::EWeaponIcon, i.e. the cell in
// data/ui/weapons/weapons_6_128.png, so the small icon and the big card are the same weapon.
struct SWeaponCard
{
	const char *m_pName;
	const char *m_pRole; // what it is for, one line
	const char *m_pHow; // how it behaves, one line
	const char *m_pTip; // practical consequence for the player
	int m_Damage; // per hit, in NeonDM health points (NeonDM caps health and armor at 10)
	int m_FireDelayMs;
	int m_MaxAmmo; // -1 = no ammo counter
	bool m_DropsInNeonDm;
};

// Damage / fire delay: datasrc/content.py (WeaponSpec + the per-weapon blocks). Availability:
// CGameControllerNeonDm::OnCharacterSpawn and ::OnEntity in src/game/server/gamemodes/neon_dm.cpp.
// Spread, explosion radius and the laser reach come from the same files that apply them; each line
// names the source so a future change cannot silently invalidate the copy.
inline constexpr SWeaponCard g_aCards[] = {
	{"Hammer",
		"Ближний бой и выталкивание",
		"Дуга удара, 3 урона и сильный отброс на обоих (character.cpp:553).",
		"Очко заfrag молотом не начисляется: удар считается административным (neon_dm_rules.h:ScoreDelta).",
		3, 125, -1, true},
	{"Pistol",
		"Штатное оружие на старте",
		"Снаряд живёт 2 с, 1 урон за попадание, скорость 2200 (content.py:596-616).",
		"Патроны восстанавливаются сами: 10 в magasinе, регенерация каждые 500 мс.",
		1, 125, 10, true},
	{"Shotgun",
		"Веер вблизи",
		"5 дробин по 1 урону, разброс ±0.185 рад, снаряд живёт 0.25 с (character.cpp:595-610).",
		"В deathmatch это веер; вне его тот же выстрел становится лучом — не путайся между режимами.",
		5, 500, 10, true},
	{"Grenade",
		"Взрыв и отскок от земли",
		"Радиус 135 px, внутренний 48 px, урон падает с расстоянием (gamecontext.cpp:396-414).",
		"Свой взрыв толкает так же, как чужой: им и разгоняются, и запрыгивают на полки.",
		2, 500, 10, true},
	{"Laser",
		"Прямой луч на 800 px",
		"5 урона, задержка 800 мс, одно отражение без штрафа (content.py:639-647, laser.cpp:100-181).",
		"Бьёт ровно одного: второй tee за первым не получит ничего, целиться надо в ближнего.",
		5, 800, 10, true},
	{"Ninja",
		"Меч и рывок",
		"9 урона, 15 с усиления, +50 к скорости на 200 мс (content.py:649-657).",
		"В NeonDM не выпадает: контроллер разрешает подбор только дробовика, гранат и лазера.",
		9, 800, -1, false},
};
inline constexpr size_t NUM_CARDS = std::size(g_aCards);

// NeonDM round rules shown under the cards (src/game/server/gamemodes/neon_dm_rules.h).
inline constexpr int MAX_HEALTH = 10;
inline constexpr int MAX_ARMOR = 10;
inline constexpr int PICKUP_RESPAWN_SECONDS = 15;
inline constexpr int RESPAWN_MILLISECONDS = 500;
} // namespace NeonArsenal

namespace NeonMaps
{
// One card of the arena gallery. m_PreviewCell is the 320x160 cell in data/ui/maps/previews.png;
// -1 means the map has no blueprint because it did not come from scripts/build_neon_maps.py.
struct SMapCard
{
	const char *m_pName;
	const char *m_pBlurb;
	int m_PreviewCell;
	int m_TilesW;
	int m_TilesH;
	int m_Spawns;
	int m_Checkpoints;
	int m_DeathTiles;
	int m_NohookTiles;
};

inline constexpr SMapCard g_aCards[] = {
	{"Neon Relay Basin", "сбалансированный заезд-введение", 0, 220, 70, 3, 3, 100, 35},
	{"Chromatic Canyon", "хук-роут по каньону над рекой смерти", 1, 240, 90, 3, 3, 163, 0},
	{"Vector Spire", "зигзаг полок вверх", 2, 160, 110, 3, 6, 24, 44},
	{"Midnight Circuit", "быстрый слалом по плоскому кругу", 3, 260, 56, 3, 5, 22, 81},
	{"Aurora Ascent", "лесенка под полосой авроры", 4, 200, 100, 3, 4, 550, 200},
	{"Neon Relay Warmup", "разминка: без дропов и без очков", -1, 0, 0, 0, 0, 0, 0},
};
inline constexpr size_t NUM_CARDS = std::size(g_aCards);

// Everything else shipped in data/maps is DDNet's own pool (dm*, ctf*, Tutorial, LearnToPlay and
// four single-purpose maps). Counted by scripts/test_map_catalog.py against the real directory.
inline constexpr int NUM_SHIPPED_MAPS = 27;
inline constexpr int PREVIEW_CELL_W = 320;
inline constexpr int PREVIEW_CELL_H = 160;
inline constexpr int PREVIEW_CELLS = 5;
} // namespace NeonMaps

#endif // GAME_CLIENT_NEON_ARSENAL_H
