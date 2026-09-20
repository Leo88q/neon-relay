/* (c) Magnus Auvinen. See licence.txt in the root of the distribution for more information. */
/* If you are missing that file, acquire a complete release at teeworlds.com.                */

#include "menus.h"

#include <base/color.h>
#include <base/dbg.h>
#include <base/fs.h>
#include <base/log.h>
#include <base/str.h>
#include <base/time.h>
#include <base/vmath.h>

#include <engine/client.h>
#include <engine/client/updater.h>
#include <engine/config.h>
#include <engine/font_icons.h>
#include <engine/friends.h>
#include <engine/gfx/image_manipulation.h>
#include <engine/graphics.h>
#include <engine/keys.h>
#include <engine/serverbrowser.h>
#include <engine/shared/config.h>
#include <engine/storage.h>
#include <engine/textrender.h>

#include <generated/client_data.h>
#include <generated/protocol.h>

#include <game/client/animstate.h>
#include <game/client/components/binds.h>
#include <game/client/components/console.h>
#include <game/client/components/key_binder.h>
#include <game/client/components/menu_background.h>
#include <game/client/components/sounds.h>
#include <game/client/gameclient.h>
#include <game/client/ui_listbox.h>
#include <game/localization.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <vector>

using namespace std::chrono_literals;

ColorRGBA CMenus::ms_GuiColor;
ColorRGBA CMenus::ms_ColorTabbarInactiveOutgame;
ColorRGBA CMenus::ms_ColorTabbarActiveOutgame;
ColorRGBA CMenus::ms_ColorTabbarHoverOutgame;
ColorRGBA CMenus::ms_ColorTabbarInactive;
ColorRGBA CMenus::ms_ColorTabbarActive = ColorRGBA(0, 0, 0, 0.5f);
ColorRGBA CMenus::ms_ColorTabbarHover;
ColorRGBA CMenus::ms_ColorTabbarInactiveIngame;
ColorRGBA CMenus::ms_ColorTabbarActiveIngame;
ColorRGBA CMenus::ms_ColorTabbarHoverIngame;

float CMenus::ms_ButtonHeight = 25.0f;
float CMenus::ms_ListheaderHeight = 17.0f;

CMenus::CMenus()
{
	m_Popup = POPUP_NONE;
	m_MenuPage = 0;
	m_GamePage = PAGE_GAME;

	m_NeedRestartGraphics = false;
	m_NeedRestartSound = false;
	m_NeedSendinfo = false;
	m_NeedSendDummyinfo = false;
	m_MenuActive = true;
	m_ShowStart = true;

	str_copy(m_aCurrentDemoFolder, "demos");
	m_DemolistStorageType = IStorage::TYPE_ALL;

	m_DemoPlayerState = DEMOPLAYER_NONE;
	m_Dummy = false;

	for(SUIAnimator &Animator : m_aAnimatorsSettingsTab)
	{
		Animator.m_YOffset = -2.5f;
		Animator.m_HOffset = 5.0f;
		Animator.m_WOffset = 5.0f;
		Animator.m_RepositionLabel = true;
	}

	for(SUIAnimator &Animator : m_aAnimatorsBigPage)
	{
		Animator.m_YOffset = -5.0f;
		Animator.m_HOffset = 5.0f;
	}

	for(SUIAnimator &Animator : m_aAnimatorsSmallPage)
	{
		Animator.m_YOffset = -2.5f;
		Animator.m_HOffset = 2.5f;
	}

	m_PasswordInput.SetBuffer(g_Config.m_Password, sizeof(g_Config.m_Password));
	m_PasswordInput.SetHidden(true);
}

int CMenus::DoButton_Toggle(const void *pId, int Checked, const CUIRect *pRect, bool Active, const unsigned Flags)
{
	Graphics()->TextureSet(g_pData->m_aImages[IMAGE_GUIBUTTONS].m_Id);
	Graphics()->QuadsBegin();
	if(!Active)
		Graphics()->SetColor(1.0f, 1.0f, 1.0f, 0.5f);
	Graphics()->SelectSprite(Checked ? SPRITE_GUIBUTTON_ON : SPRITE_GUIBUTTON_OFF);
	IGraphics::CQuadItem QuadItem(pRect->x, pRect->y, pRect->w, pRect->h);
	Graphics()->QuadsDrawTL(&QuadItem, 1);
	if(Ui()->HotItem() == pId && Active)
	{
		Graphics()->SelectSprite(SPRITE_GUIBUTTON_HOVER);
		QuadItem = IGraphics::CQuadItem(pRect->x, pRect->y, pRect->w, pRect->h);
		Graphics()->QuadsDrawTL(&QuadItem, 1);
	}
	Graphics()->QuadsEnd();

	return Active ? Ui()->DoButtonLogic(pId, Checked, pRect, Flags) : 0;
}

int CMenus::DoButton_Menu(CButtonContainer *pButtonContainer, const char *pText, int Checked, const CUIRect *pRect, const unsigned Flags, const char *pImageName, int Corners, float Rounding, float FontFactor, ColorRGBA Color)
{
	CUIRect Text = *pRect;
	bool IsActive = Checked != 0;
	bool IsHot = Ui()->HotItem() == pButtonContainer;
	float skew = 12.0f;
	float x = pRect->x;
	float y = pRect->y;
	float w = pRect->w;
	float h = pRect->h;

	if(IsActive)
	{
		x += 1.0f;
		y += 1.0f;
	}

	// iOS translucent buttons – not fully opaque
	ColorRGBA BgColor = ColorRGBA(0.047f, 0.0745f, 0.2039f, 0.62f); // Deck translucent
	ColorRGBA BorderColor = ColorRGBA(0.1647f, 0.5294f, 0.5922f, 0.75f);
	ColorRGBA TextColor = ColorRGBA(0.902f, 0.9647f, 1.0f, 1.0f);

	if(Color.r > 0.9f && Color.g > 0.7f && Color.b < 0.5f)
	{
		BgColor = ColorRGBA(1.0f, 0.7843f, 0.3412f, 0.72f);
		BorderColor = ColorRGBA(1.0f, 0.7843f, 0.3412f, 0.95f);
		TextColor = ColorRGBA(0.0235f, 0.0392f, 0.1098f, 1.0f);
	}
	else if(IsActive)
	{
		BgColor = ColorRGBA(0.3725f, 0.8902f, 0.9608f, 0.78f);
		BorderColor = ColorRGBA(0.3725f, 0.8902f, 0.9608f, 1.0f);
		TextColor = ColorRGBA(0.0235f, 0.0392f, 0.1098f, 1.0f);
	}
	else if(IsHot)
	{
		float t = (time_get() / (float)time_freq());
		float blink = 0.5f + 0.5f * std::sin(t * 2.0f * 3.14159f / 0.7f);
		BgColor = ColorRGBA(0.047f + blink * 0.08f, 0.0745f + blink * 0.12f, 0.2039f + blink * 0.20f, 0.72f);
		BorderColor = ColorRGBA(0.3725f, 0.8902f, 0.9608f, 0.85f + blink * 0.15f);
	}

	// iOS blur behind button
	Graphics()->TextureClear();
	Graphics()->QuadsBegin();
	Graphics()->SetColor(0.0235f, 0.0392f, 0.1098f, 0.18f);
	IGraphics::CQuadItem Blur(x - 4, y - 4, w + 8, h + 8);
	Graphics()->QuadsDrawTL(&Blur, 1);
	Graphics()->QuadsEnd();

	Graphics()->TextureClear();
	Graphics()->QuadsBegin();
	Graphics()->SetColor(BgColor.r, BgColor.g, BgColor.b, BgColor.a);
	IGraphics::CFreeformItem FreeBtn(x + skew, y, x + w, y, x + w - skew, y + h, x, y + h);
	Graphics()->QuadsDrawFreeform(&FreeBtn, 1);
	Graphics()->QuadsEnd();

	Graphics()->TextureClear();
	Graphics()->QuadsBegin();
	Graphics()->SetColor(BorderColor.r, BorderColor.g, BorderColor.b, BorderColor.a);
	IGraphics::CQuadItem Top(x + skew, y, w - skew, 2.0f);
	IGraphics::CQuadItem Bottom(x, y + h - 2.0f, w - skew, 2.0f);
	Graphics()->QuadsDrawTL(&Top, 1);
	Graphics()->QuadsDrawTL(&Bottom, 1);
	IGraphics::CFreeformItem LeftEdge(x + skew, y, x + skew, y + 2.0f, x, y + h, x, y + h - 2.0f);
	IGraphics::CFreeformItem RightEdge(x + w, y, x + w, y + 2.0f, x + w - skew, y + h, x + w - skew, y + h - 2.0f);
	Graphics()->QuadsDrawFreeform(&LeftEdge, 1);
	Graphics()->QuadsDrawFreeform(&RightEdge, 1);
	Graphics()->QuadsEnd();

	if(Color.a < 0.5f)
	{
		Graphics()->TextureClear();
		Graphics()->QuadsBegin();
		Graphics()->SetColor(0.047f, 0.0745f, 0.2039f, 0.35f);
		for(int i = 0; i < (int)(w / 8.0f); ++i)
		{
			float hx = x + i * 12.0f;
			IGraphics::CFreeformItem Hatch(hx, y, hx + 6.0f, y, hx + 6.0f - skew, y + h, hx - skew, y + h);
			Graphics()->QuadsDrawFreeform(&Hatch, 1);
		}
		Graphics()->QuadsEnd();
	}

	if(pImageName)
	{
		CUIRect Image;
		pRect->VSplitRight(pRect->h * 4.0f, &Text, &Image);
		const CMenuImage *pImage = FindMenuImage(pImageName);
		if(pImage)
		{
			Graphics()->TextureSet(Ui()->HotItem() == pButtonContainer ? pImage->m_OrgTexture : pImage->m_GreyTexture);
			Graphics()->WrapClamp();
			Graphics()->QuadsBegin();
			Graphics()->SetColor(1.0f, 1.0f, 1.0f, 1.0f);
			IGraphics::CQuadItem QuadItem(Image.x, Image.y, Image.w, Image.h);
			Graphics()->QuadsDrawTL(&QuadItem, 1);
			Graphics()->QuadsEnd();
			Graphics()->WrapNormal();
		}
	}

	Text.HMargin(pRect->h >= 20.0f ? 2.0f : 1.0f, &Text);
	Text.HMargin((Text.h * FontFactor) / 2.0f, &Text);
	TextRender()->TextColor(TextColor);
	Ui()->DoLabel(&Text, pText, Text.h * CUi::ms_FontmodHeight, TEXTALIGN_MC);
	TextRender()->TextColor(1.0f, 1.0f, 1.0f, 1.0f);

	return Ui()->DoButtonLogic(pButtonContainer, Checked, pRect, Flags);
}

int CMenus::DoButton_MenuTab(CButtonContainer *pButtonContainer, const char *pText, int Checked, const CUIRect *pRect, int Corners, SUIAnimator *pAnimator, const ColorRGBA *pDefaultColor, const ColorRGBA *pActiveColor, const ColorRGBA *pHoverColor, float EdgeRounding, const CCommunityIcon *pCommunityIcon)
{
	const bool MouseInside = Ui()->HotItem() == pButtonContainer;
	CUIRect Rect = *pRect;

	if(pAnimator != nullptr)
	{
		auto Time = time_get_nanoseconds();
		if(pAnimator->m_Time + 100ms < Time)
		{
			pAnimator->m_Value = pAnimator->m_Active ? 1 : 0;
			pAnimator->m_Time = Time;
		}
		pAnimator->m_Active = Checked || MouseInside;
		if(pAnimator->m_Active)
			pAnimator->m_Value = std::clamp<float>(pAnimator->m_Value + (Time - pAnimator->m_Time).count() / (double)std::chrono::nanoseconds(100ms).count(), 0, 1);
		else
			pAnimator->m_Value = std::clamp<float>(pAnimator->m_Value - (Time - pAnimator->m_Time).count() / (double)std::chrono::nanoseconds(100ms).count(), 0, 1);
		Rect.w += pAnimator->m_Value * pAnimator->m_WOffset;
		Rect.h += pAnimator->m_Value * pAnimator->m_HOffset;
		Rect.x += pAnimator->m_Value * pAnimator->m_XOffset;
		Rect.y += pAnimator->m_Value * pAnimator->m_YOffset;
		pAnimator->m_Time = Time;
	}

	// Form A iOS tab – slanted, translucent, active Gold/Cyan, with glow and impulse
	float skew = 14.0f;
	float x = Rect.x;
	float y = Rect.y;
	float w = Rect.w;
	float h = Rect.h;

	ColorRGBA BgColor = ms_ColorTabbarInactive;
	BgColor.a = 0.62f; // iOS translucent
	ColorRGBA BorderColor = ColorRGBA(0.1647f, 0.5294f, 0.5922f, 0.65f);
	if(Checked)
	{
		BgColor = ms_ColorTabbarActive;
		BgColor.a = 0.78f;
		BorderColor = ColorRGBA(1.0f, 0.7843f, 0.3412f, 1.0f);
	}
	else if(MouseInside)
	{
		BgColor = ms_ColorTabbarHover;
		BgColor.a = 0.72f;
		BorderColor = ColorRGBA(0.3725f, 0.8902f, 0.9608f, 0.9f);
	}

	// iOS blur behind tab
	Graphics()->TextureClear();
	Graphics()->QuadsBegin();
	Graphics()->SetColor(0.0235f, 0.0392f, 0.1098f, 0.20f);
	IGraphics::CQuadItem Blur(x - 6, y - 4, w + 12, h + 8);
	Graphics()->QuadsDrawTL(&Blur, 1);
	Graphics()->QuadsEnd();

	if(Checked)
	{
		Graphics()->TextureClear();
		Graphics()->QuadsBegin();
		Graphics()->SetColor(BorderColor.r, BorderColor.g, BorderColor.b, 0.25f);
		IGraphics::CQuadItem Glow(x - 8, y - 6, w + 16, h + 12);
		Graphics()->QuadsDrawTL(&Glow, 1);
		Graphics()->QuadsEnd();
	}

	Graphics()->TextureClear();
	Graphics()->QuadsBegin();
	Graphics()->SetColor(BgColor.r, BgColor.g, BgColor.b, BgColor.a);
	IGraphics::CFreeformItem FreeTab(x + skew, y, x + w, y, x + w - skew, y + h, x, y + h);
	Graphics()->QuadsDrawFreeform(&FreeTab, 1);
	Graphics()->QuadsEnd();

	Graphics()->TextureClear();
	Graphics()->QuadsBegin();
	Graphics()->SetColor(BorderColor.r, BorderColor.g, BorderColor.b, BorderColor.a);
	IGraphics::CQuadItem Top(x + skew, y, w - skew, 2.0f);
	IGraphics::CQuadItem Bottom(x, y + h - 2.0f, w - skew, 2.0f);
	Graphics()->QuadsDrawTL(&Top, 1);
	Graphics()->QuadsDrawTL(&Bottom, 1);
	Graphics()->QuadsEnd();

	if(Checked)
	{
		float t = (time_get() / (float)time_freq());
		float prog = std::fmod(t, 5.0f) / 5.0f;
		float total = 2.0f * (w + h);
		float pos = prog * total;
		float ix = x, iy = y;
		if(pos < w) { ix = x + pos; iy = y; }
		else if(pos < w + h) { ix = x + w; iy = y + (pos - w); }
		else if(pos < 2*w + h) { ix = x + w - (pos - w - h); iy = y + h; }
		else { ix = x; iy = y + h - (pos - 2*w - h); }
		Graphics()->TextureClear();
		Graphics()->QuadsBegin();
		Graphics()->SetColor(0.3725f, 0.8902f, 0.9608f, 0.95f);
		IGraphics::CQuadItem QuadImp(ix - 5, iy - 5, 10, 10);
		Graphics()->QuadsDrawTL(&QuadImp, 1);
		Graphics()->QuadsEnd();
	}

	if(pAnimator != nullptr)
	{
		if(pAnimator->m_RepositionLabel)
		{
			Rect.x += Rect.w - pRect->w + Rect.x - pRect->x;
			Rect.y += Rect.h - pRect->h + Rect.y - pRect->y;
		}
		if(!pAnimator->m_ScaleLabel)
		{
			Rect.w = pRect->w;
			Rect.h = pRect->h;
		}
	}

	if(pCommunityIcon)
	{
		CUIRect CommunityIcon;
		Rect.Margin(2.0f, &CommunityIcon);
		m_CommunityIcons.Render(pCommunityIcon, CommunityIcon, true);
	}
	else
	{
		CUIRect Label;
		Rect.HMargin(2.0f, &Label);
		Label.x += skew * 0.5f;
		Ui()->DoLabel(&Label, pText, Label.h * CUi::ms_FontmodHeight, TEXTALIGN_MC);
	}

	return Ui()->DoButtonLogic(pButtonContainer, Checked, pRect, BUTTONFLAG_LEFT);
}

