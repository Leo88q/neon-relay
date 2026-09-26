/* (c) Magnus Auvinen. See licence.txt in the root of the distribution for more information. */
/* If you are missing that file, acquire a complete release at teeworlds.com.                */
#include "menus_start.h"

#include <engine/client/updater.h>
#include <engine/font_icons.h>
#include <engine/graphics.h>
#include <engine/keys.h>
#include <engine/serverbrowser.h>
#include <engine/shared/config.h>
#include <engine/textrender.h>

#include <generated/client_data.h>

#include <game/client/gameclient.h>
#include <game/client/neon_style.h>
#include <game/client/ui.h>
#include <game/localization.h>
#include <game/version.h>
#include <algorithm>

#if defined(CONF_PLATFORM_ANDROID)
#include <android/android_main.h>
#endif

void CMenusStart::RenderStartMenu(CUIRect MainView)
{
	const float VMargin = std::max(16.0f, MainView.w * 0.04f);
	const bool Russian = str_find(g_Config.m_ClLanguagefile, "russian") != nullptr;
	CUIRect Content, Header, Hero, Menu;
	MainView.Margin(VMargin, &Content);
	Content.HSplitTop(64.0f, &Header, &Content);
	Ui()->DoLabel(&Header, "NEON RELAY", 34.0f, TEXTALIGN_ML);
	Content.HSplitBottom(34.0f, &Content, nullptr);
	bool Compact = MainView.w < 760.0f;
#if defined(CONF_PLATFORM_ANDROID)
	Compact = true;
#endif
	if(Compact)
	{
		Content.HSplitTop(std::min(136.0f, Content.h*0.30f), &Hero, &Menu);
		Menu.HSplitTop(12.0f, nullptr, &Menu);
	}
	else
	{
		Content.VSplitLeft(Content.w*0.55f, &Hero, &Menu);
		Menu.VSplitLeft(20.0f, nullptr, &Menu);
	}
	// Form A CLEAN – no covering over main character, only border, portrait 100% bright
	GameClient()->m_Menus.RenderFormAPanel(Hero, NeonStyle::PANEL_RADIUS, ColorRGBA(0, 0, 0, 0),
		NeonStyle::Dim(NeonStyle::PANEL_ACCENT, 0.85f), true, false, 0.0f, NeonStyle::PANEL_ACCENT);
	CUIRect Art = Hero;
	Art.Margin(8.0f, &Art);
	if(!Compact)
	{
		CUIRect Caption;
		Art.HSplitBottom(52.0f, &Art, &Caption);
		Ui()->DoLabel(&Caption, Russian ? "Твой маршрут. Твой стиль." : "Your route. Your style.", 20.0f, TEXTALIGN_MC);
	}
	GameClient()->m_Menus.RenderCharacterPortrait(Art, 0);
	const char *apLabels[] = {Localize("Play", "Start menu"), Localize("Characters"), Localize("Wallet"), Localize("Leaders"), Localize("Settings")};
	const int aPages[] = {CMenus::PAGE_RACES, CMenus::PAGE_CHARACTERS, CMenus::PAGE_WALLET, CMenus::PAGE_LEADERS, CMenus::PAGE_SETTINGS};
	const int aKeys[] = {KEY_P, KEY_C, KEY_W, KEY_L, KEY_S};
	static CButtonContainer s_aButtons[5];
	int NewPage = -1;
	const float ButtonHeight = std::min(62.0f, (Menu.h-32.0f)/5.0f);
	for(int i = 0; i < 5; ++i)
	{
		CUIRect Button;
		Menu.HSplitTop(ButtonHeight, &Button, &Menu);
		Menu.HSplitTop(8.0f, nullptr, &Menu);
		// Start-menu buttons: the token cyan for "Play", night-1 for the rest. The old literals were
		// a *different* cyan (#0DE6EB) and a grey outside the palette, i.e. the drift this header exists
		// to stop.
		const ColorRGBA Color = i == 0 ? NeonStyle::CYAN : NeonStyle::Dim(NeonStyle::NIGHT_1, 0.94f);
		if(GameClient()->m_Menus.DoButton_Menu(&s_aButtons[i], apLabels[i], 0, &Button, BUTTONFLAG_LEFT, nullptr, IGraphics::CORNER_ALL, 6.0f, 0.0f, Color) || CheckHotKey(aKeys[i]) || (i == 0 && Ui()->ConsumeHotkey(CUi::HOTKEY_ENTER)))
			NewPage = aPages[i];
	}
	const bool Escape = Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE);
	if(Escape || CheckHotKey(KEY_Q))
	{
		if(Escape || (g_Config.m_ClConfirmQuitTime >= 0 && GameClient()->CurrentRaceTime() / 60 >= g_Config.m_ClConfirmQuitTime))
			GameClient()->m_Menus.ShowQuitPopup();
		else
			Client()->Quit();
	}

	// render version
	CUIRect CurVersion, ConsoleButton;
	MainView.HSplitBottom(45.0f, nullptr, &CurVersion);
	CurVersion.VSplitRight(40.0f, &CurVersion, nullptr);
	CurVersion.HSplitTop(20.0f, &ConsoleButton, &CurVersion);
	CurVersion.HSplitTop(5.0f, nullptr, &CurVersion);
	ConsoleButton.VSplitRight(40.0f, nullptr, &ConsoleButton);
	Ui()->DoLabel(&CurVersion, GAME_RELEASE_VERSION, 14.0f, TEXTALIGN_MR);

	CUIRect VersionUpdate;
	MainView.HSplitBottom(20.0f, nullptr, &VersionUpdate);
	VersionUpdate.VMargin(VMargin, &VersionUpdate);
