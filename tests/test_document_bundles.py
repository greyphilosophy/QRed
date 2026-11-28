"""Collect appended document pieces through the real mobile camera worker."""
import json
import subprocess
from pathlib import Path

import pytest
from playwright.sync_api import expect
from browser_helpers import start_camera
from browser_helpers import BASE_URL, OfflineNetworkGuard, wait_for_offline_resources
from test_photo_verification import PUBLIC_KEY, prepare_reader

ROOT = Path(__file__).resolve().parents[1]

@pytest.fixture(scope="module")
def document_bundle():
    source = r"""
      import { createServer } from 'vite';
      import { PNG } from 'pngjs';
      const server = await createServer({ logLevel: 'error', server: { middlewareMode: true } });
      const { createQRedSeals } = await server.ssrLoadModule('/src/qredSealer.js');
      const { createDocumentBundle } = await server.ssrLoadModule('/src/documentBundle.js');
      const { createQRedQrSymbol } = await server.ssrLoadModule('/src/qredQr.js');
      let seed = 1234567;
      const common = Array.from({length:5000},()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return String.fromCharCode(33+((seed>>>0)%90));}).join('');
      const records=[];
      for(let pageNumber=1;pageNumber<=6;pageNumber++) records.push(await createQRedSeals({
        content:'Fictional page '+pageNumber+'\n'+common, timestamp:'2026-01-01T00:00:00.000Z',
        pageContext:{pageNumber,pageCount:6,documentRoot:'ab'.repeat(32)},
        privateKey:'txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes',
        publicKey:'eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q'}));
      const bundle=await createDocumentBundle(records), images=[];
      for(const seal of bundle.seals){
        const {modules}=createQRedQrSymbol(seal), size=(modules.size+8)*6;
        const image=new PNG({width:size,height:size});image.data.fill(255);
        for(let y=0;y<size;y++)for(let x=0;x<size;x++){
          const row=Math.floor(y/6)-4,col=Math.floor(x/6)-4;
          if(row>=0&&col>=0&&row<modules.size&&col<modules.size&&modules.get(row,col)){
            const at=(y*size+x)*4;image.data[at]=image.data[at+1]=image.data[at+2]=0;
          }
        }
        images.push(PNG.sync.write(image).toString('base64'));
      }
      console.log(JSON.stringify({seals:bundle.seals,images}));await server.close();
    """
    result = subprocess.run(["node", "--input-type=module", "-e", source], cwd=ROOT / "frontend",
                            text=True, capture_output=True, check=True)
    data = json.loads(result.stdout)
    assert 1 < len(data["seals"]) <= 6
    return data


def show_closeup(page, image):
    # A QR and its quiet zone, without a sheet outline. Browser workers receive
    # actual camera pixels; no synthetic worker result or verification hook.
    page.evaluate("""async source => {
      const image=new Image(); image.src=source; await image.decode();
      if(!window.bundleCamera){
        const frame=document.createElement('canvas');
        window.bundleCamera={frame,tracks:[],image};
        navigator.mediaDevices.getUserMedia=async()=>{
          const stream=frame.captureStream(15); bundleCamera.tracks.push(...stream.getTracks());return stream;
        };
        navigator.mediaDevices.enumerateDevices=async()=>[];
        setInterval(()=>frame.getContext('2d').drawImage(bundleCamera.image,0,0,frame.width,frame.height),100);
      }
      bundleCamera.image=image;bundleCamera.frame.width=image.width;bundleCamera.frame.height=image.height;
      bundleCamera.frame.getContext('2d').drawImage(image,0,0);
    }""", "data:image/png;base64," + image)


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
def test_individual_document_seals_collect_offline_then_request_originals(browser, document_bundle, path, tmp_path):
    context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True,
                                  has_touch=True, service_workers="allow")
    try:
        guard = OfflineNetworkGuard(context)
        context.route("**/api/keys/default", lambda route: route.fulfill(json={"public_key": PUBLIC_KEY}))
        page = context.new_page()
        page.goto(BASE_URL + path, wait_until="networkidle")
        if path != "/":
            page.locator("#publicKeyFileInput").set_input_files({"name":"key.txt","mimeType":"text/plain","buffer":PUBLIC_KEY.encode()})
        prepare_reader(page)
        wait_for_offline_resources(page, photo=True)
        guard.block()
        show_closeup(page, document_bundle["images"][-1])
        start_camera(page)
        page.get_by_role("combobox", name="Scan target").select_option("seal")
        expect(page.locator(".page-scan-guide")).not_to_be_visible()
        count = len(document_bundle["seals"])
        progress = page.locator(".ar-collection-progress, #statusText")
        expect(progress).to_contain_text(f"1 of {count} document seals collected", timeout=30000)
        expect(page.locator(".page-check-list button, .page-check-list option")).to_have_count(0)
        page.screenshot(path=str(tmp_path / "individual-seal-mobile.png"))
        for collected, image in enumerate(reversed(document_bundle["images"][:-1]), start=2):
            show_closeup(page, image)
            if collected < count:
                expect(progress).to_contain_text(f"{collected} of {count} document seals collected", timeout=30000)
        # More than five original pages use the compact page selector.
        pages = page.get_by_role("combobox", name="Choose a page to review")
        expect(pages.locator("option")).to_have_count(6, timeout=30000)
        expect(page.get_by_role("button", name="Photograph original page 1", exact=True)).to_be_visible()
        assert page.evaluate("bundleCamera.tracks.every(track=>track.readyState==='ended')")
        # No seal-sheet crop is used as an original page photograph.
        expect(page.locator(".photo-stage img")).to_have_count(0)
        guard.assert_quiet()
    finally:
        context.close()
