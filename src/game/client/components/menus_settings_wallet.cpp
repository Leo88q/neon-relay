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
#include <game/client/neon_progress.h>
#include <game/client/neon_style.h>
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

// ---------------------------------------------------------------------------
// Local progress + daily quests (cosmetic; see src/game/client/neon_progress.h).
// Kept in this file because these panels belong to the product pages, not to the
// generic menu plumbing, and because the copy has to stay aligned with the
// "no earnings are guaranteed" wording of the wallet page.
// ---------------------------------------------------------------------------
void CMenus::RenderProgressStrip(CUIRect Rect)
{
	const int Xp = g_Config.m_ClNeonXp;
	const int Level = NeonProgress::LevelFromXp(Xp);
	const int Next = NeonProgress::XpForLevel(Level + 1);
	const bool Capped = Level >= NeonProgress::MAX_LEVEL;
	char aBuf[128];

	CUIRect Icons, Bar, Quests;
	Rect.HSplitTop(20.0f, &Icons, &Rect);
	Rect.HSplitTop(10.0f, &Bar, &Rect);
	Rect.HSplitTop(6.0f, nullptr, &Rect);
	Quests = Rect;

	CUIRect Left = Icons, Right = Icons;
	Left.VSplitLeft(Icons.w * 0.5f, &Left, nullptr);
	Right.VSplitRight(150.0f, &Right, nullptr);

	CUIRect LevelIcon = Left;
	LevelIcon.VSplitLeft(20.0f, &LevelIcon, &Left);
	RenderIcon(NeonStyle::ICON_LEVEL_RING, &LevelIcon, NeonStyle::CYAN);
	str_format(aBuf, sizeof(aBuf), Localize("Level %d"), Level);
	Ui()->DoLabel(&Left, aBuf, 15.0f, TEXTALIGN_ML);

	CUIRect StreakIcon = Right;
	StreakIcon.VSplitLeft(18.0f, &StreakIcon, &Right);
	RenderIcon(NeonStyle::ICON_STREAK_FLAME, &StreakIcon, NeonStyle::PINK, g_Config.m_ClNeonStreak > 0 ? 1.0f : 0.35f);
	str_format(aBuf, sizeof(aBuf), Localize("%d-day streak"), g_Config.m_ClNeonStreak);
	Ui()->DoLabel(&Right, aBuf, 14.0f, TEXTALIGN_ML);

	if(!Capped)
	{
		str_format(aBuf, sizeof(aBuf), "%d / %d XP", Xp - NeonProgress::XpForLevel(Level), Next - NeonProgress::XpForLevel(Level));
		Ui()->DoLabel(&Bar, aBuf, 11.0f, TEXTALIGN_MR);
		CUIRect BarRect = Bar;
		BarRect.VSplitRight(160.0f, &BarRect, nullptr);
		BarRect.VSplitLeft(BarRect.w - 170.0f, &BarRect, nullptr);
		BarRect.Margin(1.0f, &BarRect);
		Ui()->RenderProgressBar(BarRect, NeonProgress::LevelProgress(Xp));
	}

	// Three daily quest chips. "Готово" pulses pink so the row can be seen from a distance.
	static CButtonContainer s_aClaim[NeonProgress::QUEST_COUNT];
	const float ChipWidth = std::max(150.0f, (Quests.w - 2 * 8.0f) / NeonProgress::QUEST_COUNT);
	for(int i = 0; i < NeonProgress::QUEST_COUNT; ++i)
	{
		const NeonProgress::SQuestState Quest = NeonProgress::QuestState(i);
		CUIRect Chip;
		Quests.VSplitLeft(ChipWidth, &Chip, &Quests);
		Quests.VSplitLeft(8.0f, nullptr, &Quests);
		const ColorRGBA Accent = Quest.m_Claimed ? NeonStyle::DIM : (Quest.m_Complete ? NeonStyle::PINK : NeonStyle::CYAN);
		RenderFormAPanel(Chip, NeonStyle::CARD_RADIUS, NeonStyle::Dim(NeonStyle::NIGHT_1, 0.92f), NeonStyle::Dim(Accent, 0.75f), false, false, 0.0f, Accent);
		CUIRect Inner = Chip;
		Inner.Margin(6.0f, &Inner);
		CUIRect IconRow = Inner;
		IconRow.VSplitLeft(16.0f, &IconRow, &Inner);
		RenderIcon(Quest.m_pQuest->m_Icon, &IconRow, Accent);
		CUIRect Title, Progress;
		Inner.HSplitTop(Inner.h - 14.0f, &Title, &Progress);
		SLabelProperties Props;
		Props.m_MaxWidth = Title.w;
		Props.m_EllipsisAtEnd = true;
		const bool Russian = str_find(g_Config.m_ClLanguagefile, "russian") != nullptr;
		Ui()->DoLabel(&Title, Russian ? Quest.m_pQuest->m_pTitleRu : Quest.m_pQuest->m_pTitle, 12.0f, TEXTALIGN_ML, Props);
		str_format(aBuf, sizeof(aBuf), "%d / %d", Quest.m_Progress, Quest.m_pQuest->m_Target);
		Ui()->DoLabel(&Progress, aBuf, 11.0f, TEXTALIGN_ML);
		if(Quest.m_Complete && !Quest.m_Claimed)
		{
			CUIRect Button;
			Progress.VSplitRight(52.0f, &Progress, &Button);
			if(DoButton_Menu(&s_aClaim[i], Localize("Claim"), 0, &Button, BUTTONFLAG_LEFT, nullptr, IGraphics::CORNER_ALL, 4.0f, -3.0f))
				NeonProgress::QuestClaim(i);
		}
	}
}

