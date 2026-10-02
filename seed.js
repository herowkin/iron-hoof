require('dotenv').config();

const bcrypt = require('bcryptjs');
const db = require('./db');

// Seeds the database with default admins, company content, and starter employees.
async function seed() {
  await db.initDb();

  const admins = [
    {
      username: 'John Hearthrite',
      password: process.env.JOHN_PASSWORD || 'ranch123',
      role: 'CFO'
    },
    {
      username: 'Sylvester Holt',
      password: process.env.SYLVESTER_PASSWORD || 'Tauros1970',
      role: 'CEO'
    }
  ];

  for (const admin of admins) {
    const hash = bcrypt.hashSync(admin.password, 12);

    await db.query(
      `
      INSERT INTO admins (username, password_hash, role)
      VALUES ($1, $2, $3)
      ON CONFLICT(username) DO UPDATE SET
        password_hash = excluded.password_hash,
        role = excluded.role
      `,
      [admin.username, hash, admin.role]
    );
  }

  await db.query(
    `
    INSERT INTO ranch_info
    (id, company_name, tagline, about, what_we_do)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT(id) DO NOTHING
    `,
    [
      1,
      'IRONHOOF',
      'AD FINEM MUNDI',
      'IRONHOOF is a Cobblemon business focused on organized trade, ranch operations, Pokémon management, and private client records.',
      'We manage Cobblemon sales, work contracts, Pokémon inventory, transport records, construction orders, mining jobs, logging jobs, and business arrangements.'
    ]
  );

  const companies = [
    ['Ironhoof Mining', 'mining', 'Handles excavation, underground labour, resource extraction, and mining-site Pokémon support.', 'Ore extraction, cave clearing, heavy labour, mining logistics, excavation contracts.'],
    ['Ironhoof Logging', 'logging', 'Provides forestry, lumber harvesting, land clearing, and wood transport operations.', 'Tree removal, lumber contracts, land clearing, forestry transport, supply work.'],
    ['Ironhoof Construction', 'construction', 'Manages building projects, repairs, ranch expansion, and heavy-duty construction contracts.', 'Building, repairs, roadwork, structure planning, site preparation.'],
    ['Ironhoof Transport', 'transport', 'Moves goods, Pokémon, supplies, equipment, and private cargo across regions.', 'Cargo hauling, Pokémon transport, supply routes, secure deliveries.'],
    ['Ironhoof Sales', 'sales', 'Handles Pokémon sales, client deals, contracts, and acquisition records.', 'Pokémon sales, client orders, contract management, trade records.']
  ];

  for (const company of companies) {
    await db.query(
      `
      INSERT INTO child_companies (name, slug, description, services)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        services = excluded.services
      `,
      company
    );
  }

  const employeeCount = await db.query('SELECT COUNT(*) AS count FROM employees');

  if (Number(employeeCount.rows[0].count) === 0) {
    await db.query(
      `
      INSERT INTO employees (name, title, description)
      VALUES
      ($1, $2, $3),
      ($4, $5, $6),
      ($7, $8, $9)
      `,
      [
        'Sylvester Holt',
        'Chief Executive Officer',
        'Oversees IRONHOOF operations, company direction, and major executive decisions.',
        'John Hearthrite',
        'Chief Financial Officer',
        'Manages sales records, financial reports, client payments, and executive admin records.',
        'Ranch Hands',
        'Operations Staff',
        'Handle ranch labour, Pokémon care, transportation, upkeep, and field work.'
      ]
    );
  }

  console.log('Database ready.');
  process.exit();
}

seed().catch(error => {
  console.error(error);
  process.exit(1);
});