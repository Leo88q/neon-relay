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
#include <algorithm>
#include <game/client/animstate.h>
#include <game/client/gameclient.h>
#include <game/client/render.h>
#include <game/client/potato_catalog.h>
#include <game/client/race_catalog.h>
#include <base/str.h>
#include <engine/graphics.h>
#include <engine/textrender.h>
#include <game/client/ui.h>
#include <game/localization.h>
#include <neonrelay/wallet_bridge.h>

void CMenus::RenderSettingsWallet(CUIRect MainView)
{
	const NeonRelayWalletInfo *pInfo = neonrelay_wallet_info();

	CUIRect Header, Part;
	MainView.HSplitTop(40.0f, &Header, &MainView);
	Ui()->DoLabel(&Header, Localize("Wallet"), 24.0f, TEXTALIGN_ML);
	MainView.HSplitTop(10.0f, nullptr, &MainView);

	// ---- status box -------------------------------------------------------
	MainView.HSplitTop(90.0f, &Part, &MainView);
	Part.Draw(ColorRGBA(0.0f, 0.0f, 0.0f, 0.25f), IGraphics::CORNER_ALL, 10.0f);
	CUIRect StatusInner;
	Part.Margin(14.0f, &StatusInner);

	ColorRGBA StatusColor;
	const char *pStatusText;
	if(pInfo->requesting)
	{
		StatusColor = ColorRGBA(1.0f, 0.85f, 0.35f, 1.0f);
		pStatusText = Localize("Waiting for the wallet app…");
	}
	else if(pInfo->connected)
	{
		StatusColor = ColorRGBA(0.45f, 1.0f, 0.45f, 1.0f);
		pStatusText = Localize("Wallet connected");
	}
	else if(pInfo->error_message[0] != '\0')
	{
		StatusColor = ColorRGBA(1.0f, 0.45f, 0.4f, 1.0f);
		pStatusText = Localize("Wallet error");
	}
	else
	{
		StatusColor = ColorRGBA(0.8f, 0.8f, 0.8f, 1.0f);
		pStatusText = Localize("No wallet connected");
	}

	CUIRect Line;
	StatusInner.HSplitTop(24.0f, &Line, &StatusInner);
	TextRender()->TextColor(StatusColor);
	Ui()->DoLabel(&Line, pStatusText, 18.0f, TEXTALIGN_ML);
	TextRender()->TextColor(TextRender()->DefaultTextColor());

	char aBuf[384];
	if(pInfo->connected)
	{
		StatusInner.HSplitTop(20.0f, &Line, &StatusInner);
		str_format(aBuf, sizeof(aBuf), Localize("Account: %s"), pInfo->account_label);
		Ui()->DoLabel(&Line, aBuf, 14.0f, TEXTALIGN_ML);

		StatusInner.HSplitTop(20.0f, &Line, &StatusInner);
		str_format(aBuf, sizeof(aBuf), Localize("Public key: %.12s… (fingerprint only — never a secret)"),
			pInfo->public_key_base64);
		TextRender()->TextColor(ColorRGBA(0.75f, 0.75f, 0.75f, 1.0f));
		Ui()->DoLabel(&Line, aBuf, 13.0f, TEXTALIGN_ML);
		TextRender()->TextColor(TextRender()->DefaultTextColor());
	}
	else if(pInfo->error_message[0] != '\0')
	{
		StatusInner.HSplitTop(20.0f, &Line, &StatusInner);
		str_format(aBuf, sizeof(aBuf), "%s", pInfo->error_message);
		TextRender()->TextColor(ColorRGBA(0.9f, 0.6f, 0.55f, 1.0f));
		Ui()->DoLabel(&Line, aBuf, 13.0f, TEXTALIGN_ML);
		TextRender()->TextColor(TextRender()->DefaultTextColor());
	}

	// ---- buttons ----------------------------------------------------------
	MainView.HSplitTop(16.0f, nullptr, &MainView);
	MainView.HSplitTop(24.0f, &Part, &MainView);
	CUIRect ButtonRect;
	static CButtonContainer s_ConnectButton;
	static CButtonContainer s_DisconnectButton;
	Part.VSplitLeft(200.0f, &ButtonRect, &Part);

	if(pInfo->connected)
	{
		if(DoButton_Menu(&s_DisconnectButton, Localize("Disconnect wallet"), 0, &ButtonRect))
			neonrelay_wallet_request_disconnect();
	}
	else if(!pInfo->requesting)
	{
		if(DoButton_Menu(&s_ConnectButton, Localize("Connect wallet"), 0, &ButtonRect))
			neonrelay_wallet_request_connect();
	}
	else
	{
		// visually muted, clicks ignored while a request is in flight
		DoButton_Menu(&s_ConnectButton, Localize("Waiting…"), 0, &ButtonRect,
			BUTTONFLAG_LEFT, nullptr, IGraphics::CORNER_ALL, 5.0f, 0.0f,
			ColorRGBA(1.0f, 1.0f, 1.0f, 0.25f));
	}

	// ---- plain-language notes (no earning claims) -------------------------
	MainView.HSplitTop(20.0f, nullptr, &MainView);
	const char *apNotes[] = {
		Localize("The wallet is optional — you can play Neon Relay without connecting one."),
		Localize("Rewards depend on server-verified match results, daily and weekly limits, and sealed reward epochs. No earnings are guaranteed."),
		Localize("Tokens used for testing are devnet test tokens: they have no value and are not an official currency."),
		Localize("Neon Relay never asks for your seed phrase or private key, and the game never sees them."),
	};
	TextRender()->TextColor(ColorRGBA(0.75f, 0.75f, 0.75f, 1.0f));
	for(const char *pNote : apNotes)
	{
		const float Height = TextRender()->TextBoundingBox(13.0f, pNote).m_H + 6.0f;
		CUIRect NoteLine;
		MainView.HSplitTop(Height, &NoteLine, &MainView);
		Ui()->DoLabel(&NoteLine, pNote, 13.0f, TEXTALIGN_TL);
	}
	TextRender()->TextColor(TextRender()->DefaultTextColor());

	// ------------------------------------------------------------- economy (15)
	// SKR pay-to-play panel: entry payments and prize claims are executed by
	// the platform wallet layer (Mobile Wallet Adapter on Seeker devices);
	// this page only requests flows and explains the model (BL-17).
	MainView.HSplitTop(8.0f, nullptr, &MainView);
	MainView.HSplitTop(24.0f, &Header, &MainView);
	Ui()->DoLabel(&Header, Localize("Economy (SKR pay-to-play)"), 20.0f, TEXTALIGN_ML);

	static const char *s_pEconomyNote = Localize("Ranked play and tournaments accept SKR entry fees; 90% of each fee feeds the epoch prize pool and the top 10 ranked players claim prizes from it (docs/PLAY_ECONOMY.md). Payments and claims are signed by your wallet app - this game never sees keys.");
	{
		const float Height = TextRender()->TextBoundingBox(13.0f, s_pEconomyNote).m_H + 6.0f;
		MainView.HSplitTop(Height, &Line, &MainView);
		TextRender()->TextColor(ColorRGBA(0.75f, 0.75f, 0.75f, 1.0f));
		Ui()->DoLabel(&Line, s_pEconomyNote, 13.0f, TEXTALIGN_ML);
		TextRender()->TextColor(TextRender()->DefaultTextColor());
	}

	MainView.HSplitTop(6.0f, nullptr, &MainView);
	MainView.HSplitTop(24.0f, &ButtonRect, &MainView);
	static CButtonContainer s_EconomyEntryButton;
	if(DoButton_Menu(&s_EconomyEntryButton, Localize("Pay ranked epoch entry (SKR)"), 0, &ButtonRect))
	{
		char aJson[384];
		str_format(aJson, sizeof(aJson),
			"{\"action\": \"pay_entry\", \"kind\": 0, \"programId\": \"%s\", \"rpcUrl\": \"%s\", \"backendUrl\": \"%s\", \"mint\": \"%s\"}",
			g_Config.m_ClNeonrelayEconomyProgram, g_Config.m_ClNeonrelayRpcUrl,
			g_Config.m_ClNeonrelayBackendUrl, g_Config.m_ClNeonrelaySkrMint);
		neonrelay_wallet_request_economy(aJson);
	}

	MainView.HSplitTop(4.0f, nullptr, &MainView);
	MainView.HSplitTop(24.0f, &ButtonRect, &MainView);
	static CButtonContainer s_EconomyTournamentButton;
	if(DoButton_Menu(&s_EconomyTournamentButton, Localize("Pay tournament entry (SKR)"), 0, &ButtonRect))
	{
		char aJson[384];
		str_format(aJson, sizeof(aJson),
			"{\"action\": \"pay_entry\", \"kind\": 1, \"programId\": \"%s\", \"rpcUrl\": \"%s\", \"backendUrl\": \"%s\", \"mint\": \"%s\"}",
			g_Config.m_ClNeonrelayEconomyProgram, g_Config.m_ClNeonrelayRpcUrl,
			g_Config.m_ClNeonrelayBackendUrl, g_Config.m_ClNeonrelaySkrMint);
		neonrelay_wallet_request_economy(aJson);
	}

	MainView.HSplitTop(4.0f, nullptr, &MainView);
	MainView.HSplitTop(24.0f, &ButtonRect, &MainView);
	static CButtonContainer s_EconomyClaimButton;
	if(DoButton_Menu(&s_EconomyClaimButton, Localize("Claim my epoch prize"), 0, &ButtonRect))
	{
		char aJson[384];
		str_format(aJson, sizeof(aJson),
			"{\"action\": \"claim\", \"programId\": \"%s\", \"rpcUrl\": \"%s\", \"backendUrl\": \"%s\", \"mint\": \"%s\"}",
			g_Config.m_ClNeonrelayEconomyProgram, g_Config.m_ClNeonrelayRpcUrl,
			g_Config.m_ClNeonrelayBackendUrl, g_Config.m_ClNeonrelaySkrMint);
		neonrelay_wallet_request_economy(aJson);
	}
}

