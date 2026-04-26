require("dotenv").config();
global.DOMMatrix = require("@thednp/dommatrix");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const mysql = require("mysql2/promise");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ExcelJS = require("exceljs");
const { PDFParse } = require("pdf-parse");
const Stripe = require("stripe");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");

const app = express();

const PORT = process.env.PORT || 5000;
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || "http://localhost:3000";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_REPLACE_ME");
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_jwt_key";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const STORAGE_DIR = path.join(__dirname, "storage");
const UPLOAD_DIR = path.join(STORAGE_DIR, "uploads");
const EXPORT_DIR = path.join(STORAGE_DIR, "exports");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(EXPORT_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 50 * 1024 * 1024 },
});

const db = mysql.createPool({
  host: process.env.MYSQL_HOST || "localhost",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "saas_db",
  charset: "utf8mb4_unicode_ci",
  waitForConnections: true,
  connectionLimit: 10,
});

app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) return res.status(400).send("Missing STRIPE_WEBHOOK_SECRET");

    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email = session.customer_email;
      const planCode = session.metadata?.plan_code || "starter";
      if (email) {
        await db.query(
          `
          INSERT INTO users (email, plan_code, stripe_customer_id, stripe_subscription_id, subscription_status)
          VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            plan_code = VALUES(plan_code),
            stripe_customer_id = VALUES(stripe_customer_id),
            stripe_subscription_id = VALUES(stripe_subscription_id),
            subscription_status = VALUES(subscription_status)
          `,
          [email, planCode, session.customer, session.subscription, "active"]
        );
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      await db.query(
        `UPDATE users SET plan_code = 'free', subscription_status = 'canceled' WHERE stripe_subscription_id = ?`,
        [sub.id]
      );
    }

    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      await db.query(
        `UPDATE users SET subscription_status = 'payment_failed' WHERE stripe_customer_id = ?`,
        [invoice.customer]
      );
    }

    res.json({ received: true });
  } catch (err) {
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

function newId() {
  return crypto.randomBytes(16).toString("hex");
}

function cleanJsonText(text) {
  return text.replace(/```json/gi, "").replace(/```/g, "").trim();
}

function normalizeRows(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (data.rows && Array.isArray(data.rows)) return data.rows;
  if (data.data && Array.isArray(data.data)) return data.data;
  if (typeof data === "object") return [data];
  return [];
}

function parseFieldsInput(value) {
  if (Array.isArray(value)) return value.map((field) => String(field).trim()).filter(Boolean);
  if (value === null || value === undefined) return [];
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      return parseFieldsInput(parsed);
    } catch {
      return text.split(",").map((field) => field.trim()).filter(Boolean);
    }
  }
  return [];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGeminiWithRetry(payload, maxAttempts = 5) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await axios.post(url, payload);
    } catch (err) {
      const status = err?.response?.status;
      const isRetryable = status === 429 || status === 503 || status === 500;
      if (!isRetryable || attempt === maxAttempts) {
        if (status === 429) {
          throw new Error("Rate limit from AI provider (429). Please retry in about 1 minute.");
        }
        throw err;
      }

      const retryAfterHeader = Number(err?.response?.headers?.["retry-after"] || 0);
      const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : 0;
      const backoffMs = 1000 * 2 ** (attempt - 1);
      const jitterMs = Math.floor(Math.random() * 300);
      await sleep(Math.max(retryAfterMs, backoffMs + jitterMs));
    }
  }
}

function fileToGeminiPart(filePath, mimeType) {
  const base64 = fs.readFileSync(filePath).toString("base64");
  return { inline_data: { mime_type: mimeType, data: base64 } };
}

async function extractPdfPages(filePath) {
  const buffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buffer });
  const info = await parser.getInfo({ parsePageInfo: false }).catch(() => null);
  const totalPages = Number(info?.total || info?.numpages || 1) || 1;
  const pages = [];

  for (let i = 1; i <= totalPages; i++) {
    const pageText = await parser.getPageText({ pageNumber: i }).catch(() => "");
    pages.push({ pageNumber: i, text: pageText || "" });
  }

  await parser.destroy().catch(() => {});
  return pages;
}

