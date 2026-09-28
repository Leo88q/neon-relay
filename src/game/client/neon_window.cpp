// «Кадр плёнки» — см. комментарий в neon_window.h и макет в
// docs/FILM_WINDOW_RU.md. Рисуем только примитивами движка (квады, линии),
// без текстур и без шрифтов: счётчик кадра набран кодовой пиксель-гарнитурой
// 3×5, поэтому хром независим от разрешения и не зависит от запечённых артов.
#include "neon_window.h"

#include "neon_style.h"
#include "ui_rect.h"

#include <base/math.h>
#include <base/str.h>
#include <base/vmath.h>

#include <engine/graphics.h>

#include <algorithm>
#include <iterator>

using namespace NeonStyle;

namespace
{
void FillRect(IGraphics *pGraphics, float X, float Y, float W, float H, ColorRGBA Color)
{
	pGraphics->TextureClear();
	pGraphics->QuadsBegin();
	pGraphics->SetColor(Color);
	IGraphics::CQuadItem Quad(X, Y, W, H);
	pGraphics->QuadsDrawTL(&Quad, 1);
	pGraphics->QuadsEnd();
}

void DrawLines(IGraphics *pGraphics, const IGraphics::CLineItem *pItems, size_t Num, ColorRGBA Color)
{
	pGraphics->TextureClear();
	pGraphics->LinesBegin();
	pGraphics->SetColor(Color);
	pGraphics->LinesDraw(pItems, Num);
	pGraphics->LinesEnd();
}

// Перфорация: вертикальный ряд отверстий с шагом кадра. `ScrollY` прокручивает
// ряд во время протяжки, чтобы плёнка реально шла, а не стояла.
void Sprockets(IGraphics *pGraphics, float StripX, float Y, float H, float ScrollY, ColorRGBA HoleColor)
{
	const float HoleX = StripX + (FILM_SPROCKET_W - FILM_HOLE_W) * 0.5f;
	const float Offset = ScrollY - std::floor(ScrollY / FILM_HOLE_STEP) * FILM_HOLE_STEP;
	for(float HoleY = Y - FILM_HOLE_STEP + Offset; HoleY < Y + H; HoleY += FILM_HOLE_STEP)
	{
		if(HoleY + FILM_HOLE_H <= Y || HoleY >= Y + H)
			continue;
		const float ClipTop = std::max(HoleY, Y + 2.0f);
		const float ClipBottom = std::min(HoleY + FILM_HOLE_H, Y + H - 2.0f);
		if(ClipBottom - ClipTop < 2.0f)
			continue;
		FillRect(pGraphics, HoleX, ClipTop, FILM_HOLE_W, ClipBottom - ClipTop, HoleColor);
	}
}

// Кодовая пиксель-гарнитура 3×5: цифры счётчика и буквы «FRM» рисуются
// квадами, без шрифтового движка — как и положено маркировке на плёнке.
const unsigned char *GlyphRows(char c)
{
	static const unsigned char DIGITS[10][5] = {
		{0b111, 0b101, 0b101, 0b101, 0b111},
		{0b010, 0b110, 0b010, 0b010, 0b111},
		{0b111, 0b001, 0b111, 0b100, 0b111},
		{0b111, 0b001, 0b011, 0b001, 0b111},
		{0b101, 0b101, 0b111, 0b001, 0b001},
		{0b111, 0b100, 0b111, 0b001, 0b111},
		{0b111, 0b100, 0b111, 0b101, 0b111},
		{0b111, 0b001, 0b001, 0b010, 0b010},
		{0b111, 0b101, 0b111, 0b101, 0b111},
		{0b111, 0b101, 0b111, 0b001, 0b111},
	};
	static const unsigned char F_[5] = {0b111, 0b100, 0b110, 0b100, 0b100};
	static const unsigned char R_[5] = {0b110, 0b101, 0b110, 0b101, 0b101};
	static const unsigned char M_[5] = {0b101, 0b111, 0b101, 0b101, 0b101};
	static const unsigned char SPACE_[5] = {0, 0, 0, 0, 0};
	if(c >= '0' && c <= '9')
		return DIGITS[c - '0'];
	if(c == 'F')
		return F_;
	if(c == 'R')
		return R_;
	if(c == 'M')
		return M_;
	return SPACE_;
}

// Рисует строку гарнитурой 3×5, прижимая правый край к `RightX`.
void DrawCounter(IGraphics *pGraphics, const char *pText, float RightX, float TopY, float Cell, ColorRGBA Color)
{
	const int Len = str_length(pText);
	const float GlyphW = 3.0f * Cell;
	const float Advance = GlyphW + Cell;
	// Собираем все занятые клетки одной пачкой квадов.
	IGraphics::CFreeformItem aCells[512];
	size_t NumCells = 0;
	for(int i = 0; i < Len && NumCells + 15 < std::size(aCells); ++i)
	{
		const unsigned char *pRows = GlyphRows(pText[i]);
		const float GlyphX = RightX - (Len - i) * Advance;
		for(int Row = 0; Row < 5; ++Row)
		{
			for(int Col = 0; Col < 3; ++Col)
			{
				if(!(pRows[Row] & (0b100 >> Col)))
					continue;
				aCells[NumCells++] = IGraphics::CFreeformItem(
					GlyphX + Col * Cell, TopY + Row * Cell,
					GlyphX + Col * Cell + Cell, TopY + Row * Cell,
					GlyphX + Col * Cell, TopY + Row * Cell + Cell,
					GlyphX + Col * Cell + Cell, TopY + Row * Cell + Cell);
			}
		}
	}
	pGraphics->TextureClear();
	pGraphics->QuadsBegin();
	pGraphics->SetColor(Color);
	pGraphics->QuadsDrawFreeform(aCells, NumCells);
	pGraphics->QuadsEnd();
}

// Регистрационная метка ⊕: окружность из отрезков + перекрестие.
void RegistrationMark(IGraphics *pGraphics, float Cx, float Cy, float Radius, ColorRGBA Color)
{
	constexpr int Segments = 14;
	IGraphics::CLineItem aRing[Segments + 2];
	for(int i = 0; i < Segments; ++i)
	{
		const float A0 = 2.0f * pi * i / Segments;
		const float A1 = 2.0f * pi * (i + 1) / Segments;
		aRing[i] = IGraphics::CLineItem(
			Cx + Radius * std::cos(A0), Cy + Radius * std::sin(A0),
			Cx + Radius * std::cos(A1), Cy + Radius * std::sin(A1));
	}
	const float Cross = Radius + 3.0f;
	aRing[Segments] = IGraphics::CLineItem(Cx - Cross, Cy, Cx + Cross, Cy);
	aRing[Segments + 1] = IGraphics::CLineItem(Cx, Cy - Cross, Cx, Cy + Cross);
	DrawLines(pGraphics, aRing, std::size(aRing), Color);
}

// Протяжка кадра: дискретная «механическая» подача в три подшага, каждый со
// своим сглаживанием — плёнка дёргается, как в проекторе, а не плывёт.
float AdvanceT(float t)
{
	t = std::clamp(t, 0.0f, 1.0f);
	const float Steps = 3.0f;
	const float Pos = t * Steps;
	const float Whole = std::floor(Pos);
	const float Local = Pos - Whole;
	const float Smooth = Local * Local * (3.0f - 2.0f * Local);
	return std::min(1.0f, (Whole + Smooth) / Steps);
}
}

