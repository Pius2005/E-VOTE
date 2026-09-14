const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const prisma = require("../lib/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { logAction } = require("../services/audit.service");
const { normalizeImageBuffer } = require("../services/upload.service");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    const err = new Error("Only image uploads are accepted");
    err.status = 415;
    cb(err);
  },
});

// Accepts the raw upload, validates it's a genuinely decodable image, and
// re-encodes it to a normalized JPEG — rejects anything that merely wore
// an image content-type. Returns the public URL path, or null if no file
// was attached.
async function processPhotoUpload(req) {
  if (!req.file) return null;
  const bytes = await normalizeImageBuffer(req.file.buffer);
  return {
    id: crypto.randomUUID(),
    contentType: "image/jpeg",
    bytes,
    byteLength: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

router.use(requireAuth, requireRole("ADMIN", "ELECTION_OFFICER"));

// --- Positions ---
router.post("/elections/:electionId/positions", async (req, res) => {
  const { title, description, displayOrder, required } = req.body || {};
  if (!title) return res.status(400).json({ error: "title is required" });
  const position = await prisma.position.create({
    data: {
      electionId: req.params.electionId,
      title,
      description,
      displayOrder: displayOrder ?? 0,
      required: required !== false,
    },
  });
  await logAction({ actorId: req.user.id, action: "POSITION_CREATED", entity: "Position", entityId: position.id });
  res.status(201).json({ position });
});

router.patch("/positions/:id", async (req, res) => {
  const { title, description, displayOrder, required, status } = req.body || {};
  const position = await prisma.position.update({
    where: { id: req.params.id },
    data: {
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(displayOrder !== undefined && { displayOrder }),
      ...(required !== undefined && { required }),
      ...(status !== undefined && { status }),
    },
  });
  await logAction({ actorId: req.user.id, action: "POSITION_UPDATED", entity: "Position", entityId: position.id });
  res.json({ position });
});

// --- Candidates ---
router.post("/elections/:electionId/candidates", upload.single("photo"), async (req, res) => {
  const { positionId, studentId, fullName, slogan, manifesto, statement, candidateInfo, level, course, displayOrder } = req.body || {};
  if (!positionId || !fullName) return res.status(400).json({ error: "positionId and fullName are required" });

  const election = await prisma.election.findUnique({ where: { id: req.params.electionId } });
  if (!election) return res.status(404).json({ error: "Election not found" });
  if (["ACTIVE", "CLOSED", "RESULTS_PUBLISHED"].includes(election.status)) {
    return res.status(409).json({ error: "Candidates cannot be added once voting has started" });
  }

  const position = await prisma.position.findFirst({ where: { id: positionId, electionId: req.params.electionId } });
  if (!position) return res.status(400).json({ error: "Position does not belong to this election" });

  let media = null;
  try {
    media = await processPhotoUpload(req);
  } catch (err) {
    return res.status(400).json({ error: "Uploaded photo could not be processed — it may not be a valid image" });
  }

  const normalizedStatement = (statement ?? slogan ?? "")?.trim() || null;
  const normalizedInfo = (candidateInfo ?? manifesto ?? "")?.trim() || null;
  const normalizedLevel = (level ?? "")?.trim() || null;
  const normalizedCourse = (course ?? "")?.trim() || null;

  const candidate = await prisma.$transaction(async (tx) => {
    if (media) await tx.mediaAsset.create({ data: media });
    return tx.candidate.create({
      data: {
        electionId: req.params.electionId,
        positionId,
        studentId: studentId || null,
        fullName,
        slogan: normalizedStatement,
        manifesto: normalizedInfo,
        statement: normalizedStatement,
        candidateInfo: normalizedInfo,
        level: normalizedLevel,
        course: normalizedCourse,
        displayOrder: displayOrder ? Number(displayOrder) : 0,
        mediaAssetId: media?.id || null,
        profilePhotoUrl: media ? `/api/media/${media.id}` : null,
      },
    });
  });
  await logAction({ actorId: req.user.id, action: "CANDIDATE_CREATED", entity: "Candidate", entityId: candidate.id });
  res.status(201).json({ candidate });
});

router.patch("/candidates/:id", upload.single("photo"), async (req, res) => {
  const existing = await prisma.candidate.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Candidate not found" });

  const election = await prisma.election.findUnique({ where: { id: existing.electionId } });
  const votingStarted = ["ACTIVE", "PAUSED", "CLOSED", "RESULTS_PUBLISHED"].includes(election.status);
  const { slogan, manifesto, statement, candidateInfo, level, course, status, displayOrder } = req.body || {};

  if (votingStarted && (req.body.fullName || req.body.positionId)) {
    return res.status(409).json({ error: "Name/position cannot change once voting has started" });
  }

  let media;
  if (req.file) {
    try {
      media = await processPhotoUpload(req);
    } catch (err) {
      return res.status(400).json({ error: "Uploaded photo could not be processed — it may not be a valid image" });
    }
  }

  if (!votingStarted && req.body.positionId) {
    const position = await prisma.position.findFirst({ where: { id: req.body.positionId, electionId: existing.electionId } });
    if (!position) return res.status(400).json({ error: "Position does not belong to this election" });
  }

  const normalizedStatement = statement !== undefined ? (statement?.trim() || null) : slogan !== undefined ? (slogan?.trim() || null) : undefined;
  const normalizedInfo = candidateInfo !== undefined ? (candidateInfo?.trim() || null) : manifesto !== undefined ? (manifesto?.trim() || null) : undefined;
  const normalizedLevel = level !== undefined ? (level?.trim() || null) : undefined;
  const normalizedCourse = course !== undefined ? (course?.trim() || null) : undefined;

  const candidate = await prisma.$transaction(async (tx) => {
    if (media) await tx.mediaAsset.create({ data: media });
    const updated = await tx.candidate.update({
      where: { id: req.params.id },
      data: {
        ...(!votingStarted && req.body.fullName && { fullName: req.body.fullName }),
        ...(!votingStarted && req.body.positionId && { positionId: req.body.positionId }),
        ...(normalizedStatement !== undefined && { slogan: normalizedStatement, statement: normalizedStatement }),
        ...(normalizedInfo !== undefined && { manifesto: normalizedInfo, candidateInfo: normalizedInfo }),
        ...(normalizedLevel !== undefined && { level: normalizedLevel }),
        ...(normalizedCourse !== undefined && { course: normalizedCourse }),
        ...(status !== undefined && { status }),
        ...(displayOrder !== undefined && { displayOrder: Number(displayOrder) }),
        ...(media && { mediaAssetId: media.id, profilePhotoUrl: `/api/media/${media.id}` }),
      },
    });
    if (media && existing.mediaAssetId) await tx.mediaAsset.delete({ where: { id: existing.mediaAssetId } });
    return updated;
  });

  await logAction({
    actorId: req.user.id,
    action: votingStarted ? "CANDIDATE_UPDATED_DURING_VOTING" : "CANDIDATE_UPDATED",
    entity: "Candidate",
    entityId: candidate.id,
  });
  res.json({ candidate });
});

// Disqualification is a dedicated, audited action distinct from a generic
// status edit — requires a reason and records who disqualified the
// candidate and when.
router.post("/candidates/:id/disqualify", async (req, res) => {
  const { reason } = req.body || {};
  if (!reason || reason.trim().length < 5) {
    return res.status(400).json({ error: "A disqualification reason of at least 5 characters is required" });
  }
  const existing = await prisma.candidate.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Candidate not found" });
  if (existing.status === "DISQUALIFIED") return res.status(409).json({ error: "Candidate is already disqualified" });

  const candidate = await prisma.candidate.update({
    where: { id: req.params.id },
    data: {
      status: "DISQUALIFIED",
      disqualifiedReason: reason.trim(),
      disqualifiedAt: new Date(),
      disqualifiedById: req.user.id,
    },
  });
  await logAction({
    actorId: req.user.id,
    action: "CANDIDATE_DISQUALIFIED",
    entity: "Candidate",
    entityId: candidate.id,
    metadata: { reason: reason.trim() },
  });
  res.json({ candidate });
});

router.post("/candidates/:id/reinstate", async (req, res) => {
  const existing = await prisma.candidate.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Candidate not found" });
  if (existing.status !== "DISQUALIFIED") return res.status(409).json({ error: "Candidate is not disqualified" });

  const candidate = await prisma.candidate.update({
    where: { id: req.params.id },
    data: { status: "ACTIVE", disqualifiedReason: null, disqualifiedAt: null, disqualifiedById: null },
  });
  await logAction({ actorId: req.user.id, action: "CANDIDATE_REINSTATED", entity: "Candidate", entityId: candidate.id });
  res.json({ candidate });
});

module.exports = router;
