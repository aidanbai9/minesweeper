export const ROOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const ROOM_CODE_RE = /^[a-z2-9]{8,16}$/;

export function isValidRoomCode(code) {
  return ROOM_CODE_RE.test(String(code));
}

export function generateRoomCode(length = 10, cryptoObj = globalThis.crypto) {
  const bytes = new Uint8Array(length);
  cryptoObj.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) {
    code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
  }
  return code;
}