// Product pages use read-only catalogs until verified settlement is available.
void CMenus::RenderRaceLobby(CUIRect MainView)
{
	MainView.Margin(20.0f, &MainView);
	CUIRect Row, Tab;
	MainView.HSplitTop(32.0f, &Row, &MainView);
	Ui()->DoLabel(&Row, Localize("Races"), 24.0f, TEXTALIGN_ML);
	MainView.HSplitTop(30.0f, &Row, &MainView);
	static int s_Currency = 0;
	static CButtonContainer s_aCurrencies[2];
	const char *apCurrencies[] = {"SKR", "POTATO"};
	for(int i = 0; i < 2; ++i)
	{
		Row.VSplitLeft(130.0f, &Tab, &Row);
		if(DoButton_MenuTab(&s_aCurrencies[i], apCurrencies[i], s_Currency == i, &Tab, IGraphics::CORNER_ALL))
			s_Currency = i;
	}
	MainView.HSplitTop(32.0f, &Row, &MainView);
	Ui()->DoLabel(&Row, Localize("Preview only. Paid entry is not available yet."), 14.0f, TEXTALIGN_ML);
	for(const auto &Race : RACE_CATALOG)
	{
		MainView.HSplitTop(46.0f, &Row, &MainView);
		Row.Draw(ColorRGBA(0.05f, 0.02f, 0.12f, 0.8f), IGraphics::CORNER_ALL, 6.0f);
		CUIRect Name, Players, Fee;
		Row.VSplitLeft(Row.w * 0.42f, &Name, &Row);
		Row.VSplitLeft(Row.w * 0.4f, &Players, &Fee);
		Name.VMargin(10.0f, &Name);
		Ui()->DoLabel(&Name, Race.m_pName, 17.0f, TEXTALIGN_ML);
		char aBuf[128];
		str_format(aBuf, sizeof(aBuf), Localize("Players: %s"), Race.m_pPlayers);
		Ui()->DoLabel(&Players, Race.m_LegendaryOnly ? Localize("Legendary holders only") : aBuf, 14.0f, TEXTALIGN_ML);
		str_format(aBuf, sizeof(aBuf), "%s %s", Race.m_pEntry, apCurrencies[s_Currency]);
		Ui()->DoLabel(&Fee, aBuf, 14.0f, TEXTALIGN_ML);
		MainView.HSplitTop(5.0f, nullptr, &MainView);
	}
	MainView.HSplitTop(26.0f, &Row, &MainView);
	Ui()->DoLabel(&Row, Localize("Prize pool: 90% players / 10% developer"), 14.0f, TEXTALIGN_ML);
	MainView.HSplitTop(26.0f, &Row, &MainView);
	Ui()->DoLabel(&Row, Localize("Top 10: 25 / 18 / 14 / 11 / 9 / 7 / 6 / 5 / 3 / 2%"), 13.0f, TEXTALIGN_ML);
	// Existing gameplay remains accessible without pretending it is a paid race.
	MainView.HSplitTop(28.0f, &Row, &MainView);
	Row.w = 260.0f;
	static CButtonContainer s_Practice;
	if(DoButton_Menu(&s_Practice, Localize("Practice - server browser"), 0, &Row))
		SetMenuPage(PAGE_INTERNET);
}

