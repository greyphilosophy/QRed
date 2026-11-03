"""Pixels-only experimental optical reader; no renderer manifest or ground truth.

Registration tags carry only public layout metadata. Center and oriented stroke
measurements use local paper normalization, with opaque document ink erased.
An arm measures the logical AND of its two endpoint bits, not the target alone.
"""
import argparse
import json
import math
from pathlib import Path
import cv2
import numpy as np
from PIL import Image,ImageOps
from layout import PAGE,TAG_CENTERS,TAG_SIZE,KINDS,geometry,tag_corners

def register(photo):
    rgb=np.array(ImageOps.exif_transpose(Image.open(photo)).convert("RGB"))
    gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
    params=cv2.aruco.DetectorParameters()
    params.cornerRefinementMethod=cv2.aruco.CORNER_REFINE_SUBPIX
    params.minMarkerPerimeterRate=.015
    detector=cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_5X5_1000),params)
    corners,ids,_=detector.detectMarkers(gray)
    if ids is None:raise ValueError("No registration tags")
    groups={}
    for c,i in zip(corners,ids.ravel()):
        version=int(i)//16;kind=(int(i)%16)//4;corner=int(i)%4
        if 1<=version<=40:groups.setdefault((version,kind),{})[corner]=c.reshape(4,2)
    if not groups:raise ValueError("No recognized geometry header")
    (version,kindid),group=max(groups.items(),key=lambda p:len(p[1]))
    if len(group)<3:raise ValueError("Fewer than three consistent registration tags")
    source=np.concatenate([group[i] for i in group]);dest=np.concatenate([tag_corners(i) for i in group])
    h,inliers=cv2.findHomography(source,dest,cv2.RANSAC,.65)
    if h is None or np.count_nonzero(inliers)<10:raise ValueError("Inconsistent registration geometry")
    # Fixed physical scale, independent of camera/simulator configuration.
    scale=4
    warp=cv2.warpPerspective(rgb,np.diag([scale,scale,1])@h,(PAGE[0]*scale,PAGE[1]*scale),
                             flags=cv2.INTER_LINEAR,borderValue=(255,255,255))
    return warp,version,next(k for k,v in KINDS.items() if v==kindid),scale,len(group)