void NeonWindow::DrawFilmFrame(IGraphics *pGraphics, const CUIRect &Area, ColorRGBA Accent, float AnimT, int FrameNumber)
{
	const float Te = AdvanceT(AnimT);
	const float W = Area.w;
	const float H = Area.h;
	// Кадр въезжает сверху и встаёт в ворота; до конца протяжки весь рисунок
	// смещён вверх.
	const float Dy = -(1.0f - Te) * (H + 30.0f);
	const float X = Area.x;
	const float Y = Area.y + Dy;
	// Во время протяжки перфорация прокручивается вместе с плёнкой.
	const float ScrollY = (1.0f - Te) * FILM_HOLE_STEP * 2.0f;

	// Основа плёнки.
	FillRect(pGraphics, X, Y, W, H, Dim(NIGHT_1, 0.97f));

	// Полосы перфорации и отверстия.
	FillRect(pGraphics, X, Y, FILM_SPROCKET_W, H, Dim(NIGHT_0, 0.85f));
	FillRect(pGraphics, X + W - FILM_SPROCKET_W, Y, FILM_SPROCKET_W, H, Dim(NIGHT_0, 0.85f));
	Sprockets(pGraphics, X, Y, H, ScrollY, Dim(NIGHT_0, 1.0f));
	Sprockets(pGraphics, X + W - FILM_SPROCKET_W, Y, H, ScrollY, Dim(NIGHT_0, 1.0f));
	const IGraphics::CLineItem aRails[] = {
		IGraphics::CLineItem(X + FILM_SPROCKET_W, Y, X + FILM_SPROCKET_W, Y + H),
		IGraphics::CLineItem(X + W - FILM_SPROCKET_W, Y, X + W - FILM_SPROCKET_W, Y + H),
	};
	DrawLines(pGraphics, aRails, std::size(aRails), Dim(DIM, 0.4f));

	// Краевой код: короткие штрихи поверх основы у верхней кромки.
	{
		IGraphics::CLineItem aCode[32];
		size_t NumCode = 0;
		const float CodeY = Y + 5.0f;
		float Cx = X + FILM_SPROCKET_W + 6.0f;
		int i = 0;
		while(Cx + FILM_EDGE_CODE < X + W - FILM_SPROCKET_W - 90.0f && NumCode < std::size(aCode))
		{
			const float Len = (i % 3 == 0) ? FILM_EDGE_CODE : 4.0f;
			aCode[NumCode++] = IGraphics::CLineItem(Cx, CodeY, Cx + Len, CodeY);
			Cx += Len + 6.0f;
			++i;
		}
		if(NumCode > 0)
			DrawLines(pGraphics, aCode, NumCode, Dim(DIM, 0.5f));
	}

	// Рама кадра между полосами перфорации.
	const float FrameX = X + FILM_SPROCKET_W + 3.0f;
	const float FrameW = W - 2.0f * (FILM_SPROCKET_W + 3.0f);
	const float FrameY = Y + FILM_HEADER_H;
	const float FrameH = H - FILM_HEADER_H - 6.0f;
	const IGraphics::CLineItem aFrame[] = {
		IGraphics::CLineItem(FrameX, FrameY, FrameX + FrameW, FrameY),
		IGraphics::CLineItem(FrameX + FrameW, FrameY, FrameX + FrameW, FrameY + FrameH),
		IGraphics::CLineItem(FrameX + FrameW, FrameY + FrameH, FrameX, FrameY + FrameH),
		IGraphics::CLineItem(FrameX, FrameY + FrameH, FrameX, FrameY),
	};
	DrawLines(pGraphics, aFrame, std::size(aFrame), Dim(Accent, 0.30f + 0.25f * Te));

	// Счётчик кадра в заголовке: «FRM 0042».
	{
		char aCounter[16];
		str_format(aCounter, sizeof(aCounter), "FRM %04d", FrameNumber % 10000);
		DrawCounter(pGraphics, aCounter, X + W - FILM_SPROCKET_W - 8.0f, Y + 10.0f, 2.2f, Dim(ICE, 0.9f));
	}

	// Несущая линия под заголовком.
	{
		const IGraphics::CLineItem aStrip[] = {
			IGraphics::CLineItem(FrameX, FrameY, FrameX + FrameW, FrameY),
		};
		DrawLines(pGraphics, aStrip, 1, Dim(Accent, 0.45f));
	}

	// Регистрационные метки ⊕ по углам рамы.
	{
		const float In = 12.0f + FILM_MARK_R;
		const float My = FrameY + In;
		const float MyB = FrameY + FrameH - In;
		RegistrationMark(pGraphics, FrameX + In, My, FILM_MARK_R, Dim(Accent, 0.55f));
		RegistrationMark(pGraphics, FrameX + FrameW - In, My, FILM_MARK_R, Dim(Accent, 0.55f));
		RegistrationMark(pGraphics, FrameX + In, MyB, FILM_MARK_R, Dim(DIM, 0.45f));
		RegistrationMark(pGraphics, FrameX + FrameW - In, MyB, FILM_MARK_R, Dim(DIM, 0.45f));
	}

	// Внешний контур кадра: тонкая рамка всей плёнки.
	{
		const IGraphics::CLineItem aOutline[] = {
			IGraphics::CLineItem(X, Y, X + W, Y),
			IGraphics::CLineItem(X + W, Y, X + W, Y + H),
			IGraphics::CLineItem(X + W, Y + H, X, Y + H),
			IGraphics::CLineItem(X, Y + H, X, Y),
		};
		DrawLines(pGraphics, aOutline, std::size(aOutline), Dim(Accent, (0.35f + 0.45f * Te) * AnimT));
	}
}

