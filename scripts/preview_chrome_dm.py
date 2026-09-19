#!/usr/bin/env python3
"""Inspection sheet of serialized chrome study; NOT a native client capture."""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import twmap
from build_chrome_dm import ROOT


def render(source,destination):
    m=twmap.Map(str(source))
    layers={l.name:l for g in m.groups for l in g.layers}
    terrain=layers['Chrome'];a=terrain.tiles;h,w,_=a.shape
    atlas=Image.fromarray(m.images[terrain.image].data)
    sky=Image.fromarray(m.images[1].data)
    game=m.game_layer().tiles[:,:,0]
    fontpath='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
    title=ImageFont.truetype(fontpath,26);font=ImageFont.truetype(fontpath,16)
    small=ImageFont.truetype(fontpath,13)
    sheet=Image.new('RGB',(1540,1140),(18,20,39));d=ImageDraw.Draw(sheet)
    d.text((26,22),'CHROME DM / dm7 / исследование материала',font=title,fill='#eff0ff')
    d.text((26,64),'Схема из .map — НЕ скриншот игры. Без персонажей, живой анимации и native-освещения.',font=font,fill='#b7c3e1')

    def view(left,top,right,bottom,scale,markers=False):
        v=sky.resize(((right-left)*scale,(bottom-top)*scale)).convert('RGBA')
        tiles={}
        for y in range(top,bottom):
            for x in range(left,right):
                idx=int(a[y,x,0])
                if idx:
                    if idx not in tiles:
                        u=idx%16*64;vv=idx//16*64
                        tiles[idx]=atlas.crop((u,vv,u+64,vv+64)).resize((scale,scale),Image.Resampling.LANCZOS)
                    v.alpha_composite(tiles[idx],((x-left)*scale,(y-top)*scale))
        if markers:
            pen=ImageDraw.Draw(v)
            for y in range(top,bottom):
                for x in range(left,right):
                    if game[y,x]==192:
                        cx=(x-left+.5)*scale;cy=(y-top+.5)*scale
                        pen.ellipse((cx-5,cy-5,cx+5,cy+5),fill='#41ffb8',outline='#101936',width=2)
        return v

    d.text((26,102),'Полная геометрия 146 × 120 / зелёные маркеры — 9 спавнов',font=font,fill='#eff0ff')
    overview=view(0,0,w,h,6,True);sheet.paste(overview,(26,134))
    d.text((936,102),'Фрагменты материала / масштаб 24 px на клетку',font=small,fill='#eff0ff')
    for index,(left,top) in enumerate([(50,38),(83,64)]):
        crop=view(left,top,left+24,top+14,24)
        sy=134+index*390;sheet.paste(crop,(936,sy))
        d.text((936,sy+345),f'Клетки x{left}–{left+23}, y{top}–{top+13}',font=small,fill='#aab6d2')
    d.text((26,894),'Основа: dm7 / Teeworlds map contributors / CC-BY-SA 3.0',font=font,fill='#e1d8ff')
    d.text((26,927),'Модификация Neon Relay: новые материалы, фон, native envelopes; геометрия сохранена.',font=font,fill='#b7c3e1')
    d.text((26,960),'Предметы и кольца на схеме не показаны. Точный GLSL и боевые правила ещё не подключены.',font=font,fill='#b7c3e1')
    d.text((26,1008),'Не является подтверждением проходимости, читаемости в движении или вместимости сервера.',font=font,fill='#efbbaa')
    d.text((26,1050),'Источник: teeworlds/teeworlds-maps @ 64baa0e / dm7.map',font=small,fill='#8e9bb9')
    destination=Path(destination);destination.parent.mkdir(parents=True,exist_ok=True);sheet.save(destination)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--map',type=Path,default=ROOT/'.cache/chrome-dm/Neon Relay Chrome DM Study.map')
    p.add_argument('--output',type=Path,default=ROOT/'.cache/chrome-dm/inspection.png')
    args=p.parse_args();render(args.map,args.output)
