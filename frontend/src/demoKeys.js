// Deliberately public test credentials, already used by QRed's demo fixtures.
// Anyone can sign with this seed; it must never establish a real issuer identity.
// The public key matches the Worker's built-in default (covered by a contract test).
export const DEMO_SIGNING_KEYS = Object.freeze({
  privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes",
  publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q",
});
