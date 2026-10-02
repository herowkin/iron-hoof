require('dotenv').config();

const fs = require('fs');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;
const newsUploadDir = path.join(__dirname, 'public', 'uploads', 'news');

fs.mkdirSync(newsUploadDir, { recursive: true });

// Main Express application for the public site and admin dashboard.

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));

app.use((req, res, next) => {
  res.locals.admin = req.session.admin || null;
  res.locals.isReporter = req.session.admin?.role === 'Reporter';
  res.locals.canAccessAdminPanel = Boolean(req.session.admin) && req.session.admin.role !== 'Reporter';
  next();
});

function requireLoggedIn(req, res, next) {
  if (!req.session.admin) return res.redirect('/login');
  next();
}

function requireAdminPanel(req, res, next) {
  if (!req.session.admin) return res.redirect('/login');

  if (req.session.admin.role === 'Reporter') {
    return res.redirect('/reporter');
  }

  next();
}

const newsUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, callback) => callback(null, newsUploadDir),
    filename: (req, file, callback) => {
      const safeName = path.basename(file.originalname, path.extname(file.originalname))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'news-report';

      callback(null, `${Date.now()}-${safeName}.pdf`);
    }
  }),
  fileFilter: (req, file, callback) => {
    const isPdf = file.mimetype === 'application/pdf' || path.extname(file.originalname).toLowerCase() === '.pdf';

    if (!isPdf) {
      return callback(new Error('Only PDF files can be uploaded.'));
    }

    callback(null, true);
  },
  limits: {
    fileSize: 20 * 1024 * 1024
  }
});

function getDiscordMessageUrl(messageId) {
  const webhookUrl = new URL(process.env.DISCORD_WEBHOOK_URL);
  webhookUrl.searchParams.delete('wait');
  webhookUrl.pathname = `${webhookUrl.pathname.replace(/\/$/, '')}/messages/${messageId}`;
  return webhookUrl.toString();
}

function getTicketStatusColor(status) {
  return {
    Open: 12058624,
    'In Progress': 16753920,
    Completed: 5763719
  }[status] || 9807270;
}

function getTicketEmbed(ticket) {
  return {
    title: 'New IRONHOOF Work Request',
    color: getTicketStatusColor(ticket.status),
    fields: [
      {
        name: 'Company',
        value: ticket.companyName || ticket.company_name || 'Unknown'
      },
      {
        name: 'Requester',
        value: ticket.requesterName || ticket.requester_name || 'Unknown'
      },
      {
        name: 'Contact',
        value: ticket.contact || 'None'
      },
      {
        name: 'Job',
        value: ticket.jobTitle || ticket.job_title || 'No title'
      },
      {
        name: 'Details',
        value: ticket.details || 'No details'
      },
      {
        name: 'Status',
        value: ticket.status || 'Open'
      }
    ]
  };
}

// Wait helper used only when Discord explicitly asks us to slow down.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readDiscordError(response) {
  const body = await response.text();
  const preview = body.replace(/\s+/g, ' ').trim().slice(0, 500);
  return preview || 'No response body';
}

async function discordFetch(url, options, attempt = 0) {
  const response = await fetch(url, options);

  // Discord normally reports rate limits with HTTP 429 and a retry_after value.
  // Retry once only; this prevents a retry loop from creating more traffic.
  if (response.status === 429 && attempt === 0) {
    let retryAfterMs = 5000;

    try {
      const data = await response.clone().json();
      if (Number.isFinite(Number(data.retry_after))) {
        retryAfterMs = Math.max(1000, Math.ceil(Number(data.retry_after) * 1000));
      }
    } catch (_) {
      const header = Number(response.headers.get('retry-after'));
      if (Number.isFinite(header)) {
        retryAfterMs = Math.max(1000, Math.ceil(header * 1000));
      }
    }

    console.warn(`Discord rate limited the webhook. Retrying once in ${retryAfterMs}ms.`);
    await sleep(retryAfterMs);
    return discordFetch(url, options, attempt + 1);
  }

  return response;
}

