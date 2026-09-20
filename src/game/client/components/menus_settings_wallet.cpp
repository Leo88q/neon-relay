/* Neon Relay — Settings → Wallet page (spec requirement 11).
 *
 * Shows the sanitized wallet state that crosses the bridge from the Android
 * wallet layer (src/neonrelay/wallet_bridge.h) and lets the player request a
 * connect/disconnect. The page never displays amounts, prices or earning
 * promises: rewards are decided server-side (docs/REWARD_SECURITY.md) and the
 * copy below states plainly that nothing is guaranteed and that the wallet is
 * optional for playing.
 */
#include "menus.h"

#include <base/color.h>
#include <base/log.h>
#include <base/time.h>
#include <algorithm>
#include <cmath>
#include <game/client/animstate.h>
#include <game/client/gameclient.h>
#include <game/client/render.h>
#include <game/client/potato_catalog.h>
#include <game/client/race_catalog.h>
#include <base/str.h>
#include <engine/graphics.h>
#include <engine/textrender.h>
#include <engine/storage.h>
#include <game/client/ui.h>
#include <game/client/ui_scrollregion.h>
#include <game/localization.h>
#include <neonrelay/wallet_bridge.h>

void CMenus::RenderSettingsWallet(CUIRect MainView)
{
	const NeonRelayWalletInfo *pInfo = neonrelay_wallet_info();
	MainView.Margin(MainView.w < 500.0f ? 12.0f : 24.0f, &MainView);
	CUIRect Header, Line, Panel;
	MainView.HSplitTop(42.0f, &Header, &MainView);
	Ui()->DoLabel(&Header, Localize("Wallet"), 28.0f, TEXTALIGN_ML);

	// Wrapped content lives inside a scroll region, never under the navigation.
	static CScrollRegion s_WalletScroll;
	CScrollRegionParams ScrollParams;
	ScrollParams.m_ScrollUnit = 48.0f;
	s_WalletScroll.Begin(&MainView, &ScrollParams);
	const auto Paragraph = [&](const char *pText, float Size = 14.0f) {
		SLabelProperties Props;
		Props.m_MaxWidth = MainView.w;
		const float Height = TextRender()->TextBoundingBox(Size, pText, -1, MainView.w).m_H + 12.0f;
		MainView.HSplitTop(Height, &Line, &MainView);
		s_WalletScroll.AddRect(Line);
		Ui()->DoLabel(&Line, pText, Size, TEXTALIGN_TL, Props);
	};

	MainView.HSplitTop(pInfo->connected ? 128.0f : 72.0f, &Panel, &MainView);
	RenderFormAPanel(Panel, 16.0f, ColorRGBA(0.047f, 0.0745f, 0.2039f, 0.96f), ColorRGBA(0.1647f, 0.5294f, 0.5922f, 0.85f), true, false, 0.0f, ColorRGBA(0.3725f, 0.8902f, 0.9608f, 1.0f));
	s_WalletScroll.AddRect(Panel);
	Panel.Margin(16.0f, &Panel);
	Panel.HSplitTop(28.0f, &Line, &Panel);
	const char *pStatus = pInfo->requesting ? Localize("Waiting for the wallet app…") :
		pInfo->connected ? Localize("Wallet connected") :
		pInfo->error_message[0] ? Localize("Wallet error") : Localize("No wallet connected");
	TextRender()->TextColor(pInfo->connected ? ColorRGBA(0.35f, 0.9f, 0.75f, 1.0f) : ColorRGBA(0.75f, 0.83f, 0.95f, 1.0f));
	Ui()->DoLabel(&Line, pStatus, 18.0f, TEXTALIGN_ML);
	TextRender()->TextColor(TextRender()->DefaultTextColor());
	if(pInfo->connected)
	{
		char aBuf[384];
		SLabelProperties Props;
		Props.m_EllipsisAtEnd = true;
		Props.m_StopAtEnd = true;
		Panel.HSplitTop(26.0f, &Line, &Panel);
		str_format(aBuf, sizeof(aBuf), Localize("Account: %s"), pInfo->account_label);
		Ui()->DoLabel(&Line, aBuf, 14.0f, TEXTALIGN_ML, Props);
		Panel.HSplitTop(26.0f, &Line, &Panel);
		str_format(aBuf, sizeof(aBuf), "%.12s…", pInfo->public_key_base64);
		Ui()->DoLabel(&Line, aBuf, 14.0f, TEXTALIGN_ML, Props);
	}
	MainView.HSplitTop(16.0f, nullptr, &MainView);
	if(pInfo->error_message[0])
		Paragraph(pInfo->error_message);

	MainView.HSplitTop(44.0f, &Line, &MainView);
	s_WalletScroll.AddRect(Line);
	static CButtonContainer s_Connect, s_Disconnect;
	if(pInfo->connected)
	{
		if(DoButton_Menu(&s_Disconnect, Localize("Disconnect wallet"), 0, &Line))
			neonrelay_wallet_request_disconnect();
	}
	else if(!pInfo->requesting)
	{
		if(DoButton_Menu(&s_Connect, Localize("Connect wallet"), 0, &Line))
			neonrelay_wallet_request_connect();
	}
	else
		Ui()->DoLabel(&Line, Localize("Waiting…"), 16.0f, TEXTALIGN_MC);
	MainView.HSplitTop(20.0f, nullptr, &MainView);
	Paragraph(Localize("The wallet is optional — you can play Neon Relay without connecting one."));
	Paragraph(Localize("Neon Relay never asks for your seed phrase or private key, and the game never sees them."));
	MainView.HSplitTop(12.0f, nullptr, &MainView);
	Paragraph("SKR / POTATO", 22.0f);
	Paragraph(Localize("Payments, prize claims and NFT purchases are unavailable in this build."));
	// Configuration alone must never enable a money-moving action.
	const bool Configured = g_Config.m_ClNeonrelayBackendUrl[0] && g_Config.m_ClNeonrelayRpcUrl[0] &&
		g_Config.m_ClNeonrelayEconomyProgram[0] && g_Config.m_ClNeonrelaySkrMint[0];
	Paragraph(Configured ? Localize("Service configuration present. Transactions remain disabled.") :
		Localize("Transaction service is not configured."));
	Paragraph(Localize("Tokens used for testing are devnet test tokens: they have no value and are not an official currency."));
	Paragraph(Localize("Rewards depend on server-verified match results, daily and weekly limits, and sealed reward epochs. No earnings are guaranteed."));
	s_WalletScroll.End();
}

