require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");

const app = express();
const PORT = Number(process.env.PORT || 4000);
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;
const MAGIC_LINK_BASE_URL = process.env.MAGIC_LINK_BASE_URL || BACKEND_URL;
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-this-secret";
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 60);
const MAGIC_LINK_MINUTES = Number(process.env.MAGIC_LINK_MINUTES || 10);
const COOKIE_NAME = "session_token";
let mailMode = "fallback";

const DB_FILE = path.join(__dirname, "data.db");
const DB_SEED_FILE = process.env.DB_SEED_FILE || path.join(__dirname, "data.seed.db");
const LEGACY_DATA_FILE = path.join(__dirname, "data.json");

function ensureDatabaseFile() {
  // For first deploy/startup, initialize runtime DB from a tracked seed snapshot.
  // After that, runtime DB is left untouched so production data is never overwritten.
  if (!fs.existsSync(DB_FILE) && fs.existsSync(DB_SEED_FILE)) {
    fs.copyFileSync(DB_SEED_FILE, DB_FILE);
    console.log(`Initialized database from seed file: ${DB_SEED_FILE}`);
  }
}

ensureDatabaseFile();
const db = new Database(DB_FILE);

// In-memory store for short-lived magic link tokens.
// Key: sha256(token), Value: { email, expiresAt }
const magicTokens = new Map();

app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true
  })
);
app.use(express.json());
app.use(cookieParser());

function isValidDate(value) {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
}

function isPoolEngEmail(email) {
  return typeof email === "string" && /^[a-zA-Z0-9._%+-]+@pooleng\.com$/i.test(email.trim());
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function sweepExpiredMagicTokens() {
  const now = Date.now();
  for (const [key, value] of magicTokens.entries()) {
    if (value.expiresAt <= now) {
      magicTokens.delete(key);
    }
  }
}

function getSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/"
  };
}

