"""Explicit opt-in collision change: 12 tiles in an empty pre-start training corridor."""
from learn_visibility import fields
HEIGHTS = (1,2,3,3,2,1)
CELLS = tuple((342+dx,y) for dx,height in enumerate(HEIGHTS) for y in range(23-height,23))

def apply(m):
    layers=dict(m.items[5]);game=layers[32];w=game[4]
    # Never silently overwrite a freeze/tele/checkpoint/entity/stop/switch or boost.
    for name,p,raw,stride,offset,flags in fields(m):
        for x,y in CELLS:
            assert raw[(y*w+x)*stride+offset]==0, (name,x,y,'terrace overlaps gameplay')
    raw=bytearray(m.raws[game[14]])
    for x in range(342,348):
        assert raw[(23*w+x)*4] in (1,3), 'terrace needs its original supporting floor'
        assert all(raw[(y*w+x)*4]==0 for y in range(17,20)), 'headroom regression'
    for x,y in CELLS:raw[(y*w+x)*4:(y*w+x)*4+4]=bytes((1,0,0,0))
    game[14]=m.raw(raw)