void NeonWindow::DrawStamp(IGraphics *pGraphics, const CUIRect &Area, EStampState State, ColorRGBA Ink)
{
	const float X = Area.x, Y = Area.y, W = Area.w, H = Area.h;
	const bool Hot = State == STAMP_HOT;
	const bool Active = State == STAMP_ACTIVE;

	// Оттиск: у наведённого штампа вокруг плиты проступают чернила.
	if(Hot)
		FillRect(pGraphics, X - 3.0f, Y - 3.0f, W + 6.0f, H + 6.0f, Dim(Ink, 0.10f));

	// Плита: выбранная залита чернилами целиком, остальные — ночная плёнка.
	if(Active)
		FillRect(pGraphics, X, Y, W, H, Dim(Ink, 0.85f));
	else
		FillRect(pGraphics, X, Y, W, H, Dim(NIGHT_2, Hot ? 0.85f : 0.72f));

	// Двойная рамка штампа: внешний контур по кромке и внутренний со сдвигом.
	const float OuterA = Active ? 1.0f : (Hot ? 0.95f : 0.55f);
	const float InnerA = Active ? 0.6f : (Hot ? 0.55f : 0.3f);
	const IGraphics::CLineItem aOuter[] = {
		IGraphics::CLineItem(X, Y, X + W, Y),
		IGraphics::CLineItem(X + W, Y, X + W, Y + H),
		IGraphics::CLineItem(X + W, Y + H, X, Y + H),
		IGraphics::CLineItem(X, Y + H, X, Y),
	};
	DrawLines(pGraphics, aOuter, std::size(aOuter), Dim(Ink, OuterA));
	const float In = 3.0f;
	if(W > 2.0f * In + 4.0f && H > 2.0f * In + 4.0f)
	{
		const IGraphics::CLineItem aInner[] = {
			IGraphics::CLineItem(X + In, Y + In, X + W - In, Y + In),
			IGraphics::CLineItem(X + W - In, Y + In, X + W - In, Y + H - In),
			IGraphics::CLineItem(X + W - In, Y + H - In, X + In, Y + H - In),
			IGraphics::CLineItem(X + In, Y + H - In, X + In, Y + In),
		};
		DrawLines(pGraphics, aInner, std::size(aInner), Dim(Ink, InnerA));
	}
}