async function getFileUnits(file) {
  if (file.mimetype === "application/pdf") {
    const pages = await extractPdfPages(file.path);
    return pages.map((page) => ({
      type: "pdf_page",
      pageNumber: page.pageNumber,
      displayName: `${file.originalname} (page ${page.pageNumber})`,
      text: page.text,
      sourcePath: file.path,
      mimeType: file.mimetype,
      originalName: file.originalname,
      size: file.size,
    }));
  }

  return [
    {
      type: "file",
      pageNumber: 1,
      displayName: file.originalname,
      text: null,
      sourcePath: file.path,
      mimeType: file.mimetype,
      originalName: file.originalname,
      size: file.size,
    },
  ];
}

async function askGeminiExtract({ item, fields, organization }) {
  if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY in .env");

  const prompt = `You are a document table extraction engine.
Return ONLY valid JSON.
Organization mode: ${organization}
Fields to extract: ${fields.join(", ")}
Rules: Extract tables, preserve columns, use null, valid JSON.`;

  const parts = [{ text: prompt }];

  if (item.type === "pdf_page") {
    parts.push({ text: item.text || "" });
  } else if (item.mimeType?.startsWith("image/")) {
    parts.push(fileToGeminiPart(item.sourcePath, item.mimeType));
  } else {
    const utf8Text = fs.readFileSync(item.sourcePath, "utf8");
    parts.push({ text: utf8Text });
  }

  const response = await callGeminiWithRetry({
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
  });

  const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return JSON.parse(cleanJsonText(raw));
}

async function askGeminiColumnsFromFirstUnit(item) {
  if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY in .env");

  const prompt = `Analyze this first document page and return ONLY JSON object like {"columns":["col1","col2"]}.
Rules: column names must be snake_case and unique.`;
  const parts = [{ text: prompt }];

  if (item.type === "pdf_page") {
    parts.push({ text: item.text || "" });
  } else if (item.mimeType?.startsWith("image/")) {
    parts.push(fileToGeminiPart(item.sourcePath, item.mimeType));
  }

  const response = await callGeminiWithRetry({
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
  });

  const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const parsed = JSON.parse(cleanJsonText(raw));
  return Array.isArray(parsed?.columns) ? parsed.columns.filter(Boolean) : [];
}

async function getPlan(code) {
  const [rows] = await db.query(`SELECT * FROM plans WHERE code = ?`, [code]);
  return rows[0];
}

async function ensureDefaultWorkspace(email) {
  const [rows] = await db.query(`SELECT id FROM workspaces WHERE user_email = ? ORDER BY created_at ASC LIMIT 1`, [email]);
  if (rows.length) return rows[0].id;

  const id = newId();
  await db.query(`INSERT INTO workspaces (id, user_email, name) VALUES (?, ?, ?)`, [id, email, "my first workspace"]);
  return id;
}

async function getUser(email) {
  const [rows] = await db.query(`SELECT * FROM users WHERE email = ?`, [email]);
  let user = rows[0];

  if (!user) {
    await db.query(`INSERT INTO users (email, plan_code) VALUES (?, 'free')`, [email]);
    const [created] = await db.query(`SELECT * FROM users WHERE email = ?`, [email]);
    user = created[0];
  }

  await ensureDefaultWorkspace(email);
  return user;
}

async function checkLimits(email, newPages, newBytes) {
  const user = await getUser(email);
  const plan = await getPlan(user.plan_code || "free");
  const maxBytes = Number(plan.storage_mb) * 1024 * 1024;

  if (Number(user.usage_pages) + newPages > Number(plan.monthly_pages)) {
    throw new Error(`Plan limit exceeded. Your plan allows ${plan.monthly_pages} pages/month.`);
  }
  if (Number(user.storage_used_bytes) + newBytes > maxBytes) {
    throw new Error(`Storage limit exceeded. Your plan allows ${plan.storage_mb} MB.`);
  }
}

function generateToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ success: false, error: "Unauthorized" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, error: "Token expired or invalid" });
    req.user = user;
    next();
  });
}

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS plans (
      code VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      price_usd_monthly DECIMAL(10,2) NOT NULL,
      monthly_pages INT NOT NULL,
      storage_mb INT NOT NULL,
      stripe_price_id VARCHAR(255)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(191) NOT NULL UNIQUE,
      password_hash VARCHAR(255),
      google_id VARCHAR(255),
      name VARCHAR(255),
      language VARCHAR(50) DEFAULT 'English',
      plan_code VARCHAR(50) DEFAULT 'free',
      usage_pages INT DEFAULT 0,
      storage_used_bytes BIGINT DEFAULT 0,
      stripe_customer_id VARCHAR(191),
      stripe_subscription_id VARCHAR(191),
      subscription_status VARCHAR(50) DEFAULT 'free',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id VARCHAR(64) PRIMARY KEY,
      user_email VARCHAR(191) NOT NULL,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS files (
      id VARCHAR(64) PRIMARY KEY,
      user_email VARCHAR(255),
      workspace_id VARCHAR(64),
      job_id VARCHAR(64),
      original_name TEXT,
      stored_path TEXT,
      mime_type VARCHAR(255),
      size_bytes BIGINT DEFAULT 0,
      pages INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id VARCHAR(64) PRIMARY KEY,
      user_email VARCHAR(255),
      workspace_id VARCHAR(64),
      status VARCHAR(50) DEFAULT 'pending',
      organization VARCHAR(50),
      fields_mode VARCHAR(20) DEFAULT 'auto',
      fields_json JSON,
      total_items INT DEFAULT 0,
      processed_items INT DEFAULT 0,
      current_item_name VARCHAR(255),
      result_json JSON,
      error_text TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`ALTER TABLE users ADD COLUMN password_hash VARCHAR(255)`).catch(() => {});
  await db.query(`ALTER TABLE users ADD COLUMN google_id VARCHAR(255)`).catch(() => {});
  await db.query(`ALTER TABLE users ADD COLUMN name VARCHAR(255)`).catch(() => {});
  await db.query(`ALTER TABLE users ADD COLUMN language VARCHAR(50) DEFAULT 'English'`).catch(() => {});

  await db.query(`ALTER TABLE files ADD COLUMN workspace_id VARCHAR(64)`).catch(() => {});
  await db.query(`ALTER TABLE files ADD COLUMN job_id VARCHAR(64)`).catch(() => {});
  await db.query(`ALTER TABLE jobs ADD COLUMN workspace_id VARCHAR(64)`).catch(() => {});
  await db.query(`ALTER TABLE jobs ADD COLUMN fields_mode VARCHAR(20) DEFAULT 'auto'`).catch(() => {});
  await db.query(`ALTER TABLE jobs ADD COLUMN total_items INT DEFAULT 0`).catch(() => {});
  await db.query(`ALTER TABLE jobs ADD COLUMN processed_items INT DEFAULT 0`).catch(() => {});
  await db.query(`ALTER TABLE jobs ADD COLUMN current_item_name VARCHAR(255)`).catch(() => {});
  await db.query(`ALTER TABLE users CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`).catch(() => {});
  await db.query(`ALTER TABLE workspaces CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`).catch(() => {});
  await db.query(`ALTER TABLE files CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`).catch(() => {});
  await db.query(`ALTER TABLE jobs CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`).catch(() => {});

  await db.query(
    `
    INSERT INTO plans (code, name, price_usd_monthly, monthly_pages, storage_mb, stripe_price_id)
    VALUES
      ('free', 'Free', 0, 50, 100, NULL),
      ('starter', 'Starter', 20, 10000, 1000, ?),
      ('business', 'Business', 50, 100000, 5000, ?)
    ON DUPLICATE KEY UPDATE stripe_price_id = VALUES(stripe_price_id)
    `,
    [process.env.STRIPE_PRICE_20 || null, process.env.STRIPE_PRICE_50 || null]
  );

  console.log("✅ Database ready");
}

initDB().catch(console.error);