// Sends a Discord notification and returns the message ID so it can be edited later.
async function sendDiscordTicketNotification(ticket) {
  if (!process.env.DISCORD_WEBHOOK_URL) {
    console.warn('Discord notification skipped: DISCORD_WEBHOOK_URL is not configured.');
    return null;
  }

  try {
    const webhookUrl = new URL(process.env.DISCORD_WEBHOOK_URL);
    webhookUrl.searchParams.set('wait', 'true');

    const response = await discordFetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: ticket.status && ticket.status !== 'Open'
          ? 'IRONHOOF work request status updated.'
          : 'New IRONHOOF work request received.',
        embeds: [getTicketEmbed(ticket)]
      })
    });

    if (!response.ok) {
      console.error(`Discord webhook failed (${response.status}): ${await readDiscordError(response)}`);
      return null;
    }

    const message = await response.json();
    console.log(`Discord notification sent. Message ID: ${message.id}`);
    return message.id;
  } catch (error) {
    console.error('Discord webhook exception:', error.message);
    return null;
  }
}

async function updateDiscordTicketNotification(ticket) {
  if (!process.env.DISCORD_WEBHOOK_URL) {
    console.warn('Discord status update skipped: DISCORD_WEBHOOK_URL is not configured.');
    return null;
  }

  // Older tickets may predate discord_message_id. Create their Discord message once,
  // save its ID in the route below, and edit that same message on future changes.
  if (!ticket.discord_message_id) {
    return sendDiscordTicketNotification({
      companyName: ticket.company_name,
      requesterName: ticket.requester_name,
      contact: ticket.contact,
      jobTitle: ticket.job_title,
      details: ticket.details,
      status: ticket.status
    });
  }

  try {
    const response = await discordFetch(getDiscordMessageUrl(ticket.discord_message_id), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: 'IRONHOOF work request status updated.',
        embeds: [getTicketEmbed(ticket)]
      })
    });

    if (!response.ok) {
      console.error(`Discord status update failed (${response.status}): ${await readDiscordError(response)}`);
      return null;
    }

    console.log(`Discord ticket message updated. Message ID: ${ticket.discord_message_id}`);
    return ticket.discord_message_id;
  } catch (error) {
    console.error('Discord status update exception:', error.message);
    return null;
  }
}

// Returns the single-row company profile used across the public site.
async function getInfo() {
  const result = await db.query('SELECT * FROM ranch_info WHERE id = 1');

  return result.rows[0] || {
    company_name: 'IRONHOOF',
    tagline: 'AD FINEM MUNDI',
    about: 'IRONHOOF is a Cobblemon business focused on organized trade, ranch operations, Pokémon management, and private client records.',
    what_we_do: 'We manage Cobblemon sales, work contracts, Pokémon inventory, transport records, and business arrangements.'
  };
}

// Renders a division page from the child_companies table.
async function renderCompanyPage(req, res, slug, pageName) {
  const result = await db.query(
    'SELECT * FROM child_companies WHERE slug = $1',
    [slug]
  );

  const company = result.rows[0];
  if (!company) return res.redirect('/');

  res.render(pageName, {
    company,
    admin: req.session.admin,
    success: false
  });
}

// Stores a work request, notifies Discord when configured, and returns the page.
async function handleCompanyRequest(req, res, slug, pageName) {
  console.log('Ticket request route hit:', slug);
  console.log('Form body:', req.body);

  const { requester_name, contact, job_title, details } = req.body;

  try {
    const result = await db.query(
      'SELECT * FROM child_companies WHERE slug = $1',
      [slug]
    );

    const company = result.rows[0];

    if (!company) {
      console.log('No company found for slug:', slug);
      return res.status(404).send('Company not found. Run npm run seed.');
    }

    const ticketResult = await db.query(
      `
      INSERT INTO tickets
      (company_id, requester_name, contact, job_title, details)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
      `,
      [
        company.id,
        requester_name,
        contact,
        job_title,
        details
      ]
    );

    const ticketId = ticketResult.rows[0].id;
    console.log('Ticket inserted:', ticketId);

    try {
      const discordMessageId = await sendDiscordTicketNotification({
        ticketId,
        companyName: company.name,
        requesterName: requester_name,
        contact,
        jobTitle: job_title,
        details,
        status: 'Open'
      });

      if (discordMessageId) {
        await db.query(
          'UPDATE tickets SET discord_message_id = $1 WHERE id = $2',
          [discordMessageId, ticketId]
        );
      }

      if (!discordMessageId) {
        console.warn(`Ticket #${ticketId} was saved, but its Discord notification was not delivered.`);
      }
    } catch (discordError) {
      console.error('Discord webhook failed:', discordError.message);
    }

    res.render(pageName, {
      company,
      admin: req.session.admin,
      success: true
    });
  } catch (error) {
    console.error('Ticket request failed:', error);
    res.status(500).send('Ticket request failed. Check Railway logs.');
  }
}

