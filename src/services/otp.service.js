const crypto = require("crypto");
const prisma = require("../lib/prisma");
const env = require("../lib/env");
const { sendEmail } = require("./email.service");
const { emailLayout } = require("./emailTemplate.service");

const OTP_TTL_SECONDS = 5 * 60;
const RESEND_COOLDOWN_SECONDS = 30;
const MAX_ATTEMPTS = 3;

function generateCode() {
  // Cryptographically secure 6-digit code, zero-padded.
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, "0");
}

function hashCode(code, studentId) {
  return crypto
    .createHmac("sha256", env.OTP_PEPPER)
    .update(`${studentId}:${code}`)
    .digest("hex");
}

/**
 * Issues a new OTP for a student + purpose, invalidating any prior
 * unconsumed OTP for that purpose, and emails the code. Enforces a resend
 * cooldown. The plaintext code is never persisted or returned to the caller
 * beyond this function (it is only used to compose the outgoing email).
 */
async function issueOtp({ studentId, email, purpose, db = prisma }) {
  const recent = await db.otpCode.findFirst({
    where: { studentId, purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (recent) {
    const secondsSinceIssue = (Date.now() - recent.createdAt.getTime()) / 1000;
    if (secondsSinceIssue < RESEND_COOLDOWN_SECONDS) {
      const wait = Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceIssue);
      const err = new Error(`Please wait ${wait}s before requesting a new code`);
      err.code = "OTP_COOLDOWN";
      err.retryAfterSeconds = wait;
      throw err;
    }
    // Invalidate the prior code — only one active OTP per purpose at a time.
    await db.otpCode.update({
      where: { id: recent.id },
      data: { consumedAt: new Date() },
    });
  }

  const code = generateCode();
  const codeHash = hashCode(code, studentId);
  const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000);

  await db.otpCode.create({
    data: { studentId, purpose, codeHash, expiresAt, maxAttempts: MAX_ATTEMPTS },
  });

  if (env.NODE_ENV !== "production") {
    console.info(`[OTP TEST] purpose=${purpose} studentId=${studentId} code=${code}`);
  }

  await sendEmail({
    to: email,
    subject: "Your SUG VOTE verification code",
    text: `Your verification code is ${code}. It expires in ${OTP_TTL_SECONDS} seconds. Do not share this code with anyone.`,
    html: emailLayout({
      heading: "Verify your email",
      bodyHtml: `
        <p style="color:#1c2422;font-size:14px;">Enter this code to continue:</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0b3d2e;background:#f6f5f1;border-radius:10px;padding:16px;text-align:center;margin:16px 0;">${code}</div>
        <p style="color:#6b7570;font-size:13px;">Expires in ${OTP_TTL_SECONDS} seconds. Never share this code with anyone — SUG VOTE staff will never ask for it.</p>
      `,
    }),
  });

  return { expiresInSeconds: OTP_TTL_SECONDS, resendCooldownSeconds: RESEND_COOLDOWN_SECONDS };
}

/**
 * Verifies a submitted OTP. Returns { ok: true } on success, or
 * { ok: false, reason } on failure. Never leaks the correct code.
 */
async function verifyOtp({ studentId, purpose, code, db = prisma }) {
  const record = await db.otpCode.findFirst({
    where: { studentId, purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!record) return { ok: false, reason: "NO_ACTIVE_CODE" };
  if (record.expiresAt.getTime() < Date.now()) return { ok: false, reason: "EXPIRED" };
  if (record.attempts >= record.maxAttempts) return { ok: false, reason: "TOO_MANY_ATTEMPTS" };

  const submittedHash = hashCode(code, studentId);
  const match =
    submittedHash.length === record.codeHash.length &&
    crypto.timingSafeEqual(Buffer.from(submittedHash), Buffer.from(record.codeHash));

  if (!match) {
    await db.otpCode.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    const attemptsLeft = record.maxAttempts - (record.attempts + 1);
    return { ok: false, reason: "INCORRECT", attemptsLeft: Math.max(attemptsLeft, 0) };
  }

  const consumed = await db.otpCode.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return consumed.count === 1 ? { ok: true } : { ok: false, reason: "ALREADY_USED" };
}

module.exports = { issueOtp, verifyOtp, OTP_TTL_SECONDS, RESEND_COOLDOWN_SECONDS };