// Product pages use read-only catalogs until verified settlement is available.
void CMenus::RenderRaceLobby(CUIRect MainView)
{
	const bool Compact = MainView.w < 620.0f;
	MainView.Margin(Compact ? 12.0f : 24.0f, &MainView);
	CUIRect Row, Tab, Footer;
	MainView.HSplitTop(42.0f, &Row, &MainView);
	Ui()->DoLabel(&Row, Localize("Races"), 28.0f, TEXTALIGN_ML);
	MainView.HSplitTop(44.0f, &Row, &MainView);
	static int s_Currency = 0;
	static CButtonContainer s_aCurrencies[2];
	const char *apCurrencies[] = {"SKR", "POTATO"};
	const float TabWidth = (Row.w - 8.0f) / 2.0f;
	for(int i = 0; i < 2; ++i)
	{
		Row.VSplitLeft(TabWidth, &Tab, &Row);
		if(DoButton_MenuTab(&s_aCurrencies[i], apCurrencies[i], s_Currency == i, &Tab, IGraphics::CORNER_ALL))
			s_Currency = i;
		Row.VSplitLeft(8.0f, nullptr, &Row);
	}
	MainView.HSplitTop(12.0f, nullptr, &MainView);
	// Practice stays outside the scroll region, including on short screens.
	MainView.HSplitBottom(44.0f, &MainView, &Footer);
	MainView.HSplitBottom(12.0f, &MainView, nullptr);
	static CButtonContainer s_Practice;
	if(DoButton_Menu(&s_Practice, Localize("Practice - server browser"), 0, &Footer))
		SetMenuPage(PAGE_INTERNET);

	static CScrollRegion s_RaceScroll;
	CScrollRegionParams ScrollParams;
	ScrollParams.m_ScrollUnit = 80.0f;
	s_RaceScroll.Begin(&MainView, &ScrollParams);
	const auto Paragraph = [&](const char *pText) {
		SLabelProperties Props;
		Props.m_MaxWidth = MainView.w;
		const float Height = TextRender()->TextBoundingBox(14.0f, pText, -1, MainView.w).m_H + 16.0f;
		MainView.HSplitTop(Height, &Row, &MainView);
		s_RaceScroll.AddRect(Row);
		Ui()->DoLabel(&Row, pText, 14.0f, TEXTALIGN_TL, Props);
	};
	// The free local course is separate from the currency-dependent race tiers.
	MainView.HSplitTop(Compact ? 196.0f : 164.0f, &Row, &MainView);
	if(s_RaceScroll.AddRect(Row))
	{
		RenderFormAPanel(Row, 12.0f, ColorRGBA(0.047f, 0.0745f, 0.2039f, 0.92f), ColorRGBA(0.1647f, 0.5294f, 0.5922f, 0.75f), true, false, 0.0f, ColorRGBA(0.3725f, 0.8902f, 0.9608f, 1.0f));
		Row.Margin(12.0f, &Row);
		CUIRect Name, Detail, Action;
		Row.HSplitBottom(40.0f, &Row, &Action);
		Row.HSplitTop(28.0f, &Name, &Row);
		Ui()->DoLabel(&Name, Localize("Warmup", "Original course"), 22.0f, TEXTALIGN_ML);
		Row.HSplitTop(24.0f, &Detail, &Row);
		TextRender()->TextColor(ColorRGBA(0.47f, 0.92f, 0.60f, 1.0f));
		Ui()->DoLabel(&Detail, Localize("Beginner / Solo / Free"), 14.0f, TEXTALIGN_ML);
		TextRender()->TextColor(TextRender()->DefaultTextColor());
		SLabelProperties Props;
		Props.m_MaxWidth = Row.w;
		Ui()->DoLabel(&Row, Localize("Original course. Local practice, no wallet or ranked prizes."), 14.0f, TEXTALIGN_TL, Props);
		static CButtonContainer s_Warmup;
		const bool Running = GameClient()->m_LocalServer.IsWarmupRunning();
		if(g_Config.m_Debug && Ui()->MouseButtonClicked(0))
			log_info("practice-ui", "click=(%.1f,%.1f) button=(%.1f,%.1f,%.1f,%.1f)", Ui()->MouseX(), Ui()->MouseY(), Action.x, Action.y, Action.w, Action.h);
		if(DoButton_Menu(&s_Warmup, Running ? Localize("Stop practice server") : Localize("Start Warmup"), 0, &Action))
		{
			if(Running)
				GameClient()->m_LocalServer.StopWarmup();
			else
				GameClient()->m_LocalServer.StartWarmup();
		}
	}
	MainView.HSplitTop(12.0f, nullptr, &MainView);
	Paragraph(Localize("Preview only. Paid entry is not available yet."));
	for(const auto &Race : RACE_CATALOG)
	{
		MainView.HSplitTop(Compact ? 108.0f : 84.0f, &Row, &MainView);
		const bool Visible = s_RaceScroll.AddRect(Row);
		if(Visible)
		{
			RenderFormAPanel(Row, 12.0f, ColorRGBA(0.047f, 0.0745f, 0.2039f, 0.92f), ColorRGBA(0.1647f, 0.5294f, 0.5922f, 0.75f), true, false, 0.0f, ColorRGBA(0.3725f, 0.8902f, 0.9608f, 1.0f));
			Row.Margin(12.0f, &Row);
			CUIRect Name, Players, Fee;
			Row.HSplitTop(28.0f, &Name, &Row);
			if(Compact)
			{
				Row.HSplitTop(26.0f, &Fee, &Row);
				Row.HSplitTop(26.0f, &Players, &Row);
			}
			else
			{
				Name.VSplitRight(180.0f, &Name, &Fee);
				Row.HSplitTop(28.0f, &Players, &Row);
			}
			Ui()->DoLabel(&Name, Race.m_pName, 19.0f, TEXTALIGN_ML);
			char aBuf[128];
			str_format(aBuf, sizeof(aBuf), Localize("Players: %s"), Race.m_pPlayers);
			TextRender()->TextColor(ColorRGBA(0.68f, 0.77f, 0.89f, 1.0f));
			Ui()->DoLabel(&Players, Race.m_LegendaryOnly ? Localize("Legendary holders only") : aBuf, 14.0f, TEXTALIGN_ML);
			TextRender()->TextColor(ColorRGBA(0.35f, 0.9f, 0.8f, 1.0f));
			str_format(aBuf, sizeof(aBuf), "%s %s", Race.m_pEntry, apCurrencies[s_Currency]);
			Ui()->DoLabel(&Fee, aBuf, 16.0f, Compact ? TEXTALIGN_ML : TEXTALIGN_MR);
			TextRender()->TextColor(TextRender()->DefaultTextColor());
		}
		MainView.HSplitTop(10.0f, nullptr, &MainView);
	}
	Paragraph(Localize("Prize pool: 90% players / 10% developer"));
	Paragraph(Localize("Top 10: 25 / 18 / 14 / 11 / 9 / 7 / 6 / 5 / 3 / 2%"));
	s_RaceScroll.End();
}

