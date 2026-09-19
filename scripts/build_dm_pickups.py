#!/usr/bin/env python3
"""Original code-drawn combat supplies. Never reads or modifies character art."""
from pathlib import Path
import argparse
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SIZE = 384


def material(mask, colors):
    y,x=np.mgrid[:SIZE,:SIZE]
    stops=np.array([0,.12,.3,.48,.60,.76,1])
    v=np.clip(y/SIZE+.055*np.sin(x/SIZE*4),0,1)
    rgb=np.stack([np.interp(v,stops,np.array(colors)[:,c]) for c in range(3)],axis=-1)
    result=Image.fromarray(rgb.astype('uint8')).convert('RGBA');result.putalpha(mask)
    return result


CHROME=[(234,247,255),(255,255,255),(119,148,179),(20,34,62),(180,209,230),(242,250,255),(70,94,135)]


def icon(kind):
    im=Image.new('RGBA',(SIZE,SIZE));d=ImageDraw.Draw(im)
    silhouette=Image.new('L',im.size);md=ImageDraw.Draw(silhouette)
    if kind=='health':md.rounded_rectangle((91,28,293,351),radius=68,fill=255)
    else:md.polygon([(192,24),(322,87),(303,235),(254,308),(192,357),(130,308),(81,235),(62,87)],fill=255)
    # Soft cyan halo, not an opaque sticker border.
    halo=Image.new('RGBA',im.size,(70,196,233,0));halo.putalpha(silhouette.filter(ImageFilter.GaussianBlur(13)).point(lambda a:a//3))
    im.alpha_composite(halo);im.alpha_composite(material(silhouette,CHROME));d=ImageDraw.Draw(im)
    if kind=='health':
        d.rounded_rectangle((91,28,293,351),68,outline=(19,34,53,255),width=6)
        # End caps and machined rails.
        for y in (43,306):
            d.rounded_rectangle((114,y,270,y+34),11,fill=(34,46,65),outline=(211,228,242),width=3)
            for x in range(132,259,18):d.line((x,y+8,x,y+26),fill=(121,152,175),width=3)
        for x in (105,269):
            d.rounded_rectangle((x,87,x+10,298),4,fill=(41,61,85),outline=(223,235,247),width=2)
        # Luminous translucent repair reservoir.
        glass=Image.new('L',im.size);ImageDraw.Draw(glass).rounded_rectangle((129,92,255,298),22,fill=255)
        colors=[(199,255,239),(218,255,247),(89,216,177),(12,83,96),(56,164,145),(133,249,205),(28,92,113)]
        im.alpha_composite(material(glass,colors));d=ImageDraw.Draw(im)
        d.rounded_rectangle((129,92,255,298),22,outline=(9,49,62),width=5)
        for y in range(246,287,10):d.line((142,y,241,y),fill=(141,255,219,100),width=2)
        # Clearly readable plus, with a dark raised plate and pale luminous inlay.
        d.rounded_rectangle((146,143,239,237),18,fill=(17,61,68),outline=(198,255,235),width=3)
        d.rounded_rectangle((182,159,204,222),4,fill=(220,255,238))
        d.rounded_rectangle((161,180,225,201),4,fill=(220,255,238))
        d.line((139,115,139,133),fill=(245,255,255),width=5)
        d.line((139,248,139,273),fill=(179,255,232),width=4)
        for x,y in [(113,84),(272,84),(113,294),(272,294)]:
            d.ellipse((x-5,y-5,x+5,y+5),fill=(21,34,49),outline=(224,239,255),width=2)
        # Charge indicator; health is green, armor is cyan and hexagonal.
        for x in (166,187,208):d.rounded_rectangle((x,68,x+11,76),2,fill=(149,255,182))
    else:
        d.line([(192,24),(322,87),(303,235),(254,308),(192,357),(130,308),(81,235),(62,87),(192,24)],fill=(16,32,60),width=6)
        inner=[(192,53),(292,102),(277,225),(235,286),(192,321),(149,286),(107,225),(92,102)]
        mask=Image.new('L',im.size);ImageDraw.Draw(mask).polygon(inner,fill=255)
        colors=[(185,243,255),(92,211,255),(42,113,166),(11,31,69),(35,86,136),(90,181,218),(16,43,88)]
        im.alpha_composite(material(mask,colors));d=ImageDraw.Draw(im)
        d.line(inner+[inner[0]],fill=(155,242,255),width=5)
        # Facets and shield core make it a protection module, not a coin.
        d.polygon([(192,96),(256,124),(246,207),(221,246),(192,270),(163,246),(138,207),(128,124)],fill=(15,41,76),outline=(195,250,255),width=4)
        d.polygon([(192,107),(192,253),(165,231),(146,199),(138,132)],fill=(93,188,223))
        d.line((192,113,192,241),fill=(225,255,255),width=4)
        for side in (-1,1):
            for y in (149,170,191,212):
                x=192+side*91
                d.line((x-7,y,x+7,y+5),fill=(19,39,60),width=5)
            for x,y in [(192+side*112,104),(192+side*82,244),(192+side*35,305)]:
                d.ellipse((x-5,y-5,x+5,y+5),fill=(22,40,61),outline=(232,249,255),width=2)
        d.line((113,92,163,66),fill=(246,255,255),width=5)
        d.line((191,331,224,305),fill=(117,230,254),width=4)
    return im.resize((128,128),Image.Resampling.LANCZOS)


def build(folder):
    folder=Path(folder);folder.mkdir(parents=True,exist_ok=True)
    for kind in ('health','armor'):icon(kind).save(folder/f'neon_dm_{kind}.png')


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output',type=Path,default=ROOT/'data/game_entities')
    args=p.parse_args();build(args.output)