void NeonWindow::DrawFolderTab(IGraphics *pGraphics, const CUIRect &Area, EStampState State, ColorRGBA Accent, int Index)
{
	const float X = Area.x, Y = Area.y, W = Area.w, H = Area.h;
	const bool Hot = State == STAMP_HOT;
	const bool Active = State == STAMP_ACTIVE;
	// Ярлык папки: нижняя часть — обычная плита, верхняя — трапеция со
	// срезанными углами (8px катет), как вырез на картотеке.
	const float Cut = 8.0f;

	pGraphics->TextureClear();
	pGraphics->QuadsBegin();
	pGraphics->SetColor(Dim(Active ? NIGHT_2 : NIGHT_1, Active ? 0.92f : (Hot ? 0.85f : 0.72f)));
	IGraphics::CQuadItem Body(X, Y + Cut, W, H - Cut);
	pGraphics->QuadsDrawTL(&Body, 1);
	IGraphics::CFreeformItem Top(X + Cut, Y, X + W - Cut, Y, X + W, Y + Cut, X, Y + Cut);
	pGraphics->QuadsDrawFreeform(&Top, 1);
	pGraphics->QuadsEnd();

	// Контур ярлыка: у активной вкладки кромка акцентная и толще.
	const ColorRGBA Edge = Dim(Accent, Active ? 0.95f : (Hot ? 0.6f : 0.3f));
	const IGraphics::CLineItem aEdges[] = {
		IGraphics::CLineItem(X + Cut, Y, X + W - Cut, Y),
		IGraphics::CLineItem(X + W - Cut, Y, X + W, Y + Cut),
		IGraphics::CLineItem(X + W, Y + Cut, X + W, Y + H),
		IGraphics::CLineItem(X + W, Y + H, X, Y + H),
		IGraphics::CLineItem(X, Y + H, X, Y + Cut),
		IGraphics::CLineItem(X, Y + Cut, X + Cut, Y),
	};
	DrawLines(pGraphics, aEdges, std::size(aEdges), Edge);
	if(Active)
	{
		const IGraphics::CLineItem aTop[] = {
			IGraphics::CLineItem(X + Cut, Y - 2.0f, X + W - Cut, Y - 2.0f),
		};
		DrawLines(pGraphics, aTop, 1, Dim(Accent, 0.5f));
	}

	// Номер ярлыка: кодовая гарнитура в правом верхнем углу.
	if(Index > 0)
	{
		char aTag[8];
		str_format(aTag, sizeof(aTag), "%02d", Index % 100);
		DrawCounter(pGraphics, aTag, X + W - Cut - 4.0f, Y + 4.0f, 1.8f, Dim(Accent, Active ? 0.9f : 0.5f));
	}
}

