require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 4000);
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;
const MAGIC_LINK_BASE_URL = process.env.MAGIC_LINK_BASE_URL || BACKEND_URL;
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-this-secret";
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 60);
const MAGIC_LINK_MINUTES = Number(process.env.MAGIC_LINK_MINUTES || 10);
const COOKIE_NAME = "session_token";
const COOKIE_SAME_SITE = process.env.COOKIE_SAME_SITE || "lax";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
const CORS_ORIGINS = (process.env.CORS_ORIGINS || FRONTEND_URL)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const LEGACY_DATA_FILE = path.join(__dirname, "data.json");

const DATABASE_SSL =
  process.env.DATABASE_SSL === "true" ||
  (process.env.NODE_ENV === "production" && process.env.DATABASE_SSL !== "false");

const pool = new Pool({
  ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}),
  ...(DATABASE_SSL ? { ssl: { rejectUnauthorized: false } } : {})
});

let defaultWorkspaceId = null;
let mailMode = "fallback";
let smtpTransporter = null;

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || CORS_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Not allowed by CORS"));
    },
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

async function deleteExpiredMagicTokens() {
  try {
    await pool.query("DELETE FROM magic_tokens WHERE expires_at <= NOW()");
  } catch (error) {
    console.error("Failed to purge expired magic tokens:", error?.message);
  }
}

function getSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAME_SITE,
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

function hasBrevoApiConfig() {
  const apiKey = String(process.env.BREVO_API_KEY || "").trim();
  const sender = String(process.env.EMAIL_FROM || "").trim();
  return Boolean(apiKey && sender);
}

async function buildSmtpTransporter() {
  // Lazy-load nodemailer so Brevo API mode does not depend on SMTP libraries.
  const nodemailer = require("nodemailer");
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  const hasSmtpConfig = SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS;
  const looksLikePlaceholder =
    String(SMTP_HOST || "").includes("your-provider.com") ||
    String(SMTP_USER || "").includes("your_smtp_user") ||
    String(SMTP_PASS || "").includes("your_smtp_password");

  if (hasSmtpConfig && !looksLikePlaceholder) {
    return nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
  }

  return null;
}

async function initializeMailSender() {
  if (hasBrevoApiConfig()) {
    mailMode = "brevo_api";
    console.log("Mail mode: Brevo API");
    return;
  }

  const transporter = await buildSmtpTransporter();
  if (transporter) {
    mailMode = "smtp";
    smtpTransporter = transporter;
    console.log("Mail mode: SMTP");
    return;
  }

  mailMode = "fallback";
  console.log("Mail mode: local fallback (magic links will be logged to backend terminal)");
}