void CMenus::RenderCharacterPortrait(CUIRect Rect, int Index)
{
	if(Index < 0 || Index >= 10) return;
	auto &Portrait = m_aCharacterPortraits[Index];
	if(!Portrait.IsValid())
	{
		char aPath[128];
		str_format(aPath, sizeof(aPath), "portraits/%s.png", POTATO_CATALOG[Index % 10].m_pSkin);
		Portrait = Graphics()->LoadTexture(aPath, IStorage::TYPE_ALL);
		if(!Portrait.IsValid())
		{
			str_format(aPath, sizeof(aPath), "skins/%s.png", POTATO_CATALOG[Index % 10].m_pSkin);
			Portrait = Graphics()->LoadTexture(aPath, IStorage::TYPE_ALL);
		}
	}
	if(!Portrait.IsValid()) return;

	const auto &Entry = POTATO_CATALOG[Index % 10];
	ColorRGBA BorderColor = ColorRGBA(0.3725f, 0.8902f, 0.9608f, 0.95f);
	int Diamonds = 1;
	if(Entry.m_PriceSkr == 1000) { BorderColor = ColorRGBA(0.6275f, 0.4667f, 1.0f, 0.95f); Diamonds = 2; }
	else if(Entry.m_PriceSkr == 2000) { BorderColor = ColorRGBA(1.0f, 0.7843f, 0.3412f, 0.95f); Diamonds = 3; }

	// Light background behind character – not dark, so portrait is bright
	CUIRect Bg = Rect;
	Bg.Draw(ColorRGBA(0.12f, 0.18f, 0.32f, 0.88f), IGraphics::CORNER_ALL, 10.0f); // lighter, not dark, so portrait bright

	CUIRect Inner = Rect;
	Inner.Margin(6.0f, &Inner);
	float Size = std::min(Inner.w, Inner.h * 0.88f);
	// Draw portrait with full brightness, no dark overlay
	Graphics()->TextureSet(Portrait);
	Graphics()->QuadsBegin();
	Graphics()->SetColor(1.0f, 1.0f, 1.0f, 1.0f);
	IGraphics::CQuadItem Quad(Inner.x + (Inner.w - Size) / 2.0f, Inner.y + (Inner.h - Size) / 2.0f, Size, Size);
	Graphics()->QuadsDrawTL(&Quad, 1);
	Graphics()->QuadsEnd();

	// Border only – no background, so character stays bright
	GameClient()->m_Menus.RenderFormAPanel(Rect, 12.0f, ColorRGBA(0,0,0,0), BorderColor, true, false, 0.0f, BorderColor);

	float dx = Rect.x + Rect.w / 2.0f - (Diamonds * 10.0f) / 2.0f;
	float dy = Rect.y + Rect.h - 14.0f;
	for(int d = 0; d < Diamonds; ++d)
	{
		CUIRect Diamond = {dx + d * 10.0f, dy, 6.0f, 6.0f};
		Diamond.Draw(BorderColor, IGraphics::CORNER_ALL, 1.5f);
	}
}

