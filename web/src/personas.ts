import { ApiError, login, register, setKyc, verifyOtp, cashIn, type Persona, type Tier } from "./api";
import { newIdempotencyKey } from "./format";

export interface PersonaSpec {
  displayName: string;
  mobile: string;
  mpin: string;
  tier: Tier;
  startingBalanceCentavos?: number;
}

export const PRESETS: readonly (PersonaSpec & { label: string })[] = [
  { label: "Juan Dela Cruz", displayName: "Juan Dela Cruz", mobile: "+639171234567", mpin: "1234", tier: "FULLY_VERIFIED" },
  { label: "Maria Santos", displayName: "Maria Santos", mobile: "+639181234567", mpin: "1234", tier: "BASIC" },
  { label: "Aling Nena's Sari-Sari Store", displayName: "Aling Nena's Sari-Sari Store", mobile: "+639191234567", mpin: "1234", tier: "FULLY_VERIFIED" },
];

/**
 * register -> verify-otp (dev_otp) -> kyc, falling back to login when the mobile exists (409).
 * KYC changes the tier claim, so a Fully Verified persona logs in once more for a fresh JWT.
 */
export async function createPersona(spec: PersonaSpec): Promise<Persona> {
  let auth;
  try {
    const { devOtp } = await register(spec.mobile, spec.displayName);
    if (!devOtp) throw new ApiError("NO_DEV_OTP", 0, "Register response had no dev_otp (is ECASH_EXPOSE_OTP=true?)");
    auth = await verifyOtp(spec.mobile, devOtp, spec.mpin);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 409) throw e;
    auth = await login(spec.mobile, spec.mpin);
  }
  if (!auth.userId) throw new ApiError("NO_USER_ID", 0, "Could not determine user id from auth response");
  if (spec.tier === "FULLY_VERIFIED" && auth.tier !== "FULLY_VERIFIED") {
    await setKyc(auth.userId, "FULLY_VERIFIED");
    auth = await login(spec.mobile, spec.mpin);
  }
  if (spec.startingBalanceCentavos) {
    await cashIn(auth.token, newIdempotencyKey(), "INSTAPAY", spec.startingBalanceCentavos);
  }
  return {
    userId: auth.userId,
    mobile: spec.mobile,
    displayName: auth.displayName || spec.displayName,
    tier: spec.tier === "FULLY_VERIFIED" ? "FULLY_VERIFIED" : auth.tier,
    token: auth.token,
    mpin: spec.mpin,
  };
}