int CMenus::DoButton_GridHeader(const void *pId, const char *pText, int Checked, const CUIRect *pRect, int Align)
{
	if(Checked == 2)
		pRect->Draw(ColorRGBA(0.05f, 0.90f, 0.92f, 0.55f), IGraphics::CORNER_T, 4.0f);
	else if(Checked)
		pRect->Draw(ColorRGBA(0.11f, 0.12f, 0.14f, 0.96f), IGraphics::CORNER_T, 4.0f);

	CUIRect Temp;
	pRect->VMargin(5.0f, &Temp);
	Ui()->DoLabel(&Temp, pText, pRect->h * CUi::ms_FontmodHeight, Align);
	return Ui()->DoButtonLogic(pId, Checked, pRect, BUTTONFLAG_LEFT);
}

int CMenus::DoButton_Favorite(const void *pButtonId, const void *pParentId, bool Checked, const CUIRect *pRect)
{
	if(Checked || (pParentId != nullptr && Ui()->HotItem() == pParentId) || Ui()->HotItem() == pButtonId)
	{
		TextRender()->SetFontPreset(EFontPreset::ICON_FONT);
		TextRender()->SetRenderFlags(ETextRenderFlags::TEXT_RENDER_FLAG_ONLY_ADVANCE_WIDTH | ETextRenderFlags::TEXT_RENDER_FLAG_NO_X_BEARING | ETextRenderFlags::TEXT_RENDER_FLAG_NO_Y_BEARING | ETextRenderFlags::TEXT_RENDER_FLAG_NO_PIXEL_ALIGNMENT | ETextRenderFlags::TEXT_RENDER_FLAG_NO_OVERSIZE);
		const float Alpha = Ui()->HotItem() == pButtonId ? 0.2f : 0.0f;
		TextRender()->TextColor(Checked ? ColorRGBA(1.0f, 0.85f, 0.3f, 0.8f + Alpha) : ColorRGBA(0.5f, 0.5f, 0.5f, 0.8f + Alpha));
		SLabelProperties Props;
		Props.m_MaxWidth = pRect->w;
		Ui()->DoLabel(pRect, FontIcon::STAR, 12.0f, TEXTALIGN_MC, Props);
		TextRender()->TextColor(TextRender()->DefaultTextColor());
		TextRender()->SetRenderFlags(0);
		TextRender()->SetFontPreset(EFontPreset::DEFAULT_FONT);
	}
	return Ui()->DoButtonLogic(pButtonId, 0, pRect, BUTTONFLAG_LEFT);
}

int CMenus::DoButton_CheckBox_Common(const void *pId, const char *pText, const char *pBoxText, const CUIRect *pRect, const unsigned Flags)
{
	CUIRect Box, Label;
	pRect->VSplitLeft(pRect->h, &Box, &Label);
	Label.VSplitLeft(5.0f, nullptr, &Label);

	Box.Margin(2.0f, &Box);
	Box.Draw(ColorRGBA(0.11f, 0.12f, 0.14f, 0.92f * Ui()->ButtonColorMul(pId)), IGraphics::CORNER_ALL, 4.0f);

	const bool Checkable = *pBoxText == 'X';
	if(Checkable)
	{
		TextRender()->SetRenderFlags(ETextRenderFlags::TEXT_RENDER_FLAG_ONLY_ADVANCE_WIDTH | ETextRenderFlags::TEXT_RENDER_FLAG_NO_X_BEARING | ETextRenderFlags::TEXT_RENDER_FLAG_NO_Y_BEARING | ETextRenderFlags::TEXT_RENDER_FLAG_NO_OVERSIZE | ETextRenderFlags::TEXT_RENDER_FLAG_NO_PIXEL_ALIGNMENT);
		TextRender()->SetFontPreset(EFontPreset::ICON_FONT);
		Ui()->DoLabel(&Box, FontIcon::XMARK, Box.h * CUi::ms_FontmodHeight, TEXTALIGN_MC);
		TextRender()->SetFontPreset(EFontPreset::DEFAULT_FONT);
	}
	else
	{
		Ui()->DoLabel(&Box, pBoxText, Box.h * CUi::ms_FontmodHeight, TEXTALIGN_MC);
	}

	TextRender()->SetRenderFlags(0);
	Ui()->DoLabel(&Label, pText, Box.h * CUi::ms_FontmodHeight, TEXTALIGN_ML);

	return Ui()->DoButtonLogic(pId, 0, pRect, Flags);
}

bool CMenus::DoLine_RadioMenu(CUIRect &View, const char *pLabel, std::vector<CButtonContainer> &vButtonContainers, const std::vector<const char *> &vLabels, const std::vector<int> &vValues, int &Value)
{
	dbg_assert(vButtonContainers.size() == vValues.size(), "vButtonContainers and vValues must have the same size");
	dbg_assert(vButtonContainers.size() == vLabels.size(), "vButtonContainers and vLabels must have the same size");
	const int N = vButtonContainers.size();
	const float Spacing = 2.0f;
	const float ButtonHeight = 20.0f;
	CUIRect Label, Buttons;
	View.HSplitTop(Spacing, nullptr, &View);
	View.HSplitTop(ButtonHeight, &Buttons, &View);
	Buttons.VSplitMid(&Label, &Buttons, 10.0f);
	Buttons.HMargin(2.0f, &Buttons);
	Ui()->DoLabel(&Label, pLabel, 13.0f, TEXTALIGN_ML);
	const float W = Buttons.w / N;
	bool Pressed = false;
	for(int i = 0; i < N; ++i)
	{
		CUIRect Button;
		Buttons.VSplitLeft(W, &Button, &Buttons);
		int Corner = IGraphics::CORNER_NONE;
		if(i == 0)
			Corner = IGraphics::CORNER_L;
		if(i == N - 1)
			Corner = IGraphics::CORNER_R;
		if(DoButton_Menu(&vButtonContainers[i], vLabels[i], vValues[i] == Value, &Button, BUTTONFLAG_LEFT, nullptr, Corner))
		{
			Pressed = true;
			Value = vValues[i];
		}
	}
	return Pressed;
}

ColorHSLA CMenus::DoLine_ColorPicker(CButtonContainer *pResetId, const float LineSize, const float LabelSize, const float BottomMargin, CUIRect *pMainRect, const char *pText, unsigned int *pColorValue, const ColorRGBA DefaultColor, bool CheckBoxSpacing, int *pCheckBoxValue, bool Alpha)
{
	CUIRect Section, ColorPickerButton, ResetButton, Label;

	pMainRect->HSplitTop(LineSize, &Section, pMainRect);
	pMainRect->HSplitTop(BottomMargin, nullptr, pMainRect);

	Section.VSplitRight(60.0f, &Section, &ResetButton);
	Section.VSplitRight(8.0f, &Section, nullptr);
	Section.VSplitRight(Section.h, &Section, &ColorPickerButton);
	Section.VSplitRight(8.0f, &Label, nullptr);

	if(pCheckBoxValue != nullptr)
	{
		Label.Margin(2.0f, &Label);
		if(DoButton_CheckBox(pCheckBoxValue, pText, *pCheckBoxValue, &Label))
			*pCheckBoxValue ^= 1;
	}
	else if(CheckBoxSpacing)
	{
		Label.VSplitLeft(Label.h + 5.0f, nullptr, &Label);
	}
	if(pCheckBoxValue == nullptr)
	{
		Ui()->DoLabel(&Label, pText, LabelSize, TEXTALIGN_ML);
	}

	const ColorHSLA PickedColor = DoButton_ColorPicker(&ColorPickerButton, pColorValue, Alpha);

	ResetButton.HMargin(2.0f, &ResetButton);
	if(DoButton_Menu(pResetId, Localize("Reset"), 0, &ResetButton, BUTTONFLAG_LEFT, nullptr, IGraphics::CORNER_ALL, 4.0f, 0.1f, ColorRGBA(1.0f, 1.0f, 1.0f, 0.25f)))
	{
		*pColorValue = color_cast<ColorHSLA>(DefaultColor).Pack(Alpha);
	}

	return PickedColor;
}

ColorHSLA CMenus::DoButton_ColorPicker(const CUIRect *pRect, unsigned int *pHslaColor, bool Alpha)
{
	ColorHSLA HslaColor = ColorHSLA(*pHslaColor, Alpha);

	ColorRGBA Outline = ColorRGBA(1.0f, 1.0f, 1.0f, 0.25f);
	Outline.a *= Ui()->ButtonColorMul(pHslaColor);

	CUIRect Rect;
	pRect->Margin(3.0f, &Rect);

	pRect->Draw(Outline, IGraphics::CORNER_ALL, 4.0f);
	Rect.Draw(color_cast<ColorRGBA>(HslaColor), IGraphics::CORNER_ALL, 4.0f);

	if(Ui()->DoButtonLogic(pHslaColor, 0, pRect, BUTTONFLAG_LEFT))
	{
		m_ColorPickerPopupContext.m_pHslaColor = pHslaColor;
		m_ColorPickerPopupContext.m_HslaColor = HslaColor;
		m_ColorPickerPopupContext.m_HsvaColor = color_cast<ColorHSVA>(HslaColor);
		m_ColorPickerPopupContext.m_RgbaColor = color_cast<ColorRGBA>(m_ColorPickerPopupContext.m_HsvaColor);
		m_ColorPickerPopupContext.m_Alpha = Alpha;
		Ui()->ShowPopupColorPicker(Ui()->MouseX(), Ui()->MouseY(), &m_ColorPickerPopupContext);
	}
	else if(Ui()->IsPopupOpen(&m_ColorPickerPopupContext) && m_ColorPickerPopupContext.m_pHslaColor == pHslaColor)
	{
		HslaColor = color_cast<ColorHSLA>(m_ColorPickerPopupContext.m_HsvaColor);
	}

	return HslaColor;
}

int CMenus::DoButton_CheckBoxAutoVMarginAndSet(const void *pId, const char *pText, int *pValue, CUIRect *pRect, float VMargin)
{
	CUIRect CheckBoxRect;
	pRect->HSplitTop(VMargin, &CheckBoxRect, pRect);

	int Logic = DoButton_CheckBox_Common(pId, pText, *pValue ? "X" : "", &CheckBoxRect, BUTTONFLAG_LEFT);

	if(Logic)
		*pValue ^= 1;

	return Logic;
}

int CMenus::DoButton_CheckBox(const void *pId, const char *pText, int Checked, const CUIRect *pRect)
{
	return DoButton_CheckBox_Common(pId, pText, Checked ? "X" : "", pRect, BUTTONFLAG_LEFT);
}

int CMenus::DoButton_CheckBox_Number(const void *pId, const char *pText, int Checked, const CUIRect *pRect)
{
	char aBuf[16];
	str_format(aBuf, sizeof(aBuf), "%d", Checked);
	return DoButton_CheckBox_Common(pId, pText, aBuf, pRect, BUTTONFLAG_LEFT | BUTTONFLAG_RIGHT);
}

void CMenus::RenderMenubar(CUIRect Box, IClient::EClientState ClientState)
{
	if(ClientState == IClient::STATE_OFFLINE)
	{
		const char *apLabels[] = {Localize("Play", "Start menu"), Localize("Characters"), Localize("Wallet"), Localize("Leaders"), Localize("Settings")};
		const int aPages[] = {PAGE_RACES, PAGE_CHARACTERS, PAGE_WALLET, PAGE_LEADERS, PAGE_SETTINGS};
		static CButtonContainer s_aTabs[5];
		const float Width = Box.w / 5.0f;
		for(int i = 0; i < 5; ++i)
		{
			CUIRect Tab;
			Box.VSplitLeft(Width, &Tab, &Box);
			if(DoButton_MenuTab(&s_aTabs[i], apLabels[i], m_MenuPage == aPages[i], &Tab, IGraphics::CORNER_T))
				SetMenuPage(aPages[i]);
		}
		return;
	}
	// Keep match controls while connected, without editor/demo shortcuts.
	const char *apLabels[] = {Localize("Game"), Localize("Players"), Localize("Server info"), Localize("Call vote"), Localize("Settings")};
	const int aPages[] = {PAGE_GAME, PAGE_PLAYERS, PAGE_SERVER_INFO, PAGE_CALLVOTE, PAGE_SETTINGS};
	static CButtonContainer s_aMatchTabs[5];
	const float Width = Box.w / 5.0f;
	for(int i = 0; i < 5; ++i)
	{
		CUIRect Tab;
		Box.VSplitLeft(Width, &Tab, &Box);
		if(DoButton_MenuTab(&s_aMatchTabs[i], apLabels[i], m_GamePage == aPages[i], &Tab, IGraphics::CORNER_T))
		{
			m_GamePage = aPages[i];
			if(aPages[i] == PAGE_CALLVOTE)
				m_ControlPageOpening = true;
		}
	}
}

void CMenus::RenderLoadingDirect(const char *pCaption, const char *pContent, std::optional<float> Progress)
{
	// TODO: not supported right now due to separate render thread

	// make sure that we don't render for each little thing we load
	// because that will slow down loading if we have vsync
	// make sure we otherwise update the progressbar if we have one for a smoother animation
	const std::chrono::nanoseconds Now = time_get_nanoseconds();

	/* Limit FPS to something reasonable. Ideally the values would just be stored and the rendering would be on a **consistent** timer with 60Hz
	 * Waiting for calls of this function makes the rendering stutter, which you can notice with the background
	 */
	int RefreshRate = g_Config.m_GfxVsync || !Progress.has_value() ? 60 : (in_range(g_Config.m_GfxRefreshRate, 1, 300) ? g_Config.m_GfxRefreshRate : 300);
	if(RefreshRate > 0 && Now - m_LoadingState.m_LastRender < std::chrono::nanoseconds(1s) / RefreshRate)
		return;

	// need up date this here to get correct
	ms_GuiColor = color_cast<ColorRGBA>(ColorHSLA(g_Config.m_UiColor, true));

	Ui()->MapScreen();

	if(GameClient()->m_MenuBackground.IsLoading())
	{
		// Avoid rendering while loading the menu background as this would otherwise
		// cause the regular menu background to be rendered for a few frames while
		// the menu background is not loaded yet.
		return;
	}
	RenderBackground();

	m_LoadingState.m_LastRender = Now;

	CUIRect Box;
	Ui()->Screen()->Margin(160.0f, &Box);

	Graphics()->TextureClear();
	Box.Draw(ColorRGBA(0.11f, 0.12f, 0.14f, 0.96f), IGraphics::CORNER_ALL, 6.0f);
	Box.Margin(20.0f, &Box);

	CUIRect Label;
	Box.HSplitTop(24.0f, &Label, &Box);
	Ui()->DoLabel(&Label, pCaption, 24.0f, TEXTALIGN_MC);

	Box.HSplitTop(20.0f, nullptr, &Box);
	Box.HSplitTop(24.0f, &Label, &Box);
	Ui()->DoLabel(&Label, pContent, 20.0f, TEXTALIGN_MC);

	if(Progress.has_value())
	{
		CUIRect ProgressBar;
		Box.HSplitBottom(30.0f, &Box, nullptr);
		Box.HSplitBottom(25.0f, &Box, &ProgressBar);
		ProgressBar.VMargin(20.0f, &ProgressBar);
		Ui()->RenderProgressBar(ProgressBar, std::clamp(Progress.value(), 0.0f, 1.0f));
	}

	Graphics()->SetColor(1.0, 1.0, 1.0, 1.0);

	Client()->UpdateAndSwap();
}

