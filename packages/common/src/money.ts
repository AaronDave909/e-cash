import { z } from "zod";

/** Integer centavos. 1 peso = 100 centavos. Safe below 2^53. */
export type Centavos = number & { readonly __brand: "Centavos" };

export function toCentavos(n: number): Centavos {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`not a valid centavo amount: ${n}`);
  return n as Centavos;
}

/** Request amounts: strictly positive safe integers. */
export const amountCentavosSchema = z
  .number({ invalid_type_error: "amount_centavos must be an integer number of centavos" })
  .int("amount_centavos must be an integer number of centavos")
  .positive("amount_centavos must be greater than zero")
  .max(Number.MAX_SAFE_INTEGER)
  .transform((n) => n as Centavos);

export function formatPhp(c: number): string {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  const pesos = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, "0");
  return `${sign}₱${pesos.toLocaleString("en-US")}.${cents}`;
}
