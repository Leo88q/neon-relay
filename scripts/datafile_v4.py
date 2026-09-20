"""Read a v4 datafile without losing item IDs, UUID extension types or raw data."""
import struct
import zlib
from pathlib import Path
from map_format import MapWriter

def read(path):
    b=Path(path).read_bytes()
    magic,version,size,swap,nt,ni,nr,item_size,raw_size=struct.unpack_from('<4s8i',b)
    if magic!=b'DATA' or version!=4: raise ValueError('Expected v4 DATA file')
    pos=36+nt*12
    io=struct.unpack_from(f'<{ni}i',b,pos);pos+=ni*4
    ro=struct.unpack_from(f'<{nr}i',b,pos);pos+=nr*4
    lengths=struct.unpack_from(f'<{nr}i',b,pos);pos+=nr*4
    start=pos+item_size
    if start+raw_size!=len(b): raise ValueError('Truncated datafile')
    m=MapWriter()
    for i,off in enumerate(ro):
        raw=zlib.decompress(b[start+off:start+(ro[i+1] if i+1<nr else raw_size)])
        if len(raw)!=lengths[i]: raise ValueError('Raw block length mismatch')
        m.raws.append(raw)
    for off in io:
        tag,n=struct.unpack_from('<Ii',b,pos+off)
        t,ident=tag>>16,tag&65535
        payload=list(struct.unpack_from(f'<{n//4}i',b,pos+off+8))
        m.items.setdefault(t,[]).append((ident,payload))
        m._next_id[t]=max(m._next_id.get(t,0),ident+1)
    return m
