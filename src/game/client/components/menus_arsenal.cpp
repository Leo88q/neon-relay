//
// Arsenal ("оружейная комната") and the arena map gallery. Both pages read from the atlases baked by
// scripts/build_potato_arena_assets.py / scripts/build_map_previews.py, so a card is always the same
// pixels the game draws elsewhere; the copy comes from neon_arsenal.h, which CI cross-checks.
//
#include "menus.h"

#include <base/str.h>

#include <engine/graphics.h>
#include <engine/storage.h>

#include <game/client/gameclient.h>
#include <game/client/neon_arsenal.h>
#include <game/client/neon_style.h>
#include <game/localization.h>

// ---------------------------------------------------------------- primitives

void CMenus::RenderAtlasCell(const IGraphics::CTextureHandle &Texture, int CellsX, int CellsY, int CellIndex, const CUIRect *pRect, float Alpha)
{
	if(!Texture.IsValid() || CellsX <= 0 || CellsY <= 0 || CellIndex < 0 || CellIndex >= CellsX * CellsY)
		return;
	// Row-major cells, the same layout both bakers write.
	const float U0 = (CellIndex % CellsX) / (float)CellsX;
	const float V0 = (CellIndex / CellsX) / (float)CellsY;
	Graphics()->TextureSet(Texture);
	Graphics()->QuadsBegin();
	Graphics()->QuadsSetSubset(U0, V0, U0 + 1.0f / (float)CellsX, V0 + 1.0f / (float)CellsY);
	Graphics()->SetColor(1.0f, 1.0f, 1.0f, Alpha);
	IGraphics::CQuadItem Quad(pRect->x, pRect->y, pRect->w, pRect->h);
	Graphics()->QuadsDrawTL(&Quad, 1);
	Graphics()->QuadsEnd();
	// A 1px inner frame keeps a bright card from dissolving into the backdrop's own niches.
	pRect->Draw(NeonStyle::Dim(NeonStyle::CYAN, 0.35f), NeonStyle::CARD_RADIUS, IGraphics::CORNER_ALL);
}

void CMenus::RenderSectionHeader(const CUIRect *pRect, const char *pTitle, const char *pNote)
{
	CUIRect Title, Note;
	pRect->VSplitLeft(pRect->w * 0.55f, &Title, &Note);
	// A 3px cyan tick before the title is the only ornament these pages need.
	CUIRect Tick, Text;
	Title.VSplitLeft(3.0f, &Tick, &Text);
	Tick.Draw(NeonStyle::CYAN, 1.5f, IGraphics::CORNER_ALL);
	Text.VSplitRight(8.0f, &Text, nullptr);
	Ui()->DoLabel(&Text, pTitle, 22.0f, TEXTALIGN_ML);
	Note.VSplitLeft(8.0f, nullptr, &Note);
	if(pNote && pNote[0])
		Ui()->DoLabel(&Note, pNote, 12.0f, TEXTALIGN_MR);
}

void CMenus::RenderStatChip(const CUIRect *pRect, const char *pLabel, const char *pValue, ColorRGBA ValueColor)
{
	CUIRect Label, Value;
	pRect->VSplitLeft(pRect->w * 0.46f, &Label, &Value);
	Ui()->DoLabel(&Label, pLabel, 11.0f, TEXTALIGN_ML);
	TextRender()->TextColor(ValueColor);
	Ui()->DoLabel(&Value, pValue, 12.0f, TEXTALIGN_MR);
	TextRender()->TextColor(TextRender()->DefaultTextColor());
}

void CMenus::RenderSectionBar(CUIRect Rect, int Active)
{
	static CButtonContainer s_aSections[3];
	const char *apNames[] = {Localize("Races"), Localize("Maps"), Localize("Arsenal")};
	const int apPages[] = {PAGE_RACES, PAGE_MAPS, PAGE_ARSENAL};
	const float Width = (Rect.w - 2.0f * NeonStyle::BORDER_WIDTH * 2.0f) / 3.0f;
	CUIRect Panel = Rect;
	Panel.Draw(NeonStyle::Dim(NeonStyle::NIGHT_1, 0.6f), NeonStyle::PANEL_RADIUS, IGraphics::CORNER_ALL);
	for(int i = 0; i < 3; ++i)
	{
		CUIRect Tab;
		Rect.VSplitLeft(Width, &Tab, &Rect);
		if(i < 2)
			Rect.VSplitLeft(4.0f, nullptr, &Rect);
		Tab.VSplitLeft(Width, &Tab, nullptr);
		if(DoButton_MenuTab(&s_aSections[i], apNames[i], Active == i, &Tab, IGraphics::CORNER_ALL))
			SetMenuPage(apPages[i]);
	}
}