void NeonWindow::DrawFilmScrap(IGraphics *pGraphics, const CUIRect &Area, ColorRGBA Accent, float Alpha)
{
	Alpha = std::clamp(Alpha, 0.0f, 1.0f);
	if(Alpha <= 0.0f)
		return;
	const float X = Area.x, Y = Area.y, W = Area.w, H = Area.h;

	// Рваные кромки: обрывок собирается из вертикальных ломтиков, у каждого
	// своя высота. Детерминированная синусоида вместо случайных чисел, чтобы
	// рваный край не дрожал между кадрами.
	const float Slice = 6.0f;
	const size_t MaxSlices = 256;
	IGraphics::CFreeformItem aSlices[MaxSlices];
	size_t NumSlices = 0;
	for(float X0 = X; X0 < X + W && NumSlices < MaxSlices; X0 += Slice)
	{
		const float X1 = std::min(X0 + Slice, X + W);
		const int I = (int)((X0 - X) / Slice);
		const float JagTop = 1.6f * std::sin(I * 2.3f) + 0.9f * std::sin(I * 5.1f + 1.3f);
		const float JagBottom = 1.6f * std::sin(I * 1.7f + 2.0f) + 0.9f * std::sin(I * 4.3f);
		aSlices[NumSlices++] = IGraphics::CFreeformItem(
			X0, Y + JagTop, X1, Y + 1.6f * std::sin((I + 1) * 2.3f) + 0.9f * std::sin((I + 1) * 5.1f + 1.3f),
			X1, Y + H + 1.6f * std::sin((I + 1) * 1.7f + 2.0f) + 0.9f * std::sin((I + 1) * 4.3f),
			X0, Y + H + JagBottom);
	}
	pGraphics->TextureClear();
	pGraphics->QuadsBegin();
	pGraphics->SetColor(Dim(NIGHT_1, 0.88f * Alpha));
	pGraphics->QuadsDrawFreeform(aSlices, NumSlices);
	pGraphics->QuadsEnd();

	// Проколы перфорации: по одному с каждого конца обрывка.
	const float HoleX0 = X + 5.0f;
	const float HoleX1 = X + W - 5.0f - FILM_HOLE_W;
	const float HoleY = Y + (H - FILM_HOLE_H) * 0.5f;
	FillRect(pGraphics, HoleX0, HoleY, FILM_HOLE_W, FILM_HOLE_H, Dim(NIGHT_0, Alpha));
	FillRect(pGraphics, HoleX1, HoleY, FILM_HOLE_W, FILM_HOLE_H, Dim(NIGHT_0, Alpha));

	// Короткая несущая риска под обрывком: акцент тревоги.
	const IGraphics::CLineItem Under(X + 18.0f, Y + H + 4.0f, X + W - 18.0f, Y + H + 4.0f);
	DrawLines(pGraphics, &Under, 1, Dim(Accent, 0.55f * Alpha));
}

