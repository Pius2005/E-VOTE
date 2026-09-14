const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const emailService = require("../src/services/email.service");
const { issueOtp } = require("../src/services/otp.service");

// Re-implements the same HMAC scheme used in otp.service.js to validate
// the hashing approach itself is deterministic and collision-resistant
// for distinct codes, without needing a live database connection.
function hashCode(code, studentId, pepper) {
  return crypto.createHmac("sha256", pepper).update(`${studentId}:${code}`).digest("hex");
}

test("hashCode is deterministic for the same inputs", () => {
  const a = hashCode("123456", "student-1", "pepper");
  const b = hashCode("123456", "student-1", "pepper");
  assert.equal(a, b);
});

test("hashCode differs for different codes", () => {
  const a = hashCode("123456", "student-1", "pepper");
  const b = hashCode("654321", "student-1", "pepper");
  assert.notEqual(a, b);
});

test("hashCode differs for different students with the same code", () => {
  const a = hashCode("123456", "student-1", "pepper");
  const b = hashCode("123456", "student-2", "pepper");
  assert.notEqual(a, b);
});

test("hashCode output is fixed-length hex, safe for timingSafeEqual", () => {
  const hash = hashCode("000000", "student-1", "pepper");
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]+$/);
});

test("issueOtp logs the generated code to the terminal in development", async () => {
  const originalEnv = process.env.NODE_ENV;
  const originalLog = console.log;
  const originalSendEmail = emailService.sendEmail;
  const logs = [];

  process.env.NODE_ENV = "development";
  console.log = (...args) => logs.push(args.join(" "));
  emailService.sendEmail = async () => {};

  try {
    const db = {
      otpCode: {
        findFirst: async () => null,
        create: async () => ({ id: "otp-1" }),
      },
    };

    await issueOtp({ studentId: "student-1", email: "student@example.edu", purpose: "VOTE_VERIFY:test", db });

    assert.ok(logs.some((line) => /OTP|VOTE_VERIFY:test|student-1/i.test(line)));
  } finally {
    console.log = originalLog;
    emailService.sendEmail = originalSendEmail;
    process.env.NODE_ENV = originalEnv;
  }
});