async function sendMagicLinkEmail({ toEmail, link }) {
  const fromAddress = process.env.EMAIL_FROM || "no-reply@pooleng.com";
  const fromName = process.env.EMAIL_FROM_NAME || "Pool Engineering";
  const subject = "Your Pool Engineering magic login link";
  const text = `Use this login link within ${MAGIC_LINK_MINUTES} minutes: ${link}`;
  const html = `<p>Click to log in:</p><p><a href="${link}">${link}</a></p><p>This link expires in ${MAGIC_LINK_MINUTES} minutes.</p>`;

  if (mailMode === "brevo_api") {
    const brevoApiKey = String(process.env.BREVO_API_KEY || "").trim();
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": brevoApiKey
      },
      body: JSON.stringify({
        sender: { name: fromName, email: fromAddress },
        to: [{ email: toEmail }],
        subject,
        textContent: text,
        htmlContent: html
      })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Brevo API error (${response.status}): ${errorBody}`);
    }
    return;
  }

  if (mailMode === "smtp" && smtpTransporter) {
    await smtpTransporter.sendMail({
      from: fromAddress,
      to: toEmail,
      subject,
      text,
      html
    });
    return;
  }

  console.log("Magic link (local dev):", link);
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Documents table now stored in Postgres instead of SQLite.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      expiration_date TIMESTAMPTZ NOT NULL,
      workspace_id TEXT REFERENCES workspaces(id),
      created_by TEXT,
      created_at TIMESTAMPTZ
    )
  `);

  // Magic link tokens in DB avoid invalidation on process restart.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS magic_tokens (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const defaultWorkspaceName = "General";
  const existingDefaultWorkspace = await pool.query(
    "SELECT id FROM workspaces WHERE name = $1 ORDER BY created_at ASC LIMIT 1",
    [defaultWorkspaceName]
  );

  if (existingDefaultWorkspace.rows.length === 0) {
    defaultWorkspaceId = crypto.randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, created_at) VALUES ($1, $2, NOW())", [
      defaultWorkspaceId,
      defaultWorkspaceName
    ]);
  } else {
    defaultWorkspaceId = existingDefaultWorkspace.rows[0].id;
  }

  const itemCountResult = await pool.query("SELECT COUNT(*)::int AS count FROM items");
  const itemCount = itemCountResult.rows[0].count;

  // Optional one-time migration from legacy JSON if table is empty.
  if (itemCount === 0 && fs.existsSync(LEGACY_DATA_FILE)) {
    try {
      const raw = fs.readFileSync(LEGACY_DATA_FILE, "utf8");
      const items = JSON.parse(raw);

      if (Array.isArray(items)) {
        for (const item of items) {
          if (!item?.name || !item?.description || !isValidDate(item?.expirationDate)) {
            continue;
          }

          await pool.query(
            `INSERT INTO items (id, name, description, expiration_date, workspace_id, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [
              item.id || crypto.randomUUID(),
              String(item.name).trim(),
              String(item.description).trim(),
              new Date(item.expirationDate).toISOString(),
              defaultWorkspaceId,
              "legacy@pooleng.com"
            ]
          );
        }
      }
    } catch (error) {
      console.error("Failed to migrate legacy JSON data:", error);
    }
  }

  // Backfill legacy rows to satisfy "document belongs to a workspace".
  await pool.query(
    "UPDATE items SET workspace_id = $1 WHERE workspace_id IS NULL OR workspace_id = ''",
    [defaultWorkspaceId]
  );
  await pool.query(
    "UPDATE items SET created_by = 'legacy@pooleng.com' WHERE created_by IS NULL OR created_by = ''"
  );
  await pool.query("UPDATE items SET created_at = NOW() WHERE created_at IS NULL");
}

async function getAllWorkspaces() {
  const result = await pool.query(
    'SELECT id, name, created_at AS "createdAt" FROM workspaces ORDER BY created_at ASC'
  );
  return result.rows;
}

async function workspaceExists(workspaceId) {
  const result = await pool.query("SELECT id FROM workspaces WHERE id = $1 LIMIT 1", [workspaceId]);
  return result.rows.length > 0;
}

async function getDocuments(workspaceId) {
  const baseQuery = `
    SELECT
      id,
      name,
      description,
      expiration_date AS "expirationDate",
      workspace_id AS "workspaceId",
      created_by AS "createdBy",
      created_at AS "createdAt"
    FROM items
  `;

  if (workspaceId) {
    const result = await pool.query(
      `${baseQuery} WHERE workspace_id = $1 ORDER BY expiration_date ASC`,
      [workspaceId]
    );
    return result.rows;
  }

  const result = await pool.query(`${baseQuery} ORDER BY expiration_date ASC`);
  return result.rows;
}

app.post("/auth/request-magic-link", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!isPoolEngEmail(email)) {
    return res.status(400).json({ error: "Only @pooleng.com emails are allowed" });
  }

  await deleteExpiredMagicTokens();

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAtIso = new Date(Date.now() + MAGIC_LINK_MINUTES * 60 * 1000).toISOString();
  await pool.query(
    "INSERT INTO magic_tokens (token_hash, email, expires_at) VALUES ($1, $2, $3) ON CONFLICT (token_hash) DO UPDATE SET email = EXCLUDED.email, expires_at = EXCLUDED.expires_at",
    [tokenHash, email, expiresAtIso]
  );

  const link = `${MAGIC_LINK_BASE_URL}/auth/verify-magic?token=${encodeURIComponent(rawToken)}`;

  try {
    await sendMagicLinkEmail({ toEmail: email, link });
  } catch (error) {
    console.error("Magic link send failed:", {
      message: error?.message,
      code: error?.code,
      response: error?.response
    });
    await pool.query("DELETE FROM magic_tokens WHERE token_hash = $1", [tokenHash]).catch(() => {});
    return res.status(500).json({
      error:
        process.env.NODE_ENV === "production"
          ? "Failed to send magic link email"
          : `Failed to send magic link email: ${error?.message || "Unknown SMTP error"}`
    });
  }

  return res.json({ message: "If the email is valid, a magic login link has been sent." });
});

app.get("/auth/verify-magic", async (req, res) => {
  const rawToken = String(req.query.token || "");
  if (!rawToken) {
    return res.redirect(`${FRONTEND_URL}/login?error=missing_token`);
  }

  try {
    await deleteExpiredMagicTokens();
    const tokenHash = hashToken(rawToken);
    const tokenResult = await pool.query(
      "SELECT email, expires_at AS \"expiresAt\" FROM magic_tokens WHERE token_hash = $1 LIMIT 1",
      [tokenHash]
    );

    if (tokenResult.rows.length === 0) {
      return res.redirect(`${FRONTEND_URL}/login?error=expired_or_invalid`);
    }

    const tokenRecord = tokenResult.rows[0];
    if (new Date(tokenRecord.expiresAt).getTime() <= Date.now()) {
      await pool.query("DELETE FROM magic_tokens WHERE token_hash = $1", [tokenHash]).catch(() => {});
      return res.redirect(`${FRONTEND_URL}/login?error=expired_or_invalid`);
    }

    const sessionToken = createSessionToken(tokenRecord.email);
    res.cookie(COOKIE_NAME, sessionToken, getSessionCookieOptions());
    return res.redirect(`${FRONTEND_URL}/dashboard`);
  } catch (error) {
    return res.redirect(`${FRONTEND_URL}/login?error=expired_or_invalid`);
  }
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

app.get("/api/workspaces", async (req, res) => {
  try {
    res.json(await getAllWorkspaces());
  } catch (error) {
    res.status(500).json({ error: "Failed to load workspaces" });
  }
});

app.post("/api/workspaces", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) {
    return res.status(400).json({ error: "Workspace name is required" });
  }

  try {
    const workspace = {
      id: crypto.randomUUID(),
      name
    };
    const result = await pool.query(
      'INSERT INTO workspaces (id, name, created_at) VALUES ($1, $2, NOW()) RETURNING id, name, created_at AS "createdAt"',
      [workspace.id, workspace.name]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Failed to create workspace" });
  }
});

app.delete("/api/workspaces/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // Workspace deletion is blocked while documents still reference it.
    const documentCountResult = await pool.query(
      "SELECT COUNT(*)::int AS count FROM items WHERE workspace_id = $1",
      [id]
    );
    if (documentCountResult.rows[0].count > 0) {
      return res.status(400).json({ error: "Cannot delete workspace that contains documents" });
    }

    const deleteResult = await pool.query("DELETE FROM workspaces WHERE id = $1", [id]);
    if (deleteResult.rowCount === 0) {
      return res.status(404).json({ error: "Workspace not found" });
    }

    return res.status(204).send();
  } catch (error) {
    return res.status(500).json({ error: "Failed to delete workspace" });
  }
});

async function listDocumentsHandler(req, res) {
  const workspaceId = String(req.query.workspaceId || "").trim();

  try {
    res.json(await getDocuments(workspaceId || null));
  } catch (error) {
    res.status(500).json({ error: "Failed to load documents" });
  }
}

app.get("/api/documents", listDocumentsHandler);
app.get("/api/items", listDocumentsHandler);

async function createDocumentHandler(req, res) {
  const { name, description, expirationDate, workspaceId } = req.body;

  if (!name || !description || !expirationDate || !isValidDate(expirationDate) || !workspaceId) {
    return res.status(400).json({ error: "name, description, workspaceId, and a valid expirationDate are required" });
  }

  if (!(await workspaceExists(workspaceId))) {
    return res.status(400).json({ error: "Selected workspace does not exist" });
  }

  try {
    const document = {
      id: crypto.randomUUID(),
      name: String(name).trim(),
      description: String(description).trim(),
      expirationDate: new Date(expirationDate).toISOString(),
      workspaceId: String(workspaceId),
      createdBy: req.user?.email || "unknown@pooleng.com"
    };

    const result = await pool.query(
      `INSERT INTO items (id, name, description, expiration_date, workspace_id, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id, name, description, expiration_date AS "expirationDate", workspace_id AS "workspaceId",
                 created_by AS "createdBy", created_at AS "createdAt"`,
      [
        document.id,
        document.name,
        document.description,
        document.expirationDate,
        document.workspaceId,
        document.createdBy
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Failed to create document" });
  }
}

app.post("/api/documents", createDocumentHandler);
app.post("/api/items", createDocumentHandler);

async function updateDocumentHandler(req, res) {
  const { id } = req.params;
  const { name, description, expirationDate, workspaceId } = req.body;

  if (!expirationDate || !isValidDate(expirationDate)) {
    return res.status(400).json({ error: "A valid expirationDate is required" });
  }

  if (workspaceId !== undefined && !(await workspaceExists(workspaceId))) {
    return res.status(400).json({ error: "Selected workspace does not exist" });
  }

  try {
    const existingResult = await pool.query(
      `SELECT id, name, description, expiration_date AS "expirationDate", workspace_id AS "workspaceId",
              created_by AS "createdBy", created_at AS "createdAt"
       FROM items WHERE id = $1`,
      [id]
    );

    if (existingResult.rows.length === 0) {
      return res.status(404).json({ error: "Document not found" });
    }

    const existing = existingResult.rows[0];
    const updatedDocument = {
      ...existing,
      ...(name !== undefined ? { name: String(name).trim() } : {}),
      ...(description !== undefined ? { description: String(description).trim() } : {}),
      ...(workspaceId !== undefined ? { workspaceId: String(workspaceId) } : {}),
      expirationDate: new Date(expirationDate).toISOString()
    };

    const result = await pool.query(
      `UPDATE items
       SET name = $1, description = $2, expiration_date = $3, workspace_id = $4
       WHERE id = $5
       RETURNING id, name, description, expiration_date AS "expirationDate", workspace_id AS "workspaceId",
                 created_by AS "createdBy", created_at AS "createdAt"`,
      [
        updatedDocument.name,
        updatedDocument.description,
        updatedDocument.expirationDate,
        updatedDocument.workspaceId,
        id
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Failed to update document" });
  }
}

app.put("/api/documents/:id", updateDocumentHandler);
app.put("/api/items/:id", updateDocumentHandler);

async function deleteDocumentById(id, res) {
  try {
    const deleteResult = await pool.query("DELETE FROM items WHERE id = $1", [id]);
    if (deleteResult.rowCount === 0) {
      return res.status(404).json({ error: "Document not found" });
    }

    return res.status(204).send();
  } catch (error) {
    return res.status(500).json({ error: "Failed to delete document" });
  }
}

app.delete("/api/documents/:id", async (req, res) => {
  return deleteDocumentById(req.params.id, res);
});

app.post("/api/documents/:id/delete", async (req, res) => {
  return deleteDocumentById(req.params.id, res);
});

app.delete("/api/items/:id", async (req, res) => {
  return deleteDocumentById(req.params.id, res);
});

app.post("/api/items/:id/delete", async (req, res) => {
  return deleteDocumentById(req.params.id, res);
});

initializeDatabase()
  .then(async () => {
    await initializeMailSender();
    app.listen(PORT, () => {
      console.log(`Backend running on ${BACKEND_URL}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize Postgres schema:", error);
    process.exit(1);
  });