void CMenus::RenderLoading(const char *pCaption, const char *pContent, int IncreaseCounter)
{
	// does not support multithreading

	const int CurLoadRenderCount = m_LoadingState.m_Current;
	m_LoadingState.m_Current += IncreaseCounter;
	dbg_assert(m_LoadingState.m_Current <= m_LoadingState.m_Total, "Invalid progress for RenderLoading");
	RenderLoadingDirect(pCaption, pContent, m_LoadingState.m_Total > 0 ? std::make_optional(CurLoadRenderCount / (float)m_LoadingState.m_Total) : std::nullopt);
}

void CMenus::FinishLoading()
{
	m_LoadingState.m_Current = 0;
	m_LoadingState.m_Total = 0;
}

void CMenus::RenderNews(CUIRect MainView)
{
	GameClient()->m_MenuBackground.ChangePosition(CMenuBackground::POS_NEWS);

	g_Config.m_UiUnreadNews = false;

	MainView.Draw(ms_ColorTabbarActive, IGraphics::CORNER_B, 10.0f);

	MainView.HSplitTop(10.0f, nullptr, &MainView);
	MainView.VSplitLeft(15.0f, nullptr, &MainView);

	CUIRect Label;

	const char *pStr = Client()->News();
	char aLine[256];
	while((pStr = str_next_token(pStr, "\n", aLine, sizeof(aLine))))
	{
		const int Len = str_length(aLine);
		if(Len > 0 && aLine[0] == '|' && aLine[Len - 1] == '|')
		{
			MainView.HSplitTop(30.0f, &Label, &MainView);
			aLine[Len - 1] = '\0';
			Ui()->DoLabel(&Label, aLine + 1, 20.0f, TEXTALIGN_ML);
		}
		else
		{
			MainView.HSplitTop(20.0f, &Label, &MainView);
			Ui()->DoLabel(&Label, aLine, 15.f, TEXTALIGN_ML);
		}
	}
}

void CMenus::OnInterfacesInit(CGameClient *pClient)
{
	CComponentInterfaces::OnInterfacesInit(pClient);
	m_MenusIngameTouchControls.OnInterfacesInit(pClient);
	m_MenusSettingsControls.OnInterfacesInit(pClient);
	m_MenusStart.OnInterfacesInit(pClient);
	m_CommunityIcons.OnInterfacesInit(pClient);
}

void CMenus::OnInit()
{
	if(g_Config.m_ClShowWelcome)
	{
		m_Popup = POPUP_LANGUAGE;
		m_CreateDefaultFavoriteCommunities = true;
	}

	if(g_Config.m_UiPage >= PAGE_FAVORITE_COMMUNITY_1 && g_Config.m_UiPage <= PAGE_FAVORITE_COMMUNITY_5 &&
		(size_t)(g_Config.m_UiPage - PAGE_FAVORITE_COMMUNITY_1) >= ServerBrowser()->FavoriteCommunities().size())
	{
		// Reset page to internet when there is no favorite community for this page.
		g_Config.m_UiPage = PAGE_INTERNET;
	}

	if(g_Config.m_ClSkipStartMenu)
	{
		m_ShowStart = false;
	}
	m_MenuPage = PAGE_RACES;

	m_RefreshButton.Init(Ui(), -1);
	m_ConnectButton.Init(Ui(), -1);

	Console()->Chain("add_favorite", ConchainFavoritesUpdate, this);
	Console()->Chain("remove_favorite", ConchainFavoritesUpdate, this);
	Console()->Chain("add_friend", ConchainFriendlistUpdate, this);
	Console()->Chain("remove_friend", ConchainFriendlistUpdate, this);

	Console()->Chain("add_excluded_community", ConchainCommunitiesUpdate, this);
	Console()->Chain("remove_excluded_community", ConchainCommunitiesUpdate, this);
	Console()->Chain("add_excluded_country", ConchainCommunitiesUpdate, this);
	Console()->Chain("remove_excluded_country", ConchainCommunitiesUpdate, this);
	Console()->Chain("add_excluded_type", ConchainCommunitiesUpdate, this);
	Console()->Chain("remove_excluded_type", ConchainCommunitiesUpdate, this);

	Console()->Chain("ui_page", ConchainUiPageUpdate, this);

	Console()->Chain("snd_enable", ConchainUpdateMusicState, this);
	Console()->Chain("snd_enable_music", ConchainUpdateMusicState, this);
	Console()->Chain("cl_background_entities", ConchainBackgroundEntities, this);

	Console()->Chain("cl_assets_entities", ConchainAssetsEntities, this);
	Console()->Chain("cl_asset_game", ConchainAssetGame, this);
	Console()->Chain("cl_asset_emoticons", ConchainAssetEmoticons, this);
	Console()->Chain("cl_asset_particles", ConchainAssetParticles, this);
	Console()->Chain("cl_asset_hud", ConchainAssetHud, this);
	Console()->Chain("cl_asset_extras", ConchainAssetExtras, this);

	Console()->Chain("demo_play", ConchainDemoPlay, this);
	Console()->Chain("demo_speed", ConchainDemoSpeed, this);

	m_TextureBlob = Graphics()->LoadTexture("blob.png", IStorage::TYPE_ALL);

	// Cyberpunk background photos – 8 varied space images
	const char *apBgNames[] = {"ui/backgrounds/start_cyan_grid.png", "ui/backgrounds/play_races_blue.png", "ui/backgrounds/characters_magenta.png", "ui/backgrounds/wallet_gold.png", "ui/backgrounds/leaders_blue.png", "ui/backgrounds/settings_grid.png", "ui/backgrounds/browser_nodes.png", "ui/backgrounds/ingame_combat.png"};
	for(size_t i = 0; i < m_aBgTextures.size(); ++i)
	{
		CImageInfo Info;
		if(Graphics()->LoadPng(Info, apBgNames[i], IStorage::TYPE_ALL))
		{
			m_aBgTextures[i] = Graphics()->LoadTextureRaw(Info, 0, apBgNames[i]);
		}
	}
	// YIELDBLOOM industrial frames – 23 assets (no characters, only frames)
	const char *apYieldNames[] = {
		"ui/yieldbloom/frame_main_panel.png", "ui/yieldbloom/frame_small_card.png", "ui/yieldbloom/button_primary.png", "ui/yieldbloom/button_tab.png",
		"ui/yieldbloom/character_card_frame.png", "ui/yieldbloom/top_header_bar.png", "ui/yieldbloom/left_menu_panel.png", "ui/yieldbloom/right_info_panel.png",
		"ui/yieldbloom/bottom_action_bar.png", "ui/yieldbloom/rack_unit.png", "ui/yieldbloom/input_field.png", "ui/yieldbloom/window_large.png",
		"ui/yieldbloom/connector_cyan.png", "ui/yieldbloom/chat_panel.png", "ui/yieldbloom/panel_races.png", "ui/yieldbloom/panel_wallet.png",
		"ui/yieldbloom/panel_leaders.png", "ui/yieldbloom/panel_settings_block.png", "ui/yieldbloom/frame_transition.png", "ui/yieldbloom/button_small.png",
		"ui/yieldbloom/progress_bar.png", "ui/yieldbloom/panel_tab_bar.png", "ui/yieldbloom/panel_notification.png"};
	for(size_t i = 0; i < std::size(apYieldNames) && i < m_aYieldBloomFrames.size(); ++i)
	{
		CImageInfo Info;
		if(Graphics()->LoadPng(Info, apYieldNames[i], IStorage::TYPE_ALL))
		{
			m_aYieldBloomFrames[i] = Graphics()->LoadTextureRaw(Info, 0, apYieldNames[i]);
		}
	}
	// Character portraits – original potato skins, NOT regenerated, keep original names
	const char *apPortraitNames[] = {
		"portraits/potato_cool_guy_1.png", "portraits/potato_cool_girl_1.png", "portraits/potato_guy_2.png",
		"portraits/potato_girl_2.png", "portraits/potato_guy_3.png", "portraits/potato_guy_4.png",
		"portraits/potato_girl_3.png", "portraits/potato_girl_4.png", "portraits/potato_legend_guy.png",
		"portraits/potato_legend_girl.png"};
	for(size_t i = 0; i < std::size(apPortraitNames) && i < std::size(m_aCharacterPortraits); ++i)
	{
		CImageInfo Info;
		if(Graphics()->LoadPng(Info, apPortraitNames[i], IStorage::TYPE_ALL))
		{
			m_aCharacterPortraits[i] = Graphics()->LoadTextureRaw(Info, 0, apPortraitNames[i]);
		}
	}

	// setup load amount
	m_LoadingState.m_Current = 0;
	m_LoadingState.m_Total = g_pData->m_NumImages + GameClient()->ComponentCount();
	if(!g_Config.m_ClThreadsoundloading)
		m_LoadingState.m_Total += g_pData->m_NumSounds;

	m_IsInit = true;

	// load menu images
	m_vMenuImages.clear();
	Storage()->ListDirectory(IStorage::TYPE_ALL, "menuimages", MenuImageScan, this);

	m_CommunityIcons.Load();

	// Quad for the direction arrows above the player
	m_DirectionQuadContainerIndex = Graphics()->CreateQuadContainer(false);
	Graphics()->QuadContainerAddSprite(m_DirectionQuadContainerIndex, 0.f, 0.f, 22.f);
	Graphics()->QuadContainerUpload(m_DirectionQuadContainerIndex);
}

void CMenus::ConchainBackgroundEntities(IConsole::IResult *pResult, void *pUserData, IConsole::FCommandCallback pfnCallback, void *pCallbackUserData)
{
	pfnCallback(pResult, pCallbackUserData);
	if(pResult->NumArguments())
	{
		CMenus *pSelf = (CMenus *)pUserData;
		if(str_comp(g_Config.m_ClBackgroundEntities, pSelf->GameClient()->m_Background.MapName()) != 0)
			pSelf->GameClient()->m_Background.LoadBackground();
	}
}

void CMenus::ConchainUpdateMusicState(IConsole::IResult *pResult, void *pUserData, IConsole::FCommandCallback pfnCallback, void *pCallbackUserData)
{
	pfnCallback(pResult, pCallbackUserData);
	auto *pSelf = (CMenus *)pUserData;
	if(pResult->NumArguments())
		pSelf->UpdateMusicState();
}

void CMenus::UpdateMusicState()
{
	const bool ShouldPlay = Client()->State() == IClient::STATE_OFFLINE && g_Config.m_SndEnable && g_Config.m_SndMusic;
	if(ShouldPlay && !GameClient()->m_Sounds.IsPlaying(SOUND_MENU))
		GameClient()->m_Sounds.Enqueue(CSounds::CHN_MUSIC, SOUND_MENU);
	else if(!ShouldPlay && GameClient()->m_Sounds.IsPlaying(SOUND_MENU))
		GameClient()->m_Sounds.Stop(SOUND_MENU);
	if(!ShouldPlay)
		GameClient()->m_MapSounds.StopAll();
}

void CMenus::PopupMessage(const char *pTitle, const char *pMessage, const char *pButtonLabel, int NextPopup, FPopupButtonCallback pfnButtonCallback)
{
	// reset active item
	Ui()->SetActiveItem(nullptr);

	str_copy(m_aPopupTitle, pTitle);
	str_copy(m_aPopupMessage, pMessage);
	str_copy(m_aPopupButtons[BUTTON_CONFIRM].m_aLabel, pButtonLabel);
	m_aPopupButtons[BUTTON_CONFIRM].m_NextPopup = NextPopup;
	m_aPopupButtons[BUTTON_CONFIRM].m_pfnCallback = pfnButtonCallback;
	m_Popup = POPUP_MESSAGE;
}

void CMenus::PopupConfirm(const char *pTitle, const char *pMessage, const char *pConfirmButtonLabel, const char *pCancelButtonLabel,
	FPopupButtonCallback pfnConfirmButtonCallback, int ConfirmNextPopup, FPopupButtonCallback pfnCancelButtonCallback, int CancelNextPopup)
{
	// reset active item
	Ui()->SetActiveItem(nullptr);

	str_copy(m_aPopupTitle, pTitle);
	str_copy(m_aPopupMessage, pMessage);
	str_copy(m_aPopupButtons[BUTTON_CONFIRM].m_aLabel, pConfirmButtonLabel);
	m_aPopupButtons[BUTTON_CONFIRM].m_NextPopup = ConfirmNextPopup;
	m_aPopupButtons[BUTTON_CONFIRM].m_pfnCallback = pfnConfirmButtonCallback;
	str_copy(m_aPopupButtons[BUTTON_CANCEL].m_aLabel, pCancelButtonLabel);
	m_aPopupButtons[BUTTON_CANCEL].m_NextPopup = CancelNextPopup;
	m_aPopupButtons[BUTTON_CANCEL].m_pfnCallback = pfnCancelButtonCallback;
	m_Popup = POPUP_CONFIRM;
}

void CMenus::PopupWarning(const char *pTopic, const char *pBody, const char *pButton, std::chrono::nanoseconds Duration)
{
	// no multiline support for console
	std::string BodyStr = pBody;
	std::replace(BodyStr.begin(), BodyStr.end(), '\n', ' ');
	log_warn("client", "%s: %s", pTopic, BodyStr.c_str());

	Ui()->SetActiveItem(nullptr);

	str_copy(m_aMessageTopic, pTopic);
	str_copy(m_aMessageBody, pBody);
	str_copy(m_aMessageButton, pButton);
	m_Popup = POPUP_WARNING;
	SetActive(true);

	m_PopupWarningDuration = Duration;
	m_PopupWarningLastTime = time_get_nanoseconds();
}

bool CMenus::CanDisplayWarning() const
{
	return m_Popup == POPUP_NONE;
}

