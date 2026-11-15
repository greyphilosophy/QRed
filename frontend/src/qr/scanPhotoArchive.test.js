import { describe, expect, it } from "vitest";
import { downloadZip } from "client-zip";
import { isScanPhotoZip, readScanPhotoZip } from "./scanPhotoArchive.js";

function zip(entries) {
  return downloadZip(entries.map(([name, input]) => ({ name, input }))).blob();
}

describe("opening a saved scan", () => {
  it("recognizes ZIPs returned by a file provider with a generic type or name", () => {
    expect(isScanPhotoZip({ name: "QRed-scan-photo (2).ZIP", type: "application/octet-stream" })).toBe(true);
    expect(isScanPhotoZip({ name: "download", type: "application/zip" })).toBe(true);
    expect(isScanPhotoZip({ name: "exposure-01.jpg", type: "image/jpeg" })).toBe(false);
  });

  it("reads the first numbered exposure of an older archive regardless of entry order", async () => {
    const entries = [
      ["scan/exposure-03.bin", new Uint8Array([3, 0, 9])],
      ["__MACOSX/scan/._exposure-01.jpg", "metadata"],
      ["scan/exposure-02.PNG", new Uint8Array([2, 0, 8])],
      ["scan/exposure-01.jpg", new Uint8Array([1, 0, 7])],
    ];
    const photo = await readScanPhotoZip(await zip(entries));
    expect(photo.type).toBe("image/jpeg");
    expect([...new Uint8Array(await photo.arrayBuffer())]).toEqual([1, 0, 7]);
  });

  it.each([
    ["exposure-01.jpg", "image/jpeg"],
    ["exposure-01.bin", "application/octet-stream"],
    ["QRed-scan-photo (9).jpeg", "image/jpeg"],
  ])("opens a single original photo named %s", async (name, type) => {
    const photo = await readScanPhotoZip(await zip([[name, "original"]]));
    expect(photo.type).toBe(type);
    expect(await photo.text()).toBe("original");
  });

  it.each([
    [[]],
    [["page-1.jpg", "page-2.jpg"]],
    [["exposure-01.jpg", "exposure-03.jpg"]],
    [["exposure-01.jpg", "exposure-01.png"]],
    [["document.pdf"]],
  ])("rejects a ZIP without a single usable capture (%j)", async names => {
    const file = await zip(names.map(name => [name, "data"]));
    await expect(readScanPhotoZip(file)).rejects.toThrow("one numbered exposure stack");
  });

  it("reports invalid archives and respects cancellation", async () => {
    const file = new Blob(["invalid ZIP"]);
    await expect(readScanPhotoZip(file)).rejects.toThrow("This ZIP could not be opened");
    await expect(readScanPhotoZip(file, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  });
});
