/* (c) Magnus Auvinen. See licence.txt in the root of the distribution for more information. */
/* If you are missing that file, acquire a complete release at teeworlds.com.                */
#include "key_binder.h"

#include <base/color.h>

#include <engine/font_icons.h>

#include <game/client/components/binds.h>
#include <game/client/gameclient.h>
#include <game/client/ui.h>
#include <game/localization.h>

bool CKeyBinder::OnInput(const IInput::CEvent &Event)
{
	if(!m_TakeKey)
	{
		return false;
	}

	if(Event.m_Flags & IInput::FLAG_RELEASE)
	{
		int ModifierCombination = CBinds::GetModifierMask(Input());
		if(ModifierCombination == CBinds::GetModifierMaskOfKey(Event.m_Key))
		{
			ModifierCombination = KeyModifier::NONE;
		}
		m_Key = {Event.m_Key, ModifierCombination};
		m_TakeKey = false;
	}
	return true;
}

CKeyBinder::CKeyReaderResult CKeyBinder::DoKeyReader(CButtonContainer *pReaderButton, CButtonContainer *pClearButton, const CUIRect *pRect, const CBindSlot &CurrentBind, bool Activate)
{
	CKeyReaderResult Result = {CurrentBind, false};

	CUIRect KeyReaderButton, ClearButton;
	pRect->VSplitRight(pRect->h, &KeyReaderButton, &ClearButton);

	const int ClearButtonResult = Ui()->DoButton_FontIcon(
		pClearButton, FontIcon::TRASH,
		Result.m_Bind == CBindSlot(KEY_UNKNOWN, KeyModifier::NONE) ? 1 : 0,
		&ClearButton, BUTTONFLAG_LEFT, IGraphics::CORNER_R);

	const int ButtonResult = Ui()->DoButtonLogic(pReaderButton, 0, &KeyReaderButton, BUTTONFLAG_LEFT | BUTTONFLAG_RIGHT);
	if(ButtonResult == 1 || Activate)
	{
		m_pKeyReaderId = pReaderButton;
		m_TakeKey = true;
		m_Key = std::nullopt;
	}
	else if(ButtonResult == 2 || ClearButtonResult != 0)
	{
		Result.m_Bind = CBindSlot(KEY_UNKNOWN, KeyModifier::NONE);
	}

	if(m_pKeyReaderId == pReaderButton && m_Key.has_value())
	{
		if(m_Key.value().m_Key == KEY_ESCAPE)
		{
			Result.m_Aborted = true;
		}
		else
		{
			Result.m_Bind = m_Key.value();
		}
		m_pKeyReaderId = nullptr;
		m_Key = std::nullopt;
		Ui()->SetActiveItem(nullptr);
	}

	char aBuf[64];
	if(m_pKeyReaderId == pReaderButton && m_TakeKey)
	{
		str_copy(aBuf, Localize("Press a key…"));
	}
	else if(Result.m_Bind.m_Key == KEY_UNKNOWN)
	{
		aBuf[0] = '\0';
	}
	else
	{
		GameClient()->m_Binds.GetKeyBindName(Result.m_Bind.m_Key, Result.m_Bind.m_ModifierMask, aBuf, sizeof(aBuf));
	}

	// iOS translucent key reader – Deck 0.72 alpha, cyan when taking key, chamfered not skewed
	const ColorRGBA Color = m_pKeyReaderId == pReaderButton && m_TakeKey ? ColorRGBA(0.3725f, 0.8902f, 0.9608f, 0.65f) : ColorRGBA(0.047f, 0.0745f, 0.2039f, 0.72f * Ui()->ButtonColorMul(pReaderButton));
	{
		float x = KeyReaderButton.x; float y = KeyReaderButton.y; float w = KeyReaderButton.w; float h = KeyReaderButton.h; float c = 6.0f;
		Graphics()->TextureClear();
		Graphics()->QuadsBegin();
		Graphics()->SetColor(Color.r, Color.g, Color.b, Color.a);
		IGraphics::CFreeformItem FreeTop(x + c, y, x + w - c, y, x + w, y + c, x, y + c);
		Graphics()->QuadsDrawFreeform(&FreeTop, 1);
		IGraphics::CQuadItem Mid(x, y + c, w, h - 2*c);
		Graphics()->QuadsDrawTL(&Mid, 1);
		IGraphics::CFreeformItem FreeBottom(x, y + h - c, x + w, y + h - c, x + w - c, y + h, x + c, y + h);
		Graphics()->QuadsDrawFreeform(&FreeBottom, 1);
		Graphics()->QuadsEnd();
		Graphics()->TextureClear();
		Graphics()->QuadsBegin();
		Graphics()->SetColor(0.1647f, 0.5294f, 0.5922f, 0.75f);
		IGraphics::CQuadItem Top(x + c, y, w - 2*c, 1.5f);
		IGraphics::CQuadItem Bottom(x + c, y + h - 1.5f, w - 2*c, 1.5f);
		IGraphics::CQuadItem Left(x, y + c, 1.5f, h - 2*c);
		IGraphics::CQuadItem Right(x + w - 1.5f, y + c, 1.5f, h - 2*c);
		Graphics()->QuadsDrawTL(&Top, 1);
		Graphics()->QuadsDrawTL(&Bottom, 1);
		Graphics()->QuadsDrawTL(&Left, 1);
		Graphics()->QuadsDrawTL(&Right, 1);
		Graphics()->QuadsEnd();
	}
	if(Ui()->HotItem() == pReaderButton)
	{
		CUIRect Edge = {KeyReaderButton.x, KeyReaderButton.y, KeyReaderButton.w, 1.5f};
		Edge.Draw(ColorRGBA(0.05f, 0.90f, 0.92f, 0.85f), IGraphics::CORNER_T, 2.0f);
	}
	CUIRect Label;
	KeyReaderButton.HMargin(1.0f, &Label);
	Ui()->DoLabel(&Label, aBuf, Label.h * CUi::ms_FontmodHeight, TEXTALIGN_MC);

	return Result;
}

bool CKeyBinder::IsActive() const
{
	return m_TakeKey;
}

bool CKeyBinder::AbortPendingKey()
{
	if(m_pKeyReaderId == nullptr)
		return false;
	m_Key = CBindSlot(KEY_ESCAPE, KeyModifier::NONE);
	m_TakeKey = false;
	return true;
}