void CMenus::RenderCharacters(CUIRect MainView)
{
	MainView.Margin(16.0f, &MainView);
	const bool Russian = str_find(g_Config.m_ClLanguagefile, "russian") != nullptr;
	CUIRect Row;
	MainView.HSplitTop(30.0f, &Row, &MainView);
	Ui()->DoLabel(&Row, Localize("Characters"), 24.0f, TEXTALIGN_ML);
	MainView.HSplitTop(26.0f, &Row, &MainView);
	Ui()->DoLabel(&Row, Russian ? "Витрина • Покупки NFT пока недоступны. Только примерка." : "Store preview • NFT purchases unavailable. Local try-on only.", 12.0f, TEXTALIGN_ML);
	bool Compact = MainView.w < 760.0f;
#if defined(CONF_PLATFORM_ANDROID)
	Compact = true;
#endif
	static bool s_DetailOpen = false;
	static int s_Page = 0;
	static CButtonContainer s_Previous, s_Next, s_Back;
	CUIRect Grid, Details;
	if(Compact)
	{
		MainView.HSplitTop(42.0f, &Row, &MainView);
		if(s_DetailOpen)
		{
			if(DoButton_Menu(&s_Back, Russian ? "Назад к коллекции" : "Back to collection", 0, &Row)) s_DetailOpen = false;
		}
		else
		{
			CUIRect Prev, Next, Count;
			Row.VSplitLeft(55.0f, &Prev, &Count); Count.VSplitRight(55.0f, &Count, &Next);
			if(DoButton_Menu(&s_Previous, "<", 0, &Prev)) s_Page = (s_Page+2)%3;
			if(DoButton_Menu(&s_Next, ">", 0, &Next)) s_Page = (s_Page+1)%3;
			char aPage[32]; str_format(aPage, sizeof(aPage), "%d / 3", s_Page+1);
			Ui()->DoLabel(&Count, aPage, 16.0f, TEXTALIGN_MC);
		}
		MainView.HSplitTop(10.0f, nullptr, &MainView);
		Grid = MainView; Details = MainView;
	}
	else
	{
		MainView.VSplitLeft(MainView.w * 0.61f, &Grid, &Details);
		Details.VSplitLeft(12.0f, nullptr, &Details);
	}
	// Details panel – Form A window 16px chamfer, Deck #0C1334, cyan dim border, impulse 5s
	{
		float t = (time_get() / (float)time_freq());
		float prog = std::fmod(t, 5.0f) / 5.0f;
		RenderFormAPanel(Details, 16.0f, ColorRGBA(0.047f, 0.0745f, 0.2039f, 0.96f), ColorRGBA(0.1647f, 0.5294f, 0.5922f, 0.85f), true, true, prog, ColorRGBA(0.3725f, 0.8902f, 0.9608f, 1.0f));
	}
	Details.Margin(12.0f, &Details);
	static int s_Selected = 0;
	static CButtonContainer s_aSelect[10], s_TryOn;
	const int Columns = Compact ? 2 : 5;
	const float Width = Grid.w / Columns;
	const float Height = std::min(Grid.h / 2.0f, 190.0f);
	for(int Slot = 0; Slot < (Compact ? 4 : 10) && (!Compact || !s_DetailOpen); ++Slot)
	{
		const int i = Compact ? s_Page*4+Slot : Slot;
		if(i >= 10) break;
		const auto &Entry = POTATO_CATALOG[i];
		CUIRect Card = {Grid.x + (Slot % Columns) * Width, Grid.y + (Slot / Columns) * Height, Width - 5.0f, Height - 5.0f};
		// Card background Form A 12px, rarity border
		ColorRGBA BorderColor = ColorRGBA(0.3725f, 0.8902f, 0.9608f, 0.85f);
		ColorRGBA ImpulseColor = BorderColor;
		float ImpulseDur = 5.0f;
		if(Entry.m_PriceSkr == 1000) { BorderColor = ColorRGBA(0.6275f, 0.4667f, 1.0f, 0.9f); ImpulseColor = BorderColor; }
		else if(Entry.m_PriceSkr == 2000) { BorderColor = ColorRGBA(1.0f, 0.7843f, 0.3412f, 0.95f); ImpulseColor = BorderColor; ImpulseDur = 6.0f; }

		bool IsSelected = s_Selected == i;
		// Draw card panel – lighter for bright portraits, not dark blurred
		{
			float t = (time_get() / (float)time_freq());
			float prog = std::fmod(t, ImpulseDur) / ImpulseDur;
			RenderFormAPanel(Card, 12.0f, ColorRGBA(0.09f, 0.14f, 0.26f, 0.85f), BorderColor, true, IsSelected, prog, ImpulseColor);
		}
		if(DoButton_Menu(&s_aSelect[i], "", IsSelected, &Card, BUTTONFLAG_LEFT, nullptr, IGraphics::CORNER_ALL, 6.0f, 0.0f, ColorRGBA(0.047f, 0.0745f, 0.2039f, 0.0f)))
		{ s_Selected = i; if(Compact) s_DetailOpen = true; }
		CUIRect Portrait = Card;
		Portrait.Margin(4.0f, &Portrait);
		Portrait.h = Height * 0.57f;
		RenderCharacterPortrait(Portrait, i);
		Card.HSplitTop(Height * 0.57f, nullptr, &Card);
		Card.HSplitTop(20.0f, &Row, &Card);
		Ui()->DoLabel(&Row, Russian ? Entry.m_pNameRu : Entry.m_pName, 13.0f, TEXTALIGN_MC);
		Card.HSplitTop(18.0f, &Row, &Card);
		Ui()->DoLabel(&Row, Entry.m_pRarity, 10.0f, TEXTALIGN_MC);
		Card.HSplitTop(20.0f, &Row, &Card);
		char aPrice[32];
		str_format(aPrice, sizeof(aPrice), "%d SKR", Entry.m_PriceSkr);
		Ui()->DoLabel(&Row, aPrice, 13.0f, TEXTALIGN_MC);
	}
	if(Compact && !s_DetailOpen) return;
	const auto &Entry = POTATO_CATALOG[s_Selected];
	CUIRect Footer;
	Details.HSplitBottom(84.0f, &Details, &Footer);
	Details.HSplitTop(26.0f, &Row, &Details);
	Ui()->DoLabel(&Row, Russian ? Entry.m_pNameRu : Entry.m_pName, 22.0f, TEXTALIGN_ML);
	Details.HSplitTop(20.0f, &Row, &Details);
	Ui()->DoLabel(&Row, Russian ? Entry.m_pTitleRu : Entry.m_pTitle, 13.0f, TEXTALIGN_ML);
	Details.HSplitTop(Compact ? 130.0f : 112.0f, &Row, &Details);
	RenderCharacterPortrait(Row, s_Selected);
	const char *pSkill = Russian ? Entry.m_pSkillRu : Entry.m_pSkill;
	const char *pLegend = Russian ? Entry.m_pLegendRu : Entry.m_pLegend;
	float Font = 12.0f;
	while(Font > 8.0f && TextRender()->TextBoundingBox(Font, pSkill, -1, Details.w).m_H + TextRender()->TextBoundingBox(Font, pLegend, -1, Details.w).m_H + 16.0f > Details.h)
		Font -= 0.5f;
	SLabelProperties Wrapped;
	Wrapped.m_MaxWidth = Details.w;
	for(const char *pText : {pSkill, pLegend})
	{
		const float H = TextRender()->TextBoundingBox(Font, pText, -1, Details.w).m_H + 8.0f;
		Details.HSplitTop(H, &Row, &Details);
		Ui()->DoLabel(&Row, pText, Font, TEXTALIGN_TL, Wrapped);
	}
	Footer.HSplitTop(32.0f, &Row, &Footer);
	Wrapped.m_MaxWidth = Row.w;
	Ui()->DoLabel(&Row, Russian ? "Навыки — только легенда. Бонусов к физике нет." : "Skills are lore only. No gameplay bonuses.", 10.0f, TEXTALIGN_TL, Wrapped);
	Footer.HSplitTop(44.0f, &Row, &Footer);
	if(DoButton_Menu(&s_TryOn, Russian ? "Примерить бесплатно (тест)" : "Try on free (preview)", 0, &Row))
	{
		str_copy(g_Config.m_ClPlayerSkin, Entry.m_pSkin);
		g_Config.m_ClPlayerUseCustomColor = 0;
		g_Config.m_ClVanillaSkinsOnly = 0;
		m_NeedSendinfo = true;
	}
}

