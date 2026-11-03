"""Render actual signed QR bits as rects, dots, or conditional hex spokes."""
import argparse
import io
import json
import math
from pathlib import Path
import cv2
import numpy as np
from pypdf import PdfReader,PdfWriter
from reportlab.pdfgen.canvas import Canvas
from layout import PAGE,BOX,TAG_CENTERS,TAG_SIZE,geometry,tag_id

def render(doc,source,output,kind,gray=.85,width=.11,dot=.12):
    g=geometry(doc["version"],kind)
    bits=np.zeros(len(g["centers"]),dtype=np.uint8)
    bits[:len(doc["bits"])]=doc["bits"]
    buf=io.BytesIO(); c=Canvas(buf,pagesize=PAGE,pageCompression=1,invariant=1)
    c.setBlendMode("Multiply"); c.setFillGray(gray); c.setStrokeGray(gray)
    c.setLineCap(1); c.setLineWidth(width*g["pitch"])
    path=c.beginPath()
    for i,((x,y),bit) in enumerate(zip(g["centers"],bits)):
        if not bit:continue
        if kind=="rect":
            path.rect(x-g["dx"]/2,PAGE[1]-y-g["dy"]/2,g["dx"],g["dy"])
            continue
        path.circle(x,PAGE[1]-y,dot*g["pitch"])
        for j in range(0 if kind=="dots" else 6 if kind=="hex6" else 12):
            target=g["neighbors"][i,j]
            if target<0 or not bits[target]:continue
            angle=g["angles"][j]
            # Round caps remain inside each hexagon, including at its sides.
            length=(.5 if j<6 else 1/math.sqrt(3))*.86*g["pitch"]
            # One nonzero-winding fill unions overlapping arms and dots.
            # Separate multiply-blended strokes would falsely darken junctions.
            dx,dy=math.cos(angle),-math.sin(angle);a=width*g["pitch"]/2
            nx,ny=-dy*a,dx*a;yy=PAGE[1]-y;xx2=x+length*dx;yy2=yy+length*dy
            path.moveTo(x-nx,yy-ny);path.lineTo(xx2-nx,yy2-ny)
            path.lineTo(xx2+nx,yy2+ny);path.lineTo(x+nx,yy+ny);path.close()
            path.circle(xx2,yy2,a)
    c.drawPath(path,stroke=0,fill=1,fillMode=1)
    # Optical registration, identical dimensions/ink for all four carriers.
    # IDs encode only public geometry (version, carrier and corner), no payload.
    c.setBlendMode("Normal")
    dictionary=cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_5X5_1000)
    for corner,(x,y) in enumerate(TAG_CENTERS):
        c.setFillGray(1); c.rect(x-TAG_SIZE/2-3,PAGE[1]-y-TAG_SIZE/2-3,TAG_SIZE+6,TAG_SIZE+6,stroke=0,fill=1)
        marker=cv2.aruco.generateImageMarker(dictionary,tag_id(doc["version"],kind,corner),7)
        c.setFillGray(0)
        for r in range(7):
            for col in range(7):
                if marker[r,col]==0:
                    c.rect(x-TAG_SIZE/2+col*TAG_SIZE/7,PAGE[1]-y+TAG_SIZE/2-(r+1)*TAG_SIZE/7,
                           TAG_SIZE/7,TAG_SIZE/7,stroke=0,fill=1)
    c.showPage();c.save(); buf.seek(0)
    page=PdfReader(source).pages[0];page.merge_page(PdfReader(buf).pages[0])
    writer=PdfWriter();writer.add_page(page)
    with open(output,"wb") as f:writer.write(f)
    return {"kind":kind,"gray":gray,"line_width_pitch":width,"dot_radius_pitch":dot,
            "version":doc["version"],"pitch_points":g["pitch"],"rows":g["rows"],"cols":g["cols"]}

if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("directory",type=Path)
    p.add_argument("--gray",type=float,default=.85);p.add_argument("--width",type=float,default=.11)
    p.add_argument("--kinds",nargs="+",choices=("rect","dots","hex6","hex12"),default=("rect","dots","hex6","hex12"))
    p.add_argument("--dot",type=float,default=.12);args=p.parse_args()
    manifest=json.loads((args.directory/"manifest.json").read_text());rendered=[]
    for doc in manifest["documents"]:
        for kind in args.kinds:
            name=f'{doc["name"]}-{kind}.pdf'
            row=render(doc,args.directory/doc["source"],args.directory/name,kind,args.gray,args.width,args.dot)
            rendered.append({"document":doc["name"],"file":name,**row})
    (args.directory/"rendered.json").write_text(json.dumps(rendered,indent=2)+"\n")
    print(json.dumps(rendered,indent=2))