int CMenus::SectionFromPage(int Page)
{
	switch(Page)
	{
	case PAGE_MAPS:
		return 1;
	case PAGE_ARSENAL:
		return 2;
	default:
		return 0;
	}
}

// ---------------------------------------------------------------- arsenal

void CMenus::RenderArsenal(CUIRect MainView)
{
	const bool Compact = MainView.w < 720.0f;
	MainView.Margin(Compact ? 12.0f : 24.0f, &MainView);

	CUIRect Row;
	MainView.HSplitTop(42.0f, &Row, &MainView);
	RenderSectionHeader(&Row, Localize("Arsenal"), Localize("Six weapons, one room"));
	MainView.HSplitTop(8.0f, nullptr, &MainView);
	MainView.HSplitTop(30.0f, &Row, &MainView);
	RenderSectionBar(Row, SectionFromPage(m_MenuPage));
	MainView.HSplitTop(12.0f, nullptr, &MainView);

	// Rules line: what every card below is measured against.
	CUIRect Rules;
	MainView.HSplitTop(20.0f, &Rules, &MainView);
	char aRules[256];
	str_format(aRules, sizeof(aRules),
		Localize("NeonDM: %d HP and %d armor, a dropped weapon respawns after %d s, respawn after %d ms"),
		NeonArsenal::MAX_HEALTH, NeonArsenal::MAX_ARMOR, NeonArsenal::PICKUP_RESPAWN_SECONDS, NeonArsenal::RESPAWN_MILLISECONDS);
	TextRender()->TextColor(NeonStyle::DIM);
	Ui()->DoLabel(&Rules, aRules, 12.0f, TEXTALIGN_ML);
	TextRender()->TextColor(TextRender()->DefaultTextColor());
	MainView.HSplitTop(12.0f, nullptr, &MainView);

	static CScrollRegion s_ArsenalScroll;
	CScrollRegionParams Params;
	Params.m_ScrollUnit = 120.0f;
	s_ArsenalScroll.Begin(&MainView, &Params);

	const int Columns = Compact ? 1 : 2;
	const float Spacing = 12.0f;
	const float CardWidth = (MainView.w - Spacing * (Columns - 1)) / (float)Columns;
	const float ArtHeight = CardWidth * 256.0f / 384.0f;
	const float CardHeight = ArtHeight + 118.0f;

	for(size_t i = 0; i < NeonArsenal::NUM_CARDS;)
	{
		CUIRect CardRow;
		MainView.HSplitTop(CardHeight, &CardRow, &MainView);
		MainView.HSplitTop(Spacing, nullptr, &MainView);
		if(!s_ArsenalScroll.AddRect(CardRow))
		{
			i += Columns;
			continue;
		}
		for(int Column = 0; Column < Columns && i < NeonArsenal::NUM_CARDS; ++Column, ++i)
		{
		CUIRect Card;
		CardRow.VSplitLeft(CardWidth, &Card, &CardRow);
		CardRow.VSplitLeft(Spacing, nullptr, &CardRow);
		const NeonArsenal::SWeaponCard &Entry = NeonArsenal::g_aCards[i];
		// Unavailable weapons are still shown: a room where something is missing needs an
		// explanation, not a gap.
		Card.Draw(NeonStyle::Dim(NeonStyle::NIGHT_1, 0.92f), NeonStyle::CARD_RADIUS, IGraphics::CORNER_ALL);
		Card.Draw(Entry.m_DropsInNeonDm ? NeonStyle::Dim(NeonStyle::CYAN, 0.6f) : NeonStyle::Dim(NeonStyle::DIM, 0.5f),
			NeonStyle::CARD_RADIUS, IGraphics::CORNER_ALL);
		Card.Margin(10.0f, &Card);

		CUIRect Art, Body;
		Card.HSplitTop(ArtHeight, &Art, &Body);
		RenderAtlasCell(m_ArsenalAtlas, 3, 2, (int)i, &Art, Entry.m_DropsInNeonDm ? 1.0f : 0.45f);

		CUIRect Name, Role;
		Body.HSplitTop(22.0f, &Name, &Body);
		Ui()->DoLabel(&Name, Localize(Entry.m_pName), 18.0f, TEXTALIGN_ML);
		CUIRect Icon;
		Name.VSplitRight(Name.h, &Name, &Icon);
		RenderWeaponIcon((int)i, &Icon, Entry.m_DropsInNeonDm ? 1.0f : 0.35f);
		Body.HSplitTop(16.0f, &Role, &Body);
		TextRender()->TextColor(NeonStyle::CYAN);
		Ui()->DoLabel(&Role, Localize(Entry.m_pRole), 13.0f, TEXTALIGN_ML);
		TextRender()->TextColor(TextRender()->DefaultTextColor());

		SLabelProperties Props;
		Props.m_MaxWidth = Body.w;
		CUIRect How;
		Body.HSplitTop(30.0f, &How, &Body);
		Ui()->DoLabel(&How, Localize(Entry.m_pHow), 12.0f, TEXTALIGN_TL, Props);
		CUIRect Tip;
		Body.HSplitTop(30.0f, &Tip, &Body);
		TextRender()->TextColor(NeonStyle::DIM);
		Ui()->DoLabel(&Tip, Localize(Entry.m_pTip), 12.0f, TEXTALIGN_TL, Props);
		TextRender()->TextColor(TextRender()->DefaultTextColor());

		CUIRect Stats;
		Body.HSplitTop(18.0f, &Stats, nullptr);
		char aDamage[32], aDelay[32], aAmmo[32], aDrop[32];
		str_format(aDamage, sizeof(aDamage), "%d", Entry.m_Damage);
		str_format(aDelay, sizeof(aDelay), "%d ms", Entry.m_FireDelayMs);
		if(Entry.m_MaxAmmo < 0)
			str_copy(aAmmo, Localize("no ammo"), sizeof(aAmmo));
		else
			str_format(aAmmo, sizeof(aAmmo), "%d", Entry.m_MaxAmmo);
		str_copy(aDrop, Entry.m_DropsInNeonDm ? Localize("drops") : Localize("not in pool"), sizeof(aDrop));
		const float Chip = Stats.w / 4.0f;
		for(int c = 0; c < 4; ++c)
		{
			CUIRect ChipRect;
			Stats.VSplitLeft(Chip, &ChipRect, &Stats);
			static const char *apLabels[] = {"damage", "delay", "magazine", "NeonDM"};
			const char *apValues[] = {aDamage, aDelay, aAmmo, aDrop};
			RenderStatChip(&ChipRect, Localize(apLabels[c]), apValues[c],
				c == 3 ? (Entry.m_DropsInNeonDm ? NeonStyle::SUCCESS : NeonStyle::PINK) : NeonStyle::ICE);
		}
		}
	}
	s_ArsenalScroll.End();
}

