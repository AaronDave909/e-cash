import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEYLEN = 64;

function derive(mpin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(mpin, salt, KEYLEN, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashMpin(mpin: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16);
  const key = await derive(mpin, salt);
  return { hash: key.toString("hex"), salt: salt.toString("hex") };
}

export async function verifyMpin(mpin: string, hash: string, salt: string): Promise<boolean> {
  const key = await derive(mpin, Buffer.from(salt, "hex"));
  const expected = Buffer.from(hash, "hex");
  return key.length === expected.length && timingSafeEqual(key, expected);
}