app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing fields" });

    const [existing] = await db.query("SELECT id FROM users WHERE email = ?", [email]);
    if (existing.length) return res.status(400).json({ error: "Email already exists" });

    const hash = await bcrypt.hash(password, 10);
    const [result] = await db.query("INSERT INTO users (email, password_hash, plan_code) VALUES (?, ?, 'free')", [email, hash]);
    await ensureDefaultWorkspace(email);

    const token = generateToken({ id: result.insertId, email });
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const [users] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
    if (!users.length) return res.status(400).json({ error: "User not found" });

    const user = users[0];
    const valid = user.password_hash && (await bcrypt.compare(password, user.password_hash));
    if (!valid) return res.status(400).json({ error: "Invalid password" });

    await ensureDefaultWorkspace(email);
    const token = generateToken(user);
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/auth/google", async (req, res) => {
  try {
    const { token } = req.body;
    const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const { email, sub: google_id, name } = payload;

    let [users] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
    let user = users[0];

    if (!user) {
      const [result] = await db.query("INSERT INTO users (email, google_id, name, plan_code) VALUES (?, ?, ?, 'free')", [email, google_id, name]);
      user = { id: result.insertId, email };
    } else if (!user.google_id) {
      await db.query("UPDATE users SET google_id = ? WHERE email = ?", [google_id, email]);
    }

    await ensureDefaultWorkspace(email);
    const jwtToken = generateToken(user);
    res.json({ success: true, token: jwtToken });
  } catch {
    res.status(400).json({ success: false, error: "Invalid Google Token" });
  }
});

