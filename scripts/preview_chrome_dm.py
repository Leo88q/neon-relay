#!/usr/bin/env python3
"""Inspection sheet for v3 atrium with photo background."""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import twmap
from build_chrome_dm import ROOT

def render(source,destination):
    m=twmap.Map(str(source))
    layers={l.name:l for g in m.groups for l in g.layers}
    terrain=layers['Chrome']; a=terrain.tiles; h,w,_=a.shape
    atlas=Image.fromarray(m.images[terrain.image].data)
    pastel_img = next((m.images[i] for i in range(len(m.images)) if m.images[i].name=='pastel'), m.images[1])
    sky=Image.fromarray(pastel_img.data)
    game=m.game_layer().tiles[:,:,0]
    front=m.front_layer().tiles[:,:,0] if m.front_layer() else None
    fontpath='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
    title=ImageFont.truetype(fontpath,26); font=ImageFont.truetype(fontpath,16)
    small=ImageFont.truetype(fontpath,13)
    sheet=Image.new('RGB',(1600,1300),(18,20,39)); d=ImageDraw.Draw(sheet)
    d.text((26,22),f'CHROME DM v3 / dm7 + atrium {w}×{h} / freeze+weapons / photo background',font=title,fill='#eff0ff')
    d.text((26,64),'Схема из .map — НЕ скриншот игры. Фото-фон + кодовые эффекты.',font=font,fill='#b7c3e1')

    def view(left,top,right,bottom,scale,markers=False):
        v=sky.resize(((right-left)*scale,(bottom-top)*scale)).convert('RGBA')
        tiles={}
        for y in range(top,bottom):
            for x in range(left,right):
                idx=int(a[y,x,0]) if 0<=y<h and 0<=x<w else 0
                if idx:
                    if idx not in tiles:
                        u=idx%16*64; vv=idx//16*64
                        tiles[idx]=atlas.crop((u,vv,u+64,vv+64)).resize((scale,scale),Image.Resampling.LANCZOS)
                    v.alpha_composite(tiles[idx],((x-left)*scale,(y-top)*scale))
        if markers:
            pen=ImageDraw.Draw(v)
            for y in range(top,bottom):
                for x in range(left,right):
                    if 0<=y<h and 0<=x<w:
                        if game[y,x]==192:
                            cx=(x-left+.5)*scale; cy=(y-top+.5)*scale
                            pen.ellipse((cx-4,cy-4,cx+4,cy+4),fill='#41ffb8',outline='#101936',width=2)
                        if front is not None and front[y,x]==9:
                            cx=(x-left+.5)*scale; cy=(y-top+.5)*scale
                            pen.rectangle((cx-3,cy-3,cx+3,cy+3),fill='#7ad8ff')
        return v

    spawns=int((game==192).sum())
    d.text((26,102),f'Полная геометрия {w} × {h} / {spawns} спавнов / freeze {int((front==9).sum()) if front is not None else 0} клеток',font=font,fill='#eff0ff')
    overview=view(0,0,w,h,3,True); sheet.paste(overview,(26,134))
    d.text((936,102),'Фрагменты: оригинал, атриум, заморозка, шпиль',font=small,fill='#eff0ff')
    for idx,(left,top) in enumerate([(50,38),(280,28),(310,108),(430,18)]):
        crop=view(left,top,left+32,top+18,18,True)
        sy=134+idx*280; sheet.paste(crop,(960,sy))
        d.text((960,sy+330),f'x{left}–{left+31}, y{top}–{top+17}',font=small,fill='#aab6d2')
    d.text((26,1050),'Основа: dm7 CC-BY-SA 3.0 + оригинальный атриум v3 с фото-фоном и freeze',font=font,fill='#e1d8ff')
    d.text((26,1080),'Оружия: все 6 типов раскиданы, health/armor оригинальные капсулы, HUD без картошки',font=font,fill='#b7c3e1')
    d.text((26,1110),'Не является подтверждением проходимости прыжками или баланса',font=font,fill='#efbbaa')
    destination=Path(destination); destination.parent.mkdir(parents=True,exist_ok=True); sheet.save(destination)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--map',type=Path,default=ROOT/'.cache/chrome-dm/Neon Relay Chrome DM Study.map')
    p.add_argument('--output',type=Path,default=ROOT/'.cache/chrome-dm/inspection.png')
    args=p.parse_args(); render(args.map,args.output)