void CMenus::Render()
{
	Ui()->MapScreen();
	Ui()->SetMouseSlow(false);

	static int s_Frame = 0;
	if(s_Frame == 0)
	{
		RefreshBrowserTab(true);
		s_Frame++;
	}
	else if(s_Frame == 1)
	{
		UpdateMusicState();
		s_Frame++;
	}
	else
	{
		m_CommunityIcons.Update();
	}

	// Initially add DDNet as favorite community and select its tab.
	// This must be delayed until the DDNet info is available.
	if(m_CreateDefaultFavoriteCommunities &&
		ServerBrowser()->DDNetInfoAvailable())
	{
		m_CreateDefaultFavoriteCommunities = false;
		if(ServerBrowser()->Community(IServerBrowser::COMMUNITY_DDNET) != nullptr)
		{
			ServerBrowser()->FavoriteCommunitiesFilter().Clear();
			ServerBrowser()->FavoriteCommunitiesFilter().Add(IServerBrowser::COMMUNITY_DDNET);
			SetMenuPage(PAGE_FAVORITE_COMMUNITY_1);
			ServerBrowser()->Refresh(IServerBrowser::TYPE_FAVORITE_COMMUNITY_1);
		}
	}
	if(m_JoinTutorial.m_Queued && m_Popup == POPUP_NONE)
	{
		const char *pAddr = ServerBrowser()->GetTutorialServer();
		if(pAddr)
		{
			Client()->Connect(pAddr);
		}
		else
		{
			m_Popup = POPUP_JOIN_TUTORIAL;
		}
		m_JoinTutorial.m_Queued = false;
	}

	// Determine the client state once before rendering because it can change
	// while rendering which causes frames with broken user interface.
	const IClient::EClientState ClientState = Client()->State();

	if(ClientState == IClient::STATE_ONLINE || ClientState == IClient::STATE_DEMOPLAYBACK)
	{
		ms_ColorTabbarInactive = ms_ColorTabbarInactiveIngame;
		ms_ColorTabbarActive = ms_ColorTabbarActiveIngame;
		ms_ColorTabbarHover = ms_ColorTabbarHoverIngame;
	}
	else
	{
		RenderBackground();
		ms_ColorTabbarInactive = ms_ColorTabbarInactiveOutgame;
		ms_ColorTabbarActive = ms_ColorTabbarActiveOutgame;
		ms_ColorTabbarHover = ms_ColorTabbarHoverOutgame;
	}

	CUIRect Screen = *Ui()->Screen();
	if(Client()->State() != IClient::STATE_DEMOPLAYBACK || m_Popup != POPUP_NONE)
	{
		Screen.Margin(10.0f, &Screen);
	}

	switch(ClientState)
	{
	case IClient::STATE_QUITTING:
	case IClient::STATE_RESTARTING:
		// Render nothing except menu background. This should not happen for more than one frame.
		return;

	case IClient::STATE_CONNECTING:
		RenderPopupConnecting(Screen);
		break;

	case IClient::STATE_LOADING:
		RenderPopupLoading(Screen);
		break;

	case IClient::STATE_OFFLINE:
		if(m_Popup != POPUP_NONE)
		{
			RenderPopupFullscreen(Screen);
		}
		else if(m_ShowStart)
		{
			m_MenusStart.RenderStartMenu(Screen);
		}
		else
		{
			CUIRect TabBar, MainView;
			Screen.HSplitTop(44.0f, &TabBar, &MainView);

			if(m_MenuPage == PAGE_RACES)
				RenderRaceLobby(MainView);
			else if(m_MenuPage == PAGE_CHARACTERS)
				RenderCharacters(MainView);
			else if(m_MenuPage == PAGE_WALLET)
			{
				MainView.Margin(20.0f, &MainView);
				RenderSettingsWallet(MainView);
			}
			else if(m_MenuPage == PAGE_LEADERS)
				RenderLeaders(MainView);
			else if(m_MenuPage == PAGE_NEWS)
			{
				RenderNews(MainView);
			}
			else if(m_MenuPage >= PAGE_INTERNET && m_MenuPage <= PAGE_FAVORITE_COMMUNITY_5)
			{
				RenderServerbrowser(MainView);
			}
			else if(m_MenuPage == PAGE_DEMOS)
			{
				RenderDemoBrowser(MainView);
			}
			else if(m_MenuPage == PAGE_SETTINGS)
			{
				RenderSettings(MainView);
			}
			else
			{
				dbg_assert_failed("Invalid m_MenuPage: %d", m_MenuPage);
			}

			RenderMenubar(TabBar, ClientState);
		}
		break;

	case IClient::STATE_ONLINE:
		if(m_Popup != POPUP_NONE)
		{
			RenderPopupFullscreen(Screen);
		}
		else
		{
			CUIRect TabBar, MainView;
			Screen.HSplitTop(44.0f, &TabBar, &MainView);

			if(m_GamePage == PAGE_GAME)
			{
				RenderGame(MainView);
				RenderIngameHint();
			}
			else if(m_GamePage == PAGE_PLAYERS)
			{
				RenderPlayers(MainView);
			}
			else if(m_GamePage == PAGE_SERVER_INFO)
			{
				RenderServerInfo(MainView);
			}
			else if(m_GamePage == PAGE_NETWORK)
			{
				RenderInGameNetwork(MainView);
			}
			else if(m_GamePage == PAGE_GHOST)
			{
				RenderGhost(MainView);
			}
			else if(m_GamePage == PAGE_CALLVOTE)
			{
				RenderServerControl(MainView);
			}
			else if(m_GamePage == PAGE_DEMOS)
			{
				RenderDemoBrowser(MainView);
			}
			else if(m_GamePage == PAGE_SETTINGS)
			{
				RenderSettings(MainView);
			}
			else
			{
				dbg_assert_failed("Invalid m_GamePage: %d", m_GamePage);
			}

			RenderMenubar(TabBar, ClientState);
		}
		break;

	case IClient::STATE_DEMOPLAYBACK:
		if(m_Popup != POPUP_NONE)
		{
			RenderPopupFullscreen(Screen);
		}
		else
		{
			RenderDemoPlayer(Screen);
		}
		break;
	}

	Ui()->RenderPopupMenus();

	// Prevent UI elements from being hovered while a key reader is active
	if(GameClient()->m_KeyBinder.IsActive())
	{
		Ui()->SetHotItem(nullptr);
	}

	// Handle this escape hotkey after popup menus
	if(!m_ShowStart && ClientState == IClient::STATE_OFFLINE && Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE))
	{
		m_ShowStart = true;
	}
}

void CMenus::RenderPopupFullscreen(CUIRect Screen)
{
	char aBuf[1536];
	const char *pTitle = "";
	const char *pExtraText = "";
	const char *pButtonText = "";
	bool TopAlign = false;

	// Dark neon panel – deep space with cyan tint
	ColorRGBA BgColor = ColorRGBA(0.04f, 0.06f, 0.11f, 1.0f);
	if(m_Popup == POPUP_MESSAGE || m_Popup == POPUP_CONFIRM)
	{
		pTitle = m_aPopupTitle;
		pExtraText = m_aPopupMessage;
		TopAlign = true;
	}
	else if(m_Popup == POPUP_DISCONNECTED)
	{
		pTitle = Localize("Disconnected");
		pExtraText = Client()->ErrorString();
		pButtonText = Localize("Ok");
		if(Client()->ReconnectTime() > 0)
		{
			str_format(aBuf, sizeof(aBuf), Localize("Reconnect in %d sec"), (int)((Client()->ReconnectTime() - time_get()) / time_freq()) + 1);
			pTitle = Client()->ErrorString();
			pExtraText = aBuf;
			pButtonText = Localize("Abort");
		}
	}
	else if(m_Popup == POPUP_RENAME_DEMO)
	{
		dbg_assert(m_DemolistSelectedIndex >= 0, "m_DemolistSelectedIndex invalid for POPUP_RENAME_DEMO");
		pTitle = m_vpFilteredDemos[m_DemolistSelectedIndex]->m_IsDir ? Localize("Rename folder") : Localize("Rename demo");
	}
#if defined(CONF_VIDEORECORDER)
	else if(m_Popup == POPUP_RENDER_DEMO)
	{
		pTitle = Localize("Render demo");
	}
	else if(m_Popup == POPUP_RENDER_DONE)
	{
		pTitle = Localize("Render complete");
	}
#endif
	else if(m_Popup == POPUP_PASSWORD)
	{
		pTitle = Localize("Password incorrect");
		pButtonText = Localize("Try again");
	}
	else if(m_Popup == POPUP_RESTART)
	{
		pTitle = Localize("Restart");
		pExtraText = Localize("Are you sure that you want to restart?");
	}
	else if(m_Popup == POPUP_QUIT)
	{
		pTitle = Localize("Quit");
		pExtraText = Localize("Are you sure that you want to quit?");
	}
	else if(m_Popup == POPUP_FIRST_LAUNCH)
	{
		pTitle = Localize("Welcome to Neon Relay");
		str_format(aBuf, sizeof(aBuf), "%s\n\n%s\n\n%s\n\n%s",
			Localize("Neon Relay is a cooperative online game where the goal is for you and your group of tees to reach the finish line of the map. As a newcomer you should start on Novice servers, which host the easiest maps. Consider the ping to choose a server close to you."),
			Localize("Use k key to kill (restart), q to pause and watch other players. See settings for other key binds."),
			Localize("It's recommended that you check the settings to adjust them to your liking before joining a server."),
			Localize("Please enter your nickname below."));
		pExtraText = aBuf;
		pButtonText = Localize("Ok");
		TopAlign = true;
	}
	else if(m_Popup == POPUP_JOIN_TUTORIAL)
	{
		pTitle = Localize("Joining Tutorial server");
	}
	else if(m_Popup == POPUP_POINTS)
	{
		pTitle = Localize("Existing Player");
		if(Client()->InfoState() == IClient::EInfoState::SUCCESS && Client()->Points() > 50)
		{
			str_format(aBuf, sizeof(aBuf), Localize("Your nickname '%s' is already used (%d points). Do you still want to use it?"), Client()->PlayerName(), Client()->Points());
			pExtraText = aBuf;
			TopAlign = true;
		}
		else
		{
			pExtraText = Localize("Checking for existing player with your name");
		}
	}
	else if(m_Popup == POPUP_WARNING)
	{
		BgColor = ColorRGBA(0.08f, 0.06f, 0.12f, 1.0f);
		pTitle = m_aMessageTopic;
		pExtraText = m_aMessageBody;
		pButtonText = m_aMessageButton;
		TopAlign = true;
	}
	else if(m_Popup == POPUP_SAVE_SKIN)
	{
		pTitle = Localize("Save skin");
		pExtraText = Localize("Are you sure you want to save your skin? If a skin with this name already exists, it will be replaced.");
	}

	CUIRect Box, Part;
	Box = Screen;
	if(m_Popup != POPUP_FIRST_LAUNCH)
	{
		Box.VMargin(std::max(12.0f, (Screen.w - 660.0f) / 2.0f), &Box);
		Box.HMargin(std::min(150.0f, Screen.h * 0.16f), &Box);
	}

	// Dim the page, then render a readable opaque dialog.
	Screen.Draw(ColorRGBA(0.02f, 0.03f, 0.07f, 0.82f), 0, 0.0f);
	Box.Draw(BgColor, IGraphics::CORNER_ALL, 15.0f);

	// Title
	{
		CUIRect Title;
		Box.HSplitTop(20.0f, nullptr, &Box);
		Box.HSplitTop(24.0f, &Title, &Box);
		Box.HSplitTop(20.0f, nullptr, &Box);
		Title.VMargin(20.0f, &Title);

		const float TitleFontSize = 24.0f;
		if(TextRender()->TextWidth(TitleFontSize, pTitle) > Title.w)
			Ui()->DoLabel(&Title, pTitle, TitleFontSize, TEXTALIGN_ML, {.m_MaxWidth = Title.w});
		else
			Ui()->DoLabel(&Title, pTitle, TitleFontSize, TEXTALIGN_MC);
	}

	// Extra text (optional)
	if(m_Popup != POPUP_JOIN_TUTORIAL)
	{
		CUIRect ExtraText;
		Box.HSplitTop(24.0f, &ExtraText, &Box);
		ExtraText.VMargin(20.0f, &ExtraText);
		if(pExtraText[0] != '\0')
		{
			const float ExtraTextFontSize = m_Popup == POPUP_FIRST_LAUNCH ? 16.0f : 20.0f;

			if(TopAlign)
				Ui()->DoLabel(&ExtraText, pExtraText, ExtraTextFontSize, TEXTALIGN_TL, {.m_MaxWidth = ExtraText.w});
			else if(TextRender()->TextWidth(ExtraTextFontSize, pExtraText) > ExtraText.w)
				Ui()->DoLabel(&ExtraText, pExtraText, ExtraTextFontSize, TEXTALIGN_ML, {.m_MaxWidth = ExtraText.w});
			else
				Ui()->DoLabel(&ExtraText, pExtraText, ExtraTextFontSize, TEXTALIGN_MC);
		}
	}

	if(m_Popup == POPUP_MESSAGE || m_Popup == POPUP_CONFIRM)
	{
		CUIRect ButtonBar;
		Box.HSplitBottom(20.0f, &Box, nullptr);
		Box.HSplitBottom(24.0f, &Box, &ButtonBar);
		ButtonBar.VMargin(100.0f, &ButtonBar);

		if(m_Popup == POPUP_MESSAGE)
		{
			static CButtonContainer s_ButtonConfirm;
			if(DoButton_Menu(&s_ButtonConfirm, m_aPopupButtons[BUTTON_CONFIRM].m_aLabel, 0, &ButtonBar) || Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE) || Ui()->ConsumeHotkey(CUi::HOTKEY_ENTER))
			{
				m_Popup = m_aPopupButtons[BUTTON_CONFIRM].m_NextPopup;
				(this->*m_aPopupButtons[BUTTON_CONFIRM].m_pfnCallback)();
			}
		}
		else if(m_Popup == POPUP_CONFIRM)
		{
			CUIRect CancelButton, ConfirmButton;
			ButtonBar.VSplitMid(&CancelButton, &ConfirmButton, 40.0f);

			static CButtonContainer s_ButtonCancel;
			if(DoButton_Menu(&s_ButtonCancel, m_aPopupButtons[BUTTON_CANCEL].m_aLabel, 0, &CancelButton) || Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE))
			{
				m_Popup = m_aPopupButtons[BUTTON_CANCEL].m_NextPopup;
				(this->*m_aPopupButtons[BUTTON_CANCEL].m_pfnCallback)();
			}

			static CButtonContainer s_ButtonConfirm;
			if(DoButton_Menu(&s_ButtonConfirm, m_aPopupButtons[BUTTON_CONFIRM].m_aLabel, 0, &ConfirmButton) || Ui()->ConsumeHotkey(CUi::HOTKEY_ENTER))
			{
				m_Popup = m_aPopupButtons[BUTTON_CONFIRM].m_NextPopup;
				(this->*m_aPopupButtons[BUTTON_CONFIRM].m_pfnCallback)();
			}
		}
	}
	else if(m_Popup == POPUP_QUIT || m_Popup == POPUP_RESTART)
	{
		CUIRect Yes, No;
		Box.HSplitBottom(20.f, &Box, &Part);
		Box.HSplitBottom(24.f, &Box, &Part);

		// additional info
		Box.VMargin(20.f, &Box);

		if(GameClient()->m_TouchControls.HasEditingChanges() || m_MenusIngameTouchControls.UnsavedChanges())
		{
			str_format(aBuf, sizeof(aBuf), "%s\n\n%s", Localize("There's an unsaved change in the touch controls editor, you might want to save it."), Localize("Continue anyway?"));
			Ui()->DoLabel(&Box, aBuf, 20.0f, TEXTALIGN_ML, {.m_MaxWidth = Part.w - 20.0f});
		}

		// buttons
		Part.VMargin(80.0f, &Part);
		Part.VSplitMid(&No, &Yes);
		Yes.VMargin(20.0f, &Yes);
		No.VMargin(20.0f, &No);

		static CButtonContainer s_ButtonAbort;
		if(DoButton_Menu(&s_ButtonAbort, Localize("No"), 0, &No) || Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE))
			m_Popup = POPUP_NONE;

		static CButtonContainer s_ButtonTryAgain;
		if(DoButton_Menu(&s_ButtonTryAgain, Localize("Yes"), 0, &Yes) || Ui()->ConsumeHotkey(CUi::HOTKEY_ENTER))
		{
			if(m_Popup == POPUP_RESTART)
			{
				m_Popup = POPUP_NONE;
				Client()->Restart();
			}
			else
			{
				m_Popup = POPUP_NONE;
				Client()->Quit();
			}
		}
	}
	else if(m_Popup == POPUP_PASSWORD)
	{
		Box.HSplitBottom(20.0f, &Box, nullptr);
		Box.HSplitBottom(24.0f, &Box, &Part);
		Part.VMargin(100.0f, &Part);

		CUIRect TryAgain, Abort;
		Part.VSplitMid(&Abort, &TryAgain, 40.0f);

		static CButtonContainer s_ButtonAbort;
		if(DoButton_Menu(&s_ButtonAbort, Localize("Abort"), 0, &Abort) ||
			Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE))
		{
			m_Popup = POPUP_NONE;
		}

		char aAddr[NETADDR_MAXSTRSIZE];
		net_addr_str(&Client()->ServerAddress(), aAddr, sizeof(aAddr), true);

		static CButtonContainer s_ButtonTryAgain;
		if(DoButton_Menu(&s_ButtonTryAgain, Localize("Try again"), 0, &TryAgain) ||
			Ui()->ConsumeHotkey(CUi::HOTKEY_ENTER))
		{
			Client()->Connect(aAddr, g_Config.m_Password);
		}

		Box.VMargin(60.0f, &Box);
		Box.HSplitBottom(32.0f, &Box, nullptr);
		Box.HSplitBottom(24.0f, &Box, &Part);

		CUIRect Label, TextBox;
		Part.VSplitLeft(100.0f, &Label, &TextBox);
		TextBox.VSplitLeft(20.0f, nullptr, &TextBox);
		Ui()->DoLabel(&Label, Localize("Password"), 18.0f, TEXTALIGN_ML);
		Ui()->DoClearableEditBox(&m_PasswordInput, &TextBox, 12.0f);

		Box.HSplitBottom(32.0f, &Box, nullptr);
		Box.HSplitBottom(24.0f, &Box, &Part);

		CUIRect Address;
		Part.VSplitLeft(100.0f, &Label, &Address);
		Address.VSplitLeft(20.0f, nullptr, &Address);
		Ui()->DoLabel(&Label, Localize("Address"), 18.0f, TEXTALIGN_ML);
		Ui()->DoLabel(&Address, aAddr, 18.0f, TEXTALIGN_ML);

		const CServerBrowser::CServerEntry *pEntry = ServerBrowser()->Find(Client()->ServerAddress());
		if(pEntry != nullptr && pEntry->m_GotInfo)
		{
			const CCommunity *pCommunity = ServerBrowser()->Community(pEntry->m_Info.m_aCommunityId);
			const CCommunityIcon *pIcon = pCommunity == nullptr ? nullptr : m_CommunityIcons.Find(pCommunity->Id());

			Box.HSplitBottom(32.0f, &Box, nullptr);
			Box.HSplitBottom(24.0f, &Box, &Part);

			CUIRect Name;
			Part.VSplitLeft(100.0f, &Label, &Name);
			Name.VSplitLeft(20.0f, nullptr, &Name);
			if(pIcon != nullptr)
			{
				CUIRect Icon;
				static char s_CommunityTooltipButtonId;
				Name.VSplitLeft(2.5f * Name.h, &Icon, &Name);
				m_CommunityIcons.Render(pIcon, Icon, true);
				Ui()->DoButtonLogic(&s_CommunityTooltipButtonId, 0, &Icon, BUTTONFLAG_NONE);
				GameClient()->m_Tooltips.DoToolTip(&s_CommunityTooltipButtonId, &Icon, pCommunity->Name());
			}

			Ui()->DoLabel(&Label, Localize("Name"), 18.0f, TEXTALIGN_ML);
			Ui()->DoLabel(&Name, pEntry->m_Info.m_aName, 18.0f, TEXTALIGN_ML);
		}
	}
	else if(m_Popup == POPUP_LANGUAGE)
	{
		CUIRect Button;
		Screen.Margin(150.0f, &Box);
		Box.HSplitTop(20.0f, nullptr, &Box);
		Box.HSplitBottom(20.0f, &Box, nullptr);
		Box.HSplitBottom(24.0f, &Box, &Button);
		Box.HSplitBottom(20.0f, &Box, nullptr);
		Box.VMargin(20.0f, &Box);
		const bool Activated = RenderLanguageSelection(Box);
		Button.VMargin(120.0f, &Button);

		static CButtonContainer s_Button;
		if(DoButton_Menu(&s_Button, Localize("Ok"), 0, &Button) || Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE) || Ui()->ConsumeHotkey(CUi::HOTKEY_ENTER) || Activated)
			m_Popup = POPUP_FIRST_LAUNCH;
	}
	else if(m_Popup == POPUP_RENAME_DEMO)
	{
		CUIRect Label, TextBox, Ok, Abort;

		Box.HSplitBottom(20.f, &Box, &Part);
		Box.HSplitBottom(24.f, &Box, &Part);
		Part.VMargin(80.0f, &Part);

		Part.VSplitMid(&Abort, &Ok);

		Ok.VMargin(20.0f, &Ok);
		Abort.VMargin(20.0f, &Abort);

		static CButtonContainer s_ButtonAbort;
		if(DoButton_Menu(&s_ButtonAbort, Localize("Abort"), 0, &Abort) || Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE))
			m_Popup = POPUP_NONE;

		static CButtonContainer s_ButtonOk;
		if(DoButton_Menu(&s_ButtonOk, Localize("Ok"), 0, &Ok) || Ui()->ConsumeHotkey(CUi::HOTKEY_ENTER))
		{
			m_Popup = POPUP_NONE;
			// rename demo
			char aBufOld[IO_MAX_PATH_LENGTH];
			str_format(aBufOld, sizeof(aBufOld), "%s/%s", m_aCurrentDemoFolder, m_vpFilteredDemos[m_DemolistSelectedIndex]->m_aFilename);
			char aBufNew[IO_MAX_PATH_LENGTH];
			str_format(aBufNew, sizeof(aBufNew), "%s/%s", m_aCurrentDemoFolder, m_DemoRenameInput.GetString());
			if(!m_vpFilteredDemos[m_DemolistSelectedIndex]->m_IsDir && !str_endswith(aBufNew, ".demo"))
				str_append(aBufNew, ".demo");

			if(str_comp(aBufOld, aBufNew) == 0)
			{
				// Nothing to rename, also same capitalization
			}
			else if(!str_valid_filename(m_DemoRenameInput.GetString()))
			{
				PopupMessage(Localize("Error"), Localize("This name cannot be used for files and folders"), Localize("Ok"), POPUP_RENAME_DEMO);
			}
			else if(str_utf8_comp_nocase(aBufOld, aBufNew) != 0 && // Allow renaming if it only changes capitalization to support case-insensitive filesystems
				Storage()->FileExists(aBufNew, m_vpFilteredDemos[m_DemolistSelectedIndex]->m_StorageType))
			{
				PopupMessage(Localize("Error"), Localize("A demo with this name already exists"), Localize("Ok"), POPUP_RENAME_DEMO);
			}
			else if(Storage()->FolderExists(aBufNew, m_vpFilteredDemos[m_DemolistSelectedIndex]->m_StorageType))
			{
				PopupMessage(Localize("Error"), Localize("A folder with this name already exists"), Localize("Ok"), POPUP_RENAME_DEMO);
			}
			else if(Storage()->RenameFile(aBufOld, aBufNew, m_vpFilteredDemos[m_DemolistSelectedIndex]->m_StorageType))
			{
				str_copy(m_aCurrentDemoSelectionName, m_DemoRenameInput.GetString());
				if(!m_vpFilteredDemos[m_DemolistSelectedIndex]->m_IsDir)
					fs_split_file_extension(m_DemoRenameInput.GetString(), m_aCurrentDemoSelectionName, sizeof(m_aCurrentDemoSelectionName));
				DemolistPopulate();
				DemolistOnUpdate(false);
			}
			else
			{
				PopupMessage(Localize("Error"), m_vpFilteredDemos[m_DemolistSelectedIndex]->m_IsDir ? Localize("Unable to rename the folder") : Localize("Unable to rename the demo"), Localize("Ok"), POPUP_RENAME_DEMO);
			}
		}

		Box.HSplitBottom(60.f, &Box, &Part);
		Box.HSplitBottom(24.f, &Box, &Part);

		Part.VSplitLeft(60.0f, nullptr, &Label);
		Label.VSplitLeft(120.0f, nullptr, &TextBox);
		TextBox.VSplitLeft(20.0f, nullptr, &TextBox);
		TextBox.VSplitRight(60.0f, &TextBox, nullptr);
		Ui()->DoLabel(&Label, Localize("New name:"), 18.0f, TEXTALIGN_ML);
		Ui()->DoEditBox(&m_DemoRenameInput, &TextBox, 12.0f);
	}
