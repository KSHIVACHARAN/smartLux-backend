"use strict";

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const multer = require("multer");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 5000);
const frontendPath = path.join(__dirname, "..");
const uploadDirectory = path.join(__dirname, "uploads", "faults");

fs.mkdirSync(uploadDirectory, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.static(frontendPath));

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "smart_street_light",
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true
});

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadDirectory),
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      return callback(new Error("Only JPG, PNG, and WEBP images are allowed."));
    }
    callback(null, true);
  }
});

function cleanString(value, maxLength = 255) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function numberOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toMySQLDate(value) {
  if (!value) return new Date().toISOString().slice(0, 19).replace("T", " ");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid timestamp.");
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function validStatus(value) {
  return ["ON", "OFF"].includes(String(value ?? "").trim().toUpperCase());
}

function removeUploadedFile(file) {
  if (!file) return;
  fs.unlink(path.join(uploadDirectory, path.basename(file.filename)), () => {});
}

async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS street_lights (
      id INT AUTO_INCREMENT PRIMARY KEY,
      light_id VARCHAR(20) NOT NULL UNIQUE,
      area VARCHAR(150) NOT NULL,
      latitude DECIMAL(10,6) NULL,
      longitude DECIMAL(10,6) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sensor_data (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      light_id VARCHAR(20) NOT NULL,
      voltage DECIMAL(10,2) NULL,
      \`current\` DECIMAL(10,3) NULL,
      brightness DECIMAL(10,2) NULL,
      status VARCHAR(20) DEFAULT 'OFF',
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sensor_light_time (light_id, recorded_at)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fault_reports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      fault_id INT NULL UNIQUE,
      light_id VARCHAR(20) NOT NULL,
      area VARCHAR(150) NULL,
      fault_type VARCHAR(100) NOT NULL,
      reported_time DATETIME NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'In Progress',
      resolved_time DATETIME NULL,
      priority VARCHAR(20) DEFAULT 'Medium',
      technician VARCHAR(100) NULL,
      description TEXT NULL,
      photo_path VARCHAR(255) NULL
    )
  `);

  // Add the photo column to existing tables too.
  const [columns] = await pool.query("SHOW COLUMNS FROM fault_reports LIKE 'photo_path'");
  if (columns.length === 0) {
    await pool.query("ALTER TABLE fault_reports ADD COLUMN photo_path VARCHAR(255) NULL");
  }

  console.log("Database tables checked successfully.");
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ success: true, message: "Node.js backend and MySQL connected." });
  } catch (error) {
    console.error("Health check:", error.message);
    res.status(500).json({ success: false, message: "Database connection failed." });
  }
});

/* LOGIN */
app.post("/api/login", async (req, res) => {
  try {
    const username = cleanString(req.body.username, 50);
    const password = String(req.body.password ?? "");

    if (!username || !password) {
      return res.status(400).json({ success: false, message: "Username and password are required." });
    }

    const [users] = await pool.query(
      "SELECT id, username, password_hash, role FROM users WHERE username = ? LIMIT 1",
      [username]
    );

    if (!users.length || !(await bcrypt.compare(password, users[0].password_hash))) {
      return res.status(401).json({ success: false, message: "Invalid username or password." });
    }

    res.json({
      success: true,
      user: { id: users[0].id, username: users[0].username, role: users[0].role }
    });
  } catch (error) {
    console.error("Login error:", error.message);
    res.status(500).json({ success: false, message: "Login failed." });
  }
});

/* GET STREET LIGHTS */
app.get("/api/lights", async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT light_id AS LightID, area AS Area,
             latitude AS Latitude, longitude AS Longitude
      FROM street_lights ORDER BY id DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error("Get lights error:", error.message);
    res.status(500).json({ message: "Unable to load street lights." });
  }
});

/* ADD STREET LIGHT */
app.post("/api/lights", async (req, res) => {
  try {
    const lightId = cleanString(req.body.lightId, 20);
    const area = cleanString(req.body.area, 150);
    if (!lightId || !area) {
      return res.status(400).json({ success: false, message: "Light ID and area are required." });
    }

    const [result] = await pool.query(
      "INSERT INTO street_lights (light_id, area, latitude, longitude) VALUES (?, ?, ?, ?)",
      [lightId, area, numberOrNull(req.body.latitude), numberOrNull(req.body.longitude)]
    );

    res.status(201).json({ success: true, id: result.insertId, message: "Street light registered." });
  } catch (error) {
    console.error("Add light error:", error.message);
    res.status(500).json({
      success: false,
      message: error.code === "ER_DUP_ENTRY" ? "This Light ID already exists." : "Unable to save street light."
    });
  }
});