// The six weapons of the potato arena, with the honest availability of the current mode:
// NeonDM issues the gun and drops shotgun / grenade / laser, hammer and ninja are not spawned.
void CMenus::RenderWeaponStrip(CUIRect Rect, const char *pCaption)
{
	CUIRect Caption, Strip;
	Rect.HSplitTop(14.0f, &Caption, &Rect);
	Strip = Rect;
	Ui()->DoLabel(&Caption, pCaption, 11.0f, TEXTALIGN_ML);
	static const bool s_aAvailable[NeonStyle::WEAPON_ICON_COUNT] = {false, true, true, true, true, false};
	const float Cell = std::min(30.0f, Strip.w / (float)NeonStyle::WEAPON_ICON_COUNT);
	for(int i = 0; i < NeonStyle::WEAPON_ICON_COUNT; ++i)
	{
		CUIRect Icon = {Strip.x + i * Cell, Strip.y, Cell - 2.0f, Strip.h};
		RenderWeaponIcon(i, &Icon, s_aAvailable[i] ? 1.0f : 0.28f);
	}
}

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
	Paragraph("Reward claims", 22.0f);
	// Configuration alone must never enable a money-moving action: a claim
	// needs a connected wallet, full service configuration, and an explicit tap.
	const bool ClaimConfigured = g_Config.m_ClNeonrelayBackendUrl[0] && g_Config.m_ClNeonrelayRpcUrl[0] &&
		g_Config.m_ClNeonrelayRewardsProgram[0];
	if(!pInfo->connected)
		Paragraph(Localize("Connect a wallet to claim sealed epoch rewards."));
	else if(!ClaimConfigured)
		Paragraph(Localize("Reward claims are not configured (backend URL, RPC URL, rewards program)."));
	else if(pInfo->requesting)
		Paragraph(Localize("Claim in progress — waiting for the wallet app…"));
	else
	{
		if(pInfo->transaction_signature[0])
		{
			char aClaim[192];
			str_format(aClaim, sizeof(aClaim), Localize("Last claim: %.16s…"), pInfo->transaction_signature);
			Paragraph(aClaim);
		}
		MainView.HSplitTop(44.0f, &Line, &MainView);
		s_WalletScroll.AddRect(Line);
		static CButtonContainer s_Claim;
		if(DoButton_Menu(&s_Claim, Localize("Claim rewards"), 0, &Line))
		{
			// Operator configuration only — authentication and the claim
			// intent stay inside the wallet layer, so no session token
			// crosses this call (src/neonrelay/wallet_bridge.h). The config
			// strings are operator-provided; a hostile quote breaks JSON
			// parsing in Kotlin, which fails safe with a user-facing error.
			char aJson[512];
			str_format(aJson, sizeof(aJson), "{\"programId\": \"%s\", \"rpcUrl\": \"%s\", \"backendUrl\": \"%s\"}",
				g_Config.m_ClNeonrelayRewardsProgram, g_Config.m_ClNeonrelayRpcUrl, g_Config.m_ClNeonrelayBackendUrl);
			neonrelay_wallet_request_rewards_claim(aJson);
		}
		Paragraph(Localize("Claims send a Solana transaction from your wallet; network fees apply. Rewards are never guaranteed."));
	}
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
	// The daily set and the streak roll over once per menu session.
	NeonProgress::TouchDay();
	CUIRect ProgressStrip;
	MainView.HSplitTop(86.0f, &ProgressStrip, &MainView);
	ProgressStrip.VSplitLeft(4.0f, nullptr, &ProgressStrip);
	RenderFormAPanel(ProgressStrip, NeonStyle::PANEL_RADIUS, NeonStyle::Dim(NeonStyle::NIGHT_1, 0.94f), NeonStyle::Dim(NeonStyle::CYAN, 0.55f), true, false, 0.0f, NeonStyle::CYAN);
	ProgressStrip.Margin(10.0f, &ProgressStrip);
	RenderProgressStrip(ProgressStrip);
	MainView.HSplitTop(12.0f, nullptr, &MainView);

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
		TextRender()->TextColor(NeonStyle::SUCCESS);
		Ui()->DoLabel(&Detail, Localize("Beginner / Solo / Free"), 14.0f, TEXTALIGN_ML);
		TextRender()->TextColor(TextRender()->DefaultTextColor());
		SLabelProperties Props;
		Props.m_MaxWidth = Row.w;
		Ui()->DoLabel(&Row, Localize("Original course. Local practice, no wallet or ranked prizes."), 14.0f, TEXTALIGN_TL, Props);
		CUIRect WeaponRow;
		Row.HSplitBottom(20.0f, &Row, &WeaponRow);
		RenderWeaponStrip(WeaponRow, Localize("Weapon pool in NeonDM: gun + shotgun / grenade / laser drops"));
		static CButtonContainer s_Warmup;
		const bool Running = GameClient()->m_LocalServer.IsWarmupRunning();
		if(g_Config.m_Debug && Ui()->MouseButtonClicked(0))
			log_info("practice-ui", "click=(%.1f,%.1f) button=(%.1f,%.1f,%.1f,%.1f)", Ui()->MouseX(), Ui()->MouseY(), Action.x, Action.y, Action.w, Action.h);
		if(DoButton_Menu(&s_Warmup, Running ? Localize("Stop practice server") : Localize("Start Warmup"), 0, &Action))
		{
			if(Running)
			{
				GameClient()->m_LocalServer.StopWarmup();
				NeonProgress::OnPracticeStopped();
			}
			else
			{
				GameClient()->m_LocalServer.StartWarmup();
				NeonProgress::OnPracticeStarted();
				NeonProgress::OnSessionStarted();
			}
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
			if(!Compact)
			{
				// The prize is claimed through the wallet after a sealed epoch, never picked up
				// in the arena; the row says so instead of pretending there is a loot drop.
				CUIRect Note;
				Row.HSplitTop(16.0f, &Note, nullptr);
				SLabelProperties NoteProps;
				NoteProps.m_MaxWidth = Note.w;
				TextRender()->TextColor(NeonStyle::Dim(NeonStyle::ICE, 0.75f));
				Ui()->DoLabel(&Note, Localize("Prize: wallet claim after the epoch, not a pickup"), 11.0f, TEXTALIGN_ML, NoteProps);
				TextRender()->TextColor(TextRender()->DefaultTextColor());
			}
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
	const NeonStyle::SRarityAccent Accent = NeonStyle::RarityAccent(Entry.m_pRarity);
	ColorRGBA BorderColor = Accent.m_Border;
	int Diamonds = Accent.m_Diamonds;

	// CLEAN – no background at all, only portrait, 100% bright
	CUIRect Inner = Rect;
	Inner.Margin(2.0f, &Inner);
	float Size = std::min(Inner.w, Inner.h);
	Graphics()->TextureSet(Portrait);
	Graphics()->QuadsBegin();
	Graphics()->SetColor(1.0f, 1.0f, 1.0f, 1.0f);
	IGraphics::CQuadItem Quad(Inner.x + (Inner.w - Size) / 2.0f, Inner.y + (Inner.h - Size) / 2.0f, Size, Size);
	Graphics()->QuadsDrawTL(&Quad, 1);
	Graphics()->QuadsEnd();

	// Border only – transparent, no film, no triangles (chamfer 0)
	GameClient()->m_Menus.RenderFormAPanel(Rect, 0.0f, ColorRGBA(0,0,0,0), BorderColor, false, false, 0.0f, BorderColor);

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
		// Card background Form A 12px, rarity border (single source: NeonStyle::RarityAccent)
		const NeonStyle::SRarityAccent Accent = NeonStyle::RarityAccent(Entry.m_pRarity);
		ColorRGBA BorderColor = NeonStyle::Dim(Accent.m_Border, 0.85f);
		ColorRGBA ImpulseColor = BorderColor;
		float ImpulseDur = Accent.m_ImpulseSeconds;

		bool IsSelected = s_Selected == i;
		// CLEAN – no blue/purple/yellow film, no triangles, only border with rarity color
		CUIRect CardTop, CardBottom;
		Card.HSplitTop(Height * 0.57f, &CardTop, &CardBottom);
		// Bottom text – no film, just text on transparent, only border below
		{
			// No background film, only border for text part
			RenderFormAPanel(CardBottom, 0.0f, ColorRGBA(0,0,0,0), BorderColor, false, false, 0.0f, BorderColor);
		}
		// Full card border – no background film, no triangles (chamfer 0), only border + glow + impulse
		{
			float t = (time_get() / (float)time_freq());
			float prog = std::fmod(t, ImpulseDur) / ImpulseDur;
			RenderFormAPanel(Card, 0.0f, ColorRGBA(0,0,0,0), BorderColor, true, IsSelected, prog, ImpulseColor);
		}
		if(DoButton_Menu(&s_aSelect[i], "", IsSelected, &Card, BUTTONFLAG_LEFT, nullptr, IGraphics::CORNER_ALL, 6.0f, 0.0f, ColorRGBA(0.047f, 0.0745f, 0.2039f, 0.0f)))
		{ s_Selected = i; if(Compact) s_DetailOpen = true; }
		CUIRect Portrait = CardTop;
		Portrait.Margin(2.0f, &Portrait);
		RenderCharacterPortrait(Portrait, i);
		// Card now is bottom part already
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
		NeonProgress::OnCharacterTried();
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
	// A three-row podium, marked as a preview: the copy below is explicit that only
	// server-verified results can occupy it.
	for(int Place = 0; Place < 3; ++Place)
	{
		CUIRect PodiumRow;
		MainView.HSplitTop(30.0f, &PodiumRow, &MainView);
		MainView.HSplitTop(4.0f, nullptr, &MainView);
		const ColorRGBA Metal = Place == 0 ? NeonStyle::RARE_GOLD : (Place == 1 ? NeonStyle::ICE : NeonStyle::DIM);
		RenderFormAPanel(PodiumRow, NeonStyle::CARD_RADIUS, NeonStyle::Dim(NeonStyle::NIGHT_2, 0.5f), NeonStyle::Dim(Metal, 0.5f), false, false, 0.0f, Metal);
		CUIRect Medal = PodiumRow, Label = PodiumRow;
		Medal.VSplitLeft(34.0f, &Medal, &Label);
		Medal.Margin(7.0f, &Medal);
		RenderIcon(NeonStyle::ICON_MEDAL, &Medal, Metal);
		char aPlace[48];
		str_format(aPlace, sizeof(aPlace), Localize("Place %d — waiting for verified results"), Place + 1);
		Ui()->DoLabel(&Label, aPlace, 13.0f, TEXTALIGN_ML);
	}
	MainView.HSplitTop(10.0f, nullptr, &MainView);
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