// ---------------------------------------------------------------- maps

void CMenus::RenderMaps(CUIRect MainView)
{
	const bool Compact = MainView.w < 720.0f;
	MainView.Margin(Compact ? 12.0f : 24.0f, &MainView);

	CUIRect Row;
	MainView.HSplitTop(42.0f, &Row, &MainView);
	char aNote[96];
	str_format(aNote, sizeof(aNote), Localize("%d maps, one blueprint each"), (int)NeonMaps::NUM_CARDS);
	RenderSectionHeader(&Row, Localize("Maps"), aNote);
	MainView.HSplitTop(8.0f, nullptr, &MainView);
	MainView.HSplitTop(30.0f, &Row, &MainView);
	RenderSectionBar(Row, SectionFromPage(m_MenuPage));
	MainView.HSplitTop(12.0f, nullptr, &MainView);

	CUIRect Legend;
	MainView.HSplitTop(18.0f, &Legend, &MainView);
	TextRender()->TextColor(NeonStyle::DIM);
	Ui()->DoLabel(&Legend,
		Localize("Every blueprint is rasterised from the map's own collision layer: rock, death, no-hook, "
			 "teleports, checkpoints, spawns. Numbers are counted on the same pass."),
		12.0f, TEXTALIGN_ML);
	TextRender()->TextColor(TextRender()->DefaultTextColor());
	MainView.HSplitTop(12.0f, nullptr, &MainView);

	static CScrollRegion s_MapsScroll;
	CScrollRegionParams Params;
	Params.m_ScrollUnit = 120.0f;
	s_MapsScroll.Begin(&MainView, &Params);

	const float CardHeight = Compact ? 150.0f : 132.0f;
	for(size_t i = 0; i < NeonMaps::NUM_CARDS; ++i)
	{
		MainView.HSplitTop(CardHeight, &Row, &MainView);
		if(!s_MapsScroll.AddRect(Row))
			continue;
		const NeonMaps::SMapFacts &Entry = NeonMaps::g_aFacts[i];
		CUIRect Card = Row;
		Card.Draw(NeonStyle::Dim(NeonStyle::NIGHT_1, 0.92f), NeonStyle::CARD_RADIUS, IGraphics::CORNER_ALL);
		// Our own six maps get the accent frame; the base-game pool keeps a neutral one, because the
		// page must not imply this fork reshaped someone else's map.
		Card.Draw(NeonStyle::Dim(Entry.m_BaseGame ? NeonStyle::DIM : NeonStyle::CYAN, 0.5f),
			NeonStyle::CARD_RADIUS, IGraphics::CORNER_ALL);

		CUIRect Art, Body;
		Card.VSplitLeft(Card.h * 2.0f, &Art, &Body); // previews are 320x160, i.e. exactly 2:1
		Art.Margin(6.0f, &Art);
		RenderAtlasCell(m_MapPreviews, NeonMaps::PREVIEW_COLS, NeonMaps::PREVIEW_ROWS,
			Entry.m_PreviewCell, &Art, 1.0f);
		Body.Margin(10.0f, &Body);

		CUIRect Name;
		Body.HSplitTop(22.0f, &Name, &Body);
		Ui()->DoLabel(&Name, Localize(Entry.m_pName), 18.0f, TEXTALIGN_ML);
		SLabelProperties Props;
		Props.m_MaxWidth = Body.w;
		CUIRect Blurb;
		Body.HSplitTop(16.0f, &Blurb, &Body);
		TextRender()->TextColor(NeonStyle::CYAN);
		Ui()->DoLabel(&Blurb, Localize(Entry.m_pBlurb), 13.0f, TEXTALIGN_ML, Props);
		TextRender()->TextColor(TextRender()->DefaultTextColor());

		Body.HSplitTop(6.0f, nullptr, &Body);
		char aGrid[32], aSpawns[16], aCps[16], aDeath[16], aNohook[16];
		str_format(aGrid, sizeof(aGrid), "%d\u00d7%d", Entry.m_TilesW, Entry.m_TilesH);
		str_format(aSpawns, sizeof(aSpawns), "%d", Entry.m_Spawns);
		str_format(aCps, sizeof(aCps), "%d", Entry.m_Checkpoints);
		str_format(aDeath, sizeof(aDeath), "%d", Entry.m_DeathTiles);
		str_format(aNohook, sizeof(aNohook), "%d", Entry.m_NohookTiles);
		const char *apLabels[] = {"grid", "spawns", "checkpoints", "death tiles", "no-hook"};
		const char *apValues[] = {aGrid, aSpawns, aCps, aDeath, aNohook};
		const float Chip = Body.w / 5.0f;
		for(int c = 0; c < 5; ++c)
		{
			CUIRect ChipRect;
			Body.VSplitLeft(Chip, &ChipRect, &Body);
			RenderStatChip(&ChipRect, Localize(apLabels[c]), apValues[c], NeonStyle::ICE);
		}
		// Second line: what makes the map playable, and who to credit for it.
		CUIRect Facts;
		Body.HSplitTop(16.0f, &Facts, &Body);
		char aMode[48], aTileset[64], aLicense[32], aDrops[32];
		str_copy(aMode, Localize(Entry.m_RaceReady ? "race" : Entry.m_NeonDmReady ? "deathmatch" : "no spawns"),
			sizeof(aMode));
		// Base-game maps print their licence here: their tileset asset names belong to upstream,
		// and the branding gate keeps those out of user-facing strings.
		str_copy(aTileset, Entry.m_pTileset[0] ? Entry.m_pTileset : Entry.m_pLicense,
			sizeof(aTileset));
		str_copy(aLicense, Entry.m_pLicense[0] ? Entry.m_pLicense : Localize("base game"), sizeof(aLicense));
		str_format(aDrops, sizeof(aDrops), Localize("%d drops, %d hazards"), Entry.m_Pickups, Entry.m_Hazards);
		const char *apFactLabels[] = {"mode", "tileset", "licence", "in the map"};
		const char *apFactValues[] = {aMode, aTileset, aLicense, aDrops};
		TextRender()->TextColor(NeonStyle::DIM);
		for(int c = 0; c < 4; ++c)
		{
			CUIRect FactRect;
			Body.VSplitLeft(Body.w / (float)(4 - c), &FactRect, &Body);
			char aLine[192];
			str_format(aLine, sizeof(aLine), "%s %s", Localize(apFactLabels[c]), apFactValues[c]);
			Ui()->DoLabel(&FactRect, aLine, 11.0f, TEXTALIGN_ML);
		}
		TextRender()->TextColor(TextRender()->DefaultTextColor());
	}
	s_MapsScroll.End();

	CUIRect Footer;
	MainView.HSplitTop(16.0f, nullptr, &MainView);
	MainView.HSplitTop(32.0f, &Footer, &MainView);
	SLabelProperties FootProps;
	FootProps.m_MaxWidth = Footer.w;
	TextRender()->TextColor(NeonStyle::DIM);
	Ui()->DoLabel(&Footer,
		Localize("The pool is read, not described: the base-game maps count the same entities this page shows, "
			 "and their credits come from data/maps/license.txt. Neon Relay only reshapes its own six."),
		12.0f, TEXTALIGN_TL, FootProps);
	TextRender()->TextColor(TextRender()->DefaultTextColor());
}