async function renderApplicationPage(req, res, success = false) {
  res.render('apply', {
    admin: req.session.admin,
    success
  });
}

async function handleJobApplication(req, res) {
  const {
    full_name,
    minecraft_username,
    discord_username,
    why_want_job
  } = req.body;

  const contact = `${minecraft_username} | ${discord_username}`;

  try {
    await db.query(
      `
      INSERT INTO job_applications
      (full_name, contact, minecraft_username, discord_username, why_want_job, desired_role, experience, availability, message)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        full_name,
        contact,
        minecraft_username,
        discord_username,
        why_want_job,
        'Not provided',
        'Not provided',
        'Not provided',
        'Not provided'
      ]
    );

    renderApplicationPage(req, res, true);
  } catch (error) {
    console.error('Job application failed:', error);
    res.status(500).send('Job application failed. Check Railway logs.');
  }
}

app.get('/', async (req, res) => {
  const info = await getInfo();
  const employees = await db.query('SELECT * FROM employees ORDER BY id');

  res.render('index', {
    info,
    employees: employees.rows,
    admin: req.session.admin
  });
});

app.get('/mining', (req, res) => renderCompanyPage(req, res, 'mining', 'mining'));
app.get('/logging', (req, res) => renderCompanyPage(req, res, 'logging', 'logging'));
app.get('/construction', (req, res) => renderCompanyPage(req, res, 'construction', 'construction'));
app.get('/transport', (req, res) => renderCompanyPage(req, res, 'transport', 'transport'));
app.get('/sales', (req, res) => renderCompanyPage(req, res, 'sales', 'sales'));
app.get('/apply', (req, res) => renderApplicationPage(req, res));

app.get('/news', async (req, res) => {
  const newsPosts = await db.query(
    `
    SELECT *
    FROM news_posts
    ORDER BY created_at DESC, id DESC
    `
  );

  res.render('news', {
    admin: req.session.admin,
    newsPosts: newsPosts.rows
  });
});

app.get('/news/:id', async (req, res) => {
  const newsPostResult = await db.query(
    `
    SELECT *
    FROM news_posts
    WHERE id = $1
    `,
    [req.params.id]
  );

  const newsPost = newsPostResult.rows[0];

  if (!newsPost) {
    return res.redirect('/news');
  }

  res.render('news-post', {
    admin: req.session.admin,
    newsPost,
    pdfUrl: `/uploads/news/${newsPost.pdf_filename}`
  });
});

app.get('/reporter', requireLoggedIn, async (req, res) => {
  const newsPosts = await db.query(
    `
    SELECT *
    FROM news_posts
    ORDER BY created_at DESC, id DESC
    `
  );

  res.render('reporter', {
    admin: req.session.admin,
    newsPosts: newsPosts.rows,
    error: null,
    success: null
  });
});

app.post('/mining/request', (req, res) => handleCompanyRequest(req, res, 'mining', 'mining'));
app.post('/logging/request', (req, res) => handleCompanyRequest(req, res, 'logging', 'logging'));
app.post('/construction/request', (req, res) => handleCompanyRequest(req, res, 'construction', 'construction'));
app.post('/transport/request', (req, res) => handleCompanyRequest(req, res, 'transport', 'transport'));
app.post('/sales/request', (req, res) => handleCompanyRequest(req, res, 'sales', 'sales'));
app.post('/apply', (req, res) => handleJobApplication(req, res));

app.post('/reporter/news', requireLoggedIn, (req, res) => {
  newsUpload.single('pdf_file')(req, res, async error => {
    try {
      const newsPostsResult = await db.query(
        `
        SELECT *
        FROM news_posts
        ORDER BY created_at DESC, id DESC
        `
      );

      if (error) {
        return res.status(400).render('reporter', {
          admin: req.session.admin,
          newsPosts: newsPostsResult.rows,
          error: error.message,
          success: null
        });
      }

      const { title, summary } = req.body;

      if (!title || !req.file) {
        if (req.file && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }

        return res.status(400).render('reporter', {
          admin: req.session.admin,
          newsPosts: newsPostsResult.rows,
          error: 'A title and PDF file are required.',
          success: null
        });
      }

      await db.query(
        `
        INSERT INTO news_posts
        (title, summary, pdf_filename, posted_by, posted_role)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [
          title,
          summary || '',
          path.basename(req.file.filename),
          req.session.admin.username,
          req.session.admin.role
        ]
      );

      const refreshedPosts = await db.query(
        `
        SELECT *
        FROM news_posts
        ORDER BY created_at DESC, id DESC
        `
      );

      return res.render('reporter', {
        admin: req.session.admin,
        newsPosts: refreshedPosts.rows,
        error: null,
        success: 'PDF news post uploaded successfully.'
      });
    } catch (uploadError) {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      return res.status(500).render('reporter', {
        admin: req.session.admin,
        newsPosts: [],
        error: 'News upload failed.',
        success: null
      });
    }
  });
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  const result = await db.query(
    'SELECT * FROM admins WHERE username = $1',
    [username]
  );

  const admin = result.rows[0];

  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.render('login', { error: 'Invalid username or password.' });
  }

  req.session.admin = {
    username: admin.username,
    role: admin.role
  };

  if (admin.role === 'Reporter') {
    return res.redirect('/reporter');
  }

  res.redirect('/admin');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/admin', requireAdminPanel, async (req, res) => {
  const search = req.query.search || '';
  const info = await getInfo();

  const employees = await db.query('SELECT * FROM employees ORDER BY id');
  const sales = await db.query('SELECT * FROM sales ORDER BY created_at DESC, id DESC');
  const admins = await db.query(
    `
    SELECT id, username, role
    FROM admins
    WHERE role <> 'Reporter'
    ORDER BY role, username
    `
  );
  const reporters = await db.query(
    `
    SELECT id, username, role
    FROM admins
    WHERE role = 'Reporter'
    ORDER BY username
    `
  );
  const applications = await db.query(
    `
    SELECT *
    FROM job_applications
    WHERE
      full_name ILIKE $1 OR
      contact ILIKE $1 OR
      minecraft_username ILIKE $1 OR
      discord_username ILIKE $1 OR
      why_want_job ILIKE $1 OR
      status ILIKE $1
    ORDER BY created_at DESC, id DESC
    `,
    [`%${search}%`]
  );

  const tickets = await db.query(
    `
    SELECT tickets.*, child_companies.name AS company_name
    FROM tickets
    LEFT JOIN child_companies ON tickets.company_id = child_companies.id
    WHERE
      requester_name ILIKE $1 OR
      contact ILIKE $1 OR
      job_title ILIKE $1 OR
      details ILIKE $1 OR
      status ILIKE $1 OR
      child_companies.name ILIKE $1
    ORDER BY tickets.created_at DESC
    `,
    [`%${search}%`]
  );

  res.render('admin', {
    info,
    employees: employees.rows,
    sales: sales.rows,
    admins: admins.rows,
    reporters: reporters.rows,
    applications: applications.rows,
    tickets: tickets.rows,
    search,
    admin: req.session.admin
  });
});

