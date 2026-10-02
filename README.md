# Iron Hoof Ranch

IRONHOOF is a Cobblemon company website with public division pages, employee profiles, work request forms, and an admin dashboard for managing content.

This project uses PostgreSQL through `pg`, not SQLite. The app reads its database connection from `DATABASE_URL` and seeds its data on startup.

## Features

- Public home page with company info and employee cards
- Division pages for mining, logging, construction, transport, and sales
- Public job application page for new applicants
- Work request forms that create tickets in the database
- Admin login for editing company info, employees, sales, tickets, job applications, and admin accounts
- Employee Minecraft usernames with profile skins on the public site
- Photo galleries on the division pages

## Requirements

- Node.js 18 or newer
- PostgreSQL database
- A `.env` file with the required environment variables

## Setup

```powershell
npm install
copy .env.example .env
npm run seed
npm start
```

Then open:

```text
http://localhost:3001
```

## Environment Variables

- `DATABASE_URL`: PostgreSQL connection string
- `PORT`: Optional port override for the web server
- `SESSION_SECRET`: Session signing secret for admin login
- `DISCORD_WEBHOOK_URL`: Optional webhook for work request notifications
- `JOHN_PASSWORD`: Optional seed override for John Hearthrite
- `SYLVESTER_PASSWORD`: Optional seed override for Sylvester Holt

## Default Admin Accounts

The seed script creates these accounts by default:

- `John Hearthrite` / `ranch123`
- `Sylvester Holt` / `ceo123`

If you change the seeded passwords in `.env`, run the seed script again.

## Scripts

```powershell
npm start   # start the production server
npm run dev # start the server with nodemon
npm run seed # create or refresh the database records
```

## Data Model

The main tables are:

- `admins`
- `ranch_info`
- `employees`
- `sales`
- `child_companies`
- `tickets`
- `job_applications`

The `employees` table also supports `minecraft_username` so the site can render Minecraft skins for staff members.

## Project Structure

- `server.js`: Express app, routes, and admin behavior
- `db.js`: PostgreSQL pool and database initialization
- `seed.js`: Seeds admin users, company records, and default employees
- `views/`: EJS templates for the public site and admin dashboard
- `public/css/style.css`: Shared site styling
- `public/images/`: Logos, employee assets, and division photos

## Division Photo Galleries

Each division page displays a simple photo gallery backed by images in `public/images/companies/`.

- `mining`: `public/images/companies/mining/image.png`
- `logging`: `public/images/companies/logging/image.png`
- `construction`: `public/images/companies/construction/image.png`
- `transport`: `public/images/companies/transportation/image.png`
- `sales`: `public/images/companies/sales/image.png`

## Hosting Notes

Use a host with persistent PostgreSQL storage. If the database is recreated on each deploy, the site will lose seeded content and user-submitted tickets.

Good options include hosts that support managed PostgreSQL or persistent volumes.
