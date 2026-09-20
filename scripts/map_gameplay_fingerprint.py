#!/usr/bin/env python3
"""Hash collision/special-layer bytes and dimensions, independent of visuals."""
import struct,zlib,hashlib,json
from pathlib import Path

def gameplay(path):
    b=Path(path).read_bytes(); _,_,_,_,nt,ni,nr,sz,rs=struct.unpack_from('<4s8i',b)
    pos=36+nt*12;io=struct.unpack_from(f'<{ni}i',b,pos);pos+=ni*4
    ro=struct.unpack_from(f'<{nr}i',b,pos);pos+=nr*8
    rawstart=pos+sz
    raws=[zlib.decompress(b[rawstart+o:rawstart+(ro[i+1] if i+1<nr else rs)]) for i,o in enumerate(ro)]
    result=[]
    for off in io:
        tag,size=struct.unpack_from('<2i',b,pos+off)
        p=struct.unpack_from(f'<{size//4}i',b,pos+off+8)
        if tag>>16==5 and p[1]==2 and p[6]:
            layer=[p[4],p[5],p[6],raws[p[14]].hex()]
            for idx in p[18:23]:layer.append(raws[idx].hex() if idx>=0 else None)
            result.append(layer)
        if tag>>16==1 and len(p)>5 and p[5]>=0:result.append(['settings',raws[p[5]].hex()])
    return hashlib.sha256(json.dumps(result,separators=(',',':')).encode()).hexdigest()

if __name__=='__main__':
    import sys
    print(gameplay(sys.argv[1]))