app.put("/api/account/update", authenticateToken, async (req, res) => {
  try {
    const currentEmail = req.user.email;
    const { email: newEmail, password, language } = req.body;
    let query = "UPDATE users SET ";
    const params = [];
    const updates = [];

    if (newEmail && newEmail !== currentEmail) {
      const [exists] = await db.query("SELECT id FROM users WHERE email = ?", [newEmail]);
      if (exists.length) return res.status(400).json({ success: false, error: "Email already taken" });
      updates.push("email = ?");
      params.push(newEmail);
    }

    if (password) {
      const hash = await bcrypt.hash(password, 10);
      updates.push("password_hash = ?");
      params.push(hash);
    }

    if (language) {
      updates.push("language = ?");
      params.push(language);
    }

    if (!updates.length) return res.json({ success: true, message: "No changes requested" });

    query += updates.join(", ") + " WHERE email = ?";
    params.push(currentEmail);
    await db.query(query, params);

    const targetEmail = newEmail || currentEmail;
    const [updated] = await db.query("SELECT * FROM users WHERE email = ?", [targetEmail]);
    const newToken = generateToken(updated[0]);
    res.json({ success: true, token: newToken, message: "Account updated successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/health", async (req, res) => {
  res.json({ success: true, message: "Backend running", port: PORT });
});

app.get("/api/me", authenticateToken, async (req, res) => {
  try {
    const user = await getUser(req.user.email);
    const plan = await getPlan(user.plan_code || "free");
    const [workspaceCountRows] = await db.query(`SELECT COUNT(*) AS total FROM workspaces WHERE user_email = ?`, [req.user.email]);
    const { password_hash, ...safeUser } = user;
    res.json({ success: true, user: { ...safeUser, workspace_count: workspaceCountRows[0]?.total || 0 }, plan });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/workspaces", authenticateToken, async (req, res) => {
  try {
    await ensureDefaultWorkspace(req.user.email);
    const [rows] = await db.query(
      `SELECT w.*, 
        (SELECT COUNT(*) FROM jobs j WHERE j.workspace_id = w.id) AS jobs_count,
        (SELECT j2.status FROM jobs j2 WHERE j2.workspace_id = w.id ORDER BY j2.created_at DESC LIMIT 1) AS last_job_status,
        (SELECT j3.id FROM jobs j3 WHERE j3.workspace_id = w.id ORDER BY j3.created_at DESC LIMIT 1) AS last_job_id
      FROM workspaces w
      WHERE w.user_email = ?
      ORDER BY w.created_at ASC`,
      [req.user.email]
    );
    res.json({ success: true, workspaces: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/workspaces", authenticateToken, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ success: false, error: "Workspace name is required" });
    const id = newId();
    await db.query(`INSERT INTO workspaces (id, user_email, name) VALUES (?, ?, ?)`, [id, req.user.email, name]);
    res.json({ success: true, workspace: { id, name } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/workspaces/:id/jobs", authenticateToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, workspace_id, status, fields_mode, fields_json, total_items, processed_items, current_item_name, result_json, error_text, created_at, updated_at
      FROM jobs
      WHERE user_email = ? AND workspace_id = ?
      ORDER BY created_at DESC LIMIT 20`,
      [req.user.email, req.params.id]
    );
    res.json({ success: true, jobs: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/billing/history", authenticateToken, async (req, res) => {
  try {
    const user = await getUser(req.user.email);
    if (!user.stripe_customer_id) return res.json({ success: true, history: [] });

    const invoices = await stripe.invoices.list({ customer: user.stripe_customer_id, limit: 20 });
    res.json({ success: true, history: invoices.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/create-checkout", authenticateToken, async (req, res) => {
  try {
    const email = req.user.email;
    const { plan_code } = req.body;
    if (!["starter", "business"].includes(plan_code)) {
      return res.status(400).json({ success: false, error: "plan_code must be starter or business" });
    }

    const plan = await getPlan(plan_code);
    if (!plan || !plan.stripe_price_id) {
      return res.status(400).json({ success: false, error: "Stripe price ID missing in database." });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      success_url: `${APP_PUBLIC_URL}?billing=success`,
      cancel_url: `${APP_PUBLIC_URL}?billing=cancel`,
      metadata: { email, plan_code },
      subscription_data: { metadata: { email, plan_code } },
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/columns/suggest", authenticateToken, upload.array("files", 20), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ success: false, error: "No files uploaded" });

    const firstUnits = await getFileUnits(files[0]);
    const firstUnit = firstUnits[0];
    const columns = await askGeminiColumnsFromFirstUnit(firstUnit);
    res.json({ success: true, columns });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/upload", authenticateToken, upload.array("files", 20), async (req, res) => {
  try {
    const email = req.user.email;
    const workspaceId = req.body.workspace_id;
    const fields = parseFieldsInput(req.body.fields);
    const organization = req.body.organization || "one_table";

    if (!workspaceId) return res.status(400).json({ success: false, error: "workspace_id is required" });
    if (!fields.length) return res.status(400).json({ success: false, error: "fields is required" });

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ success: false, error: "No files uploaded" });

    const units = [];
    let totalBytes = 0;
    for (const file of files) {
      totalBytes += Number(file.size || 0);
      const fileUnits = await getFileUnits(file);
      units.push(...fileUnits);
    }

    await checkLimits(email, units.length, totalBytes);

    const allResults = [];
    for (const item of units) {
      const result = await askGeminiExtract({ item, fields, organization });
      if (organization === "one_table") allResults.push(...normalizeRows(result));
      else allResults.push({ file: item.displayName, result });
    }

    await db.query(`UPDATE users SET usage_pages = usage_pages + ?, storage_used_bytes = storage_used_bytes + ? WHERE email = ?`, [
      units.length,
      totalBytes,
      email,
    ]);

    res.json({ success: true, data: allResults, pages_used: units.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/jobs", authenticateToken, upload.array("files", 20), async (req, res) => {
  try {
    const email = req.user.email;
    const workspaceId = req.body.workspace_id;
    const organization = req.body.organization || "one_table";
    const fieldsMode = req.body.fields_mode || "auto";
    const fields = parseFieldsInput(req.body.fields);

    if (!workspaceId) return res.status(400).json({ success: false, error: "workspace_id is required" });
    if (!fields.length) return res.status(400).json({ success: false, error: "fields is required" });

    const [workspaceRows] = await db.query(`SELECT id FROM workspaces WHERE id = ? AND user_email = ?`, [workspaceId, email]);
    if (!workspaceRows.length) return res.status(404).json({ success: false, error: "Workspace not found" });

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ success: false, error: "No files uploaded" });

    let totalBytes = 0;
    let totalUnits = 0;

    const jobId = newId();

    for (const file of files) {
      const fileUnits = await getFileUnits(file);
      const pages = fileUnits.length;
      totalUnits += pages;
      totalBytes += Number(file.size || 0);

      await db.query(
        `INSERT INTO files (id, user_email, workspace_id, job_id, original_name, stored_path, mime_type, size_bytes, pages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId(), email, workspaceId, jobId, file.originalname, file.path, file.mimetype, file.size, pages]
      );
    }

    await checkLimits(email, totalUnits, totalBytes);

    await db.query(
      `INSERT INTO jobs (id, user_email, workspace_id, status, organization, fields_mode, fields_json, total_items, processed_items) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, 0)`,
      [jobId, email, workspaceId, organization, fieldsMode, JSON.stringify(fields), totalUnits]
    );

    await db.query(`UPDATE users SET usage_pages = usage_pages + ?, storage_used_bytes = storage_used_bytes + ? WHERE email = ?`, [
      totalUnits,
      totalBytes,
      email,
    ]);

    processJob(jobId).catch(console.error);
    res.json({ success: true, job_id: jobId, status: "pending", total_items: totalUnits });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/jobs/:id", authenticateToken, async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT * FROM jobs WHERE id = ? AND user_email = ?`, [req.params.id, req.user.email]);
    if (!rows.length) return res.status(404).json({ success: false, error: "Job not found" });
    res.json({ success: true, job: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

async function processJob(jobId) {
  const [jobs] = await db.query(`SELECT * FROM jobs WHERE id = ?`, [jobId]);
  if (!jobs.length) return;

  const job = jobs[0];
  await db.query(`UPDATE jobs SET status = 'processing' WHERE id = ?`, [jobId]);

  try {
    const [files] = await db.query(
      `SELECT * FROM files WHERE job_id = ? AND user_email = ? ORDER BY created_at ASC`,
      [jobId, job.user_email]
    );

    const fields = parseFieldsInput(job.fields_json);
    const organization = job.organization || "one_table";
    const finalResult = [];
    let processed = 0;

    for (const file of files) {
      const fileUnits = await getFileUnits({
        path: file.stored_path,
        mimetype: file.mime_type,
        originalname: file.original_name,
        size: file.size_bytes,
      });

      for (const unit of fileUnits) {
        await db.query(`UPDATE jobs SET current_item_name = ? WHERE id = ?`, [unit.displayName, jobId]);

        const result = await askGeminiExtract({ item: unit, fields, organization });
        if (organization === "one_table") finalResult.push(...normalizeRows(result));
        else finalResult.push({ file: unit.displayName, result });

        processed += 1;
        await db.query(`UPDATE jobs SET processed_items = ? WHERE id = ?`, [processed, jobId]);
      }
    }

    await db.query(`UPDATE jobs SET status = 'done', result_json = ?, current_item_name = NULL WHERE id = ?`, [
      JSON.stringify(finalResult),
      jobId,
    ]);
  } catch (err) {
    await db.query(`UPDATE jobs SET status = 'failed', error_text = ?, current_item_name = NULL WHERE id = ?`, [err.message, jobId]);
  }
}

app.post("/api/export", async (req, res) => {
  try {
    const { data, job_id } = req.body;
    let exportData = data;

    if (job_id) {
      const [rows] = await db.query(`SELECT result_json FROM jobs WHERE id = ?`, [job_id]);
      if (!rows.length) return res.status(404).json({ success: false, error: "Job not found" });
      exportData = rows[0].result_json;
    }

    if (typeof exportData === "string") exportData = JSON.parse(exportData);
    const rows = normalizeRows(exportData);
    if (!rows.length) return res.status(400).json({ success: false, error: "No data to export" });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Extracted Data");

    const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row || {}))));
    sheet.columns = keys.map((key) => ({ header: key, key, width: 25 }));
    rows.forEach((row) => sheet.addRow(row));
    sheet.getRow(1).font = { bold: true };

    const fileName = `export-${Date.now()}.xlsx`;
    const filePath = path.join(EXPORT_DIR, fileName);
    await workbook.xlsx.writeFile(filePath);

    res.download(filePath, fileName);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