#if defined(CONF_VIDEORECORDER)
	else if(m_Popup == POPUP_RENDER_DEMO)
	{
		CUIRect Row, Ok, Abort;
		Box.VMargin(60.0f, &Box);
		Box.HMargin(20.0f, &Box);
		Box.HSplitBottom(24.0f, &Box, &Row);
		Box.HSplitBottom(40.0f, &Box, nullptr);
		Row.VMargin(40.0f, &Row);
		Row.VSplitMid(&Abort, &Ok, 40.0f);

		static CButtonContainer s_ButtonAbort;
		if(DoButton_Menu(&s_ButtonAbort, Localize("Abort"), 0, &Abort) || Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE))
		{
			m_DemoRenderInput.Clear();
			m_Popup = POPUP_NONE;
		}

		static CButtonContainer s_ButtonOk;
		if(DoButton_Menu(&s_ButtonOk, Localize("Ok"), 0, &Ok) || Ui()->ConsumeHotkey(CUi::HOTKEY_ENTER))
		{
			m_Popup = POPUP_NONE;
			// render video
			char aVideoPath[IO_MAX_PATH_LENGTH];
			str_format(aVideoPath, sizeof(aVideoPath), "videos/%s", m_DemoRenderInput.GetString());
			if(!str_endswith(aVideoPath, ".mp4"))
				str_append(aVideoPath, ".mp4");

			if(!str_valid_filename(m_DemoRenderInput.GetString()))
			{
				PopupMessage(Localize("Error"), Localize("This name cannot be used for files and folders"), Localize("Ok"), POPUP_RENDER_DEMO);
			}
			else if(Storage()->FolderExists(aVideoPath, IStorage::TYPE_SAVE))
			{
				PopupMessage(Localize("Error"), Localize("A folder with this name already exists"), Localize("Ok"), POPUP_RENDER_DEMO);
			}
			else if(Storage()->FileExists(aVideoPath, IStorage::TYPE_SAVE))
			{
				char aMessage[128 + IO_MAX_PATH_LENGTH];
				str_format(aMessage, sizeof(aMessage), Localize("File '%s' already exists, do you want to overwrite it?"), m_DemoRenderInput.GetString());
				PopupConfirm(Localize("Replace video"), aMessage, Localize("Yes"), Localize("No"), &CMenus::PopupConfirmDemoReplaceVideo, POPUP_NONE, &CMenus::DefaultButtonCallback, POPUP_RENDER_DEMO);
			}
			else
			{
				PopupConfirmDemoReplaceVideo();
			}
		}

		CUIRect ShowChatCheckbox, UseSoundsCheckbox;
		Box.HSplitBottom(20.0f, &Box, &Row);
		Box.HSplitBottom(10.0f, &Box, nullptr);
		Row.VSplitMid(&ShowChatCheckbox, &UseSoundsCheckbox, 20.0f);

		if(DoButton_CheckBox(&g_Config.m_ClVideoShowChat, Localize("Show chat"), g_Config.m_ClVideoShowChat, &ShowChatCheckbox))
			g_Config.m_ClVideoShowChat ^= 1;

		if(DoButton_CheckBox(&g_Config.m_ClVideoSndEnable, Localize("Use sounds"), g_Config.m_ClVideoSndEnable, &UseSoundsCheckbox))
			g_Config.m_ClVideoSndEnable ^= 1;

		CUIRect ShowHudButton;
		Box.HSplitBottom(20.0f, &Box, &Row);
		Row.VSplitMid(&Row, &ShowHudButton, 20.0f);

		if(DoButton_CheckBox(&g_Config.m_ClVideoShowhud, Localize("Show ingame HUD"), g_Config.m_ClVideoShowhud, &ShowHudButton))
			g_Config.m_ClVideoShowhud ^= 1;

		// slowdown
		CUIRect SlowDownButton;
		Row.VSplitLeft(20.0f, &SlowDownButton, &Row);
		Row.VSplitLeft(5.0f, nullptr, &Row);
		static CButtonContainer s_SlowDownButton;
		if(Ui()->DoButton_FontIcon(&s_SlowDownButton, FontIcon::BACKWARD, 0, &SlowDownButton, BUTTONFLAG_LEFT))
			m_Speed = std::clamp(m_Speed - 1, 0, (int)(std::size(DEMO_SPEEDS) - 1));

		// paused
		CUIRect PausedButton;
		Row.VSplitLeft(20.0f, &PausedButton, &Row);
		Row.VSplitLeft(5.0f, nullptr, &Row);
		static CButtonContainer s_PausedButton;
		if(Ui()->DoButton_FontIcon(&s_PausedButton, FontIcon::PAUSE, 0, &PausedButton, BUTTONFLAG_LEFT))
			m_StartPaused ^= 1;

		// fastforward
		CUIRect FastForwardButton;
		Row.VSplitLeft(20.0f, &FastForwardButton, &Row);
		Row.VSplitLeft(8.0f, nullptr, &Row);
		static CButtonContainer s_FastForwardButton;
		if(Ui()->DoButton_FontIcon(&s_FastForwardButton, FontIcon::FORWARD, 0, &FastForwardButton, BUTTONFLAG_LEFT))
			m_Speed = std::clamp(m_Speed + 1, 0, (int)(std::size(DEMO_SPEEDS) - 1));

		// speed meter
		char aBuffer[128];
		const char *pPaused = m_StartPaused ? Localize("(paused)") : "";
		str_format(aBuffer, sizeof(aBuffer), "%s: ×%g %s", Localize("Speed"), DEMO_SPEEDS[m_Speed], pPaused);
		Ui()->DoLabel(&Row, aBuffer, 12.8f, TEXTALIGN_ML);
		Box.HSplitBottom(16.0f, &Box, nullptr);
		Box.HSplitBottom(24.0f, &Box, &Row);

		CUIRect Label, TextBox;
		Row.VSplitLeft(110.0f, &Label, &TextBox);
		TextBox.VSplitLeft(10.0f, nullptr, &TextBox);
		Ui()->DoLabel(&Label, Localize("Video name:"), 12.8f, TEXTALIGN_ML);
		Ui()->DoEditBox(&m_DemoRenderInput, &TextBox, 12.8f);

		// Warn about disconnect if online
		if(Client()->State() == IClient::STATE_ONLINE)
		{
			Box.HSplitBottom(10.0f, &Box, nullptr);
			Box.HSplitBottom(20.0f, &Box, &Row);
			SLabelProperties LabelProperties;
			LabelProperties.SetColor(ColorRGBA(1.0f, 0.0f, 0.0f));
			Ui()->DoLabel(&Row, Localize("You will be disconnected from the server."), 12.8f, TEXTALIGN_MC, LabelProperties);
		}
	}
	else if(m_Popup == POPUP_RENDER_DONE)
	{
		CUIRect Ok, OpenFolder;

		char aFilePath[IO_MAX_PATH_LENGTH];
		char aSaveFolder[IO_MAX_PATH_LENGTH];
		Storage()->GetCompletePath(IStorage::TYPE_SAVE, "videos", aSaveFolder, sizeof(aSaveFolder));
		str_format(aFilePath, sizeof(aFilePath), "%s/%s.mp4", aSaveFolder, m_DemoRenderInput.GetString());

		Box.HSplitBottom(20.f, &Box, &Part);
		Box.HSplitBottom(24.f, &Box, &Part);
		Part.VMargin(80.0f, &Part);

		Part.VSplitMid(&OpenFolder, &Ok);

		Ok.VMargin(20.0f, &Ok);
		OpenFolder.VMargin(20.0f, &OpenFolder);

		static CButtonContainer s_ButtonOpenFolder;
		if(DoButton_Menu(&s_ButtonOpenFolder, Localize("Videos directory"), 0, &OpenFolder))
		{
			Client()->ViewFile(aSaveFolder);
		}

		static CButtonContainer s_ButtonOk;
		if(DoButton_Menu(&s_ButtonOk, Localize("Ok"), 0, &Ok) || Ui()->ConsumeHotkey(CUi::HOTKEY_ENTER))
		{
			m_Popup = POPUP_NONE;
			m_DemoRenderInput.Clear();
		}

		Box.HSplitBottom(160.f, &Box, &Part);
		Part.VMargin(20.0f, &Part);

		str_format(aBuf, sizeof(aBuf), Localize("Video was saved to '%s'"), aFilePath);

		SLabelProperties MessageProps;
		MessageProps.m_MaxWidth = (int)Part.w;
		Ui()->DoLabel(&Part, aBuf, 18.0f, TEXTALIGN_TL, MessageProps);
	}
