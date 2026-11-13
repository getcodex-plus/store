import { readFile } from 'node:fs/promises'
import { pool, transaction } from '../src/server/db'
import { hashPassword } from 'better-auth/crypto'
import { id } from '../src/server/crypto'
import { validateRuntime } from '../src/server/config'

validateRuntime()
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase()
const passwordFile = process.env.BOOTSTRAP_PASSWORD_FILE
if (!email || !passwordFile)
  throw new Error(
    'Set ADMIN_EMAIL and BOOTSTRAP_PASSWORD_FILE to a protected file path. No password on the command line.',
  )
const password = (await readFile(passwordFile, 'utf8')).trimEnd()
if (password.length < 16 || password.length > 128)
  throw new Error('The initial password must contain 16–128 characters')
const encoded = await hashPassword(password)
await transaction(async (client) => {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('getgpt-bootstrap-owner'))")
  if ((await client.query("SELECT id FROM users WHERE role='admin'")).rowCount)
    throw new Error('An owner already exists. Bootstrap will not reset an existing account.')
  const userId = id('u_')
  await client.query(
    "INSERT INTO users(id,email,role,referral_code,name,email_verified) VALUES($1,$2,'admin',$3,'Owner',true)",
    [userId, email, id().slice(0, 10)],
  )
  await client.query(
    `INSERT INTO auth_account(id,"userId","accountId","providerId",password,"createdAt","updatedAt") VALUES($1,$2,$2,'credential',$3,now(),now())`,
    [id('a_'), userId, encoded],
  )
})
console.log('Owner initialized. Sign in with the password, then add a Passkey and TOTP.')
await pool.end()
