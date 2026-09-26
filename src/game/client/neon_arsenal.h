//
// Static data for the Arsenal page, plus the generated Maps catalogue. Every weapon number here is
// copied from the code that implements it (see the comments) and scripts/test_map_catalog.py fails
// if the tables drift: the weapon numbers are re-derived from datasrc/content.py, the map rows from
// data/maps/*.map via scripts/neon_mapread.py.
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

// Maps: the catalogue is generated, not typed here. scripts/build_map_previews.py reads every
// shipped data/maps/*.map through scripts/neon_mapread.py and writes src/game/client/neon_maps_gen.h
// (blurbs included), which is why the page cannot disagree with the map a player joins. The gate is
// the generator's own --check plus scripts/test_map_catalog.py.
#include "neon_maps_gen.h"

#endif // GAME_CLIENT_NEON_ARSENAL_H