#endif
	else if(m_Popup == POPUP_FIRST_LAUNCH)
	{
		CUIRect Label, TextBox, Skip, Join;

		Box.HSplitBottom(20.f, &Box, &Part);
		Box.HSplitBottom(24.f, &Box, &Part);
		Part.VMargin(80.0f, &Part);
		Part.VSplitMid(&Skip, &Join);
		Skip.VMargin(20.0f, &Skip);
		Join.VMargin(20.0f, &Join);

		static CButtonContainer s_JoinTutorialButton;
		if(DoButton_Menu(&s_JoinTutorialButton, Localize("Join Tutorial Server"), 0, &Join) || Ui()->ConsumeHotkey(CUi::HOTKEY_ENTER))
		{
			Client()->RequestDDNetInfo();
			m_Popup = g_Config.m_BrIndicateFinished ? POPUP_POINTS : POPUP_NONE;
			JoinTutorial();
		}

		static CButtonContainer s_SkipTutorialButton;
		if(DoButton_Menu(&s_SkipTutorialButton, Localize("Skip Tutorial"), 0, &Skip) || Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE))
		{
			Client()->RequestDDNetInfo();
			m_JoinTutorial.m_Queued = false;
			m_Popup = g_Config.m_BrIndicateFinished ? POPUP_POINTS : POPUP_NONE;
		}

		Box.HSplitBottom(20.f, &Box, &Part);
		Box.HSplitBottom(24.f, &Box, &Part);

		Part.VSplitLeft(30.0f, nullptr, &Part);
		str_format(aBuf, sizeof(aBuf), "%s\n(%s)",
			Localize("Show map finishes in server browser"),
			Localize("transmits your player name to the configured info service"));

		if(DoButton_CheckBox(&g_Config.m_BrIndicateFinished, aBuf, g_Config.m_BrIndicateFinished, &Part))
			g_Config.m_BrIndicateFinished ^= 1;

		Box.HSplitBottom(20.f, &Box, &Part);
		Box.HSplitBottom(24.f, &Box, &Part);

		Part.VSplitLeft(60.0f, nullptr, &Label);
		Label.VSplitLeft(100.0f, nullptr, &TextBox);
		TextBox.VSplitLeft(20.0f, nullptr, &TextBox);
		TextBox.VSplitRight(60.0f, &TextBox, nullptr);
		Ui()->DoLabel(&Label, Localize("Nickname"), 16.0f, TEXTALIGN_ML);
		static CLineInput s_PlayerNameInput(g_Config.m_PlayerName, sizeof(g_Config.m_PlayerName));
		s_PlayerNameInput.SetEmptyText(Client()->PlayerName());
		Ui()->DoEditBox(&s_PlayerNameInput, &TextBox, 12.0f);
	}
	else if(m_Popup == POPUP_JOIN_TUTORIAL)
	{
		CUIRect ButtonBar, StatusLabel, ProgressLabel, ProgressIndicator;
		Box.HSplitBottom(20.0f, &Box, nullptr);
		Box.HSplitBottom(24.0f, &Box, &ButtonBar);
		ButtonBar.VMargin(120.0f, &ButtonBar);
		Box.HSplitBottom(20.0f, &StatusLabel, nullptr);
		StatusLabel.VMargin(20.0f, &StatusLabel);
		StatusLabel.HSplitMid(&StatusLabel, &ProgressLabel);
		ProgressLabel.VSplitLeft(50.0f, &ProgressIndicator, &ProgressLabel);

		if(m_JoinTutorial.m_Status == CJoinTutorial::EStatus::REFRESHING)
		{
			if(ServerBrowser()->IsGettingServerlist() ||
				Client()->InfoState() == IClient::EInfoState::LOADING)
			{
				// Still refreshing
			}
			else if(ServerBrowser()->IsServerlistError() ||
				Client()->InfoState() == IClient::EInfoState::ERROR)
			{
				m_JoinTutorial.m_Status = CJoinTutorial::EStatus::SERVER_LIST_ERROR;
			}
			else
			{
				const char *pAddr = ServerBrowser()->GetTutorialServer();
				if(pAddr)
				{
					Client()->Connect(pAddr);
				}
				else
				{
					m_JoinTutorial.m_Status = CJoinTutorial::EStatus::NO_TUTORIAL_AVAILABLE;
				}
			}
		}

		const char *pStatusLabel = nullptr;
		switch(m_JoinTutorial.m_Status)
		{
		case CJoinTutorial::EStatus::REFRESHING:
			pStatusLabel = Localize("Getting server list from master server");
			break;
		case CJoinTutorial::EStatus::SERVER_LIST_ERROR:
			pStatusLabel = Localize("Could not get server list from master server");
			break;
		case CJoinTutorial::EStatus::NO_TUTORIAL_AVAILABLE:
			pStatusLabel = Localize("There are no Tutorial servers available");
			break;
		}
		if(pStatusLabel != nullptr)
		{
			Ui()->DoLabel(&StatusLabel, pStatusLabel, 20.0f, TEXTALIGN_ML);
		}

		const char *pProgressLabel = nullptr;
		bool ProgressDeterminate = true;
		const float LastStateChangeSeconds = std::chrono::duration_cast<std::chrono::duration<float>>(time_get_nanoseconds() - m_JoinTutorial.m_StateChange).count();
		constexpr float RefreshDelay = 5.0f;

		if(m_JoinTutorial.m_Status == CJoinTutorial::EStatus::REFRESHING)
		{
			pProgressLabel = Localize("Please wait…");
			ProgressDeterminate = false;
		}
		else if(!m_JoinTutorial.m_TryRefresh)
		{
			if(!m_JoinTutorial.m_TriedRefresh)
			{
				m_JoinTutorial.m_TryRefresh = true;
				m_JoinTutorial.m_StateChange = time_get_nanoseconds();
			}
			else if(m_JoinTutorial.m_LocalServerState == CJoinTutorial::ELocalServerState::NOT_TRIED)
			{
				m_JoinTutorial.m_LocalServerState = CJoinTutorial::ELocalServerState::TRY;
				m_JoinTutorial.m_StateChange = time_get_nanoseconds();
			}
		}

		if(m_JoinTutorial.m_TryRefresh)
		{
			if(LastStateChangeSeconds >= RefreshDelay)
			{
				// Activate internet tab before joining tutorial to make sure the server info
				// for the tutorial servers is available.
				GameClient()->m_Menus.SetMenuPage(CMenus::PAGE_INTERNET);
				GameClient()->m_Menus.RefreshBrowserTab(true);
				m_JoinTutorial.m_Status = CJoinTutorial::EStatus::REFRESHING;
				m_JoinTutorial.m_TryRefresh = false;
				m_JoinTutorial.m_TriedRefresh = true;
				m_JoinTutorial.m_StateChange = time_get_nanoseconds();
			}
			else
			{
				pProgressLabel = Localize("Retrying…");
			}
		}

		const auto &&ShowFinalErrorMessage = [&]() {
			PopupMessage(Localize("Error joining Tutorial server"), Localize("Could not find a Tutorial server. Check your internet connection."), Localize("Ok"));
		};
		const auto &&RunServer = [&]() {
			char aMotd[256];
			str_copy(aMotd, "sv_motd \"");
			char *pDst = aMotd + str_length(aMotd);
			str_escape(&pDst, Localize("You're playing on a local server because no online Tutorial server could be found.\n\nYour record will only be saved locally."), aMotd + sizeof(aMotd) - 1);
			str_append(aMotd, "\"");
			if(GameClient()->m_LocalServer.RunServer({"sv_register 0", "sv_map Tutorial", aMotd}))
			{
				m_JoinTutorial.m_LocalServerState = CJoinTutorial::ELocalServerState::WAITING_START;
				m_JoinTutorial.m_StateChange = time_get_nanoseconds();
			}
			else
			{
				ShowFinalErrorMessage();
			}
		};
		if(m_JoinTutorial.m_LocalServerState == CJoinTutorial::ELocalServerState::TRY)
		{
			if(LastStateChangeSeconds >= RefreshDelay)
			{
				if(GameClient()->m_LocalServer.IsServerRunning())
				{
					GameClient()->m_LocalServer.KillServer();
					m_JoinTutorial.m_LocalServerState = CJoinTutorial::ELocalServerState::WAITING_STOP;
					m_JoinTutorial.m_StateChange = time_get_nanoseconds();
				}
				else
				{
					RunServer();
				}
			}
			else
			{
				pProgressLabel = Localize("Could not find online Tutorial server.\nStarting and connecting to local server…");
			}
		}
		else if(m_JoinTutorial.m_LocalServerState == CJoinTutorial::ELocalServerState::WAITING_STOP)
		{
			if(LastStateChangeSeconds >= 5.0f)
			{
				ShowFinalErrorMessage();
			}
			else
			{
				if(!GameClient()->m_LocalServer.IsServerRunning())
				{
					RunServer();
				}

				pProgressLabel = Localize("Waiting for local server to stop…");
				ProgressDeterminate = false;
			}
		}
		else if(m_JoinTutorial.m_LocalServerState == CJoinTutorial::ELocalServerState::WAITING_START)
		{
			if(LastStateChangeSeconds >= 5.0f)
			{
				ShowFinalErrorMessage();
			}
			else
			{
				if(LastStateChangeSeconds >= 2.0f &&
					GameClient()->m_LocalServer.IsServerRunning())
				{
					Client()->Connect("localhost");
				}

				pProgressLabel = Localize("Waiting for local server to start…");
				ProgressDeterminate = false;
			}
		}

		if(pProgressLabel != nullptr)
		{
			Ui()->RenderProgressSpinner(ProgressIndicator.Center(), 12.0f, {.m_Progress = ProgressDeterminate ? (LastStateChangeSeconds / RefreshDelay) : -1.0f});
			Ui()->DoLabel(&ProgressLabel, pProgressLabel, 20.0f, TEXTALIGN_ML);
		}

		static CButtonContainer s_Button;
		if(DoButton_Menu(&s_Button, Localize("Cancel"), 0, &ButtonBar) ||
			Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE) ||
			Ui()->ConsumeHotkey(CUi::HOTKEY_ENTER))
		{
			m_Popup = POPUP_NONE;
		}
	}
	else if(m_Popup == POPUP_POINTS)
	{
		Box.HSplitBottom(20.0f, &Box, nullptr);
		Box.HSplitBottom(24.0f, &Box, &Part);
		Part.VMargin(120.0f, &Part);

		if(Client()->InfoState() == IClient::EInfoState::SUCCESS && Client()->Points() > 50)
		{
			CUIRect Yes, No;
			Part.VSplitMid(&No, &Yes, 40.0f);
			static CButtonContainer s_ButtonNo;
			if(DoButton_Menu(&s_ButtonNo, Localize("No"), 0, &No) ||
				Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE))
			{
				m_Popup = POPUP_FIRST_LAUNCH;
			}

			static CButtonContainer s_ButtonYes;
			if(DoButton_Menu(&s_ButtonYes, Localize("Yes"), 0, &Yes) ||
				Ui()->ConsumeHotkey(CUi::HOTKEY_ENTER))
			{
				m_Popup = POPUP_NONE;
			}
		}
		else
		{
			static CButtonContainer s_Button;
			if(DoButton_Menu(&s_Button, Localize("Cancel"), 0, &Part) ||
				Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE) ||
				Ui()->ConsumeHotkey(CUi::HOTKEY_ENTER) ||
				Client()->InfoState() == IClient::EInfoState::SUCCESS)
			{
				m_Popup = POPUP_NONE;
			}
			if(Client()->InfoState() == IClient::EInfoState::ERROR)
			{
				PopupMessage(Localize("Error checking player name"), Localize("Could not check for existing player with your name. Check your internet connection."), Localize("Ok"));
			}
		}
	}
	else if(m_Popup == POPUP_WARNING)
	{
		Box.HSplitBottom(20.f, &Box, &Part);
		Box.HSplitBottom(24.f, &Box, &Part);
		Part.VMargin(120.0f, &Part);

		static CButtonContainer s_Button;
		if(DoButton_Menu(&s_Button, pButtonText, 0, &Part) || Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE) || Ui()->ConsumeHotkey(CUi::HOTKEY_ENTER) || (m_PopupWarningDuration > 0s && time_get_nanoseconds() - m_PopupWarningLastTime >= m_PopupWarningDuration))
		{
			m_Popup = POPUP_NONE;
			SetActive(false);
		}
	}
	else if(m_Popup == POPUP_SAVE_SKIN)
	{
		CUIRect Label, TextBox, Yes, No;

		Box.HSplitBottom(20.f, &Box, &Part);
		Box.HSplitBottom(24.f, &Box, &Part);
		Part.VMargin(80.0f, &Part);

		Part.VSplitMid(&No, &Yes);

		Yes.VMargin(20.0f, &Yes);
		No.VMargin(20.0f, &No);

		static CButtonContainer s_ButtonNo;
		if(DoButton_Menu(&s_ButtonNo, Localize("No"), 0, &No) || Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE))
			m_Popup = POPUP_NONE;

		static CButtonContainer s_ButtonYes;
		if(DoButton_Menu(&s_ButtonYes, Localize("Yes"), m_SkinNameInput.IsEmpty() ? 1 : 0, &Yes) || Ui()->ConsumeHotkey(CUi::HOTKEY_ENTER))
		{
			if(!str_valid_filename(m_SkinNameInput.GetString()))
			{
				PopupMessage(Localize("Error"), Localize("This name cannot be used for files and folders"), Localize("Ok"), POPUP_SAVE_SKIN);
			}
			else if(CSkins7::IsSpecialSkin(m_SkinNameInput.GetString()))
			{
				PopupMessage(Localize("Error"), Localize("Unable to save the skin with a reserved name"), Localize("Ok"), POPUP_SAVE_SKIN);
			}
			else if(!GameClient()->m_Skins7.SaveSkinfile(m_SkinNameInput.GetString(), m_Dummy))
			{
				PopupMessage(Localize("Error"), Localize("Unable to save the skin"), Localize("Ok"), POPUP_SAVE_SKIN);
			}
			else
			{
				m_Popup = POPUP_NONE;
				m_SkinList7LastRefreshTime = std::nullopt;
			}
		}

		Box.HSplitBottom(60.f, &Box, &Part);
		Box.HSplitBottom(24.f, &Box, &Part);

		Part.VMargin(60.0f, &Label);
		Label.VSplitLeft(100.0f, &Label, &TextBox);
		TextBox.VSplitLeft(20.0f, nullptr, &TextBox);
		Ui()->DoLabel(&Label, Localize("Name"), 18.0f, TEXTALIGN_ML);
		Ui()->DoClearableEditBox(&m_SkinNameInput, &TextBox, 12.0f);
	}
	else
	{
		Box.HSplitBottom(20.f, &Box, &Part);
		Box.HSplitBottom(24.f, &Box, &Part);
		Part.VMargin(120.0f, &Part);

		static CButtonContainer s_Button;
		if(DoButton_Menu(&s_Button, pButtonText, 0, &Part) || Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE) || Ui()->ConsumeHotkey(CUi::HOTKEY_ENTER))
		{
			if(m_Popup == POPUP_DISCONNECTED && Client()->ReconnectTime() > 0)
				Client()->SetReconnectTime(0);
			m_Popup = POPUP_NONE;
		}
	}

	if(m_Popup == POPUP_NONE)
		Ui()->SetActiveItem(nullptr);
}

void CMenus::RenderPopupConnecting(CUIRect Screen)
{
	const float FontSize = 20.0f;

	CUIRect Box, Label;
	Screen.Margin(150.0f, &Box);
	Box.Draw(ColorRGBA(0.11f, 0.12f, 0.14f, 0.96f), IGraphics::CORNER_ALL, 6.0f);
	Box.Margin(20.0f, &Box);

	Box.HSplitTop(24.0f, &Label, &Box);
	Ui()->DoLabel(&Label, Localize("Connecting to"), 24.0f, TEXTALIGN_MC);

	Box.HSplitTop(20.0f, nullptr, &Box);
	Box.HSplitTop(24.0f, &Label, &Box);
	SLabelProperties Props;
	Props.m_MaxWidth = Label.w;
	Props.m_EllipsisAtEnd = true;
	Ui()->DoLabel(&Label, Client()->ConnectAddressString(), FontSize, TEXTALIGN_MC, Props);

	if(time_get() - Client()->StateStartTime() > time_freq())
	{
		const char *pConnectivityLabel = "";
		switch(Client()->UdpConnectivity(Client()->ConnectNetTypes()))
		{
		case IClient::CONNECTIVITY_UNKNOWN:
			break;
		case IClient::CONNECTIVITY_CHECKING:
			pConnectivityLabel = Localize("Trying to determine UDP connectivity…");
			break;
		case IClient::CONNECTIVITY_UNREACHABLE:
			pConnectivityLabel = Localize("UDP seems to be filtered.");
			break;
		case IClient::CONNECTIVITY_DIFFERING_UDP_TCP_IP_ADDRESSES:
			pConnectivityLabel = Localize("UDP and TCP IP addresses seem to be different. Try disabling VPN, proxy or network accelerators.");
			break;
		case IClient::CONNECTIVITY_REACHABLE:
			pConnectivityLabel = Localize("No answer from server yet.");
			break;
		}
		if(pConnectivityLabel[0] != '\0')
		{
			Box.HSplitTop(20.0f, nullptr, &Box);
			Box.HSplitTop(24.0f, &Label, &Box);
			SLabelProperties ConnectivityLabelProps;
			ConnectivityLabelProps.m_MaxWidth = Label.w;
			if(TextRender()->TextWidth(FontSize, pConnectivityLabel) > Label.w)
				Ui()->DoLabel(&Label, pConnectivityLabel, FontSize, TEXTALIGN_ML, ConnectivityLabelProps);
			else
				Ui()->DoLabel(&Label, pConnectivityLabel, FontSize, TEXTALIGN_MC);
		}
	}

	CUIRect Button;
	Box.HSplitBottom(24.0f, &Box, &Button);
	Button.VMargin(100.0f, &Button);

	static CButtonContainer s_Button;
	if(DoButton_Menu(&s_Button, Localize("Abort"), 0, &Button) || Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE))
	{
		Client()->Disconnect();
		Ui()->SetActiveItem(nullptr);
		RefreshBrowserTab(true);
	}
}