app.post('/admin/applications/:id/status', requireAdminPanel, async (req, res) => {
  const { status } = req.body;

  await db.query(
    'UPDATE job_applications SET status = $1 WHERE id = $2',
    [status, req.params.id]
  );

  res.redirect('/admin');
});

app.post('/admin/applications/:id/delete', requireAdminPanel, async (req, res) => {
  await db.query('DELETE FROM job_applications WHERE id = $1', [req.params.id]);
  res.redirect('/admin');
});

app.post('/admin/info', requireAdminPanel, async (req, res) => {
  const { company_name, tagline, about, what_we_do } = req.body;

  await db.query(
    `
    UPDATE ranch_info
    SET company_name = $1, tagline = $2, about = $3, what_we_do = $4
    WHERE id = 1
    `,
    [company_name, tagline, about, what_we_do]
  );

  res.redirect('/admin');
});

app.post('/admin/employees/add', requireAdminPanel, async (req, res) => {
  const { name, title, description, minecraft_username } = req.body;

  await db.query(
    'INSERT INTO employees (name, title, description, minecraft_username) VALUES ($1, $2, $3, $4)',
    [name, title, description, minecraft_username || '']
  );

  res.redirect('/admin');
});

app.post('/admin/employees/:id/edit', requireAdminPanel, async (req, res) => {
  const { name, title, description, minecraft_username } = req.body;

  await db.query(
    'UPDATE employees SET name = $1, title = $2, description = $3, minecraft_username = $4 WHERE id = $5',
    [name, title, description, minecraft_username || '', req.params.id]
  );

  res.redirect('/admin');
});

app.post('/admin/employees/:id/delete', requireAdminPanel, async (req, res) => {
  await db.query('DELETE FROM employees WHERE id = $1', [req.params.id]);
  res.redirect('/admin');
});

