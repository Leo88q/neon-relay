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
}
