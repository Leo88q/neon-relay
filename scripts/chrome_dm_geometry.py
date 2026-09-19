#!/usr/bin/env python3
"""Authored extension to dm7 – v3 substantially bigger with freeze and all weapons."""
import numpy as np

WIDTH, HEIGHT = 520, 180
# Only these junction rectangles may alter the original 146x120 region.
JUNCTIONS = [(128,34,158,42),(124,69,158,78),(132,105,162,115)]

# Original atrium decks
DECKS_V2 = [(154,190,36),(206,240,36),(255,269,36),
            (165,204,56),(220,258,56),
            (152,182,76),(197,230,76),(246,269,76)]

# Extended atrium and new zones – hookable combat decks
DECKS_V3 = [
    # Extended atrium east
    (280,320,28),(335,375,28),(390,420,28),
    (285,325,48),(340,380,48),(395,435,48),
    (275,315,68),(330,370,68),(385,425,68),(440,470,68),
    # Frozen Foundry mid-level
    (300,340,108),(355,395,108),(410,450,108),
    (310,350,128),(365,405,128),
    # Weapon Spire vertical ledges
    (430,470,18),(435,475,38),(430,470,58),(435,475,78),(430,470,98),(435,475,118),(430,470,138),
    # Lower obstacle field
    (155,195,118),(210,250,118),(265,305,118),
    (160,200,148),(220,260,148),(280,320,148),(340,380,148),(400,440,148),
]

NEW_SPAWNS_V2 = [(170,35),(224,35),(177,55),(242,55),(169,75),(214,75),(258,75),(159,95),(200,95),(260,95)]
NEW_SPAWNS_V3 = [
    (295,27),(360,27),(410,27),
    (300,47),(375,47),(425,47),
    (290,67),(355,67),(445,67),
    (315,107),(375,107),(430,107),
    (325,127),(385,127),(455,127),
    (175,117),(235,117),(285,117),(345,147),(415,147),(465,17),(465,77),(465,137),
]

# All 6 weapons scattered: 198 health, 197 armor, 199 shotgun, 200 grenade, 202 laser, 201 ninja (as 6th)
NEW_ITEMS_V2 = [(181,35,198),(211,35,197),(232,35,202),
                (182,55,199),(193,55,198),(230,55,197),(250,55,200),
                (161,75,198),(205,75,200),(223,75,197),(255,75,199),
                (179,95,198),(217,95,202),(239,95,197)]

NEW_ITEMS_V3 = [
    # Atrium east – mixed
    (295,27,199),(310,27,197),(360,27,200),(375,27,198),(410,27,202),(425,27,197),
    (300,47,198),(315,47,199),(375,47,202),(390,47,197),(425,47,200),(440,47,198),
    (290,67,197),(305,67,200),(355,67,199),(370,67,198),(445,67,202),(460,67,197),
    # Foundry – health/armor plus freeze-survival rewards
    (315,107,198),(330,107,197),(375,107,199),(390,107,200),(430,107,202),(445,107,198),
    (325,127,197),(340,127,198),(385,127,199),(400,127,200),(455,127,202),(470,127,198),
    # Lower field – all weapons
    (175,117,199),(190,117,197),(235,117,200),(250,117,198),(285,117,202),(300,117,197),
    (345,147,199),(360,147,200),(415,147,202),(430,147,198),(465,17,201),(465,77,199),(465,137,200),
    # Ninja as rare 6th
    (320,27,201),(380,67,201),(420,147,201),
]

# Freeze obstacles – front layer tiles: 9 freeze, 11 unfreeze, 12 deep freeze, 13 deep unfreeze
FREEZE_ZONES = [
    # Foundry floor freeze with unfreeze islands
    (300,420,110,112,9),   # freeze strip
    (305,315,108,108,11), (335,345,108,108,11), (365,375,108,108,11), (395,405,108,108,11),
    (310,430,130,132,9),
    (315,325,128,128,11), (345,355,128,128,11), (375,385,128,128,11), (405,415,128,128,11),
    # Spire freeze rings
    (428,472,20,22,9), (433,477,40,42,9), (428,472,60,62,9),
    # Lower death+freeze mix – small freeze patches as hazards
    (170,190,120,122,9), (230,250,120,122,9), (290,310,150,152,9), (360,380,150,152,9),
]

