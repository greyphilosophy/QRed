import { decodePhoto } from "./decodePhoto.js";

self.onmessage = ({ data: { image, returnPayload } }) => {
  try { self.postMessage({ action: decodePhoto(image, { returnPayload }) }); }
  catch (error) { self.postMessage({ error: error.message || "The photo could not be scanned." }); }
};
