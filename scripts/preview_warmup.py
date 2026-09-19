#!/usr/bin/env python3
"""Inspection sheet from the serialized map; NOT a native engine screenshot.

Renders axis-aligned terrain, icons and oil frame zero. Omits entities,
parallax, live motion and native lighting. Does not modify any source assets.
"""
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont
import twmap
from build_warmup import OUTPUT


def render(destination):
    m=twmap.Map(str(OUTPUT))
    images=[Image.fromarray(image.data) for image in m.images]
    layers={layer.name:layer for group in m.groups for layer in group.layers}
    scale=18
    sections=[('01 / ПОДЪЁМ',0,45),('02 / ПРЫЖКИ',38,79),
              ('03 / ТРЕНИРОВКА КРЮКА',75,116),('04 / ФИНИШ',133,174)]
    font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',18)
    small=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',14)
    sheet=Image.new('RGB',(1680,1220),(14,10,25));d=ImageDraw.Draw(sheet)
    d.text((28,18),'РАЗОГРЕВ / ОРИГИНАЛЬНЫЙ МАРШРУТ / PLAYTEST 1',font=font,fill=(224,214,246))
    d.text((28,48),'Схема из сохранённого .map, не скриншот клиента. Показан один кадр; персонажи и движение не отображены.',font=small,fill=(157,148,181))
    for index,(title,left,right) in enumerate(sections):
        view=Image.new('RGBA',((right-left)*scale,30*scale),(22,14,36,255))
        for name in ['Stage','Route icons']:
            layer=layers[name];atlas=images[layer.image];tiles=layer.tiles;cell=atlas.width//16
            for y in range(14,44):
                for x in range(left,right):
                    tile=int(tiles[y,x,0])
                    if tile:
                        u=(tile%16)*cell;v=(tile//16)*cell
                        tex=atlas.crop((u,v,u+cell,v+cell)).resize((scale,scale),Image.Resampling.LANCZOS)
                        view.alpha_composite(tex,((x-left)*scale,(y-14)*scale))
        oil=layers['Oil return'];atlas=images[oil.image]
        for q in oil.quads:
            if m.envelopes[q.color_env].points[0].content[3]!=1:continue
            x0,y0=q.corners[0];x1,y1=q.corners[3]
            if x0<left or x1>right:continue
            u,v=q.texture_coords[0];u1,v1=q.texture_coords[3]
            tex=atlas.crop((round(u*atlas.width),round(v*atlas.height),round(u1*atlas.width),round(v1*atlas.height)))
            tex=tex.resize((round((x1-x0)*scale),round((y1-y0)*scale)),Image.Resampling.LANCZOS)
            view.alpha_composite(tex,(round((x0-left)*scale),round((y0-14)*scale)))
        x=28+(index%2)*836;y=112+(index//2)*568
        d.text((x,y-28),title,font=font,fill=(200,170,237))
        sheet.paste(view,(x,y),view)
    destination=Path(destination);destination.parent.mkdir(parents=True,exist_ok=True)
    sheet.save(destination)


if __name__=='__main__':render(sys.argv[1])