def extend(original):
    assert original.shape==(120,146,2)
    game = np.zeros((HEIGHT,WIDTH,2), dtype=np.uint8)
    game[:,:,0]=1
    # Place original at (0,0) – top-left preserved
    game[0:120,0:146]=original
    # Clear atrium area
    game[10:160,146:520]=0
    # Re-create solid borders
    game[0,:,0]=1; game[-1,:,0]=1; game[:,0,0]=1; game[:,-1,0]=1
    # Keep original interior solid where it was solid, but clear new area
    # Decks v2 and v3
    for left,right,y in DECKS_V2+DECKS_V3:
        if y < HEIGHT and left < WIDTH:
            r = min(right, WIDTH-2)
            game[y:y+3,left:r+1,0]=1
    # Hanging nodes for hook gaps
    for left,right,y in [(195,201,29),(245,250,29),(209,215,49),(187,192,69),(235,241,69),
                         (330,336,21),(380,386,41),(440,446,61),(350,356,101),(410,416,121)]:
        if y < HEIGHT:
            game[y:y+2,left:min(right,WIDTH-2)+1,0]=1
    # Ascending routes left and right
    for level,y in enumerate(range(92,19,-4)):
        for left in (148+(level%2)*5,256+(level%2)*5,360+(level%2)*5,430+(level%2)*5):
            if left < WIDTH-8 and y < HEIGHT:
                game[y,left:left+7,0]=1
    # Vertical spire steps
    for y in range(18,150,10):
        x = 430 + (y//20)%2*10
        if x < WIDTH-10:
            game[y,x:x+12,0]=1
    # Lower death pits as obstacles (still hookable edges)
    for x0,x1,y in [(155,195,150),(210,250,150),(265,305,170),(340,380,170)]:
        if y < HEIGHT-2:
            game[y+1:y+3,x0:x1,0]=2  # death
    # Junctions – clear and add floors
    for x0,y0,x1,y1 in JUNCTIONS:
        if y0 < HEIGHT and x0 < WIDTH:
            x1c = min(x1, WIDTH); y1c = min(y1, HEIGHT)
            region = game[y0:y1c-1,x0:x1c]
            region[region[:,:,0]<192]=0
            floor = game[y1c-1,x0:x1c]
            floor[floor[:,0]<192]=(1,0)
    # Spawns – ensure solid platform below
    for x,y in NEW_SPAWNS_V2+NEW_SPAWNS_V3:
        if 0 < x < WIDTH-1 and 0 < y < HEIGHT-1:
            # ensure at least 3-wide platform below
            if y+1 < HEIGHT:
                if game[y+1,x,0]!=1:
                    game[y+1,x-1:x+2,0]=1
                game[y,x]=(192,0)
    # Items – all 6 weapons
    for x,y,kind in NEW_ITEMS_V2+NEW_ITEMS_V3:
        if 0 < x < WIDTH-1 and 0 < y < HEIGHT-1:
            if game[y,x,0]==0 and game[y+1,x,0]==1:
                game[y,x]=(kind,0)
    return game

def front_layer():
    front = np.zeros((HEIGHT,WIDTH,2), dtype=np.uint8)
    for x0,x1,y0,y1,tile in FREEZE_ZONES:
        x0c=max(0,x0); x1c=min(WIDTH,x1); y0c=max(0,y0); y1c=min(HEIGHT,y1)
        front[y0c:y1c, x0c:x1c, 0]=tile
    return front

def change_mask():
    mask=np.zeros((120,146),dtype=bool)
    for x0,y0,x1,y1 in JUNCTIONS:
        if x0<146 and y0<120:
            mask[y0:min(y1,120),x0:min(x1,146)]=True
    return mask
