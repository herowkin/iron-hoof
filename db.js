require('dotenv').config();

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

// Creates the tables used by the app and applies lightweight migrations.
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'Admin'
      
    );
    

    CREATE TABLE IF NOT EXISTS ranch_info (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      company_name TEXT NOT NULL,
      tagline TEXT NOT NULL,
      about TEXT NOT NULL,
      what_we_do TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
     description TEXT NOT NULL,
      minecraft_username TEXT
    );

    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      customer TEXT NOT NULL,
      item TEXT NOT NULL,
      category TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS child_companies (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL,
      services TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES child_companies(id) ON DELETE SET NULL,
      requester_name TEXT NOT NULL,
      contact TEXT NOT NULL,
      job_title TEXT NOT NULL,
      details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Open',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS job_applications (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      contact TEXT NOT NULL,
      minecraft_username TEXT NOT NULL,
      discord_username TEXT NOT NULL,
      why_want_job TEXT NOT NULL,
      desired_role TEXT NOT NULL,
      experience TEXT NOT NULL,
      availability TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS news_posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT,
      pdf_filename TEXT NOT NULL,
      posted_by TEXT NOT NULL,
      posted_role TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    ALTER TABLE employees
    ADD COLUMN IF NOT EXISTS minecraft_username TEXT;
  `);

  await pool.query(`
    ALTER TABLE job_applications
    ADD COLUMN IF NOT EXISTS why_want_job TEXT;
  `);

  await pool.query(`
    ALTER TABLE job_applications
    ADD COLUMN IF NOT EXISTS minecraft_username TEXT;
  `);

  await pool.query(`
    ALTER TABLE job_applications
    ADD COLUMN IF NOT EXISTS discord_username TEXT;
  `);

  await pool.query(`
    ALTER TABLE news_posts
    ADD COLUMN IF NOT EXISTS summary TEXT;
  `);

  await pool.query(`
    ALTER TABLE tickets
    ADD COLUMN IF NOT EXISTS discord_message_id TEXT;
  `);
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  initDb
};