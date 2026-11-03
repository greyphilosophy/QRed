"""Public geometry shared by the encoder and reader. No fixture data."""
import math
import numpy as np

PAGE=(612,792)
BOX=(54,54,504,684)  # top-left origin, 0.75 inch margins
TAG_CENTERS=((68,68),(544,68),(544,724),(68,724))
TAG_SIZE=22
KINDS={"rect":0,"dots":1,"hex6":2,"hex12":3}
NEAR=((1,0),(0,1),(-1,1),(-1,0),(0,-1),(1,-1))
FAR=((1,1),(-1,2),(-2,1),(-1,-1),(1,-2),(2,-1))

def geometry(version,kind):
    n=17+4*version
    x,y,w,h=BOX
    if kind=="rect":
        centers=np.array([(x+(c+.5)*w/n,y+(r+.5)*h/n) for r in range(n) for c in range(n)])
        return dict(size=n,centers=centers,pitch=w/n,dx=w/n,dy=h/n,rows=n,cols=n)
    choices=[]
    for cols in range(4,n*2+1):
        rows=math.ceil(n*n/cols)
        pitch=min(w/(cols+.5),h/((rows-1)*math.sqrt(3)/2+2/math.sqrt(3)))
        choices.append((pitch,cols,rows))
    pitch,cols,rows=max(choices)
    width=(cols+.5)*pitch
    height=((rows-1)*math.sqrt(3)/2+2/math.sqrt(3))*pitch
    x+=(w-width)/2+pitch/2
    y+=(h-height)/2+pitch/math.sqrt(3)
    centers=np.array([(x+(c+.5*(r%2))*pitch,y+r*math.sqrt(3)/2*pitch)
                      for r in range(rows) for c in range(cols)])
    axial=[(c-r//2,r) for r in range(rows) for c in range(cols)]
    index={p:i for i,p in enumerate(axial)}
    neighbors=np.full((len(axial),12),-1,dtype=np.int32)
    for i,(q,r) in enumerate(axial):
        for j,(dq,dr) in enumerate(NEAR+FAR):
            neighbors[i,j]=index.get((q+dq,r+dr),-1)
    angles=np.array([math.atan2(dr*math.sqrt(3)/2,dq+dr/2) for dq,dr in NEAR+FAR])
    return dict(size=n,centers=centers,pitch=pitch,rows=rows,cols=cols,
                neighbors=neighbors,angles=angles)

def tag_corners(corner):
    x,y=TAG_CENTERS[corner]; a=TAG_SIZE/2
    return np.array(((x-a,y-a),(x+a,y-a),(x+a,y+a),(x-a,y+a)),dtype=np.float32)

def tag_id(version,kind,corner):
    return version*16+KINDS[kind]*4+corner
