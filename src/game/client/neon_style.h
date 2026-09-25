// Neon Relay — single source of truth for the interface style.
//
// Every panel, border, progress bar and icon tint in the menus and the HUD must come from
// these tokens, so that the shipped PNG art (data/ui/backgrounds, data/ui/icons,
// data/ui/weapons) and the code-drawn surfaces cannot drift apart. Token values are the
// adopted Night Drive palette (docs/DESIGN_SYNTHWAVE.md) plus the two rarity accents used by
// the character storefront; the hexes are written next to each value on purpose, because
// before this header existed the same three "brand" colours were spelled out as float
// literals in 231 places and none of them matched the token table.
#ifndef GAME_CLIENT_NEON_STYLE_H
#define GAME_CLIENT_NEON_STYLE_H

#include <base/color.h>

namespace NeonStyle
{
// Surfaces (night-0 / night-1 / night-2)
inline constexpr ColorRGBA NIGHT_0{0.0196f, 0.0235f, 0.0549f, 1.0f}; // #05060E backdrop
inline constexpr ColorRGBA NIGHT_1{0.0392f, 0.0549f, 0.1176f, 1.0f}; // #0A0E1E panels
inline constexpr ColorRGBA NIGHT_2{0.0627f, 0.1020f, 0.1882f, 1.0f}; // #101A30 raised cards
// Accents
inline constexpr ColorRGBA CYAN{0.3020f, 0.8902f, 0.9686f, 1.0f};   // #4DE3F7 primary / safe
inline constexpr ColorRGBA PINK{1.0f, 0.1804f, 0.5333f, 1.0f};     // #FF2E88 risk / hot accent
inline constexpr ColorRGBA INDIGO{0.4235f, 0.3765f, 1.0f, 1.0f};    // #6C60FF secondary glow
// Text and muted states
inline constexpr ColorRGBA ICE{0.8471f, 0.9647f, 1.0f, 1.0f};       // #D8F6FF labels, digits
inline constexpr ColorRGBA DIM{0.3765f, 0.4549f, 0.5804f, 1.0f};     // #607494 grid, disabled
// Rarity accents of the character storefront (the only gold/violet in the interface)
inline constexpr ColorRGBA RARE_VIOLET{0.6275f, 0.4667f, 1.0f, 1.0f};     // #A077FF
inline constexpr ColorRGBA RARE_GOLD{1.0f, 0.7843f, 0.3412f, 1.0f};       // #FFC857
inline constexpr ColorRGBA SUCCESS{0.3490f, 0.9020f, 0.7490f, 1.0f};      // mint, "ready/verified"

// Page chrome: the fill / border / accent triple that every product-page panel and card uses, and
// the two text tones for "good" and "secondary" copy. These were float literals in the wallet file
// (and the same numbers again in the storefront), which is how one page ends up a shade off.
inline constexpr ColorRGBA PANEL_FILL{0.0470f, 0.0745f, 0.2039f, 0.96f};   // card / form background
inline constexpr ColorRGBA PANEL_BORDER{0.1647f, 0.5294f, 0.5922f, 0.85f}; // its hairline
inline constexpr ColorRGBA PANEL_ACCENT{0.3725f, 0.8902f, 0.9608f, 1.0f};  // its highlight bar
inline constexpr ColorRGBA TEXT_SOFT{0.7490f, 0.8275f, 0.9490f, 1.0f};     // explanatory paragraphs
inline constexpr ColorRGBA TEXT_FAINT{0.6784f, 0.7686f, 0.8902f, 1.0f};    // footnotes, secondary rows

// Geometry (rule P7 of docs/UI_POTATO_ARENA_REDESIGN_RU.md)
inline constexpr float PANEL_RADIUS = 16.0f;
inline constexpr float CARD_RADIUS = 12.0f;
inline constexpr float BORDER_WIDTH = 2.0f;
inline constexpr float GLOW_WIDTH = 10.0f;
// The backdrop is a photo-like render; without this veil the labels lose contrast, and
// without the raised texture alpha the art is invisible (it used to be multiplied twice).
inline constexpr float BACKDROP_ALPHA = 0.62f;
inline constexpr float BACKDROP_VEIL_ALPHA = 0.55f;

inline ColorRGBA Dim(ColorRGBA Color, float Alpha)
{
	Color.a = Alpha;
	return Color;
}

// Border + impulse colour of a storefront card, from the catalogue rarity string.
// Icon ids of data/ui/icons/gamification_24.png (8 columns x 3 rows of 64px) and of the
// six-weapon strip data/ui/weapons/weapons_6_128.png. The order is produced by
// scripts/build_potato_arena_assets.py (ICON_NAMES / WEAPON_ORDER); living here, in the shared
// style header, keeps the menu, the storefront and the quest table on the same numbers.
enum EIcon
{
	ICON_LEVEL_RING = 0, ICON_XP_BOLT, ICON_STREAK_FLAME, ICON_QUEST_TARGET, ICON_DAILY_SUN,
	ICON_CHEST_PRIZE, ICON_TROPHY, ICON_MEDAL, ICON_TICKET, ICON_COIN_SKR, ICON_POTATO, ICON_SHIELD,
	ICON_HEART, ICON_STAR, ICON_CROWN, ICON_LOCK, ICON_CHECK, ICON_BELL, ICON_RANK_UP, ICON_SKULL,
	ICON_TIMER, ICON_HOOK, ICON_CHAT, ICON_GEAR, ICON_COUNT,
};

enum EWeaponIcon
{
	WEAPON_ICON_HAMMER = 0, WEAPON_ICON_PISTOL, WEAPON_ICON_SHOTGUN, WEAPON_ICON_GRENADE,
	WEAPON_ICON_LASER, WEAPON_ICON_NINJA, WEAPON_ICON_COUNT,
};

struct SRarityAccent
{
	ColorRGBA m_Border;
	float m_ImpulseSeconds;
	int m_Diamonds;
};

inline SRarityAccent RarityAccent(const char *pRarity)
{
	// str_comp is not constexpr, so callers pass through this normal function instead.
	if(pRarity && pRarity[0] == 'L')
		return {RARE_GOLD, 6.0f, 3};
	if(pRarity && pRarity[0] == 'R')
		return {RARE_VIOLET, 5.0f, 2};
	return {CYAN, 5.0f, 1};
}
} // namespace NeonStyle

#endif // GAME_CLIENT_NEON_STYLE_H