void CMenus::RenderCharacters(CUIRect MainView)
{
	MainView.Margin(20.0f, &MainView);
	CUIRect Row;
	MainView.HSplitTop(32.0f, &Row, &MainView);
	Ui()->DoLabel(&Row, Localize("Characters"), 24.0f, TEXTALIGN_ML);
	MainView.HSplitTop(28.0f, &Row, &MainView);
	Ui()->DoLabel(&Row, Localize("Catalog preview. NFT purchases and equipping are not available yet."), 14.0f, TEXTALIGN_ML);
	const float Width = MainView.w / 5.0f;
	const float Height = std::min(MainView.h / 2.0f, 180.0f);
	for(int i = 0; i < 10; ++i)
	{
		const auto &Entry = POTATO_CATALOG[i];
		CUIRect Card = {MainView.x + (i % 5) * Width, MainView.y + (i / 5) * Height, Width - 6.0f, Height - 6.0f};
		Card.Draw(ColorRGBA(0.05f, 0.02f, 0.12f, 0.8f), IGraphics::CORNER_ALL, 8.0f);
		CTeeRenderInfo Info;
		Info.Apply(GameClient()->m_Skins.Find(Entry.m_pSkin));
		Info.m_Size = 64.0f;
		RenderTools()->RenderTee(CAnimState::GetIdle(), &Info, EMOTE_NORMAL, vec2(1.0f, 0.0f), vec2(Card.x + Card.w / 2.0f, Card.y + 48.0f));
		Card.HSplitTop(90.0f, nullptr, &Card);
		Card.HSplitTop(22.0f, &Row, &Card);
		Ui()->DoLabel(&Row, Entry.m_pName, 13.0f, TEXTALIGN_MC);
		Card.HSplitTop(20.0f, &Row, &Card);
		Ui()->DoLabel(&Row, Entry.m_pRarity, 12.0f, TEXTALIGN_MC);
		Card.HSplitTop(22.0f, &Row, &Card);
		char aPrice[32];
		str_format(aPrice, sizeof(aPrice), "%d SKR", Entry.m_PriceSkr);
		Ui()->DoLabel(&Row, aPrice, 15.0f, TEXTALIGN_MC);
	}
}

void CMenus::RenderLeaders(CUIRect MainView)
{
	MainView.Margin(20.0f, &MainView);
	CUIRect Row;
	MainView.HSplitTop(40.0f, &Row, &MainView);
	Ui()->DoLabel(&Row, Localize("Leaders"), 24.0f, TEXTALIGN_ML);
	MainView.HSplitTop(30.0f, &Row, &MainView);
	Ui()->DoLabel(&Row, Localize("Rankings are unavailable until the race service is connected."), 15.0f, TEXTALIGN_ML);
}