function createSessionToken(email) {
  return jwt.sign({ email }, JWT_SECRET, {
    expiresIn: `${SESSION_DAYS}d`
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

async function buildTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  const hasSmtpConfig = SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS;
  const looksLikePlaceholder =
    String(SMTP_HOST || "").includes("your-provider.com") ||
    String(SMTP_USER || "").includes("your_smtp_user") ||
    String(SMTP_PASS || "").includes("your_smtp_password");

  if (hasSmtpConfig && !looksLikePlaceholder) {
    console.log("Mail mode: SMTP");
    mailMode = "smtp";
    return nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
  }

  console.log("Mail mode: local JSON fallback (magic links will be logged to backend terminal)");
  mailMode = "fallback";
  return nodemailer.createTransport({ jsonTransport: true });
}

let mailTransporter;
buildTransporter()
  .then((transporter) => {
    mailTransporter = transporter;
  })
  .catch((error) => {
    console.error("Failed to initialize mail transporter:", error);
  });

function initializeDatabase() {
  // Workspace table: each document belongs to one workspace.
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      expirationDate TEXT NOT NULL
    )
  `);

  // Extend existing documents table with workspaceId if missing.
  const itemColumns = db.prepare("PRAGMA table_info(items)").all();
  const hasWorkspaceId = itemColumns.some((column) => column.name === "workspaceId");
  const hasCreatedBy = itemColumns.some((column) => column.name === "createdBy");
  const hasCreatedAt = itemColumns.some((column) => column.name === "createdAt");
  if (!hasWorkspaceId) {
    db.exec("ALTER TABLE items ADD COLUMN workspaceId TEXT");
  }
  if (!hasCreatedBy) {
    db.exec("ALTER TABLE items ADD COLUMN createdBy TEXT");
  }
  if (!hasCreatedAt) {
    db.exec("ALTER TABLE items ADD COLUMN createdAt TEXT");
  }

  const existingCount = db.prepare("SELECT COUNT(*) AS count FROM items").get().count;
  if (existingCount === 0 && fs.existsSync(LEGACY_DATA_FILE)) {
    try {
      const raw = fs.readFileSync(LEGACY_DATA_FILE, "utf8");
      const items = JSON.parse(raw);
      if (Array.isArray(items)) {
        const insertStatement = db.prepare(
          "INSERT OR IGNORE INTO items (id, name, description, expirationDate, workspaceId, createdBy, createdAt) VALUES (?, ?, ?, ?, NULL, ?, ?)"
        );

        const insertMany = db.transaction((records) => {
          for (const item of records) {
            if (!item?.name || !item?.description || !isValidDate(item?.expirationDate)) {
              continue;
            }

            insertStatement.run(
              item.id || crypto.randomUUID(),
              String(item.name).trim(),
              String(item.description).trim(),
              new Date(item.expirationDate).toISOString(),
              "legacy@pooleng.com",
              new Date().toISOString()
            );
          }
        });

        insertMany(items);
      }
    } catch (error) {
      console.error("Failed to migrate legacy JSON data:", error);
    }
  }

  // Ensure there is always a default workspace so legacy documents can be tied to one.
  const defaultWorkspaceName = "General";
  let defaultWorkspace = db.prepare("SELECT id FROM workspaces WHERE name = ?").get(defaultWorkspaceName);
  if (!defaultWorkspace) {
    const createdWorkspace = {
      id: crypto.randomUUID(),
      name: defaultWorkspaceName,
      createdAt: new Date().toISOString()
    };
    db.prepare("INSERT INTO workspaces (id, name, createdAt) VALUES (?, ?, ?)")
      .run(createdWorkspace.id, createdWorkspace.name, createdWorkspace.createdAt);
    defaultWorkspace = { id: createdWorkspace.id };
  }

  // Documents must belong to exactly one workspace.
  db.prepare("UPDATE items SET workspaceId = ? WHERE workspaceId IS NULL OR workspaceId = ''")
    .run(defaultWorkspace.id);
  db.prepare("UPDATE items SET createdBy = ? WHERE createdBy IS NULL OR createdBy = ''")
    .run("legacy@pooleng.com");
  db.prepare("UPDATE items SET createdAt = ? WHERE createdAt IS NULL OR createdAt = ''")
    .run(new Date().toISOString());
}

function getAllWorkspaces() {
  return db.prepare("SELECT id, name, createdAt FROM workspaces ORDER BY datetime(createdAt) ASC").all();
}

function workspaceExists(workspaceId) {
  const workspace = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
  return Boolean(workspace);
}

function getDocuments(workspaceId) {
  // Filtering by optional workspaceId keeps sorting by expiration date.
  if (workspaceId) {
    return db
      .prepare(
        "SELECT id, name, description, expirationDate, workspaceId, createdBy, createdAt FROM items WHERE workspaceId = ? ORDER BY datetime(expirationDate) ASC"
      )
      .all(workspaceId);
  }

  return db
    .prepare("SELECT id, name, description, expirationDate, workspaceId, createdBy, createdAt FROM items ORDER BY datetime(expirationDate) ASC")
    .all();
}

initializeDatabase();

app.post("/auth/request-magic-link", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!isPoolEngEmail(email)) {
    return res.status(400).json({ error: "Only @pooleng.com emails are allowed" });
  }

  if (!mailTransporter) {
    return res.status(503).json({ error: "Email service not ready. Try again in a few seconds." });
  }

  sweepExpiredMagicTokens();

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = Date.now() + MAGIC_LINK_MINUTES * 60 * 1000;
  magicTokens.set(tokenHash, { email, expiresAt });

  const link = `${MAGIC_LINK_BASE_URL}/auth/verify-magic?token=${encodeURIComponent(rawToken)}`;
  const fromAddress = process.env.EMAIL_FROM || "no-reply@pooleng.com";
  if (mailMode !== "smtp" && process.env.NODE_ENV !== "production") {
    console.log("Magic link (local dev):", link);
  }

  try {
    const mailResult = await mailTransporter.sendMail({
      from: fromAddress,
      to: email,
      subject: "Your Pool Engineering magic login link",
      text: `Use this login link within ${MAGIC_LINK_MINUTES} minutes: ${link}`,
      html: `<p>Click to log in:</p><p><a href="${link}">${link}</a></p><p>This link expires in ${MAGIC_LINK_MINUTES} minutes.</p>`
    });

    if (mailResult.message) {
      console.log("Magic link email payload (dev transport):", mailResult.message.toString());
    }
  } catch (error) {
    console.error("SMTP send failed:", {
      message: error?.message,
      code: error?.code,
      response: error?.response
    });
    magicTokens.delete(tokenHash);
    return res.status(500).json({
      error: process.env.NODE_ENV === "production"
        ? "Failed to send magic link email"
        : `Failed to send magic link email: ${error?.message || "Unknown SMTP error"}`
    });
  }

  return res.json({ message: "If the email is valid, a magic login link has been sent." });
});

app.get("/auth/verify-magic", (req, res) => {
  const rawToken = String(req.query.token || "");
  if (!rawToken) {
    return res.redirect(`${FRONTEND_URL}/login?error=missing_token`);
  }

  sweepExpiredMagicTokens();
  const tokenHash = hashToken(rawToken);
  const tokenRecord = magicTokens.get(tokenHash);
  if (!tokenRecord || tokenRecord.expiresAt <= Date.now()) {
    magicTokens.delete(tokenHash);
    return res.redirect(`${FRONTEND_URL}/login?error=expired_or_invalid`);
  }

  magicTokens.delete(tokenHash);
  const sessionToken = createSessionToken(tokenRecord.email);
  res.cookie(COOKIE_NAME, sessionToken, getSessionCookieOptions());
  return res.redirect(`${FRONTEND_URL}/dashboard`);
});

app.get("/auth/me", requireAuth, (req, res) => {
  return res.json({ email: req.user.email });
});

app.post("/auth/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME, getSessionCookieOptions());
  return res.status(204).send();
});

app.use("/api/workspaces", requireAuth);
app.use("/api/documents", requireAuth);
app.use("/api/items", requireAuth);

app.get("/api/workspaces", (req, res) => {
  try {
    res.json(getAllWorkspaces());
  } catch (error) {
    res.status(500).json({ error: "Failed to load workspaces" });
  }
});

app.post("/api/workspaces", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) {
    return res.status(400).json({ error: "Workspace name is required" });
  }

  try {
    const workspace = {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString()
    };
    db.prepare("INSERT INTO workspaces (id, name, createdAt) VALUES (?, ?, ?)")
      .run(workspace.id, workspace.name, workspace.createdAt);
    res.status(201).json(workspace);
  } catch (error) {
    res.status(500).json({ error: "Failed to create workspace" });
  }
});

app.delete("/api/workspaces/:id", (req, res) => {
  const { id } = req.params;

  try {
    // Workspace deletion is blocked while documents still reference it.
    const documentCount = db.prepare("SELECT COUNT(*) AS count FROM items WHERE workspaceId = ?").get(id).count;
    if (documentCount > 0) {
      return res.status(400).json({ error: "Cannot delete workspace that contains documents" });
    }

    const deleteResult = db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
    if (deleteResult.changes === 0) {
      return res.status(404).json({ error: "Workspace not found" });
    }

    return res.status(204).send();
  } catch (error) {
    return res.status(500).json({ error: "Failed to delete workspace" });
  }
});

function listDocumentsHandler(req, res) {
  const workspaceId = String(req.query.workspaceId || "").trim();

  try {
    res.json(getDocuments(workspaceId || null));
  } catch (error) {
    res.status(500).json({ error: "Failed to load documents" });
  }
}

app.get("/api/documents", listDocumentsHandler);
app.get("/api/items", listDocumentsHandler);

function createDocumentHandler(req, res) {
  const { name, description, expirationDate, workspaceId } = req.body;

  if (!name || !description || !expirationDate || !isValidDate(expirationDate) || !workspaceId) {
    return res.status(400).json({ error: "name, description, workspaceId, and a valid expirationDate are required" });
  }

  if (!workspaceExists(workspaceId)) {
    return res.status(400).json({ error: "Selected workspace does not exist" });
  }

  try {
    const document = {
      id: crypto.randomUUID(),
      name: String(name).trim(),
      description: String(description).trim(),
      expirationDate: new Date(expirationDate).toISOString(),
      workspaceId: String(workspaceId),
      // Track who created the document from the authenticated session.
      createdBy: req.user?.email || "unknown@pooleng.com",
      createdAt: new Date().toISOString()
    };

    db.prepare("INSERT INTO items (id, name, description, expirationDate, workspaceId, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        document.id,
        document.name,
        document.description,
        document.expirationDate,
        document.workspaceId,
        document.createdBy,
        document.createdAt
      );

    res.status(201).json(document);
  } catch (error) {
    res.status(500).json({ error: "Failed to create document" });
  }
}

app.post("/api/documents", createDocumentHandler);
app.post("/api/items", createDocumentHandler);

function updateDocumentHandler(req, res) {
  const { id } = req.params;
  const { name, description, expirationDate, workspaceId } = req.body;

  if (!expirationDate || !isValidDate(expirationDate)) {
    return res.status(400).json({ error: "A valid expirationDate is required" });
  }

  if (workspaceId !== undefined && !workspaceExists(workspaceId)) {
    return res.status(400).json({ error: "Selected workspace does not exist" });
  }

  try {
    const existing = db.prepare("SELECT id, name, description, expirationDate, workspaceId, createdBy, createdAt FROM items WHERE id = ?").get(id);
    if (!existing) {
      return res.status(404).json({ error: "Document not found" });
    }

    const updatedDocument = {
      ...existing,
      ...(name !== undefined ? { name: String(name).trim() } : {}),
      ...(description !== undefined ? { description: String(description).trim() } : {}),
      ...(workspaceId !== undefined ? { workspaceId: String(workspaceId) } : {}),
      expirationDate: new Date(expirationDate).toISOString()
    };

    db.prepare("UPDATE items SET name = ?, description = ?, expirationDate = ?, workspaceId = ? WHERE id = ?").run(
      updatedDocument.name,
      updatedDocument.description,
      updatedDocument.expirationDate,
      updatedDocument.workspaceId,
      id
    );

    res.json(updatedDocument);
  } catch (error) {
    res.status(500).json({ error: "Failed to update document" });
  }
}

app.put("/api/documents/:id", updateDocumentHandler);
app.put("/api/items/:id", updateDocumentHandler);

function deleteDocumentById(id, res) {
  try {
    const deleteResult = db.prepare("DELETE FROM items WHERE id = ?").run(id);
    if (deleteResult.changes === 0) {
      return res.status(404).json({ error: "Document not found" });
    }

    return res.status(204).send();
  } catch (error) {
    return res.status(500).json({ error: "Failed to delete document" });
  }
}

app.delete("/api/documents/:id", (req, res) => {
  return deleteDocumentById(req.params.id, res);
});

app.post("/api/documents/:id/delete", (req, res) => {
  return deleteDocumentById(req.params.id, res);
});

app.delete("/api/items/:id", (req, res) => {
  return deleteDocumentById(req.params.id, res);
});

app.post("/api/items/:id/delete", (req, res) => {
  return deleteDocumentById(req.params.id, res);
});

app.listen(PORT, () => {
  console.log(`Backend running on ${BACKEND_URL}`);
});
