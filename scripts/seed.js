// Development/testing seed script — NOT run in production.
// Safe to delete entirely; the application works with an empty database.
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const argon2 = require("argon2");

const prisma = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run seed script in production.");
    process.exit(1);
  }

  const adminPassword = await argon2.hash("AdminPass!2025", { type: argon2.argon2id });
  const admin = await prisma.student.upsert({
    where: { matricNumber: "ADMIN/0001" },
    update: {
      fullName: "System Admin",
      email: "admin@example.edu",
      passwordHash: adminPassword,
      role: "ADMIN",
      accountStatus: "ACTIVE",
    },
    create: {
      fullName: "System Admin",
      matricNumber: "ADMIN/0001",
      email: "admin@example.edu",
      passwordHash: adminPassword,
      role: "ADMIN",
    },
  });

  const officerPassword = await argon2.hash("OfficerPass!2025", { type: argon2.argon2id });
  const officer = await prisma.student.upsert({
    where: { matricNumber: "EO/0001" },
    update: {
      fullName: "Electoral Officer",
      email: "electoral.officer@example.edu",
      passwordHash: officerPassword,
      role: "ELECTION_OFFICER",
      accountStatus: "ACTIVE",
    },
    create: {
      fullName: "Electoral Officer",
      matricNumber: "EO/0001",
      email: "electoral.officer@example.edu",
      passwordHash: officerPassword,
      role: "ELECTION_OFFICER",
    },
  });

  const studentPassword = await argon2.hash("Passw0rd!23", { type: argon2.argon2id });
  const students = [];
  for (let i = 1; i <= 5; i++) {
    const s = await prisma.student.upsert({
      where: { matricNumber: `CSC/20/000${i}` },
      update: {
        fullName: `Sample Student ${i}`,
        email: `student${i}@example.edu`,
        department: "Computer Science",
        level: "300",
        passwordHash: studentPassword,
        role: "STUDENT",
        accountStatus: "ACTIVE",
      },
      create: {
        fullName: `Sample Student ${i}`,
        matricNumber: `CSC/20/000${i}`,
        email: `student${i}@example.edu`,
        department: "Computer Science",
        level: "300",
        passwordHash: studentPassword,
        role: "STUDENT",
      },
    });
    students.push(s);
  }

  const election = await prisma.election.upsert({
    where: { id: "seed-election-2026" },
    update: {},
    create: {
      id: "seed-election-2026",
      title: "SUG General Election 2026",
      description: "Sample development election — safe to delete.",
      academicSession: "2025/2026",
      startDate: new Date(Date.now() - 60 * 60 * 1000),
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      status: "ACTIVE",
      createdBy: admin.id,
    },
  });

  const president = await prisma.position.create({
    data: { electionId: election.id, title: "President", displayOrder: 1, required: true },
  });

  await prisma.candidate.createMany({
    data: [
      { electionId: election.id, positionId: president.id, fullName: "Candidate A", slogan: "Progress. Unity. Service.", displayOrder: 1 },
      { electionId: election.id, positionId: president.id, fullName: "Candidate B", slogan: "Students First.", displayOrder: 2 },
    ],
  });

  await prisma.electionEligibility.createMany({
    data: students.map((s) => ({ electionId: election.id, studentId: s.id })),
    skipDuplicates: true,
  });

  console.log("Seed complete.");
  console.log("Admin login: ADMIN/0001 / AdminPass!2025");
  console.log("Electoral Officer login: EO/0001 / OfficerPass!2025");
  console.log("Student login: CSC/20/0001 / Passw0rd!23");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