/* GET FAULT REPORTS */
app.get("/api/faults", async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT f.fault_id AS FaultID,
             f.light_id AS LightID,
             COALESCE(NULLIF(f.area, ''), l.area, '') AS Area,
             f.fault_type AS FaultType,
             f.reported_time AS ReportedTime,
             f.status AS Status,
             f.resolved_time AS ResolvedTime,
             COALESCE(f.priority, 'Medium') AS Priority,
             COALESCE(f.technician, '') AS Technician,
             COALESCE(f.description, '') AS Description,
             f.photo_path AS PhotoPath
      FROM fault_reports f
      LEFT JOIN street_lights l ON f.light_id = l.light_id
      ORDER BY f.reported_time DESC, f.id DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error("Get faults error:", error.message);
    res.status(500).json({ message: "Unable to load fault reports." });
  }
});

/* SUBMIT FAULT REPORT, WITH OPTIONAL PHOTO */
app.post("/api/faults", (req, res) => {
  upload.single("photo")(req, res, async uploadError => {
    if (uploadError) {
      removeUploadedFile(req.file);
      const message = uploadError.code === "LIMIT_FILE_SIZE"
        ? "Photo must be 5 MB or smaller."
        : uploadError.message || "Photo upload failed.";
      return res.status(400).json({ success: false, message });
    }

    const lightId = cleanString(req.body.lightId, 20);
    const area = cleanString(req.body.area, 150) || "General Area";
    const faultType = cleanString(req.body.faultType, 100);
    const priority = cleanString(req.body.priority || "Medium", 20);
    const technician = cleanString(req.body.technician, 100);
    const description = String(req.body.description ?? "");

    if (!lightId || !faultType) {
      removeUploadedFile(req.file);
      return res.status(400).json({
        success: false,
        message: "Light ID and fault type are required."
      });
    }

    if (description.length > 10000) {
      removeUploadedFile(req.file);
      return res.status(400).json({ success: false, message: "Description is too long." });
    }

    const photoPath = req.file ? `uploads/faults/${req.file.filename}` : null;
    let connection;

    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      await connection.query(`
        INSERT INTO street_lights (light_id, area)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE
          area = IF(area IS NULL OR area = '' OR area = 'General Area', VALUES(area), area)
      `, [lightId, area]);

      const [result] = await connection.query(`
        INSERT INTO fault_reports
          (light_id, area, fault_type, reported_time, status,
           priority, technician, description, photo_path)
        VALUES (?, ?, ?, NOW(), 'In Progress', ?, ?, ?, ?)
      `, [lightId, area, faultType, priority, technician, description, photoPath]);

      await connection.query(
        "UPDATE fault_reports SET fault_id = id WHERE id = ? AND fault_id IS NULL",
        [result.insertId]
      );

      await connection.commit();

      res.status(201).json({
        success: true,
        faultId: result.insertId,
        photoPath,
        message: "Fault report saved successfully."
      });
    } catch (error) {
      if (connection) await connection.rollback();
      removeUploadedFile(req.file);
      console.error("Save fault error:", error.message);
      res.status(500).json({ success: false, message: "Unable to save fault report." });
    } finally {
      if (connection) connection.release();
    }
  });
});

/* RESOLVE ALL UNRESOLVED FAULTS FOR A LIGHT */
app.put("/api/faults/light/:lightId/resolve", async (req, res) => {
  try {
    const lightId = cleanString(req.params.lightId, 20);
    const [result] = await pool.query(`
      UPDATE fault_reports
      SET status = 'Resolved', resolved_time = NOW()
      WHERE light_id = ? AND LOWER(status) <> 'resolved'
    `, [lightId]);

    res.json({
      success: true,
      affectedRows: result.affectedRows,
      message: "Fault status updated."
    });
  } catch (error) {
    console.error("Resolve fault error:", error.message);
    res.status(500).json({ success: false, message: "Unable to resolve faults." });
  }
});

