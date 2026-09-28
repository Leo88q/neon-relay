// Neon Relay — «Кадр плёнки»: фирменный оконный хром клиента.
//
// Окно = кадр проявленной плёнки из архива записей (демки и записи матчей —
// это и есть архив). Перфорация по краям, счётчик кадра в заголовке,
// регистрационные метки ⊕ по углам рамы, краевой код сверху и протяжка кадра
// при появлении. Токены геометрии — в `neon_style.h`; зеркало на сайте —
// CSS-переменные `--film-*` (design/potato-arena/index.html); паритет
// игра↔сайт проверяет `scripts/test_film_window.py`. Макет и правила:
// `docs/FILM_WINDOW_RU.md`.
#ifndef GAME_CLIENT_NEON_WINDOW_H
#define GAME_CLIENT_NEON_WINDOW_H

#include <base/color.h>

class CUIRect;
class IGraphics;

namespace NeonWindow
{
// Полный кадр плёнки (попопы меню, платы коннекта/загрузки).
// `Accent` — цвет проявки: циан для штатных кадров, розовый для аварийных
// (отключение, неверный пароль, предупреждение). `AnimT` в [0, 1]: 0 — кадр
// только пошёл в протяжку, 1 — кадр встал в ворота; протяжка дискретная,
// «механическая», с прокруткой перфорации. `FrameNumber` — номер кадра в
// правом верхнем углу (счётчик рисуется кодом, без шрифтов).
void DrawFilmFrame(IGraphics *pGraphics, const CUIRect &Area, ColorRGBA Accent, float AnimT, int FrameNumber);

// Компактная киноячейка для движковых попопов (палитра цвета, выбор, …):
// перфорация только слева (справа мелким плитам тесно), контур и краевой код.
void DrawFilmPlate(IGraphics *pGraphics, const CUIRect &Area, ColorRGBA Border, ColorRGBA Fill);

// Состояние кнопки-штампа.
enum EStampState
{
	STAMP_NORMAL = 0,
	STAMP_HOT, // курсор над кнопкой
	STAMP_ACTIVE, // кнопка нажата/выбрана
};

// Кнопка-штамп внутри кадра: прямая плита с двойной рамкой (внешний контур и
// внутренний со сдвигом 3px), чернила — `Ink` (циан для обычных кнопок,
// золото для наградных). Без скосов и миганий: штамп ставится, а не светится.
void DrawStamp(IGraphics *pGraphics, const CUIRect &Area, EStampState State, ColorRGBA Ink);

// Вкладка-ярлык архивной папки (п. 2 раскатки): плёночная папка с обрезанными
// верхними углами; активная получает циановую кромку и поднятие, `Index > 0`
// печатает номер ярлыка кодовой гарнитурой в правом верхнем углу.
void DrawFolderTab(IGraphics *pGraphics, const CUIRect &Area, EStampState State, ColorRGBA Accent, int Index);

// Обрывок плёнки для тостов/алертов (п. 4 раскатки): короткая полоса плёнки с
// рваными кромками — силуэт собирается из вертикальных ломтиков разной высоты,
// по одному проколу перфорации с каждого конца. `Alpha` гасит весь обрывок
// (используется фейдом алерта).
void DrawFilmScrap(IGraphics *pGraphics, const CUIRect &Area, ColorRGBA Accent, float Alpha);
}

#endif