void CMenus::RenderPopupLoading(CUIRect Screen)
{
	char aTitle[256];
	char aLabel1[128];
	char aLabel2[128];
	if(Client()->MapDownloadTotalsize() > 0)
	{
		const int64_t Now = time_get();
		if(Now - m_DownloadLastCheckTime >= time_freq())
		{
			if(m_DownloadLastCheckSize > Client()->MapDownloadAmount())
			{
				// map downloaded restarted
				m_DownloadLastCheckSize = 0;
			}

			// update download speed
			const float Diff = (Client()->MapDownloadAmount() - m_DownloadLastCheckSize) / ((int)((Now - m_DownloadLastCheckTime) / time_freq()));
			const float StartDiff = m_DownloadLastCheckSize - 0.0f;
			if(StartDiff + Diff > 0.0f)
				m_DownloadSpeed = (Diff / (StartDiff + Diff)) * (Diff / 1.0f) + (StartDiff / (Diff + StartDiff)) * m_DownloadSpeed;
			else
				m_DownloadSpeed = 0.0f;
			m_DownloadLastCheckTime = Now;
			m_DownloadLastCheckSize = Client()->MapDownloadAmount();
		}

		str_format(aTitle, sizeof(aTitle), "%s: %s", Localize("Downloading map"), Client()->MapDownloadName());

		str_format(aLabel1, sizeof(aLabel1), Localize("%d/%d KiB (%.1f KiB/s)"), Client()->MapDownloadAmount() / 1024, Client()->MapDownloadTotalsize() / 1024, m_DownloadSpeed / 1024.0f);

		const int SecondsLeft = std::max(1, m_DownloadSpeed > 0.0f ? static_cast<int>((Client()->MapDownloadTotalsize() - Client()->MapDownloadAmount()) / m_DownloadSpeed) : 1);
		const int MinutesLeft = SecondsLeft / 60;
		if(MinutesLeft > 0)
		{
			str_format(aLabel2, sizeof(aLabel2), MinutesLeft == 1 ? Localize("%i minute left") : Localize("%i minutes left"), MinutesLeft);
		}
		else
		{
			str_format(aLabel2, sizeof(aLabel2), SecondsLeft == 1 ? Localize("%i second left") : Localize("%i seconds left"), SecondsLeft);
		}
	}
	else
	{
		str_copy(aTitle, Localize("Connected"));
		switch(Client()->LoadingStateDetail())
		{
		case IClient::LOADING_STATE_DETAIL_INITIAL:
			str_copy(aLabel1, Localize("Getting game info"));
			break;
		case IClient::LOADING_STATE_DETAIL_LOADING_MAP:
			str_copy(aLabel1, Localize("Loading map file from storage"));
			break;
		case IClient::LOADING_STATE_DETAIL_LOADING_DEMO:
			str_copy(aLabel1, Localize("Loading demo file from storage"));
			break;
		case IClient::LOADING_STATE_DETAIL_SENDING_READY:
			str_copy(aLabel1, Localize("Requesting to join the game"));
			break;
		case IClient::LOADING_STATE_DETAIL_GETTING_READY:
			str_copy(aLabel1, Localize("Sending initial client info"));
			break;
		default:
			dbg_assert_failed("Invalid loading state %d for RenderPopupLoading", static_cast<int>(Client()->LoadingStateDetail()));
		}
		aLabel2[0] = '\0';
	}

	const float FontSize = 20.0f;

	CUIRect Box, Label;
	Screen.Margin(150.0f, &Box);
	Box.Draw(ColorRGBA(0.11f, 0.12f, 0.14f, 0.96f), IGraphics::CORNER_ALL, 6.0f);
	Box.Margin(20.0f, &Box);

	Box.HSplitTop(24.0f, &Label, &Box);
	Ui()->DoLabel(&Label, aTitle, 24.0f, TEXTALIGN_MC);

	Box.HSplitTop(20.0f, nullptr, &Box);
	Box.HSplitTop(24.0f, &Label, &Box);
	Ui()->DoLabel(&Label, aLabel1, FontSize, TEXTALIGN_MC);

	if(aLabel2[0] != '\0')
	{
		Box.HSplitTop(20.0f, nullptr, &Box);
		Box.HSplitTop(24.0f, &Label, &Box);
		SLabelProperties ExtraTextProps;
		ExtraTextProps.m_MaxWidth = Label.w;
		if(TextRender()->TextWidth(FontSize, aLabel2) > Label.w)
			Ui()->DoLabel(&Label, aLabel2, FontSize, TEXTALIGN_ML, ExtraTextProps);
		else
			Ui()->DoLabel(&Label, aLabel2, FontSize, TEXTALIGN_MC);
	}

	if(Client()->MapDownloadTotalsize() > 0)
	{
		CUIRect ProgressBar;
		Box.HSplitTop(20.0f, nullptr, &Box);
		Box.HSplitTop(24.0f, &ProgressBar, &Box);
		ProgressBar.VMargin(20.0f, &ProgressBar);
		Ui()->RenderProgressBar(ProgressBar, Client()->MapDownloadAmount() / (float)Client()->MapDownloadTotalsize());
	}

	CUIRect Button;
	Box.HSplitBottom(24.0f, &Box, &Button);
	Button.VMargin(100.0f, &Button);

	static CButtonContainer s_Button;
	if(DoButton_Menu(&s_Button, Localize("Abort"), 0, &Button) || Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE))
	{
		Client()->Disconnect();
		Ui()->SetActiveItem(nullptr);
		RefreshBrowserTab(true);
	}
}

#if defined(CONF_VIDEORECORDER)
void CMenus::PopupConfirmDemoReplaceVideo()
{
	char aBuf[IO_MAX_PATH_LENGTH];
	str_format(aBuf, sizeof(aBuf), "%s/%s.demo", m_aCurrentDemoFolder, m_aCurrentDemoSelectionName);
	char aVideoName[IO_MAX_PATH_LENGTH];
	str_copy(aVideoName, m_DemoRenderInput.GetString());
	const char *pError = Client()->DemoPlayer_Render(aBuf, m_DemolistStorageType, aVideoName, m_Speed, m_StartPaused);
	m_Speed = DEMO_SPEED_INDEX_DEFAULT;
	m_StartPaused = false;
	m_LastPauseChange = -1.0f;
	m_LastSpeedChange = -1.0f;
	if(pError)
	{
		m_DemoRenderInput.Clear();
		PopupMessage(Localize("Error loading demo"), pError, Localize("Ok"));
	}
}
#endif

void CMenus::SetActive(bool Active)
{
	if(Active != m_MenuActive)
	{
		Ui()->SetHotItem(nullptr);
		Ui()->SetActiveItem(nullptr);
	}
	m_MenuActive = Active;
	if(!m_MenuActive)
	{
		if(m_NeedSendinfo)
		{
			GameClient()->SendInfo(false);
			m_NeedSendinfo = false;
		}

		if(m_NeedSendDummyinfo)
		{
			GameClient()->SendDummyInfo(false);
			m_NeedSendDummyinfo = false;
		}

		if(Client()->State() == IClient::STATE_ONLINE)
		{
			GameClient()->OnRelease();
		}
	}
	else if(Client()->State() == IClient::STATE_DEMOPLAYBACK)
	{
		GameClient()->OnRelease();
	}
}

void CMenus::OnShutdown()
{
	for(auto &Texture : m_aCharacterPortraits) Graphics()->UnloadTexture(&Texture);
	for(auto &Texture : m_aBgTextures) Graphics()->UnloadTexture(&Texture);
	for(auto &Texture : m_aYieldBloomFrames) Graphics()->UnloadTexture(&Texture);
	m_CommunityIcons.Shutdown();
}

bool CMenus::OnCursorMove(float x, float y, IInput::ECursorType CursorType)
{
	if(!m_MenuActive)
		return false;

	Ui()->ConvertMouseMove(&x, &y, CursorType);
	Ui()->OnCursorMove(x, y);

	return true;
}

bool CMenus::OnInput(const IInput::CEvent &Event)
{
	// Escape key is always handled to activate/deactivate menu
	if((Event.m_Flags & IInput::FLAG_PRESS && Event.m_Key == KEY_ESCAPE) || IsActive())
	{
		Ui()->OnInput(Event);
		return true;
	}
	return false;
}

void CMenus::OnStateChange(int NewState, int OldState)
{
	// reset active item
	Ui()->SetActiveItem(nullptr);

	if(OldState == IClient::STATE_ONLINE || OldState == IClient::STATE_OFFLINE)
		TextRender()->DeleteTextContainer(m_MotdTextContainerIndex);

	if(NewState == IClient::STATE_OFFLINE)
	{
		if(OldState >= IClient::STATE_ONLINE && NewState < IClient::STATE_QUITTING)
			UpdateMusicState();
		m_Popup = POPUP_NONE;
		if(Client()->ErrorString() && Client()->ErrorString()[0] != 0)
		{
			if(str_find(Client()->ErrorString(), "password"))
			{
				m_Popup = POPUP_PASSWORD;
				m_PasswordInput.SelectAll();
				Ui()->SetActiveItem(&m_PasswordInput);
			}
			else
			{
				m_Popup = POPUP_DISCONNECTED;
			}
		}
	}
	else if(NewState == IClient::STATE_LOADING)
	{
		m_DownloadLastCheckTime = time_get();
		m_DownloadLastCheckSize = 0;
		m_DownloadSpeed = 0.0f;
	}
	else if(NewState == IClient::STATE_ONLINE || NewState == IClient::STATE_DEMOPLAYBACK)
	{
		if(m_Popup != POPUP_WARNING)
		{
			m_Popup = POPUP_NONE;
			SetActive(false);
		}
	}
}

void CMenus::OnWindowResize()
{
	TextRender()->DeleteTextContainer(m_MotdTextContainerIndex);
}

void CMenus::OnRender()
{
	if(Client()->State() != IClient::STATE_ONLINE && Client()->State() != IClient::STATE_DEMOPLAYBACK)
		SetActive(true);

	if(Client()->State() == IClient::STATE_ONLINE && GameClient()->m_ServerMode == CGameClient::SERVERMODE_PUREMOD)
	{
		Client()->Disconnect();
		SetActive(true);
		PopupMessage(Localize("Disconnected"), Localize("The server is running a non-standard tuning on a pure game type."), Localize("Ok"));
	}

	if(!IsActive())
	{
		if(Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE))
		{
			SetActive(true);
		}
		else if(Client()->State() != IClient::STATE_DEMOPLAYBACK)
		{
			Ui()->ClearHotkeys();
			return;
		}
	}

	Ui()->StartCheck();
	UpdateColors();

	Ui()->Update();

	if(IsActive())
		Ui()->DoBackButton();

	Render();

	if(IsActive())
	{
		Ui()->RenderBackButton();
		RenderTools()->RenderCursor(Ui()->MousePos(), 24.0f);
	}

	// render debug information
	if(g_Config.m_Debug)
		Ui()->DebugRender(2.0f, Ui()->Screen()->h - 12.0f);

	if(Ui()->ConsumeHotkey(CUi::HOTKEY_ESCAPE))
		SetActive(false);

	Ui()->FinishCheck();
	Ui()->ClearHotkeys();
}

void CMenus::UpdateColors()
{
	// New design from screenshots – Void, Deck, Cyan, Magenta, Violet, Gold, Ink
	// Void #060A1C = 0.0235,0.0392,0.1098
	// Deck #0C1334 = 0.047,0.0745,0.2039
	// Deck2 #121B46 = 0.0706,0.1059,0.2745
	// Cyan #5FE3F5 = 0.3725,0.8902,0.9608
	// Cyan dim #2A8797 = 0.1647,0.5294,0.5922
	// Magenta #EE4592 = 0.9333,0.2706,0.5725
	// Violet #A077FF Rare, Gold #FFC857 Legendary
	ms_GuiColor = ColorRGBA(0.0235f, 0.0392f, 0.1098f, 1.0f);

	// Tabs: inactive Deck with dim border, active Gold/Cyan, hover Cyan
	ms_ColorTabbarInactiveOutgame = ColorRGBA(0.047f, 0.0745f, 0.2039f, 0.94f);
	ms_ColorTabbarActiveOutgame = ColorRGBA(1.0f, 0.7843f, 0.3412f, 0.96f); // Gold for active
	ms_ColorTabbarHoverOutgame = ColorRGBA(0.3725f, 0.8902f, 0.9608f, 0.92f); // Cyan

	ms_ColorTabbarInactiveIngame = ColorRGBA(0.047f, 0.0745f, 0.2039f, 0.90f);
	ms_ColorTabbarActiveIngame = ColorRGBA(0.3725f, 0.8902f, 0.9608f, 0.90f);
	ms_ColorTabbarHoverIngame = ColorRGBA(0.6275f, 0.4667f, 1.0f, 0.85f); // Violet
}

void CMenus::RenderYieldBloomFrame(CUIRect Rect, float Rounding, bool WithRivets)
{
	// Deprecated – now using Form A pure code, keep for compatibility – draw Form A panel
	RenderFormAPanel(Rect, 16.0f, ColorRGBA(0.047f, 0.0745f, 0.2039f, 0.96f), ColorRGBA(0.1647f, 0.5294f, 0.5922f, 0.85f), true, false, 0.0f, ColorRGBA(0.3725f, 0.8902f, 0.9608f, 1.0f));
}