/* GET SENSOR READINGS */
app.get("/api/sensors", async (req, res) => {
  try {
    const params = [];
    let sql = `
      SELECT light_id AS LightID,
             recorded_at AS Timestamp,
             status AS LightStatus,
             voltage AS Voltage,
             \`current\` AS CurrentValue,
             brightness AS BrightnessValue
      FROM sensor_data
    `;

    if (req.query.lightId && req.query.lightId !== "all") {
      sql += " WHERE light_id = ?";
      params.push(cleanString(req.query.lightId, 20));
    }

    sql += " ORDER BY recorded_at DESC, id DESC LIMIT 100";
    const [rows] = await pool.query(sql, params);

    res.json(rows.map(row => ({
      LightID: row.LightID,
      Timestamp: row.Timestamp,
      LightStatus: row.LightStatus,
      Voltage: row.Voltage,
      "Current(A)": row.CurrentValue,
      "Brightness(Lux)": row.BrightnessValue
    })));
  } catch (error) {
    console.error("Get sensors error:", error.message);
    res.status(500).json({ message: "Unable to load sensor readings." });
  }
});

/* GET LATEST SENSOR READING */
app.get("/api/sensors/latest", async (req, res) => {
  try {
    const params = [];
    let sql = `
      SELECT light_id AS LightID,
             recorded_at AS Timestamp,
             status AS LightStatus,
             voltage AS Voltage,
             \`current\` AS CurrentValue,
             brightness AS BrightnessValue
      FROM sensor_data
    `;

    if (req.query.lightId && req.query.lightId !== "all") {
      sql += " WHERE light_id = ?";
      params.push(cleanString(req.query.lightId, 20));
    }

    sql += " ORDER BY recorded_at DESC, id DESC LIMIT 1";
    const [rows] = await pool.query(sql, params);

    if (!rows.length) return res.json(null);
    const row = rows[0];

    res.json({
      LightID: row.LightID,
      Timestamp: row.Timestamp,
      LightStatus: row.LightStatus,
      Voltage: row.Voltage,
      "Current(A)": row.CurrentValue,
      "Brightness(Lux)": row.BrightnessValue
    });
  } catch (error) {
    console.error("Latest sensor error:", error.message);
    res.status(500).json({ message: "Unable to load latest sensor reading." });
  }
});

/* RECEIVE SENSOR DATA FROM HARDWARE */
app.post("/api/sensors", async (req, res) => {
  const lightId = cleanString(req.body.lightId, 20);
  if (!lightId) {
    return res.status(400).json({ success: false, message: "Light ID is required." });
  }

  const voltage = numberOrNull(req.body.voltage);
  const current = numberOrNull(req.body.current);
  const brightness = numberOrNull(req.body.brightness);

  if (
    (req.body.voltage != null && voltage === null) ||
    (req.body.current != null && current === null) ||
    (req.body.brightness != null && brightness === null)
  ) {
    return res.status(400).json({ success: false, message: "Sensor readings must be valid numbers." });
  }

  const status = cleanString(req.body.status || "OFF", 20).toUpperCase();
  if (!validStatus(status)) {
    return res.status(400).json({ success: false, message: "Status must be ON or OFF." });
  }

  try {
    const timestamp = toMySQLDate(req.body.timestamp);
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      await connection.query(`
        INSERT INTO street_lights (light_id, area)
        VALUES (?, 'General Area')
        ON DUPLICATE KEY UPDATE light_id = VALUES(light_id)
      `, [lightId]);

      const [result] = await connection.query(`
        INSERT INTO sensor_data
          (light_id, voltage, \`current\`, brightness, status, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [lightId, voltage, current, brightness, status, timestamp]);

      await connection.commit();
      res.status(201).json({
        success: true,
        id: result.insertId,
        message: "Sensor reading saved successfully."
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Save sensor error:", error.message);
    res.status(500).json({ success: false, message: "Unable to save sensor reading." });
  }
});

/* GLOBAL ERROR HANDLER */
app.use((error, _req, res, _next) => {
  console.error("Server error:", error.message);
  res.status(500).json({ success: false, message: "Unexpected server error." });
});

async function startServer() {
  try {
    await setupDatabase();
    app.listen(PORT, () => {
      console.log("-----------------------------------");
      console.log("Smart Street Light server started");
      console.log(`Website: http://localhost:${PORT}`);
      console.log(`Health:  http://localhost:${PORT}/api/health`);
      console.log(`Lights:  http://localhost:${PORT}/api/lights`);
      console.log(`Faults:  http://localhost:${PORT}/api/faults`);
      console.log(`Sensors: http://localhost:${PORT}/api/sensors`);
      console.log("-----------------------------------");
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
}

startServer();