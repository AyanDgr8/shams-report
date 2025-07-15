// makeUser.js

import bcrypt from 'bcrypt';
import mysql from 'mysql2/promise';

async function main() {

  // Admin credentials (change as required)
  const username = 'Ayan Khan';
  const email = 'ayan@multycomm.com';
  const plainPassword = 'Ayan1012';

  const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'Ayan@1012',
    database: 'shams',
    port: 3306,
    waitForConnections: true,
    connectionLimit: 5,
  });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    // Upsert into users table
    const [existing] = await conn.query('SELECT id FROM users WHERE email = ? OR username = ?', [email, username]);
    if (existing.length) {
      await conn.query('UPDATE users SET password = ?, username = ? WHERE id = ?', [hashedPassword, username, existing[0].id]);
      console.log('✅ Existing admin updated');
    } else {
      await conn.query('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', [username, email, hashedPassword]);
      console.log('✅ Admin created');
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error('❌ Failed to create admin:', err.message);
  } finally {
    conn.release();
    await pool.end();
  }
}

main();