app.post('/admin/sales/add', requireAdminPanel, async (req, res) => {
  const { customer, item, category, amount, status, notes } = req.body;

  await db.query(
    `
    INSERT INTO sales (customer, item, category, amount, status, notes)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [customer, item, category, Number(amount || 0), status, notes || '']
  );

  res.redirect('/admin');
});

app.post('/admin/sales/:id/edit', requireAdminPanel, async (req, res) => {
  const { customer, item, category, amount, status, notes } = req.body;

  await db.query(
    `
    UPDATE sales
    SET customer = $1, item = $2, category = $3, amount = $4, status = $5, notes = $6
    WHERE id = $7
    `,
    [customer, item, category, Number(amount || 0), status, notes || '', req.params.id]
  );

  res.redirect('/admin');
});

app.post('/admin/sales/:id/delete', requireAdminPanel, async (req, res) => {
  await db.query('DELETE FROM sales WHERE id = $1', [req.params.id]);
  res.redirect('/admin');
});

app.post('/admin/tickets/:id/status', requireAdminPanel, async (req, res) => {
  const { status } = req.body;
  const ticketId = req.params.id;

  const ticketResult = await db.query(
    `
    SELECT tickets.*, child_companies.name AS company_name
    FROM tickets
    LEFT JOIN child_companies ON tickets.company_id = child_companies.id
    WHERE tickets.id = $1
    `,
    [ticketId]
  );

  const ticket = ticketResult.rows[0];

  if (!ticket) {
    return res.redirect('/admin');
  }

  await db.query(
    'UPDATE tickets SET status = $1 WHERE id = $2',
    [status, ticketId]
  );

  try {
    const discordMessageId = await updateDiscordTicketNotification({
      ...ticket,
      status
    });

    if (discordMessageId && !ticket.discord_message_id) {
      await db.query(
        'UPDATE tickets SET discord_message_id = $1 WHERE id = $2',
        [discordMessageId, ticketId]
      );
    }
  } catch (discordError) {
    console.error('Discord status update failed:', discordError.message);
  }

  if (status === 'Completed') {
    const existingSale = await db.query(
      `
      SELECT * FROM sales
      WHERE notes ILIKE $1
      `,
      [`%Ticket #${ticketId}%`]
    );

    if (existingSale.rows.length === 0) {
      await db.query(
        `
        INSERT INTO sales
        (customer, item, category, amount, status, notes)
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          ticket.requester_name,
          ticket.job_title,
          ticket.company_name || 'Work Request',
          0,
          'Completed',
          `Created from Ticket #${ticketId}. Contact: ${ticket.contact}. Details: ${ticket.details}`
        ]
      );
    }
  }

  res.redirect('/admin');
});

app.post('/admin/tickets/:id/delete', requireAdminPanel, async (req, res) => {
  await db.query('DELETE FROM tickets WHERE id = $1', [req.params.id]);

  res.redirect('/admin');
});

app.post('/admin/admins/add', requireAdminPanel, async (req, res) => {
  const { username, password, role } = req.body;

  if (!username || !password || !role) return res.redirect('/admin');

  const passwordHash = bcrypt.hashSync(password, 12);

  await db.query(
    `
    INSERT INTO admins (username, password_hash, role)
    VALUES ($1, $2, $3)
    ON CONFLICT(username) DO NOTHING
    `,
    [username, passwordHash, role]
  );

  res.redirect('/admin');
});
app.get('/debug-db', async (req, res) => {
  try {
    const host = new URL(process.env.DATABASE_URL).host;

    const companies = await db.query(
      'SELECT COUNT(*) FROM child_companies'
    );

    const tickets = await db.query(
      'SELECT COUNT(*) FROM tickets'
    );

    const latestTickets = await db.query(
      'SELECT * FROM tickets ORDER BY created_at DESC LIMIT 10'
    );

    res.json({
      dbHost: host,
      companyCount: companies.rows[0].count,
      ticketCount: tickets.rows[0].count,
      latestTickets: latestTickets.rows
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});
app.get('/db-check', async (req, res) => {
  res.json({
    databaseUrl: process.env.DATABASE_URL,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE
  });
});

async function startServer() {
  await db.initDb();

  app.listen(PORT, () => {
    console.log(`IRONHOOF running at http://localhost:${PORT}`);
  });
}

startServer().catch(error => {
  console.error(error);
  process.exit(1);
});