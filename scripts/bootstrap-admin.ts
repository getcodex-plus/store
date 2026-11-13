import { readFile } from 'node:fs/promises'
import { db, transaction } from '../src/server/db'
import { advisoryLock, databaseNow } from '../src/server/database-sql'
import { client, ready, server } from '@serenity-kit/opaque'
import { opaqueSetup } from '../src/server/opaque-setup'
import { id } from '../src/server/crypto'
import { validateRuntime } from '../src/server/config'

try {
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
  await ready
  const { clientRegistrationState, registrationRequest } = client.startRegistration({ password })
  const { registrationResponse } = server.createRegistrationResponse({
    serverSetup: await opaqueSetup(),
    userIdentifier: email,
    registrationRequest,
  })
  const { registrationRecord } = client.finishRegistration({
    password,
    clientRegistrationState,
    registrationResponse,
  })
  await transaction(async (client) => {
    await advisoryLock(client, 'getgpt-bootstrap-owner')
    if (await client.user.count({ where: { role: 'admin' } }))
      throw new Error('An owner already exists. Bootstrap will not reset an existing account.')
    const userId = id('u_')
    await client.user.create({
      data: {
        id: userId,
        email,
        role: 'admin',
        referralCode: id().slice(0, 10),
        name: 'Owner',
        emailVerified: true,
      },
    })
    await client.authAccount.create({
      data: {
        id: id('a_'),
        userId,
        accountId: userId,
        providerId: 'opaque',
        registrationRecord,
        updatedAt: await databaseNow(client),
      },
    })
  })
  console.log('Owner initialized. Add a Passkey and TOTP after signing in.')
} finally {
  await db.$disconnect()
}