void CMenus::RenderFormAPanel(CUIRect Rect, float Chamfer, ColorRGBA BgColor, ColorRGBA BorderColor, bool WithGlow, bool WithImpulse, float ImpulseProgress, ColorRGBA ImpulseColor)
{
	// Form A iOS – chamfered, translucent background behind text/characters, 2px frame + glow 10-12px 30%
	float x = Rect.x;
	float y = Rect.y;
	float w = Rect.w;
	float h = Rect.h;
	float c = Chamfer;

	// iOS blur simulation – larger translucent underlay
	if(WithGlow)
	{
		Graphics()->TextureClear();
		Graphics()->QuadsBegin();
		Graphics()->SetColor(0.0235f, 0.0392f, 0.1098f, 0.32f); // Void translucent blur
		IGraphics::CQuadItem Blur(x - 12, y - 12, w + 24, h + 24);
		Graphics()->QuadsDrawTL(&Blur, 1);
		Graphics()->QuadsEnd();

		Graphics()->TextureClear();
		Graphics()->QuadsBegin();
		Graphics()->SetColor(BorderColor.r, BorderColor.g, BorderColor.b, 0.22f);
		IGraphics::CQuadItem QuadGlow(x - 10, y - 10, w + 20, h + 20);
		Graphics()->QuadsDrawTL(&QuadGlow, 1);
		Graphics()->QuadsEnd();
	}

	// Main background – iOS translucent 0.62-0.78, not solid
	float bgAlpha = BgColor.a * 0.72f;
	if(BgColor.a < 0.1f) bgAlpha = 0.68f; // for character frames that passed 0.0f
	else if(BgColor.a > 0.9f) bgAlpha = 0.74f;

	Graphics()->TextureClear();
	Graphics()->QuadsBegin();
	Graphics()->SetColor(BgColor.r, BgColor.g, BgColor.b, bgAlpha);
	IGraphics::CFreeformItem FreeTop(x + c, y, x + w - c, y, x + w, y + c, x, y + c);
	Graphics()->QuadsDrawFreeform(&FreeTop, 1);
	IGraphics::CQuadItem QuadMid(x, y + c, w, h - 2 * c);
	Graphics()->QuadsDrawTL(&QuadMid, 1);
	IGraphics::CFreeformItem FreeBottom(x, y + h - c, x + w, y + h - c, x + w - c, y + h, x + c, y + h);
	Graphics()->QuadsDrawFreeform(&FreeBottom, 1);
	Graphics()->QuadsEnd();

	// Inner gradient top – Deck2 #121B46 with more translucency
	Graphics()->TextureClear();
	Graphics()->QuadsBegin();
	Graphics()->SetColor(0.0706f, 0.1059f, 0.2745f, 0.42f);
	IGraphics::CQuadItem QuadTopGrad(x + c, y, w - 2 * c, h * 0.38f);
	Graphics()->QuadsDrawTL(&QuadTopGrad, 1);
	Graphics()->QuadsEnd();

	// Subtle raster / glass line
	Graphics()->TextureClear();
	Graphics()->QuadsBegin();
	Graphics()->SetColor(0.3725f, 0.8902f, 0.9608f, 0.06f);
	for(int i = 0; i < (int)(h / 3.0f); ++i)
	{
		if(i % 2 == 0)
		{
			IGraphics::CQuadItem Line(x + c, y + c + i * 3.0f, w - 2*c, 1.0f);
			Graphics()->QuadsDrawTL(&Line, 1);
		}
	}
	Graphics()->QuadsEnd();

	// Border – 2px chamfered frame, more visible on iOS
	Graphics()->TextureClear();
	Graphics()->QuadsBegin();
	Graphics()->SetColor(BorderColor.r, BorderColor.g, BorderColor.b, BorderColor.a * 0.92f);
	IGraphics::CQuadItem TopEdge(x + c, y, w - 2 * c, 2.0f);
	IGraphics::CQuadItem BottomEdge(x + c, y + h - 2.0f, w - 2 * c, 2.0f);
	IGraphics::CQuadItem LeftEdge(x, y + c, 2.0f, h - 2 * c);
	IGraphics::CQuadItem RightEdge(x + w - 2.0f, y + c, 2.0f, h - 2 * c);
	Graphics()->QuadsDrawTL(&TopEdge, 1);
	Graphics()->QuadsDrawTL(&BottomEdge, 1);
	Graphics()->QuadsDrawTL(&LeftEdge, 1);
	Graphics()->QuadsDrawTL(&RightEdge, 1);
	IGraphics::CFreeformItem CornerTL(x, y + c, x + c, y, x + c, y + 2.0f, x + 2.0f, y + c);
	IGraphics::CFreeformItem CornerTR(x + w - c, y, x + w, y + c, x + w - 2.0f, y + c, x + w - c, y + 2.0f);
	IGraphics::CFreeformItem CornerBL(x, y + h - c, x + 2.0f, y + h - c, x + c, y + h - 2.0f, x + c, y + h);
	IGraphics::CFreeformItem CornerBR(x + w - 2.0f, y + h - c, x + w, y + h - c, x + w - c, y + h, x + w - c, y + h - 2.0f);
	Graphics()->QuadsDrawFreeform(&CornerTL, 1);
	Graphics()->QuadsDrawFreeform(&CornerTR, 1);
	Graphics()->QuadsDrawFreeform(&CornerBL, 1);
	Graphics()->QuadsDrawFreeform(&CornerBR, 1);
	Graphics()->QuadsEnd();

	// Impulse – running light around border (5s, Legendary 6s gold)
	if(WithImpulse)
	{
		float total = 2.0f * (w + h);
		float pos = ImpulseProgress * total;
		float ix = x, iy = y;
		if(pos < w) { ix = x + pos; iy = y; }
		else if(pos < w + h) { ix = x + w; iy = y + (pos - w); }
		else if(pos < 2 * w + h) { ix = x + w - (pos - w - h); iy = y + h; }
		else { ix = x; iy = y + h - (pos - 2 * w - h); }
		Graphics()->TextureClear();
		Graphics()->QuadsBegin();
		Graphics()->SetColor(ImpulseColor.r, ImpulseColor.g, ImpulseColor.b, 0.95f);
		IGraphics::CQuadItem QuadImp(ix - 6.0f, iy - 6.0f, 12.0f, 12.0f);
		Graphics()->QuadsDrawTL(&QuadImp, 1);
		Graphics()->SetColor(ImpulseColor.r, ImpulseColor.g, ImpulseColor.b, 0.35f);
		IGraphics::CQuadItem QuadImpGlow(ix - 14.0f, iy - 14.0f, 28.0f, 28.0f);
		Graphics()->QuadsDrawTL(&QuadImpGlow, 1);
		Graphics()->QuadsEnd();
	}

	// Corner brackets – management panel style
	if(WithGlow && WithImpulse)
	{
		Graphics()->TextureClear();
		Graphics()->QuadsBegin();
		Graphics()->SetColor(0.9333f, 0.2706f, 0.5725f, 0.85f);
		IGraphics::CQuadItem B1(x + w - 18.0f, y + 6.0f, 12.0f, 2.0f);
		IGraphics::CQuadItem B2(x + w - 8.0f, y + 6.0f, 2.0f, 12.0f);
		IGraphics::CQuadItem B3(x + 6.0f, y + h - 8.0f, 12.0f, 2.0f);
		IGraphics::CQuadItem B4(x + 6.0f, y + h - 18.0f, 2.0f, 12.0f);
		Graphics()->QuadsDrawTL(&B1, 1);
		Graphics()->QuadsDrawTL(&B2, 1);
		Graphics()->QuadsDrawTL(&B3, 1);
		Graphics()->QuadsDrawTL(&B4, 1);
		Graphics()->QuadsEnd();
	}
}

void CMenus::RenderYieldBloomProgressBar(CUIRect Rect, float Progress, ColorRGBA FillColor)
{
	Progress = std::clamp(Progress, 0.0f, 1.0f);
	// Background Deck
	RenderFormAPanel(Rect, 6.0f, ColorRGBA(0.047f, 0.0745f, 0.2039f, 0.92f), ColorRGBA(0.1647f, 0.5294f, 0.5922f, 0.55f), false, false, 0.0f, ColorRGBA(0,0,0,0));
	if(Progress > 0.0f)
	{
		CUIRect Fill = {Rect.x + 3.0f, Rect.y + 3.0f, (Rect.w - 6.0f) * Progress, Rect.h - 6.0f};
		Graphics()->TextureClear();
		Graphics()->QuadsBegin();
		Graphics()->SetColor(FillColor.r, FillColor.g, FillColor.b, FillColor.a);
		IGraphics::CQuadItem QuadFill(Fill.x, Fill.y, Fill.w, Fill.h);
		Graphics()->QuadsDrawTL(&QuadFill, 1);
		Graphics()->QuadsEnd();
	}
}



void CMenus::RenderBackground()
{
	Ui()->MapScreen();
	const CUIRect Screen = *Ui()->Screen();
	// New design – Void #060A1C with neon grid, translucent for iOS effect
	Screen.Draw(ColorRGBA(0.0235f, 0.0392f, 0.1098f, 1.0f), 0, 0);

	int BgIndex = 0;
	if(m_ShowStart)
		BgIndex = 0;
	else
	{
		switch(m_MenuPage)
		{
		case PAGE_RACES: BgIndex = 1; break;
		case PAGE_CHARACTERS: BgIndex = 2; break;
		case PAGE_WALLET: BgIndex = 3; break;
		case PAGE_LEADERS: BgIndex = 4; break;
		case PAGE_SETTINGS: BgIndex = 5; break;
		default:
			if(m_MenuPage >= PAGE_INTERNET && m_MenuPage <= PAGE_FAVORITE_COMMUNITY_5)
				BgIndex = 6;
			else
				BgIndex = 0;
			break;
		}
		if(Client()->State() == IClient::STATE_ONLINE)
			BgIndex = 7;
	}

	if(BgIndex >= 0 && BgIndex < (int)m_aBgTextures.size() && m_aBgTextures[BgIndex].IsValid())
	{
		Graphics()->TextureSet(m_aBgTextures[BgIndex]);
		Graphics()->QuadsBegin();
		Graphics()->SetColor(1.0f, 1.0f, 1.0f, 0.38f);
		IGraphics::CQuadItem Quad(Screen.x, Screen.y, Screen.w, Screen.h);
		Graphics()->QuadsDrawTL(&Quad, 1);
		Graphics()->QuadsEnd();
		Screen.Draw(ColorRGBA(0.0235f, 0.0392f, 0.1098f, 0.85f), 0, 0);
	}

	// Neon grid – subtle for iOS depth behind translucent panels
	for(int i = 0; i < 40; ++i)
	{
		float y = Screen.y + i * Screen.h / 40.0f;
		CUIRect Line = {Screen.x, y, Screen.w, 1.0f};
		Line.Draw(ColorRGBA(0.1647f, 0.5294f, 0.5922f, 0.06f), 0, 0);
	}
	for(int i = 0; i < 60; ++i)
	{
		float x = Screen.x + i * Screen.w / 60.0f;
		CUIRect Line = {x, Screen.y, 1.0f, Screen.h};
		Line.Draw(ColorRGBA(0.6275f, 0.4667f, 1.0f, 0.04f), 0, 0);
	}
	// Top cyan beam
	CUIRect TopBeam = {Screen.x, Screen.y, Screen.w, 2.0f};
	TopBeam.Draw(ColorRGBA(0.3725f, 0.8902f, 0.9608f, 0.35f), 0, 0);
	// Bottom gold beam
	CUIRect BottomGlow = {Screen.x, Screen.y + Screen.h - 2.0f, Screen.w, 2.0f};
	BottomGlow.Draw(ColorRGBA(1.0f, 0.7843f, 0.3412f, 0.25f), 0, 0);
	// Side accent
	CUIRect VAccent = {Screen.x + Screen.w * 0.75f, Screen.y, 1.5f, Screen.h};
	VAccent.Draw(ColorRGBA(0.3725f, 0.8902f, 0.9608f, 0.12f), 0, 0);
}

int CMenus::DoButton_CheckBox_Tristate(const void *pId, const char *pText, TRISTATE Checked, const CUIRect *pRect)
{
	switch(Checked)
	{
	case TRISTATE::NONE:
		return DoButton_CheckBox_Common(pId, pText, "", pRect, BUTTONFLAG_LEFT);
	case TRISTATE::SOME:
		return DoButton_CheckBox_Common(pId, pText, "O", pRect, BUTTONFLAG_LEFT);
	case TRISTATE::ALL:
		return DoButton_CheckBox_Common(pId, pText, "X", pRect, BUTTONFLAG_LEFT);
	default:
		dbg_assert_failed("Invalid tristate. Checked: %d", static_cast<int>(Checked));
	}
}

int CMenus::MenuImageScan(const char *pName, int IsDir, int DirType, void *pUser)
{
	const char *pExtension = ".png";
	CMenuImage MenuImage;
	CMenus *pSelf = static_cast<CMenus *>(pUser);
	if(IsDir || !str_endswith(pName, pExtension) || str_length(pName) - str_length(pExtension) >= (int)sizeof(MenuImage.m_aName))
		return 0;

	char aPath[IO_MAX_PATH_LENGTH];
	str_format(aPath, sizeof(aPath), "menuimages/%s", pName);

	CImageInfo Info;
	if(!pSelf->Graphics()->LoadPng(Info, aPath, DirType))
	{
		log_error("menus", "Failed to load menu image from '%s'", aPath);
		return 0;
	}
	if(Info.m_Format != CImageInfo::FORMAT_RGBA)
	{
		Info.Free();
		log_error("menus", "Failed to load menu image from '%s': must be an RGBA image", aPath);
		return 0;
	}

	MenuImage.m_OrgTexture = pSelf->Graphics()->LoadTextureRaw(Info, 0, aPath);

	ConvertToGrayscale(Info);
	MenuImage.m_GreyTexture = pSelf->Graphics()->LoadTextureRawMove(Info, 0, aPath);

	str_truncate(MenuImage.m_aName, sizeof(MenuImage.m_aName), pName, str_length(pName) - str_length(pExtension));
	pSelf->m_vMenuImages.push_back(MenuImage);

	pSelf->RenderLoading(Localize("Loading Neon Relay"), Localize("Loading menu images"), 0);

	return 0;
}

const CMenus::CMenuImage *CMenus::FindMenuImage(const char *pName)
{
	for(auto &Image : m_vMenuImages)
		if(str_comp(Image.m_aName, pName) == 0)
			return &Image;
	return nullptr;
}

void CMenus::SetMenuPage(int NewPage)
{
	const int OldPage = m_MenuPage;
	m_MenuPage = NewPage;
	if(NewPage >= PAGE_INTERNET && NewPage <= PAGE_FAVORITE_COMMUNITY_5)
	{
		g_Config.m_UiPage = NewPage;
		bool ForceRefresh = false;
		if(m_ForceRefreshLanPage && NewPage == PAGE_LAN)
		{
			ForceRefresh = true;
			m_ForceRefreshLanPage = false;
		}
		if(OldPage != NewPage || ForceRefresh)
		{
			RefreshBrowserTab(ForceRefresh);
		}
	}
}

void CMenus::RefreshBrowserTab(bool Force)
{
	if(g_Config.m_UiPage == PAGE_INTERNET)
	{
		if(Force || ServerBrowser()->GetCurrentType() != IServerBrowser::TYPE_INTERNET)
		{
			if(Force || ServerBrowser()->GetCurrentType() == IServerBrowser::TYPE_LAN)
			{
				Client()->RequestDDNetInfo();
			}
			ServerBrowser()->Refresh(IServerBrowser::TYPE_INTERNET);
			UpdateCommunityCache(true);
		}
	}
	else if(g_Config.m_UiPage == PAGE_LAN)
	{
		if(Force || ServerBrowser()->GetCurrentType() != IServerBrowser::TYPE_LAN)
		{
			ServerBrowser()->Refresh(IServerBrowser::TYPE_LAN);
			UpdateCommunityCache(true);
		}
	}
	else if(g_Config.m_UiPage == PAGE_FAVORITES)
	{
		if(Force || ServerBrowser()->GetCurrentType() != IServerBrowser::TYPE_FAVORITES)
		{
			if(Force || ServerBrowser()->GetCurrentType() == IServerBrowser::TYPE_LAN)
			{
				Client()->RequestDDNetInfo();
			}
			ServerBrowser()->Refresh(IServerBrowser::TYPE_FAVORITES);
			UpdateCommunityCache(true);
		}
	}
	else if(g_Config.m_UiPage >= PAGE_FAVORITE_COMMUNITY_1 && g_Config.m_UiPage <= PAGE_FAVORITE_COMMUNITY_5)
	{
		const int BrowserType = g_Config.m_UiPage - PAGE_FAVORITE_COMMUNITY_1 + IServerBrowser::TYPE_FAVORITE_COMMUNITY_1;
		if(Force || ServerBrowser()->GetCurrentType() != BrowserType)
		{
			if(Force || ServerBrowser()->GetCurrentType() == IServerBrowser::TYPE_LAN)
			{
				Client()->RequestDDNetInfo();
			}
			ServerBrowser()->Refresh(BrowserType);
			UpdateCommunityCache(true);
		}
	}
}

void CMenus::ForceRefreshLanPage()
{
	m_ForceRefreshLanPage = true;
}

void CMenus::SetShowStart(bool ShowStart)
{
	m_ShowStart = ShowStart;
}

void CMenus::ShowQuitPopup()
{
	m_Popup = POPUP_QUIT;
}

void CMenus::JoinTutorial()
{
	m_JoinTutorial.m_Queued = true;
	m_JoinTutorial.m_Status = CJoinTutorial::EStatus::REFRESHING;
	m_JoinTutorial.m_TryRefresh = false;
	m_JoinTutorial.m_TriedRefresh = false;
	m_JoinTutorial.m_LocalServerState = CJoinTutorial::ELocalServerState::NOT_TRIED;
	m_JoinTutorial.m_StateChange = time_get_nanoseconds();
}