#if defined(CONF_AUTOUPDATE)
	CUIRect UpdateButton;
	VersionUpdate.VSplitRight(100.0f, &VersionUpdate, &UpdateButton);
	VersionUpdate.VSplitRight(10.0f, &VersionUpdate, nullptr);

	char aBuf[128];
	const IUpdater::EUpdaterState State = Updater()->GetCurrentState();
	const bool NeedUpdate = str_comp(Client()->LatestVersion(), "0");

	if(State == IUpdater::CLEAN && NeedUpdate)
	{
		static CButtonContainer s_VersionUpdate;
		if(GameClient()->m_Menus.DoButton_Menu(&s_VersionUpdate, Localize("Update now"), 0, &UpdateButton, BUTTONFLAG_LEFT, 0, IGraphics::CORNER_ALL, 5.0f, 0.0f, ColorRGBA(0.0f, 0.0f, 0.0f, 0.25f)))
		{
			Updater()->InitiateUpdate();
		}
	}
	else if(State == IUpdater::NEED_RESTART)
	{
		static CButtonContainer s_VersionUpdate;
		if(GameClient()->m_Menus.DoButton_Menu(&s_VersionUpdate, Localize("Restart"), 0, &UpdateButton, BUTTONFLAG_LEFT, 0, IGraphics::CORNER_ALL, 5.0f, 0.0f, ColorRGBA(0.0f, 0.0f, 0.0f, 0.25f)))
		{
			Client()->Restart();
		}
	}
	else if(State >= IUpdater::GETTING_MANIFEST && State < IUpdater::NEED_RESTART)
	{
		Ui()->RenderProgressBar(UpdateButton, Updater()->GetCurrentPercent() / 100.0f);
	}

	if(State == IUpdater::CLEAN && NeedUpdate)
	{
		str_format(aBuf, sizeof(aBuf), Localize("Neon Relay %s is out!"), Client()->LatestVersion());
		TextRender()->TextColor(1.0f, 0.4f, 0.4f, 1.0f);
	}
	else if(State == IUpdater::CLEAN)
	{
		aBuf[0] = '\0';
	}
	else if(State >= IUpdater::GETTING_MANIFEST && State < IUpdater::NEED_RESTART)
	{
		char aCurrentFile[64];
		Updater()->GetCurrentFile(aCurrentFile, sizeof(aCurrentFile));
		str_format(aBuf, sizeof(aBuf), Localize("Downloading %s:"), aCurrentFile);
	}
	else if(State == IUpdater::FAIL)
	{
		str_copy(aBuf, Localize("Update failed! Check log…"));
		TextRender()->TextColor(1.0f, 0.4f, 0.4f, 1.0f);
	}
	else if(State == IUpdater::NEED_RESTART)
	{
		str_copy(aBuf, Localize("Neon Relay client updated!"));
		TextRender()->TextColor(1.0f, 0.4f, 0.4f, 1.0f);
	}
	Ui()->DoLabel(&VersionUpdate, aBuf, 14.0f, TEXTALIGN_ML);
	TextRender()->TextColor(TextRender()->DefaultTextColor());
#elif defined(CONF_INFORM_UPDATE)
	if(str_comp(Client()->LatestVersion(), "0") != 0)
	{
		CUIRect DownloadButton;
		VersionUpdate.VSplitRight(100.0f, &VersionUpdate, &DownloadButton);
		VersionUpdate.VSplitRight(10.0f, &VersionUpdate, nullptr);

		static CButtonContainer s_DownloadButton;
		if(GameClient()->m_Menus.DoButton_Menu(&s_DownloadButton, Localize("Download"), 0, &DownloadButton, BUTTONFLAG_LEFT, nullptr, IGraphics::CORNER_ALL, 5.0f, 0.0f, ColorRGBA(0.0f, 0.0f, 0.0f, 0.25f)))
		{
			Client()->ViewLink("https://github.com/Leo88q/neon-relay/releases");
		}

		char aBuf[64];
		str_format(aBuf, sizeof(aBuf), Localize("Neon Relay %s is out!"), Client()->LatestVersion());
		SLabelProperties UpdateLabelProps;
		UpdateLabelProps.SetColor(ColorRGBA(1.0f, 0.4f, 0.4f, 1.0f));
		Ui()->DoLabel(&VersionUpdate, aBuf, 14.0f, TEXTALIGN_ML, UpdateLabelProps);
	}
#endif

	if(NewPage != -1)
	{
		GameClient()->m_Menus.SetShowStart(false);
		GameClient()->m_Menus.SetMenuPage(NewPage);
	}
}

bool CMenusStart::CheckHotKey(int Key) const
{
	return !Input()->ShiftIsPressed() && !Input()->ModifierIsPressed() && !Input()->AltIsPressed() && // no modifier
	       Input()->KeyPress(Key) &&
	       !GameClient()->m_GameConsole.IsActive();
}