def normalized_ink(rgb,pitch,scale):
    # Normalize each channel before averaging so moderate lighting tint cancels.
    smooth=cv2.GaussianBlur(rgb.astype(np.float32),(0,0),.65)
    kernel=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(int(pitch*scale*1.4)//2*2+1,)*2)
    paper=cv2.dilate(smooth,kernel)
    paper=cv2.GaussianBlur(paper,(0,0),pitch*scale*.5)
    ink=255*(1-np.mean(smooth/np.maximum(paper,1),axis=2))
    # The carrier is pale (85% gray or lighter). Treat substantially darker ink,
    # including antialiased table rules, as an occlusion rather than a bit.
    opaque=(ink>60).astype(np.uint8)
    # Registration markers and their quiet zones are deliberate erasures.
    for x,y in TAG_CENTERS:
        a=TAG_SIZE/2+3.5
        opaque[int((y-a)*scale):int((y+a)*scale)+1,int((x-a)*scale):int((x+a)*scale)+1]=1
    opaque=cv2.dilate(opaque,np.ones((3,3),np.uint8))
    return ink,opaque

def measure(ink,opaque,points,scale):
    shape=points.shape[:-1]
    x=(points[...,0]*scale).astype(np.float32).reshape(points.shape[0],-1)
    y=(points[...,1]*scale).astype(np.float32).reshape(points.shape[0],-1)
    values=cv2.remap(ink,x,y,cv2.INTER_LINEAR).reshape(shape)
    blocked=cv2.remap(opaque,x,y,cv2.INTER_NEAREST,borderMode=cv2.BORDER_CONSTANT,borderValue=1).reshape(shape)>0
    return values,blocked

def decode(photo,rectified=None):
    rgb,version,kind,scale,tags=register(photo)
    if rectified:Image.fromarray(rgb).save(rectified)
    g=geometry(version,kind);p=g["pitch"];centers=g["centers"];n=g["size"]
    ink,opaque=normalized_ink(rgb,p,scale)
    if kind=="rect":
        offsets=np.array([(x*g["dx"],y*g["dy"]) for y in (-.3,-.15,0,.15,.3) for x in (-.3,-.15,0,.15,.3)])
    else:
        offsets=np.array([(0,0)]+[(math.cos(a)*r*p,math.sin(a)*r*p) for r in (.045,.085) for a in np.arange(8)*math.pi/4])
    values,blocked=measure(ink,opaque,centers[:,None,:]+offsets[None,:,:],scale)
    clean=np.where(blocked,np.nan,values)
    with np.errstate(all="ignore"):
        # Partial text coverage must not discard the entire rectangular module.
        count=np.sum(~blocked,axis=1)
        center=np.nansum(clean,axis=1)/np.maximum(count,1)
    valid=count>=max(3,len(offsets)*.35)
    if kind!="rect":
        # The gaps halfway between the twelve possible spokes estimate the
        # local substrate, including shaded table bands. A hub must stand out
        # from its own surroundings, not merely be darker than page white.
        gap_angles=(np.arange(12)+.5)*math.pi/6
        ring=np.stack((np.cos(gap_angles),np.sin(gap_angles)),axis=1)*p*.49
        surrounding,covered=measure(ink,opaque,centers[:,None,:]+ring[None,:,:],scale)
        available=np.sum(~covered,axis=1)
        sorted_ring=np.sort(np.where(covered,np.inf,surrounding),axis=1)
        background=sorted_ring[np.arange(len(centers)),np.maximum(0,(available*.25).astype(int)-1)]
        background[available==0]=0
        center-=background
        valid&=available>=3
    low,high=np.percentile(center[valid],(20,80))
    if high-low<5:raise ValueError("No separable watermark contrast")
    llr=np.clip((center-(high+low)/2)*8/(high-low),-8,8)
    llr[~valid]=0
    candidates=[("centers",llr)]
    arm_info={}
    if kind in ("hex6","hex12"):
        arms=6 if kind=="hex6" else 12
        angles=g["angles"][:arms]
        directions=np.stack((np.cos(angles),np.sin(angles)),axis=1)
        normals=np.stack((-np.sin(angles),np.cos(angles)),axis=1)
        distances=np.array([(.32,.37,.42) if j<6 else (.38,.43,.48) for j in range(arms)])
        positions=centers[:,None,None,:]+p*directions[None,:,None,:]*distances[None,:,:,None]
        on,on_block=measure(ink,opaque,positions,scale)
        left,left_block=measure(ink,opaque,positions+normals[None,:,None,:]*p*.105,scale)
        right,right_block=measure(ink,opaque,positions-normals[None,:,None,:]*p*.105,scale)
        arm_valid=~(on_block|left_block|right_block).any(axis=2)
        contrast=np.mean(on-(left+right)/2,axis=2)
        neighbor=g["neighbors"][:,:arms]
        inside=neighbor>=0
        # Calibrate from confident center observations, never expected bits.
        safe=arm_valid&inside&valid[:,None]&valid[np.maximum(neighbor,0)]
        confident_on=safe&(llr[:,None]>2)&(llr[np.maximum(neighbor,0)]>2)
        confident_off=safe&((llr[:,None]<-2)|(llr[np.maximum(neighbor,0)]<-2))
        off=float(np.median(contrast[confident_off])) if np.any(confident_off) else 0
        on_level=float(np.median(contrast[confident_on])) if np.any(confident_on) else high-low
        arm_info={"off":off,"on":on_level,"valid_fraction":float(arm_valid.mean())}
        if on_level-off>3:
            edge=np.clip((contrast-(on_level+off)/2)*5/(on_level-off),-5,5)
            edge[~(arm_valid&inside)]=0
            # Conservative, single-pass conditional votes. Missing/occluded
            # strokes are unknown, and absent strokes need a black source.
            fused=llr.copy();incoming=np.zeros_like(llr);weights=np.zeros_like(llr)
            for j in range(arms):
                eligible=inside[:,j]&arm_valid[:,j]&(llr>2)
                target=neighbor[eligible,j]
                w=np.clip(llr[eligible]/4,0,1)
                np.add.at(incoming,target,edge[eligible,j]*w)
                np.add.at(weights,target,w)
            # Cap evidence from correlated neighboring observations.
            fused+=incoming*np.minimum(1,3/np.maximum(weights,1))*.7
            positive=np.max(np.where(arm_valid,edge,0),axis=1)
            fused+=np.maximum(positive-1,0)*.6
            candidates.append(("neighbors",fused))
    output=[]
    for name,score in candidates:
        for erasure in (1.0,2.0):
            output.append(dict(reader=name,erasure=erasure,version=version,kind=kind,
                bits=(score[:n*n]>0).astype(int).tolist(),
                unknown=(np.abs(score[:n*n])<erasure).astype(int).tolist(),
                risk=np.clip(255-np.abs(score[:n*n])*32,0,255).astype(int).tolist()))
    return {"version":version,"kind":kind,"tags":tags,"center_low":float(low),"center_high":float(high),
            "center_valid_fraction":float(valid.mean()),"arm":arm_info,"candidates":output}

if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("photo",type=Path);p.add_argument("output",type=Path)
    p.add_argument("--rectified",type=Path);args=p.parse_args()
    result=decode(args.photo,args.rectified);args.output.write_text(json.dumps(result)+"\n")
    print(json.dumps({k:v for k,v in result.items() if k!="candidates"},indent=2))