void NeonWindow::DrawFilmPlate(IGraphics *pGraphics, const CUIRect &Area, ColorRGBA Border, ColorRGBA Fill)
{
	const float X = Area.x, Y = Area.y, W = Area.w, H = Area.h;
	// Узким плитам полная перфорация с двух сторон тесна — оставляем одну
	// полосу слева и сужаем её на мелких попопах.
	const float Strip = W >= 320.0f ? FILM_SPROCKET_W : 12.0f;

	FillRect(pGraphics, X, Y, W, H, Fill);
	FillRect(pGraphics, X, Y, Strip, H, Dim(NIGHT_0, 0.55f));

	// Отверстия перфорации (шаг сохраняем, ширину режем под узкую полосу).
	{
		const float HoleW = std::min(FILM_HOLE_W, Strip - 4.0f);
		const float HoleX = X + (Strip - HoleW) * 0.5f;
		for(float HoleY = Y + 4.0f; HoleY + FILM_HOLE_H < Y + H - 2.0f; HoleY += FILM_HOLE_STEP)
			FillRect(pGraphics, HoleX, HoleY, HoleW, FILM_HOLE_H, Dim(NIGHT_0, 1.0f));
	}

	const IGraphics::CLineItem aRail(X + Strip, Y, X + Strip, Y + H);
	DrawLines(pGraphics, &aRail, 1, Dim(DIM, 0.4f));

	// Краевой код вдоль верхней кромки.
	{
		IGraphics::CLineItem aCode[24];
		size_t NumCode = 0;
		float Cx = X + Strip + 8.0f;
		int i = 0;
		while(Cx + FILM_EDGE_CODE < X + W - 8.0f && NumCode < std::size(aCode))
		{
			const float Len = (i % 3 == 0) ? FILM_EDGE_CODE : 4.0f;
			aCode[NumCode++] = IGraphics::CLineItem(Cx, Y + 4.0f, Cx + Len, Y + 4.0f);
			Cx += Len + 6.0f;
			++i;
		}
		if(NumCode > 0)
			DrawLines(pGraphics, aCode, NumCode, Dim(DIM, 0.5f));
	}

	// Контур всей плиты.
	const IGraphics::CLineItem aOutline[] = {
		IGraphics::CLineItem(X, Y, X + W, Y),
		IGraphics::CLineItem(X + W, Y, X + W, Y + H),
		IGraphics::CLineItem(X + W, Y + H, X, Y + H),
		IGraphics::CLineItem(X, Y + H, X, Y),
	};
	DrawLines(pGraphics, aOutline, std::size(aOutline), Border);
}
