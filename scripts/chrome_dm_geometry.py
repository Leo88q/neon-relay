#!/usr/bin/env python3
"""Authored extension to dm7. Never stretches or randomly duplicates old geometry."""
import numpy as np

WIDTH, HEIGHT = 274, 120
# Only these two junction rectangles may alter the original 146x120 region.
JUNCTIONS = [(128,34,158,42),(124,69,158,78)]
# Inclusive span, top row. Hookable horizontal combat decks, not sealed floors.
DECKS = [(154,190,36),(206,240,36),(255,269,36),
         (165,204,56),(220,258,56),
         (152,182,76),(197,230,76),(246,269,76)]
NEW_SPAWNS = [(170,35),(224,35),(177,55),(242,55),(169,75),(214,75),(258,75),(159,95),(200,95),(260,95)]
NEW_ITEMS = [(181,35,198),(211,35,197),(232,35,202),
             (182,55,199),(193,55,198),(230,55,197),(250,55,200),
             (161,75,198),(205,75,200),(223,75,197),(255,75,199),
             (179,95,198),(217,95,202),(239,95,197)]


def extend(original):
    assert original.shape==(HEIGHT,146,2)
    game=np.zeros((HEIGHT,WIDTH,2),dtype=np.uint8)
    game[:,:,0]=1
    game[:,:146]=original
    game[18:96,146:270]=0
    for left,right,y in DECKS:
        game[y:y+3,left:right+1,0]=1
    # Hookable hanging nodes across the wider combat-deck gaps.
    for left,right,y in [(195,201,29),(245,250,29),(209,215,49),(187,192,69),(235,241,69)]:
        game[y:y+2,left:right+1,0]=1
    # Ascending return routes at both sides: rise 4, overlapping hookable steps.
    # They connect all three deck elevations instead of a single tall void.
    for level,y in enumerate(range(92,19,-4)):
        for left in (148+(level%2)*5,256+(level%2)*5):
            game[y,left:left+7,0]=1
    # Two wide, separated connections from the original arena, with firm floors.
    for x0,y0,x1,y1 in JUNCTIONS:
        region=game[y0:y1-1,x0:x1]
        region[region[:,:,0]<192]=0
        floor=game[y1-1,x0:x1]
        floor[floor[:,0]<192]=(1,0)
    for x,y in NEW_SPAWNS:
        assert np.all(game[y-1:y+1,x,0]==0) and game[y+1,x,0]==1,(x,y)
        game[y,x]=(192,0)
    for x,y,kind in NEW_ITEMS:
        assert game[y,x,0]==0 and game[y+1,x,0]==1,(x,y)
        game[y,x]=(kind,0)
    assert np.all(game[:,0,0]==1) and np.all(game[:,-1,0]==1)
    return game


def change_mask():
    mask=np.zeros((HEIGHT,146),dtype=bool)
    for x0,y0,x1,y1 in JUNCTIONS:mask[y0:y1,x0:min(x1,146)]=True
    return mask