void CMenus::RenderLeaders(CUIRect MainView)
{
	MainView.Margin(MainView.w < 620.0f ? 12.0f : 24.0f, &MainView);
	CUIRect Row, Footer;
	MainView.HSplitTop(42.0f, &Row, &MainView);
	Ui()->DoLabel(&Row, Localize("Leaders"), 28.0f, TEXTALIGN_ML);
	MainView.HSplitBottom(44.0f, &MainView, &Footer);
	MainView.HSplitBottom(12.0f, &MainView, nullptr);
	static CButtonContainer s_Races;
	if(DoButton_Menu(&s_Races, Localize("View races"), 0, &Footer))
		SetMenuPage(PAGE_RACES);
	{ float t=(time_get()/(float)time_freq()); float prog=std::fmod(t,5.0f)/5.0f; RenderFormAPanel(MainView, 16.0f, ColorRGBA(0.047f, 0.0745f, 0.2039f, 0.96f), ColorRGBA(0.1647f, 0.5294f, 0.5922f, 0.85f), true, true, prog, ColorRGBA(0.3725f, 0.8902f, 0.9608f, 1.0f)); }
	MainView.Margin(16.0f, &MainView);
	static CScrollRegion s_LeadersScroll;
	CScrollRegionParams ScrollParams;
	s_LeadersScroll.Begin(&MainView, &ScrollParams);
	const char *apMessages[] = {
		Localize("No verified results yet"),
		Localize("Rankings are unavailable until the race service is connected."),
		Localize("Only verified race results will appear here. Practice does not award ranked prizes."),
	};
	for(int i = 0; i < 3; ++i)
	{
		const float Size = i == 0 ? 22.0f : 15.0f;
		SLabelProperties Props;
		Props.m_MaxWidth = MainView.w;
		const float Height = TextRender()->TextBoundingBox(Size, apMessages[i], -1, MainView.w).m_H + 20.0f;
		MainView.HSplitTop(Height, &Row, &MainView);
		s_LeadersScroll.AddRect(Row);
		Ui()->DoLabel(&Row, apMessages[i], Size, TEXTALIGN_TL, Props);
	}
	s_LeadersScroll.End();
}
