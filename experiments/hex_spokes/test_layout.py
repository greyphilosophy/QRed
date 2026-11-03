"""Invariants that matter to the proposed optical code, not snapshots."""
import math
import unittest
import numpy as np
from layout import BOX,KINDS,geometry,tag_id

class GeometryTests(unittest.TestCase):
    def test_twelve_neighbors_are_the_two_correct_distance_shells(self):
        for version in (1,13,24,40):
            g=geometry(version,"hex12");p=g["pitch"]
            self.assertGreaterEqual(len(g["centers"]),g["size"]**2)
            for j in range(12):
                neighbors=g["neighbors"][:,j];valid=neighbors>=0
                distances=np.linalg.norm(g["centers"][neighbors[valid]]-g["centers"][valid],axis=1)/p
                self.assertTrue(np.allclose(distances,1 if j<6 else math.sqrt(3)))
                reverse=(j+3)%6 if j<6 else (j-6+3)%6+6
                self.assertTrue(np.array_equal(g["neighbors"][neighbors[valid],reverse],np.flatnonzero(valid)))

    def test_glyphs_stay_inside_hexagons_and_page_margin(self):
        g=geometry(24,"hex12");p=g["pitch"]
        x,y,w,h=BOX
        self.assertGreaterEqual(g["centers"][:,0].min()-p/2,x-1e-8)
        self.assertLessEqual(g["centers"][:,0].max()+p/2,x+w+1e-8)
        self.assertGreaterEqual(g["centers"][:,1].min()-p/math.sqrt(3),y-1e-8)
        self.assertLessEqual(g["centers"][:,1].max()+p/math.sqrt(3),y+h+1e-8)
        for j,angle in enumerate(g["angles"]):
            length=(.5 if j<6 else 1/math.sqrt(3))*.86
            for normal in g["angles"][:6]:
                self.assertLess(length*math.cos(angle-normal)+.11/2,.5)

    def test_registration_ids_do_not_collide(self):
        ids=[tag_id(v,k,c) for v in range(1,41) for k in KINDS for c in range(4)]
        self.assertEqual(len(ids),len(set(ids)))
        self.assertLess(max(ids),1000)

if __name__=="__main__":unittest.main()
